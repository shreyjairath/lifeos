"""Session reflection: knowledge base update, session archive, conversation summary."""
import json
import time
from collections.abc import AsyncGenerator

import anthropic

from core import hooks
from core.memory import summaries_dir, get_conv_summary, write_conv_summary
from core.tools import TOOLS, dispatch_tool

_HAIKU_MODEL = "claude-haiku-4-5-20251001"

_REFLECT_TOOLS = [t for t in TOOLS if t["name"] in {
    "update_knowledge", "create_project", "update_project", "write_file", "update_file",
    "list_projects", "read_project",
    "add_project_file", "read_project_file", "update_project_file", "delete_project_file",
}]

_REFLECT_SYSTEM = """\
You are a memory agent. Review this conversation and persist any new, lasting information \
to the user's knowledge base or projects using your tools.

Persist:
- New facts about the user (values, preferences, context) → update_knowledge("identity")
- Routine or habit changes → update_knowledge("routines")
- New services or tools mentioned → update_knowledge("services") or update_knowledge("tools")
- Notes or documents the user wants saved → write_file / update_file

Additionally, for every project touched in this session (or any active project whose state changed):
1. Call list_projects to find relevant projects, then read_project to get current content.
2. Rewrite the `snapshot` section with the current state of the project as of this session.
3. Rewrite the `next_action` section with the clearest next step going forward.
4. If the project's background or constraints changed, rewrite `context` too.
These three sections are how continuity is maintained across sessions — always keep them current.

Only persist information that is genuinely new or changed. Skip anything already known.
After updating, respond with a short bullet list of what you saved. \
If nothing was worth persisting, respond with exactly: nothing to save.\
"""

_SUMMARIZE_SYSTEM = """\
Summarize this conversation session in 2-3 concise paragraphs for archival purposes.
Focus on: what was discussed, decisions made, open threads. Write in second person \
("You were discussing...", "The user asked..."). Be specific — include names, numbers, \
and concrete details. Omit small talk.\
"""

_CONV_SUMMARIZE_SYSTEM = """\
You maintain a running summary of an ongoing conversation between a user and their personal AI agent.
Given the current summary (if any) and a new session transcript, produce an updated summary that merges both.
Capture: topics discussed, decisions made, actions taken, open threads, and key facts or preferences revealed.
Write in second person ("You discussed...", "The user wants...").
Be specific — include names, numbers, dates, concrete details.
Aim for 3-6 paragraphs. Drop stale details that are no longer relevant. Omit small talk.\
"""


def build_transcript(history: list) -> str:
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
                    input_str = json.dumps(block.get("input", {}), ensure_ascii=False)
                    lines.append(f"TOOL CALL [{block['name']}]: {input_str}")
                elif btype == "tool_result":
                    content_val = block.get("content", "")
                    lines.append(f"TOOL RESULT: {content_val}")
    return "\n\n".join(lines)


async def kb_reflect(
    history: list, config: dict, conv_id: str = "", session_id: str = ""
) -> AsyncGenerator[str, None]:
    """Tier 1: persist new knowledge from session to knowledge base and projects."""
    transcript = build_transcript(history)
    if not transcript:
        return

    client = anthropic.Anthropic()
    messages = [{"role": "user", "content": "Conversation to reflect on:\n\n" + transcript}]

    response = client.messages.create(
        model=_HAIKU_MODEL,
        system=_REFLECT_SYSTEM,
        tools=_REFLECT_TOOLS,
        messages=messages,
        max_tokens=2048,
    )

    tool_results = []
    for block in response.content:
        if block.type == "tool_use":
            result = dispatch_tool(block.name, block.input, config)
            tool_results.append({"type": "tool_result", "tool_use_id": block.id, "content": json.dumps(result)})

    if tool_results:
        followup = client.messages.create(
            model=_HAIKU_MODEL,
            system=_REFLECT_SYSTEM,
            tools=_REFLECT_TOOLS,
            messages=messages + [
                {"role": "assistant", "content": response.content},
                {"role": "user", "content": tool_results},
            ],
            max_tokens=512,
        )
        summary = "".join(b.text for b in followup.content if hasattr(b, "text")).strip()
    else:
        summary = "".join(b.text for b in response.content if hasattr(b, "text")).strip()

    if summary and summary.lower() != "nothing to save":
        await hooks.fire("on_kb_reflect", conv_id=conv_id, session_id=session_id, summary=summary)
        yield f"data: {json.dumps({'type': 'reflection', 'text': summary})}\n\n"


def write_session_summary(conv_id: str, transcript: str) -> None:
    """Tier 2: archive session as a timestamped summary file."""
    try:
        client = anthropic.Anthropic()
        resp = client.messages.create(
            model=_HAIKU_MODEL,
            system=_SUMMARIZE_SYSTEM,
            messages=[{"role": "user", "content": transcript}],
            max_tokens=1024,
        )
        summary = "".join(b.text for b in resp.content if hasattr(b, "text")).strip()
        if summary:
            sdir = summaries_dir(conv_id)
            sdir.mkdir(parents=True, exist_ok=True)
            (sdir / f"{int(time.time())}.md").write_text(summary, encoding="utf-8")
    except Exception as e:
        import logging
        logging.getLogger(__name__).warning("Session summary failed: %s", e)


def update_conv_summary(conv_id: str, transcript: str) -> None:
    """Tier 3: merge session into the rolling conversation-level summary."""
    try:
        existing = get_conv_summary(conv_id)
        user_content = f"New session transcript:\n\n{transcript}"
        if existing:
            user_content = f"Existing summary:\n\n{existing}\n\n---\n\n{user_content}"
        client = anthropic.Anthropic()
        resp = client.messages.create(
            model=_HAIKU_MODEL,
            system=_CONV_SUMMARIZE_SYSTEM,
            messages=[{"role": "user", "content": user_content}],
            max_tokens=1024,
        )
        summary = "".join(b.text for b in resp.content if hasattr(b, "text")).strip()
        if summary:
            write_conv_summary(conv_id, summary)
    except Exception as e:
        import logging
        logging.getLogger(__name__).warning("Conv summary failed: %s", e)


async def rotation_reflect(
    conv_id: str,
    history: list,
    config: dict,
    pending_user_message: str = "",
    session_id: str = "",
) -> AsyncGenerator[str, None]:
    """Full 3-tier reflection at session rotation.

    pending_user_message: the user message that triggered rotation, not yet in
    history. Appended to the transcript so summaries capture what the user was
    about to say, giving the new session proper context.
    """
    transcript = build_transcript(history)
    if not transcript:
        return

    if pending_user_message:
        transcript += f"\n\nUSER (pending — triggered session rotation): {pending_user_message}"

    async for chunk in kb_reflect(history, config, conv_id=conv_id, session_id=session_id):
        yield chunk

    write_session_summary(conv_id, transcript)
    update_conv_summary(conv_id, transcript)
    await hooks.fire("on_reflection_done", conv_id=conv_id, session_id=session_id)
