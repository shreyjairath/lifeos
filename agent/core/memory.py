"""Conversation history per session — persisted to data/conversations.json."""
import json
import threading
from pathlib import Path

_DATA_FILE = Path(__file__).parent.parent / "data" / "conversations.json"
_lock = threading.Lock()


def _load_all() -> dict[str, list[dict]]:
    if not _DATA_FILE.exists():
        return {}
    try:
        return json.loads(_DATA_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def _save_all(sessions: dict[str, list[dict]]) -> None:
    _DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    _DATA_FILE.write_text(json.dumps(sessions, ensure_ascii=False, indent=2), encoding="utf-8")


def get_history(session_id: str) -> list[dict]:
    with _lock:
        return list(_load_all().get(session_id, []))


def append_message(session_id: str, message: dict) -> None:
    with _lock:
        sessions = _load_all()
        sessions.setdefault(session_id, []).append(message)
        _save_all(sessions)


def clear_session(session_id: str) -> None:
    with _lock:
        sessions = _load_all()
        sessions.pop(session_id, None)
        _save_all(sessions)


def list_sessions() -> list[str]:
    with _lock:
        return list(_load_all().keys())
