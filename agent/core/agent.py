"""Core agent loop: Claude API with tool use and streaming."""
import json
from collections.abc import AsyncGenerator

import anthropic

from core.knowledge import load_knowledge_base
from core.memory import append_message, get_history
from core.tools import TOOLS, dispatch_tool

_MAX_HISTORY = 10


def _prepare_messages(messages: list) -> list:
    """Strip historical tool cycles, preserve current tail, keep last N turns.

    The 'current tail' is the live assistant+tool_results pair at the end of
    history that the next API call needs to see. Everything before it has its
    tool_use/tool_result blocks stripped so past cycles don't bloat the context.
    """
    if not messages:
        return []

    # Peel off the current tool cycle from the tail (if present)
    tail = []
    rest = list(messages)

    last = rest[-1]
    if (isinstance(last.get("content"), list) and
            any(isinstance(b, dict) and b.get("type") == "tool_result"
                for b in last["content"])):
        tail = [rest.pop()]
        if rest and rest[-1].get("role") == "assistant":
            tail = [rest.pop()] + tail

    # Strip tool cycles from the remaining history
    clean = []
    for msg in rest:
        content = msg.get("content")
        if isinstance(content, list):
            filtered = [b for b in content
                        if isinstance(b, dict)
                        and b.get("type") not in ("tool_use", "tool_result")]
            if not filtered:
                continue
            msg = {**msg, "content": filtered}
        clean.append(msg)

    # Window the clean history, reserving slots for the tail
    window = clean[-(max(1, _MAX_HISTORY - len(tail))):]
    return window + tail


async def run_agent(
    session_id: str,
    user_message: str,
    config: dict,
) -> AsyncGenerator[str, None]:
    """
    Run the agent for one user message.
    Yields SSE-formatted strings: 'data: ...\n\n'
    """
    client = anthropic.Anthropic()
    system_prompt = load_knowledge_base(config)

    # Add user message to history
    append_message(session_id, {"role": "user", "content": user_message})
    messages = _prepare_messages(get_history(session_id))

    # Agentic loop
    while True:
        # Stream the response
        full_text = ""
        tool_uses = []
        stop_reason = None

        # Emit the exact request payload before each API call
        request_payload = {
            "model": config["model"],
            "max_tokens": 4096,
            "system": system_prompt,
            "tools": TOOLS,
            "messages": messages,
        }
        yield f"data: {json.dumps({'type': 'request_json', 'payload': request_payload})}\n\n"

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
                    elif event.type == "message_delta":
                        if hasattr(event, "delta") and hasattr(event.delta, "stop_reason"):
                            stop_reason = event.delta.stop_reason

        # Get the final message to extract content blocks properly
        final_message = stream.get_final_message()
        stop_reason = final_message.stop_reason

        # Emit response payload for inspector
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

        # Build assistant message content
        assistant_content = []
        if full_text:
            assistant_content.append({"type": "text", "text": full_text})

        # Parse tool use inputs from the final message
        parsed_tool_uses = []
        for block in final_message.content:
            if block.type == "tool_use":
                parsed_tool_uses.append({
                    "id": block.id,
                    "name": block.name,
                    "input": block.input,
                })
                assistant_content.append({
                    "type": "tool_use",
                    "id": block.id,
                    "name": block.name,
                    "input": block.input,
                })

        # Save assistant turn
        append_message(session_id, {"role": "assistant", "content": assistant_content})
        messages = _prepare_messages(get_history(session_id))

        if stop_reason != "tool_use" or not parsed_tool_uses:
            break

        # Execute tools and build tool_result messages
        tool_results = []
        for tu in parsed_tool_uses:
            yield f"data: {json.dumps({'type': 'tool_call', 'name': tu['name'], 'input': tu['input']})}\n\n"
            result = dispatch_tool(tu["name"], tu["input"], config)
            yield f"data: {json.dumps({'type': 'tool_result', 'name': tu['name'], 'result': result})}\n\n"
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": tu["id"],
                "content": json.dumps(result),
            })

        append_message(session_id, {"role": "user", "content": tool_results})
        messages = _prepare_messages(get_history(session_id))

    yield f"data: {json.dumps({'type': 'done'})}\n\n"
