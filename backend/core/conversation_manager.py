"""Conversation manager: handles an incoming message end-to-end.

Owns: session lifecycle, history setup, system prompt assembly, SSE serialization, error handling.
Delegates the agentic loop to executor.run_loop.
"""
import json
import time
from collections.abc import AsyncGenerator

from core.events import bus
from core.knowledge import prepare_system_prompt
from agent_executor.llm_client import (
    LlmClientRequestEvent, LlmClientTextEvent, LlmClientToolCallEvent, LlmClientResponseEvent,
)
from agent_executor.tools_client import (
    ToolsClientConfirmRequestEvent, ToolsClientConfirmDeniedEvent,
    ToolsClientResultEvent, ToolsClientCancelledEvent,
)
from core.memory import append_message, get_history, get_session_meta, new_session, update_session_meta
from core.reflection import rotation_reflect
from agent_executor import cancellation
from core import hooks
from agent_executor.executor import run_loop, prepare_messages, AgentAppendEvent


# ── Public API ────────────────────────────────────────────────────────────────

async def handle_message(
    conv_id: str,
    session_id: str,
    message: str,
    config: dict,
) -> AsyncGenerator[str, None]:
    """Entry point for a user message. Yields SSE-formatted strings."""
    try:
        async for chunk in _handle_inner(conv_id, session_id, message, config):
            yield chunk
    except Exception as e:
        import traceback
        err = traceback.format_exc()
        yield f"data: {json.dumps({'type': 'error', 'text': str(e), 'detail': err})}\n\n"
        bus.publish({"type": "error", "text": str(e)})


# ── Internal ──────────────────────────────────────────────────────────────────

async def _handle_inner(
    conv_id: str,
    session_id: str,
    message: str,
    config: dict,
) -> AsyncGenerator[str, None]:
    should_rotate, reason = _check_rotation(conv_id, session_id, config)
    if should_rotate:
        old_session_id = session_id
        old_history = get_history(conv_id, session_id)
        summary = await rotation_reflect(conv_id, old_history, pending_user_message=message, session_id=old_session_id)
        if summary:
            yield f"data: {json.dumps({'type': 'reflection', 'text': summary})}\n\n"
        session_id = new_session(conv_id)
        yield f"data: {json.dumps({'type': 'session_rotated', 'session_id': session_id, 'reason': reason})}\n\n"
        await hooks.fire("on_session_rotate", conv_id=conv_id, old_session_id=old_session_id, new_session_id=session_id, reason=reason)

    cancellation.clear(session_id)
    await hooks.fire("on_agent_start", conv_id=conv_id, session_id=session_id, user_message=message)

    system_prompt = prepare_system_prompt(config, conv_id)
    append_message(conv_id, session_id, {"role": "user", "content": message})
    messages = prepare_messages(get_history(conv_id, session_id))

    stopped = False
    async for event in run_loop(session_id, messages, system_prompt, config["model"]):
        if isinstance(event, AgentAppendEvent):
            append_message(conv_id, session_id, {"role": event.role, "content": event.content})
        elif isinstance(event, LlmClientResponseEvent):
            update_session_meta(conv_id, session_id, input_tokens=event.usage["input_tokens"])
            await hooks.fire("on_llm_response", conv_id=conv_id, session_id=session_id,
                             input_tokens=event.usage["input_tokens"],
                             output_tokens=event.usage["output_tokens"],
                             stop_reason=event.stop_reason)
        elif isinstance(event, ToolsClientCancelledEvent):
            stopped = True
        sse = _to_sse(event)
        if sse:
            yield sse

    if not stopped:
        stopped = cancellation.is_cancelled(session_id)

    await hooks.fire("on_agent_done", conv_id=conv_id, session_id=session_id, stopped=stopped)
    if stopped:
        yield f"data: {json.dumps({'type': 'stopped'})}\n\n"
    else:
        yield f"data: {json.dumps({'type': 'done'})}\n\n"


def _check_rotation(conv_id: str, session_id: str, config: dict) -> tuple[bool, str]:
    cfg = config.get("session", {})
    token_threshold = cfg.get("token_threshold", 50_000)
    time_threshold_hours = cfg.get("time_threshold_hours", 4)

    meta = get_session_meta(conv_id, session_id)
    if not meta:
        return False, ""

    if meta.get("last_input_tokens", 0) >= token_threshold:
        return True, f"context window ({meta['last_input_tokens']:,} input tokens)"

    last_msg = meta.get("last_message_at")
    if last_msg and (time.time() - last_msg) >= time_threshold_hours * 3600:
        hours = (time.time() - last_msg) / 3600
        return True, f"inactivity ({hours:.0f}h since last message)"

    return False, ""


def _to_sse(event) -> str:
    if isinstance(event, LlmClientRequestEvent):
        return f"data: {json.dumps({'type': 'request_json', 'payload': {'model': event.model, 'max_tokens': event.max_tokens, 'messages': event.message_count, 'system': event.system}})}\n\n"
    if isinstance(event, LlmClientTextEvent):
        return f"data: {json.dumps({'type': 'text', 'text': event.text})}\n\n"
    if isinstance(event, LlmClientToolCallEvent):
        return f"data: {json.dumps({'type': 'tool_call', 'name': event.name, 'input': event.input})}\n\n"
    if isinstance(event, LlmClientResponseEvent):
        return f"data: {json.dumps({'type': 'response_json', 'payload': {'stop_reason': event.stop_reason, 'usage': event.usage, 'content': event.content}})}\n\n"
    if isinstance(event, ToolsClientConfirmRequestEvent):
        return f"data: {json.dumps({'type': 'tool_confirm_request', 'request_id': event.request_id, 'name': event.name, 'input': event.input})}\n\n"
    if isinstance(event, ToolsClientConfirmDeniedEvent):
        return f"data: {json.dumps({'type': 'tool_confirm_denied', 'name': event.name})}\n\n"
    if isinstance(event, ToolsClientResultEvent):
        return f"data: {json.dumps({'type': 'tool_result', 'name': event.name, 'result': event.result})}\n\n"
    return ""
