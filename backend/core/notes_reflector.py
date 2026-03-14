"""NotesReflector: persists user knowledge to free-form notes at session rotation."""
import json

from agent_executor.executor import run_loop, AgentAppendEvent
from core.knowledge import load_prompt_part

_HAIKU_MODEL = "claude-haiku-4-5-20251001"

_NOTES_TOOLS = [
    {
        "name": "list_notes",
        "description": "List all note files in the notes directory.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "read_note",
        "description": "Read the content of a note file.",
        "input_schema": {
            "type": "object",
            "properties": {
                "filename": {"type": "string", "description": "Note filename, e.g. user.md"},
            },
            "required": ["filename"],
        },
    },
    {
        "name": "write_note",
        "description": "Write (create or overwrite) a note file.",
        "input_schema": {
            "type": "object",
            "properties": {
                "filename": {"type": "string", "description": "Note filename, e.g. user.md"},
                "content": {"type": "string", "description": "Full content to write"},
            },
            "required": ["filename", "content"],
        },
    },
    {
        "name": "delete_note",
        "description": "Delete a note file.",
        "input_schema": {
            "type": "object",
            "properties": {
                "filename": {"type": "string", "description": "Note filename to delete"},
            },
            "required": ["filename"],
        },
    },
]


async def run(history: list) -> str | None:
    """Review history and persist user knowledge to notes. Returns summary or None."""
    transcript = _build_transcript(history)
    if not transcript:
        return None

    prompt = load_prompt_part("reflect-notes.md")
    if not prompt:
        prompt = (
            "You are a memory agent. Review this conversation and persist any new, lasting "
            "information about the user using your tools.\n\n"
            "Use list_notes to see what files exist, then read_note to check current content before writing. "
            "Only write what is genuinely new or changed.\n\n"
            "After updating, respond with a short bullet list of what you saved. "
            "If nothing was worth persisting, respond with exactly: nothing to save"
        )

    messages = [{"role": "user", "content": "Conversation to reflect on:\n\n" + transcript}]
    summary = ""

    async for event in run_loop("_reflect_notes", messages, prompt, _HAIKU_MODEL, tools=_NOTES_TOOLS):
        if isinstance(event, AgentAppendEvent) and event.role == "assistant":
            summary = "".join(
                b["text"] for b in event.content
                if isinstance(b, dict) and b.get("type") == "text"
            )

    if summary and summary.strip().lower() != "nothing to save":
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
