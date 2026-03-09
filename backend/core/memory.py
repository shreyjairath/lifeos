"""Conversation and session management.

Data layout:
  .user-data/conversations/{conv_id}/
    meta.json          — name, project_name, created_at, sessions[], current_session, session_meta{}
    sessions/
      {session_id}.json — message list
    summaries/
      {timestamp}.md   — session summaries (most recent N loaded into system prompt)
"""
import json
import threading
import time
import uuid
from pathlib import Path

_USER_DATA = Path(__file__).parent.parent.parent / ".user-data"
_CONV_ROOT = _USER_DATA / "conversations"
_lock = threading.Lock()


# ── Internal helpers ──────────────────────────────────────────────────────────

def _conv_dir(conv_id: str) -> Path:
    return _CONV_ROOT / conv_id

def _meta_path(conv_id: str) -> Path:
    return _conv_dir(conv_id) / "meta.json"

def _session_path(conv_id: str, session_id: str) -> Path:
    return _conv_dir(conv_id) / "sessions" / f"{session_id}.json"

def summaries_dir(conv_id: str) -> Path:
    return _conv_dir(conv_id) / "summaries"


def _load_meta(conv_id: str) -> dict:
    p = _meta_path(conv_id)
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def _save_meta(conv_id: str, meta: dict) -> None:
    p = _meta_path(conv_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(meta, indent=2), encoding="utf-8")


def _load_session(conv_id: str, session_id: str) -> list:
    p = _session_path(conv_id, session_id)
    if not p.exists():
        return []
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []


def _save_session(conv_id: str, session_id: str, messages: list) -> None:
    p = _session_path(conv_id, session_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(messages, ensure_ascii=False, indent=2), encoding="utf-8")


def _new_session_id() -> str:
    return "session-" + uuid.uuid4().hex[:12]


def _new_conv_id() -> str:
    return "conv-" + uuid.uuid4().hex[:12]


# ── Public API ────────────────────────────────────────────────────────────────

def get_or_create_main() -> tuple[str, str]:
    """Get or create the single main conversation. Returns (conv_id, session_id)."""
    return get_or_create_for_project("__main__")


def create_conversation(name: str, project_name: str = "") -> tuple[str, str]:
    """Create a new conversation with an initial session. Returns (conv_id, session_id)."""
    with _lock:
        conv_id = _new_conv_id()
        session_id = _new_session_id()
        meta = {
            "name": name,
            "project_name": project_name,
            "created_at": time.time(),
            "sessions": [session_id],
            "current_session": session_id,
            "session_meta": {},
        }
        _save_meta(conv_id, meta)
        _save_session(conv_id, session_id, [])
        return conv_id, session_id


def get_or_create_for_project(project_name: str) -> tuple[str, str]:
    """Find an existing conversation for a project, or create one. Returns (conv_id, session_id)."""
    with _lock:
        if _CONV_ROOT.exists():
            for conv_dir in sorted(_CONV_ROOT.iterdir()):
                if not conv_dir.is_dir():
                    continue
                try:
                    meta = json.loads((conv_dir / "meta.json").read_text(encoding="utf-8"))
                    if meta.get("project_name") == project_name:
                        conv_id = conv_dir.name
                        session_id = meta.get("current_session") or meta["sessions"][-1]
                        return conv_id, session_id
                except (json.JSONDecodeError, OSError, KeyError):
                    pass
        # Create new
        conv_id = _new_conv_id()
        session_id = _new_session_id()
        meta = {
            "name": project_name,
            "project_name": project_name,
            "created_at": time.time(),
            "sessions": [session_id],
            "current_session": session_id,
            "session_meta": {},
        }
        _save_meta(conv_id, meta)
        _save_session(conv_id, session_id, [])
        return conv_id, session_id


def list_conversations() -> list[dict]:
    """Return all conversations sorted by creation time (oldest first)."""
    if not _CONV_ROOT.exists():
        return []
    result = []
    for conv_dir in _CONV_ROOT.iterdir():
        if not conv_dir.is_dir():
            continue
        meta = _load_meta(conv_dir.name)
        if not meta:
            continue
        result.append({
            "id": conv_dir.name,
            "name": meta.get("name", conv_dir.name),
            "project_name": meta.get("project_name", ""),
            "created_at": meta.get("created_at", 0),
            "current_session": meta.get("current_session", ""),
        })
    return sorted(result, key=lambda x: x["created_at"])


