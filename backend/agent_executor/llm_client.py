"""Thin async wrapper around the Anthropic streaming API.

Yields typed stream events. Callers handle serialization (SSE, JSON, etc.).
Swap this file to change LLM providers.
"""
import json
from collections.abc import AsyncGenerator
from dataclasses import dataclass, field

import anthropic

_client = anthropic.Anthropic()


# ── Result accumulator ────────────────────────────────────────────────────────

@dataclass
class LlmClientResult:
    full_text: str = ""
    parsed_tool_uses: list = field(default_factory=list)
    final_message: object = None
    stop_reason: str | None = None


# ── Stream events ─────────────────────────────────────────────────────────────

@dataclass
class LlmClientRequestEvent:
    model: str
    max_tokens: int
    message_count: int
    system: str

@dataclass
class LlmClientTextEvent:
    text: str

@dataclass
class LlmClientToolCallEvent:
    name: str
    input: dict

@dataclass
class LlmClientResponseEvent:
    stop_reason: str
    usage: dict
    content: list


LlmClientStreamEvent = LlmClientRequestEvent | LlmClientTextEvent | LlmClientToolCallEvent | LlmClientResponseEvent


# ── Public API ────────────────────────────────────────────────────────────────

async def stream_llm(
    model: str,
    system: str,
    messages: list,
    tools: list,
    result: LlmClientResult,
    max_tokens: int = 4096,
) -> AsyncGenerator[LlmClientStreamEvent, None]:
    """Stream a Claude response, yielding typed events and populating `result`."""
    tool_uses: list[dict] = []

    yield LlmClientRequestEvent(model=model, max_tokens=max_tokens, message_count=len(messages), system=system)

    with _client.messages.stream(model=model, system=system, tools=tools, messages=messages, max_tokens=max_tokens) as stream:
        for event in stream:
            if not hasattr(event, "type"):
                continue
            if event.type == "content_block_start":
                _on_block_start(event, tool_uses)
            elif event.type == "content_block_delta":
                ev = _on_block_delta(event, result, tool_uses)
                if ev:
                    yield ev
            elif event.type == "content_block_stop":
                ev = _on_block_stop(event, tool_uses)
                if ev:
                    yield ev

    yield _finalize(stream, result)


# ── Private helpers ───────────────────────────────────────────────────────────

def _on_block_start(event, tool_uses: list) -> None:
    cb = getattr(event, "content_block", None)
    if cb and cb.type == "tool_use":
        tool_uses.append({"id": cb.id, "name": cb.name, "input_str": "", "index": event.index})


def _on_block_delta(event, result: LlmClientResult, tool_uses: list) -> LlmClientTextEvent | None:
    delta = getattr(event, "delta", None)
    if not delta or not hasattr(delta, "type"):
        return None
    if delta.type == "text_delta":
        result.full_text += delta.text
        return LlmClientTextEvent(text=delta.text)
    if delta.type == "input_json_delta" and tool_uses:
        tool_uses[-1]["input_str"] += delta.partial_json
    return None


def _on_block_stop(event, tool_uses: list) -> LlmClientToolCallEvent | None:
    idx = getattr(event, "index", None)
    if idx is None:
        return None
    for tool_use in tool_uses:
        if tool_use.get("index") == idx:
            try:
                parsed = json.loads(tool_use["input_str"]) if tool_use["input_str"] else {}
            except json.JSONDecodeError:
                parsed = {}
            return LlmClientToolCallEvent(name=tool_use["name"], input=parsed)
    return None


def _finalize(stream, result: LlmClientResult) -> LlmClientResponseEvent:
    final = stream.get_final_message()
    result.final_message = final
    result.stop_reason = final.stop_reason
    result.parsed_tool_uses = [
        {"id": b.id, "name": b.name, "input": b.input}
        for b in final.content if b.type == "tool_use"
    ]
    return LlmClientResponseEvent(
        stop_reason=final.stop_reason,
        usage={"input_tokens": final.usage.input_tokens, "output_tokens": final.usage.output_tokens},
        content=[
            {"type": b.type, "text": b.text} if b.type == "text"
            else {"type": b.type, "id": b.id, "name": b.name, "input": b.input}
            for b in final.content
        ],
    )
