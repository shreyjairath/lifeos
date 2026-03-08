"""Core agent loop: Claude API with tool use and streaming."""
import json
import time
from collections.abc import AsyncGenerator

import anthropic

from core.events import bus
from core.knowledge import prepare_system_prompt
from core.memory import (
    append_message, get_history, get_session_meta, update_session_meta,
    new_session,
)
from core.reflection import rotation_reflect
from core.tools import TOOLS, dispatch_tool
from core import confirmations, cancellation, hooks

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

    if meta.get("last_input_tokens", 0) >= token_threshold:
        return True, f"context window ({meta['last_input_tokens']:,} input tokens)"

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
        old_session_id = session_id
        old_history = get_history(conv_id, session_id)
        async for chunk in rotation_reflect(conv_id, old_history, config, pending_user_message=user_message, session_id=old_session_id):
            yield chunk
        session_id = new_session(conv_id)
        yield f"data: {json.dumps({'type': 'session_rotated', 'session_id': session_id, 'reason': reason})}\n\n"
        await hooks.fire("on_session_rotate", conv_id=conv_id, old_session_id=old_session_id, new_session_id=session_id, reason=reason)

    cancellation.clear(session_id)
    await hooks.fire("on_agent_start", conv_id=conv_id, session_id=session_id, user_message=user_message)
    client = anthropic.Anthropic()

    system_prompt = prepare_system_prompt(config, conv_id)

    append_message(conv_id, session_id, {"role": "user", "content": user_message})
    messages = _prepare_messages(get_history(conv_id, session_id))

    while True:
        if cancellation.is_cancelled(session_id):
            yield f"data: {json.dumps({'type': 'stopped'})}\n\n"
            break

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
        await hooks.fire("on_llm_call", conv_id=conv_id, session_id=session_id, message_count=len(messages), model=config["model"])

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
        update_session_meta(conv_id, session_id, input_tokens=final_message.usage.input_tokens)
        await hooks.fire("on_llm_response", conv_id=conv_id, session_id=session_id,
                         input_tokens=final_message.usage.input_tokens,
                         output_tokens=final_message.usage.output_tokens,
                         stop_reason=stop_reason)

        assistant_content = []
        if full_text:
            assistant_content.append({"type": "text", "text": full_text})

        parsed_tool_uses = []
        for block in final_message.content:
            if block.type == "tool_use":
                parsed_tool_uses.append({"id": block.id, "name": block.name, "input": block.input})
                assistant_content.append({"type": "tool_use", "id": block.id, "name": block.name, "input": block.input})

        append_message(conv_id, session_id, {"role": "assistant", "content": assistant_content})
        messages = _prepare_messages(get_history(conv_id, session_id))

        if stop_reason != "tool_use" or not parsed_tool_uses:
            break

        tool_results = []
        try:
            for i, tu in enumerate(parsed_tool_uses):
                if cancellation.is_cancelled(session_id):
                    # Stub out all remaining tool uses so history stays valid
                    for remaining in parsed_tool_uses[i:]:
                        tool_results.append({
                            "type": "tool_result",
                            "tool_use_id": remaining["id"],
                            "content": json.dumps({"error": "Cancelled by user"}),
                        })
                    append_message(conv_id, session_id, {"role": "user", "content": tool_results})
                    await hooks.fire("on_agent_done", conv_id=conv_id, session_id=session_id, stopped=True)
                    yield f"data: {json.dumps({'type': 'stopped'})}\n\n"
                    return

                # on_pre_tool hook — return a dict to override execution
                override = await hooks.fire("on_pre_tool", conv_id=conv_id, session_id=session_id, tool_name=tu["name"], tool_input=tu["input"])
                if isinstance(override, dict):
                    result = override
                elif confirmations.is_gated(tu["name"]):
                    req_id = confirmations.register()
                    yield f"data: {json.dumps({'type': 'tool_confirm_request', 'request_id': req_id, 'name': tu['name'], 'input': tu['input']})}\n\n"
                    approved = await confirmations.wait_for(req_id)
                    if not approved:
                        result = {"error": f"User denied execution of {tu['name']}"}
                        yield f"data: {json.dumps({'type': 'tool_confirm_denied', 'name': tu['name']})}\n\n"
                    else:
                        result = dispatch_tool(tu["name"], tu["input"], config)
                else:
                    result = dispatch_tool(tu["name"], tu["input"], config)

                await hooks.fire("on_post_tool", conv_id=conv_id, session_id=session_id, tool_name=tu["name"], tool_input=tu["input"], result=result)
                yield f"data: {json.dumps({'type': 'tool_result', 'name': tu['name'], 'result': result})}\n\n"
                tool_results.append({"type": "tool_result", "tool_use_id": tu["id"], "content": json.dumps(result)})
        except Exception as exc:
            # Stub any tool_uses that didn't get results so history stays valid
            dispatched_ids = {r["tool_use_id"] for r in tool_results}
            for tu in parsed_tool_uses:
                if tu["id"] not in dispatched_ids:
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": tu["id"],
                        "content": json.dumps({"error": str(exc)}),
                    })
            append_message(conv_id, session_id, {"role": "user", "content": tool_results})
            raise

        append_message(conv_id, session_id, {"role": "user", "content": tool_results})
        messages = _prepare_messages(get_history(conv_id, session_id))

    stopped = cancellation.is_cancelled(session_id)
    await hooks.fire("on_agent_done", conv_id=conv_id, session_id=session_id, stopped=stopped)
    yield f"data: {json.dumps({'type': 'done'})}\n\n"