def get_history(conv_id: str, session_id: str) -> list[dict]:
    with _lock:
        return list(_load_session(conv_id, session_id))


def append_message(conv_id: str, session_id: str, message: dict) -> None:
    with _lock:
        messages = _load_session(conv_id, session_id)
        messages.append(message)
        _save_session(conv_id, session_id, messages)


def new_session(conv_id: str) -> str:
    """Create a new session within an existing conversation. Returns session_id."""
    with _lock:
        session_id = _new_session_id()
        meta = _load_meta(conv_id)
        meta.setdefault("sessions", []).append(session_id)
        meta["current_session"] = session_id
        _save_meta(conv_id, meta)
        _save_session(conv_id, session_id, [])
        return session_id


def clear_session(conv_id: str, session_id: str) -> None:
    with _lock:
        _save_session(conv_id, session_id, [])


def truncate_session(conv_id: str, session_id: str, from_index: int) -> int:
    with _lock:
        messages = _load_session(conv_id, session_id)[:from_index]
        _save_session(conv_id, session_id, messages)
        return len(messages)


def get_session_meta(conv_id: str, session_id: str) -> dict:
    with _lock:
        return _load_meta(conv_id).get("session_meta", {}).get(session_id, {})


def update_session_meta(conv_id: str, session_id: str, input_tokens: int = 0) -> None:
    with _lock:
        meta = _load_meta(conv_id)
        entry = meta.setdefault("session_meta", {}).setdefault(session_id, {
            "created_at": time.time(),
        })
        entry["last_message_at"] = time.time()
        entry["last_input_tokens"] = input_tokens
        _save_meta(conv_id, meta)


def get_conv_summary(conv_id: str) -> str:
    p = _conv_dir(conv_id) / "summary.md"
    if not p.exists():
        return ""
    return p.read_text(encoding="utf-8").strip()


def write_conv_summary(conv_id: str, content: str) -> None:
    p = _conv_dir(conv_id) / "summary.md"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")


_DISPLAY_SESSIONS = 3


def get_all_display_history(conv_id: str) -> dict:
    """Return the last _DISPLAY_SESSIONS sessions as full messages.

    If older sessions exist, includes the rolling conv summary so the frontend
    can render a collapsed history card instead of loading all raw messages.
    """
    meta = _load_meta(conv_id)
    current_session = meta.get("current_session", "")
    sessions = meta.get("sessions", [])

    truncated = max(0, len(sessions) - _DISPLAY_SESSIONS)
    visible = sessions[truncated:]

    result = []
    for sid in visible:
        messages = _load_session(conv_id, sid)
        display = []
        for i, msg in enumerate(messages):
            if msg["role"] in ("user", "assistant"):
                content = msg["content"]
                if isinstance(content, str):
                    display.append({"role": msg["role"], "text": content, "raw_index": i})
                elif isinstance(content, list):
                    text = " ".join(
                        b["text"] for b in content
                        if isinstance(b, dict) and b.get("type") == "text"
                    )
                    if text:
                        display.append({"role": msg["role"], "text": text, "raw_index": i})
        result.append({
            "session_id": sid,
            "is_current": sid == current_session,
            "total": len(messages),
            "messages": display,
        })

    response = {"sessions": result, "current_session": current_session, "truncated_sessions": truncated}
    if truncated > 0:
        response["conv_summary"] = get_conv_summary(conv_id)
    return response


def get_display_history(conv_id: str, session_id: str) -> tuple[list[dict], int]:
    """Return (display_messages_with_raw_index, total_raw_count)."""
    history = get_history(conv_id, session_id)
    display = []
    for i, msg in enumerate(history):
        if msg["role"] in ("user", "assistant"):
            content = msg["content"]
            if isinstance(content, str):
                display.append({"role": msg["role"], "text": content, "raw_index": i})
            elif isinstance(content, list):
                text = " ".join(
                    b["text"] for b in content
                    if isinstance(b, dict) and b.get("type") == "text"
                )
                if text:
                    display.append({"role": msg["role"], "text": text, "raw_index": i})
    return display, len(history)
