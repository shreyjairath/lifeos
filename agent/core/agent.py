"""Core agent loop: Claude API with tool use and streaming."""
import json
import time
from collections.abc import AsyncGenerator

import anthropic

from core.events import bus
from core.knowledge import prepare_system_prompt
from core.memory import (
    append_message, get_history, get_session_meta, update_session_meta,
    new_session, summaries_dir, get_conv_summary, write_conv_summary,
)
from core.tools import TOOLS, dispatch_tool

_HAIKU_MODEL = "claude-haiku-4-5-20251001"

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

_REFLECT_TOOLS = [t for t in TOOLS if t["name"] in {
    "update_knowledge", "create_project", "update_project", "write_file", "update_file",
}]

_REFLECT_SYSTEM = """\
You are a memory agent. Review this conversation and persist any new, lasting information \
to the user's knowledge base or projects using your tools.

Persist:
- New facts about the user (values, preferences, context) → update_knowledge("identity")
- Routine or habit changes → update_knowledge("routines")
- New services or tools mentioned → update_knowledge("services") or update_knowledge("tools")
- Project progress or new projects → update_project / create_project
- Notes or documents the user wants saved → write_file / update_file

Only persist information that is genuinely new or changed. Skip anything already known.
After updating, respond with a short bullet list of what you saved. \
If nothing was worth persisting, respond with exactly: nothing to save.\
"""

def _prepare_messages(messages: list) -> list:
    """Pass full history, trimming only a leading orphaned tool_result if needed."""
    if not messages:
        return []
    window = list(messages)
    while window:
        content = window[0].get("content")
        if (isinstance(content, list) and
                any(isinstance(b, dict) and b.get("type") == "tool_result" for b in content)):
            window = window[1:]
        else:
            break
    return window


async def run_agent(
    conv_id: str,
    session_id: str,
    user_message: str,
    config: dict,
) -> AsyncGenerator[str, None]:
    """Run the agent for one user message. Yields SSE-formatted strings."""
    try:
        async for chunk in _run_agent_inner(conv_id, session_id, user_message, config):
            yield chunk
    except Exception as e:
        import traceback
        err = traceback.format_exc()
        yield f"data: {json.dumps({'type': 'error', 'text': str(e), 'detail': err})}\n\n"
        bus.publish({"type": "error", "text": str(e)})


def _check_rotation(conv_id: str, session_id: str, config: dict) -> tuple[bool, str]:
    cfg = config.get("session", {})
    token_threshold = cfg.get("token_threshold", 50_000)
    time_threshold_hours = cfg.get("time_threshold_hours", 4)

    meta = get_session_meta(conv_id, session_id)
    if not meta:
        return False, ""

    if meta.get("total_tokens", 0) >= token_threshold:
        return True, f"token threshold ({token_threshold:,} tokens)"

    last_msg = meta.get("last_message_at")
    if last_msg and (time.time() - last_msg) >= time_threshold_hours * 3600:
        hours = (time.time() - last_msg) / 3600
        return True, f"inactivity ({hours:.0f}h since last message)"

    return False, ""


