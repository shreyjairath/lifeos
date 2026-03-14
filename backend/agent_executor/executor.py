"""Agent client: the agentic loop — LLM turns and tool dispatch."""
from collections.abc import AsyncGenerator
from dataclasses import dataclass

from agent_executor.llm_client import (
    LlmClientResult, stream_llm, LlmClientStreamEvent,
)
from agent_executor.tools_client import (
    ToolsClientResult, invoke_tools, ToolsClientEvent,
)
from agent_executor.tools_registry import get_tools
from agent_executor import cancellation


# ── Events ────────────────────────────────────────────────────────────────────

@dataclass
class AgentAppendEvent:
    """Signals the caller to append a message to persistent history."""
    role: str
    content: list


AgentClientEvent = LlmClientStreamEvent | ToolsClientEvent | AgentAppendEvent


# ── Public API ────────────────────────────────────────────────────────────────

async def run_loop(
    session_id: str,
    messages: list,
    system: str,
    model: str,
    tools: list | None = None,
) -> AsyncGenerator[AgentClientEvent, None]:
    """The agentic loop: calls LLM => invokes tools => calls LLM, until done or cancelled.

    Yields typed events. Caller persists history via AgentAppendEvent.
    """
    local = list(messages)
    _tools = tools if tools is not None else get_tools()

    while True:
        if cancellation.is_cancelled(session_id):
            return

        llm = LlmClientResult()
        async for event in stream_llm(model, system, local, _tools, result=llm):
            yield event

        assistant_content = []
        if llm.full_text:
            assistant_content.append({"type": "text", "text": llm.full_text})
        for tool_use in llm.parsed_tool_uses:
            assistant_content.append({
                "type": "tool_use",
                "id": tool_use["id"],
                "name": tool_use["name"],
                "input": tool_use["input"],
            })

        assistant_msg = {"role": "assistant", "content": assistant_content}
        local.append(assistant_msg)
        local = prepare_messages(local)
        yield AgentAppendEvent(role="assistant", content=assistant_content)

        if llm.stop_reason != "tool_use" or not llm.parsed_tool_uses:
            return

        tools = ToolsClientResult()
        try:
            async for event in invoke_tools(llm.parsed_tool_uses, session_id, result=tools):
                yield event
        except BaseException:
            local.append({"role": "user", "content": tools.messages})
            yield AgentAppendEvent(role="user", content=tools.messages)
            raise

        local.append({"role": "user", "content": tools.messages})
        local = prepare_messages(local)
        yield AgentAppendEvent(role="user", content=tools.messages)

        if tools.cancelled:
            return


# ── Private helpers ───────────────────────────────────────────────────────────

def prepare_messages(messages: list) -> list:
    """Trim leading orphaned tool_result blocks from history."""
    if not messages:
        return []
    window = list(messages)
    while window:
        content = window[0].get("content")
        if isinstance(content, list) and any(
            isinstance(b, dict) and b.get("type") == "tool_result" for b in content
        ):
            window = window[1:]
        else:
            break
    return window
