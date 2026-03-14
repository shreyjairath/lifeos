"""ProjectsReflector: updates project files at session rotation (disabled by default)."""
import json

from agent_executor.executor import run_loop, AgentAppendEvent
from agent_executor.tools_registry import TOOLS
from core.knowledge import load_prompt_part

_HAIKU_MODEL = "claude-haiku-4-5-20251001"

_PROJECT_TOOL_NAMES = {
    "create_project", "list_projects", "update_project", "read_project",
    "add_project_file", "read_project_file", "update_project_file", "delete_project_file",
}

_PROJECT_TOOLS = [t for t in TOOLS if t["name"] in _PROJECT_TOOL_NAMES]


async def run(history: list) -> str | None:
    """Review history and update project state. Returns summary or None."""
    transcript = _build_transcript(history)
    if not transcript:
        return None

    prompt = load_prompt_part("reflect-projects.md")
    if not prompt:
        prompt = (
            "You are a project manager agent. Review this conversation and update any active projects "
            "using your tools. For each project touched in this session:\n"
            "1. Call list_projects then read_project to get current state.\n"
            "2. Rewrite the snapshot section with current state.\n"
            "3. Rewrite the next_action section with the clearest next step.\n"
            "Only update projects where something genuinely changed. "
            "After updating, respond with a short bullet list. "
            "If nothing changed, respond with exactly: nothing to update"
        )

    messages = [{"role": "user", "content": "Conversation to reflect on:\n\n" + transcript}]
    summary = ""

    async for event in run_loop("_reflect_projects", messages, prompt, _HAIKU_MODEL, tools=_PROJECT_TOOLS):
        if isinstance(event, AgentAppendEvent) and event.role == "assistant":
            summary = "".join(
                b["text"] for b in event.content
                if isinstance(b, dict) and b.get("type") == "text"
            )

    if summary and summary.strip().lower() not in ("nothing to update", "nothing to save"):
        return summary.strip()
    return None


def _build_transcript(history: list) -> str:
    lines = []
    for msg in history:
        role = msg.get("role", "")
        content = msg.get("content", "")
        if isinstance(content, str):
            lines.append(f"{role.upper()}: {content}")
        elif isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                btype = block.get("type")
                if btype == "text":
                    lines.append(f"{role.upper()}: {block['text']}")
                elif btype == "tool_use":
                    lines.append(f"TOOL CALL [{block['name']}]: {json.dumps(block.get('input', {}))}")
                elif btype == "tool_result":
                    lines.append(f"TOOL RESULT: {block.get('content', '')}")
    return "\n\n".join(lines)
