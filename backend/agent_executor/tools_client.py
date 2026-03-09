"""Tool invocation, gating, and cancellation for the agent loop."""
import asyncio
import json
from collections.abc import AsyncGenerator
from dataclasses import dataclass, field

from agent_executor import confirmations
from agent_executor import cancellation
from agent_executor.tools_registry import dispatch_tool


# ── Result accumulator ────────────────────────────────────────────────────────

@dataclass
class ToolsClientResult:
    messages: list = field(default_factory=list)  # tool_result dicts for history
    cancelled: bool = False


# ── Events ────────────────────────────────────────────────────────────────────

@dataclass
class ToolsClientConfirmRequestEvent:
    request_id: str
    name: str
    input: dict

@dataclass
class ToolsClientConfirmDeniedEvent:
    name: str

@dataclass
class ToolsClientResultEvent:
    name: str
    result: dict

@dataclass
class ToolsClientCancelledEvent:
    pass


ToolsClientEvent = ToolsClientConfirmRequestEvent | ToolsClientConfirmDeniedEvent | ToolsClientResultEvent | ToolsClientCancelledEvent


# ── Public API ────────────────────────────────────────────────────────────────

async def invoke_tools(
    tool_uses: list,
    session_id: str,
    result: ToolsClientResult,
) -> AsyncGenerator[ToolsClientEvent, None]:
    """Dispatch all tool_uses, yielding typed events and populating `result.messages`.

    On cancellation: stubs remaining tool_uses, sets result.cancelled, yields
    ToolsClientCancelledEvent, then returns (generator ends cleanly).

    On BaseException: stubs undispatched tool_uses into result.messages, then
    re-raises so the caller can persist history before propagating.
    """
    try:
        for i, tool_use in enumerate(tool_uses):
            if cancellation.is_cancelled(session_id):
                _stub_tools(tool_uses[i:], result, "Cancelled by user")
                result.cancelled = True
                yield ToolsClientCancelledEvent()
                return

            async for event in _invoke_one(tool_use, result):
                yield event

    except BaseException as exc:
        _stub_undispatched(tool_uses, result, exc)
        raise


# ── Private ───────────────────────────────────────────────────────────────────

async def _invoke_one(
    tool_use: dict,
    result: ToolsClientResult,
) -> AsyncGenerator[ToolsClientEvent, None]:
    """Gate, dispatch, and record a single tool call."""
    if confirmations.is_gated(tool_use["name"]):
        req_id = confirmations.register()
        yield ToolsClientConfirmRequestEvent(request_id=req_id, name=tool_use["name"], input=tool_use["input"])
        approved = await confirmations.wait_for(req_id)
        if not approved:
            tool_result = {"error": f"User denied execution of {tool_use['name']}"}
            yield ToolsClientConfirmDeniedEvent(name=tool_use["name"])
        else:
            tool_result = await asyncio.get_event_loop().run_in_executor(None, dispatch_tool, tool_use["name"], tool_use["input"])
    else:
        tool_result = await asyncio.get_event_loop().run_in_executor(None, dispatch_tool, tool_use["name"], tool_use["input"])

    result.messages.append({"type": "tool_result", "tool_use_id": tool_use["id"], "content": json.dumps(tool_result)})
    yield ToolsClientResultEvent(name=tool_use["name"], result=tool_result)


def _stub_tools(tool_uses: list, result: ToolsClientResult, error: str) -> None:
    """Append stub tool_result messages for a list of tool_uses."""
    for tool_use in tool_uses:
        result.messages.append({
            "type": "tool_result",
            "tool_use_id": tool_use["id"],
            "content": json.dumps({"error": error}),
        })


def _stub_undispatched(tool_uses: list, result: ToolsClientResult, exc: BaseException) -> None:
    """Stub any tool_uses not yet in result.messages. Called on unexpected exceptions."""
    dispatched_ids = {m["tool_use_id"] for m in result.messages}
    _stub_tools(
        [t for t in tool_uses if t["id"] not in dispatched_ids],
        result,
        str(exc) or "Interrupted",
    )
