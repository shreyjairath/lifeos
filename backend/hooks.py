"""Agent lifecycle hooks.

Edit this file to react to agent events. All functions are async and optional —
remove or leave any of them as-is to skip. Errors here are caught and logged,
they will not crash the agent.
"""
import json
from datetime import datetime, timezone
from pathlib import Path

from core.events import bus

_LOG_DIR = Path(__file__).parent.parent / ".user-data" / "logs"


def _log(session_id: str, event: str, **fields):
    _LOG_DIR.mkdir(parents=True, exist_ok=True)
    entry = {"ts": datetime.now(timezone.utc).isoformat(), "event": event, **fields}
    path = _LOG_DIR / f"{session_id}.jsonl"
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")


async def on_agent_start(conv_id: str, session_id: str, user_message: str):
    """Called once when the agent begins processing a user message."""
    bus.publish({"type": "session_start", "session_id": session_id})
    _log(session_id, "agent_start", conv_id=conv_id, message_preview=user_message[:120])


async def on_agent_done(conv_id: str, session_id: str, stopped: bool):
    """Called when the agent finishes — naturally or via Stop."""
    bus.publish({"type": "session_end", "session_id": session_id, "stopped": stopped})
    _log(session_id, "agent_done", conv_id=conv_id, stopped=stopped)


async def on_llm_call(conv_id: str, session_id: str, message_count: int, model: str = ""):
    """Called before each Claude API request."""
    bus.publish({"type": "llm_request", "model": model, "messages": message_count})
    _log(session_id, "llm_call", conv_id=conv_id, message_count=message_count, model=model)


async def on_llm_response(conv_id: str, session_id: str, input_tokens: int, output_tokens: int, stop_reason: str):
    """Called after each Claude response streams in."""
    bus.publish({"type": "llm_response", "stop_reason": stop_reason,
                 "input_tokens": input_tokens, "output_tokens": output_tokens})
    _log(session_id, "llm_response", conv_id=conv_id,
         input_tokens=input_tokens, output_tokens=output_tokens, stop_reason=stop_reason)


async def on_session_rotate(conv_id: str, old_session_id: str, new_session_id: str, reason: str):
    """Called when a session rotates due to token limit or inactivity."""
    bus.publish({"type": "session_rotate", "session_id": old_session_id,
                 "new_session_id": new_session_id, "reason": reason})
    _log(old_session_id, "session_rotate", conv_id=conv_id,
         new_session_id=new_session_id, reason=reason)


async def on_kb_reflect(conv_id: str, session_id: str, summary: str):
    """Called after the knowledge-base reflection pass writes its summary."""
    bus.publish({"type": "reflection", "summary": summary})
    _log(session_id, "kb_reflect", conv_id=conv_id, summary_preview=summary[:200])


async def on_reflection_done(conv_id: str, session_id: str):
    """Called after all three reflection tiers have finished."""
    bus.publish({"type": "reflection_done", "session_id": session_id})
    _log(session_id, "reflection_done", conv_id=conv_id)