async def _run_agent_inner(
    conv_id: str,
    session_id: str,
    user_message: str,
    config: dict,
) -> AsyncGenerator[str, None]:
    # Check if session should be rotated
    should_rotate, reason = _check_rotation(conv_id, session_id, config)
    if should_rotate:
        old_history = get_history(conv_id, session_id)
        bus.publish({"type": "session_rotate", "session_id": session_id, "reason": reason})
        async for chunk in _rotation_reflect(conv_id, old_history, config):
            yield chunk
        session_id = new_session(conv_id)
        yield f"data: {json.dumps({'type': 'session_rotated', 'session_id': session_id, 'reason': reason})}\n\n"

    bus.publish({"type": "session_start", "session_id": session_id})
    client = anthropic.Anthropic()

    system_prompt = prepare_system_prompt(config, conv_id)

    append_message(conv_id, session_id, {"role": "user", "content": user_message})
    messages = _prepare_messages(get_history(conv_id, session_id))

    while True:
        full_text = ""
        tool_uses = []
        stop_reason = None

        request_payload = {
            "model": config["model"],
            "max_tokens": 4096,
            "system": system_prompt,
            "tools": TOOLS,
            "messages": messages,
        }
        yield f"data: {json.dumps({'type': 'request_json', 'payload': request_payload})}\n\n"
        bus.publish({"type": "llm_request", "model": config["model"], "messages": len(messages)})

        with client.messages.stream(
            model=config["model"],
            system=system_prompt,
            tools=TOOLS,
            messages=messages,
            max_tokens=4096,
        ) as stream:
            for event in stream:
                if hasattr(event, "type"):
                    if event.type == "content_block_start":
                        if hasattr(event, "content_block") and event.content_block.type == "tool_use":
                            tool_uses.append({
                                "id": event.content_block.id,
                                "name": event.content_block.name,
                                "input_str": "",
                                "index": event.index,
                            })
                    elif event.type == "content_block_delta":
                        delta = event.delta
                        if hasattr(delta, "type"):
                            if delta.type == "text_delta":
                                full_text += delta.text
                                yield f"data: {json.dumps({'type': 'text', 'text': delta.text})}\n\n"
                            elif delta.type == "input_json_delta":
                                if tool_uses:
                                    tool_uses[-1]["input_str"] += delta.partial_json
                    elif event.type == "content_block_stop":
                        idx = getattr(event, "index", None)
                        if idx is not None:
                            matching = [tu for tu in tool_uses if tu.get("index") == idx]
                            if matching:
                                tu = matching[-1]
                                try:
                                    parsed_input = json.loads(tu["input_str"]) if tu["input_str"] else {}
                                except json.JSONDecodeError:
                                    parsed_input = {}
                                yield f"data: {json.dumps({'type': 'tool_call', 'name': tu['name'], 'input': parsed_input})}\n\n"
                    elif event.type == "message_delta":
                        if hasattr(event, "delta") and hasattr(event.delta, "stop_reason"):
                            stop_reason = event.delta.stop_reason

        final_message = stream.get_final_message()
        stop_reason = final_message.stop_reason

        response_payload = {
            "stop_reason": final_message.stop_reason,
            "usage": {
                "input_tokens": final_message.usage.input_tokens,
                "output_tokens": final_message.usage.output_tokens,
            },
            "content": [
                {"type": block.type, "text": block.text} if block.type == "text"
                else {"type": block.type, "id": block.id, "name": block.name, "input": block.input}
                for block in final_message.content
            ],
        }
        yield f"data: {json.dumps({'type': 'response_json', 'payload': response_payload})}\n\n"
        turn_tokens = final_message.usage.input_tokens + final_message.usage.output_tokens
        bus.publish({"type": "llm_response", "stop_reason": stop_reason, "input_tokens": final_message.usage.input_tokens, "output_tokens": final_message.usage.output_tokens})
        update_session_meta(conv_id, session_id, tokens_delta=turn_tokens)

        assistant_content = []
        if full_text:
            assistant_content.append({"type": "text", "text": full_text})

        parsed_tool_uses = []
        for block in final_message.content:
            if block.type == "tool_use":
                parsed_tool_uses.append({"id": block.id, "name": block.name, "input": block.input})
                assistant_content.append({"type": "tool_use", "id": block.id, "name": block.name, "input": block.input})
                bus.publish({"type": "tool_use", "name": block.name, "input": block.input})

        append_message(conv_id, session_id, {"role": "assistant", "content": assistant_content})
        messages = _prepare_messages(get_history(conv_id, session_id))

        if stop_reason != "tool_use" or not parsed_tool_uses:
            break

        tool_results = []
        for tu in parsed_tool_uses:
            bus.publish({"type": "tool_call", "name": tu["name"], "input": tu["input"]})
            result = dispatch_tool(tu["name"], tu["input"], config)
            yield f"data: {json.dumps({'type': 'tool_result', 'name': tu['name'], 'result': result})}\n\n"
            bus.publish({"type": "tool_result", "name": tu["name"], "result": result})
            tool_results.append({"type": "tool_result", "tool_use_id": tu["id"], "content": json.dumps(result)})

        append_message(conv_id, session_id, {"role": "user", "content": tool_results})
        messages = _prepare_messages(get_history(conv_id, session_id))

    bus.publish({"type": "session_end", "session_id": session_id})
    yield f"data: {json.dumps({'type': 'done'})}\n\n"


def _build_transcript(history: list) -> str:
    lines = []
    for msg in history:
        role = msg.get("role", "")
        content = msg.get("content", "")
        if isinstance(content, str):
            lines.append(f"{role.upper()}: {content}")
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    lines.append(f"{role.upper()}: {block['text']}")
    return "\n\n".join(lines)


async def _rotation_reflect(
    conv_id: str,
    history: list,
    config: dict,
) -> AsyncGenerator[str, None]:
    """Full 3-tier reflection at session rotation: KB update, session archive, conv summary."""
    transcript = _build_transcript(history)
    if not transcript:
        return

    # Tier 1: knowledge base update (same as per-turn reflection)
    async for chunk in _reflect(history, config):
        yield chunk

    # Tiers 2 & 3: session archive + rolling conversation summary
    try:
        client = anthropic.Anthropic()

        # Tier 2: archive this session as a timestamped file
        session_resp = client.messages.create(
            model=_HAIKU_MODEL,
            system=_SUMMARIZE_SYSTEM,
            messages=[{"role": "user", "content": transcript}],
            max_tokens=1024,
        )
        session_summary = "".join(b.text for b in session_resp.content if hasattr(b, "text")).strip()
        if session_summary:
            sdir = summaries_dir(conv_id)
            sdir.mkdir(parents=True, exist_ok=True)
            (sdir / f"{int(time.time())}.md").write_text(session_summary, encoding="utf-8")
            bus.publish({"type": "session_summary_written", "chars": len(session_summary)})

        # Tier 3: update rolling conversation-level summary
        existing = get_conv_summary(conv_id)
        user_content = f"New session transcript:\n\n{transcript}"
        if existing:
            user_content = f"Existing summary:\n\n{existing}\n\n---\n\n{user_content}"
        conv_resp = client.messages.create(
            model=_HAIKU_MODEL,
            system=_CONV_SUMMARIZE_SYSTEM,
            messages=[{"role": "user", "content": user_content}],
            max_tokens=1024,
        )
        conv_summary = "".join(b.text for b in conv_resp.content if hasattr(b, "text")).strip()
        if conv_summary:
            write_conv_summary(conv_id, conv_summary)
            bus.publish({"type": "conv_summary_updated", "chars": len(conv_summary)})
    except Exception as e:
        bus.publish({"type": "error", "text": f"Rotation reflection failed: {e}"})


async def _reflect(history: list, config: dict) -> AsyncGenerator[str, None]:
    transcript = _build_transcript(history)
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
            bus.publish({"type": "tool_result", "name": block.name, "result": result})
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
        bus.publish({"type": "reflection", "summary": summary})
        yield f"data: {json.dumps({'type': 'reflection', 'text': summary})}\n\n"
