"""Flat session model.

Data layout:
  .user-data/sessions/
    pointers.json          — {key: session_id} e.g. {"main": "session-abc"}
    {session_id}/
      meta.json            — {id, title, created_at, last_message_at, last_input_tokens, parent_session_id}
      messages.json        — list of message dicts (Anthropic format, with optional _ts)
      summary.md           — written at rotation by SessionSummarizer
"""
import json
import threading
import time
import uuid
from pathlib import Path

_USER_DATA = Path(__file__).parent.parent.parent / ".user-data"
_SESSIONS_ROOT = _USER_DATA / "sessions"
_POINTERS_FILE = _SESSIONS_ROOT / "pointers.json"
_lock = threading.Lock()


# ── Internal helpers ──────────────────────────────────────────────────────────

def _session_dir(session_id: str) -> Path:
    return _SESSIONS_ROOT / session_id

def _meta_path(session_id: str) -> Path:
    return _session_dir(session_id) / "meta.json"

def _messages_path(session_id: str) -> Path:
    return _session_dir(session_id) / "messages.json"

def _summary_path(session_id: str) -> Path:
    return _session_dir(session_id) / "summary.md"


def _load_pointers() -> dict:
    if not _POINTERS_FILE.exists():
        return {}
    try:
        return json.loads(_POINTERS_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def _save_pointers(pointers: dict) -> None:
    _POINTERS_FILE.parent.mkdir(parents=True, exist_ok=True)
    _POINTERS_FILE.write_text(json.dumps(pointers, indent=2), encoding="utf-8")


def _load_meta(session_id: str) -> dict:
    p = _meta_path(session_id)
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def _save_meta(session_id: str, meta: dict) -> None:
    p = _meta_path(session_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(meta, indent=2), encoding="utf-8")


def _load_messages(session_id: str) -> list:
    p = _messages_path(session_id)
    if not p.exists():
        return []
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []


def _save_messages(session_id: str, messages: list) -> None:
    p = _messages_path(session_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(messages, ensure_ascii=False, indent=2), encoding="utf-8")


def _new_session_id() -> str:
    return "session-" + uuid.uuid4().hex[:12]


def _title_from_messages(messages: list) -> str:
    for msg in messages:
        if msg.get("role") == "user":
            content = msg.get("content", "")
            if isinstance(content, str):
                text = content
            elif isinstance(content, list):
                text = " ".join(
                    b["text"] for b in content
                    if isinstance(b, dict) and b.get("type") == "text"
                )
            else:
                continue
            return text[:60].strip()
    return "New chat"


def _create_session(pointer_key: str = None, parent_session_id: str = None) -> str:
    """Create a new session, optionally linked to a pointer key and/or a parent session."""
    session_id = _new_session_id()
    meta = {
        "id": session_id,
        "title": "New chat",
        "created_at": time.time(),
        "last_message_at": None,
        "last_input_tokens": 0,
        "parent_session_id": parent_session_id,
    }
    _save_meta(session_id, meta)
    _save_messages(session_id, [])
    if pointer_key is not None:
        pointers = _load_pointers()
        pointers[pointer_key] = session_id
        _save_pointers(pointers)
    return session_id


# ── Public API ────────────────────────────────────────────────────────────────

def get_or_create_main() -> str:
    """Get or create the main session. Returns session_id."""
    with _lock:
        pointers = _load_pointers()
        session_id = pointers.get("main")
        if session_id and _meta_path(session_id).exists():
            return session_id
        return _create_session(pointer_key="main")


def get_or_create_for_project(project_name: str) -> str:
    """Get or create a session for a project. Returns session_id."""
    key = f"project-{project_name}"
    with _lock:
        pointers = _load_pointers()
        session_id = pointers.get(key)
        if session_id and _meta_path(session_id).exists():
            return session_id
        return _create_session(pointer_key=key)


def create_new_session() -> str:
    """Create a brand-new unkeyed session. Returns session_id."""
    with _lock:
        return _create_session()


def rotate_session(old_session_id: str) -> str:
    """Create a new session as a child of old_session_id. Updates any pointer that was pointing to old."""
    with _lock:
        new_session_id = _create_session(parent_session_id=old_session_id)
        pointers = _load_pointers()
        for key, sid in list(pointers.items()):
            if sid == old_session_id:
                pointers[key] = new_session_id
        _save_pointers(pointers)
        return new_session_id


def list_sessions() -> list[dict]:
    """Return all sessions sorted by created_at (oldest first)."""
    if not _SESSIONS_ROOT.exists():
        return []
    result = []
    for d in _SESSIONS_ROOT.iterdir():
        if not d.is_dir():
            continue
        meta = _load_meta(d.name)
        if not meta:
            continue
        result.append({
            "id": meta.get("id", d.name),
            "title": meta.get("title", "Untitled"),
            "created_at": meta.get("created_at", 0),
            "last_message_at": meta.get("last_message_at"),
        })
    return sorted(result, key=lambda x: x["created_at"])


def get_history(session_id: str) -> list:
    with _lock:
        return list(_load_messages(session_id))


def append_message(session_id: str, message: dict) -> None:
    with _lock:
        messages = _load_messages(session_id)
        message = dict(message)
        if "_ts" not in message:
            message["_ts"] = int(time.time())
        messages.append(message)
        _save_messages(session_id, messages)
        meta = _load_meta(session_id)
        if meta.get("title") == "New chat":
            meta["title"] = _title_from_messages(messages)
        meta["last_message_at"] = time.time()
        _save_meta(session_id, meta)


def clear_session(session_id: str) -> None:
    with _lock:
        _save_messages(session_id, [])


def truncate_session(session_id: str, from_index: int) -> int:
    with _lock:
        messages = _load_messages(session_id)[:from_index]
        _save_messages(session_id, messages)
        return len(messages)


def get_session_meta(session_id: str) -> dict:
    with _lock:
        return _load_meta(session_id)


def update_session_meta(session_id: str, input_tokens: int = 0) -> None:
    with _lock:
        meta = _load_meta(session_id)
        if not meta:
            return
        meta["last_message_at"] = time.time()
        meta["last_input_tokens"] = input_tokens
        _save_meta(session_id, meta)


def get_parent_summary(session_id: str) -> str:
    """Return the summary.md of this session's parent, if any."""
    meta = _load_meta(session_id)
    parent_id = meta.get("parent_session_id")
    if not parent_id:
        return ""
    p = _summary_path(parent_id)
    if not p.exists():
        return ""
    return p.read_text(encoding="utf-8").strip()


def write_session_summary(session_id: str, content: str) -> None:
    p = _summary_path(session_id)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")


def check_rotation(session_id: str, config: dict) -> tuple[bool, str]:
    cfg = config.get("session", {})
    token_threshold = cfg.get("token_threshold", 50_000)
    time_threshold_hours = cfg.get("time_threshold_hours", 4)

    meta = get_session_meta(session_id)
    if not meta:
        return False, ""

    if meta.get("last_input_tokens", 0) >= token_threshold:
        return True, f"context window ({meta['last_input_tokens']:,} input tokens)"

    last_msg = meta.get("last_message_at")
    if last_msg and (time.time() - last_msg) >= time_threshold_hours * 3600:
        hours = (time.time() - last_msg) / 3600
        return True, f"inactivity ({hours:.0f}h since last message)"

    return False, ""


def get_display_history(session_id: str) -> dict:
    """Return {session_id, messages (display format), total}."""
    history = get_history(session_id)
    display = []
    for i, msg in enumerate(history):
        role = msg.get("role", "")
        if role not in ("user", "assistant"):
            continue
        content = msg.get("content", "")
        ts = msg.get("_ts")
        if isinstance(content, str):
            display.append({"role": role, "text": content, "raw_index": i, "ts": ts})
        elif isinstance(content, list):
            text = " ".join(
                b["text"] for b in content
                if isinstance(b, dict) and b.get("type") == "text"
            )
            if text:
                display.append({"role": role, "text": text, "raw_index": i, "ts": ts})
    return {"session_id": session_id, "messages": display, "total": len(history)}
