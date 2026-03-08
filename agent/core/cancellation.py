"""Per-session cancellation tokens for the agent loop."""
import threading

_cancelled: set[str] = set()
_lock = threading.Lock()


def cancel(session_id: str) -> None:
    with _lock:
        _cancelled.add(session_id)


def is_cancelled(session_id: str) -> bool:
    with _lock:
        return session_id in _cancelled


def clear(session_id: str) -> None:
    with _lock:
        _cancelled.discard(session_id)
