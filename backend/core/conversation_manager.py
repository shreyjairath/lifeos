"""Handles an incoming message end-to-end (flat session model).

Owns: session rotation, history, system prompt, SSE serialization, error handling.
Delegates the agentic loop to executor.run_loop.
"""
import json
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
from core.memory import (
    append_message, get_history, get_session_meta, rotate_session,
    update_session_meta, check_rotation,
)
from core.reflection_manager import run as reflection_run
from agent_executor import cancellation
from core import hooks
from agent_executor.executor import run_loop, prepare_messages, AgentAppendEvent


# ── Public API ────────────────────────────────────────────────────────────────

async def handle_message(
    session_id: str,
    message: str,
    config: dict,
) -> AsyncGenerator[str, None]:
    """Entry point for a user message. Yields SSE-formatted strings."""
    try:
        async for chunk in _handle_inner(session_id, message, config):
            yield chunk
    except Exception as e:
        import traceback
        err = traceback.format_exc()
        yield f"data: {json.dumps({'type': 'error', 'text': str(e), 'detail': err})}\n\n"
        bus.publish({"type": "error", "text": str(e)})


# ── Internal ──────────────────────────────────────────────────────────────────

async def _handle_inner(
    session_id: str,
    message: str,
    config: dict,
) -> AsyncGenerator[str, None]:
    should_rotate, reason = check_rotation(session_id, config)
    if should_rotate:
        old_session_id = session_id
        old_history = get_history(old_session_id)
        yield f"data: {json.dumps({'type': 'session_rotating', 'reason': reason})}\n\n"
        summary = await reflection_run(
            old_session_id, old_history,
            pending_user_message=message, config=config,
        )
        if summary:
            yield f"data: {json.dumps({'type': 'reflection', 'text': summary})}\n\n"
        session_id = rotate_session(old_session_id)
        yield f"data: {json.dumps({'type': 'session_rotated', 'session_id': session_id, 'reason': reason})}\n\n"
        await hooks.fire("on_session_rotate", old_session_id=old_session_id, new_session_id=session_id, reason=reason)

    cancellation.clear(session_id)
    await hooks.fire("on_agent_start", session_id=session_id, user_message=message)

    system_prompt = prepare_system_prompt(config, session_id)
    append_message(session_id, {"role": "user", "content": message})
    messages = prepare_messages(get_history(session_id))

    stopped = False
    async for event in run_loop(session_id, messages, system_prompt, config["model"]):
        if isinstance(event, AgentAppendEvent):
            append_message(session_id, {"role": event.role, "content": event.content})
        elif isinstance(event, LlmClientResponseEvent):
            update_session_meta(session_id, input_tokens=event.usage["input_tokens"])
            await hooks.fire("on_llm_response", session_id=session_id,
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

    await hooks.fire("on_agent_done", session_id=session_id, stopped=stopped)
    if stopped:
        yield f"data: {json.dumps({'type': 'stopped'})}\n\n"
    else:
        yield f"data: {json.dumps({'type': 'done'})}\n\n"


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
