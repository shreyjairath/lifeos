"""Filesystem tools — read/write files under .user-data/."""
from pathlib import Path

from core.events import bus

_USER_DATA = Path(__file__).parent.parent.parent / ".user-data"


def _resolve_safe(relative_path: str) -> Path:
    """Resolve path relative to .user-data/, raising if it escapes."""
    resolved = (_USER_DATA / relative_path).resolve()
    if not resolved.is_relative_to(_USER_DATA.resolve()):
        raise ValueError(f"Path '{relative_path}' escapes .user-data/.")
    return resolved


def write_file(path: str, content: str) -> dict:
    """Write content to a file under the project root, creating dirs as needed."""
    try:
        target = _resolve_safe(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        bus.publish({"type": "file_written", "path": path, "chars": len(content)})
        return {"written": path, "chars": len(content)}
    except ValueError as e:
        return {"error": str(e)}
    except OSError as e:
        return {"error": f"Could not write '{path}': {e}"}


def read_file(path: str) -> dict:
    """Read a file under the project root."""
    try:
        target = _resolve_safe(path)
        if not target.exists():
            return {"error": f"'{path}' does not exist."}
        if not target.is_file():
            return {"error": f"'{path}' is not a file."}
        content = target.read_text(encoding="utf-8")
        return {"path": path, "content": content}
    except ValueError as e:
        return {"error": str(e)}
    except OSError as e:
        return {"error": f"Could not read '{path}': {e}"}


def update_file(path: str, old_str: str, new_str: str) -> dict:
    """Replace a unique string in a file. Fails if old_str appears 0 or 2+ times."""
    try:
        target = _resolve_safe(path)
        if not target.exists():
            return {"error": f"'{path}' does not exist."}
        content = target.read_text(encoding="utf-8")
        count = content.count(old_str)
        if count == 0:
            return {"error": "old_str not found in file."}
        if count > 1:
            return {"error": f"old_str appears {count} times — provide more context to make it unique."}
        updated = content.replace(old_str, new_str, 1)
        target.write_text(updated, encoding="utf-8")
        bus.publish({"type": "file_written", "path": path, "chars": len(updated)})
        return {"updated": path, "chars": len(updated)}
    except ValueError as e:
        return {"error": str(e)}
    except OSError as e:
        return {"error": f"Could not update '{path}': {e}"}


def list_dir(path: str = ".") -> dict:
    """List contents of a directory under the project root."""
    try:
        target = _resolve_safe(path)
        if not target.exists():
            return {"error": f"'{path}' does not exist."}
        if not target.is_dir():
            return {"error": f"'{path}' is not a directory."}
        entries = []
        for entry in sorted(target.iterdir()):
            entries.append({
                "name": entry.name,
                "type": "dir" if entry.is_dir() else "file",
                "path": str(entry.relative_to(_USER_DATA)),
            })
        return {"path": path, "entries": entries}
    except ValueError as e:
        return {"error": str(e)}
    except OSError as e:
        return {"error": f"Could not list '{path}': {e}"}
