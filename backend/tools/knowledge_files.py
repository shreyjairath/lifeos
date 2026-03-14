"""Free-form notes tools — list, read, write, delete, grep notes in .user-data/knowledge/notes/."""
import re
from pathlib import Path

from core.events import bus

_USER_DATA = Path(__file__).parent.parent.parent / ".user-data"
NOTES_DIR = _USER_DATA / "knowledge" / "notes"

_SAFE_NAME = re.compile(r"^[a-zA-Z0-9._-]+\.md$")


def _validate_name(filename: str) -> str | None:
    """Return error string if invalid, else None."""
    if not _SAFE_NAME.match(filename):
        return f"Invalid filename '{filename}'. Use only letters, digits, dots, dashes, underscores, ending in .md"
    return None


def list_notes() -> dict:
    if not NOTES_DIR.exists():
        return {"notes": []}
    files = sorted(p.name for p in NOTES_DIR.glob("*.md"))
    return {"notes": files}


def read_note(filename: str) -> dict:
    err = _validate_name(filename)
    if err:
        return {"error": err}
    p = NOTES_DIR / filename
    if not p.exists():
        return {"error": f"Note '{filename}' not found"}
    return {"filename": filename, "content": p.read_text(encoding="utf-8")}


def write_note(filename: str, content: str) -> dict:
    err = _validate_name(filename)
    if err:
        return {"error": err}
    NOTES_DIR.mkdir(parents=True, exist_ok=True)
    p = NOTES_DIR / filename
    p.write_text(content, encoding="utf-8")
    bus.publish({"type": "knowledge_updated", "file": filename, "chars": len(content)})
    return {"written": filename}


def delete_note(filename: str) -> dict:
    err = _validate_name(filename)
    if err:
        return {"error": err}
    p = NOTES_DIR / filename
    if not p.exists():
        return {"error": f"Note '{filename}' not found"}
    p.unlink()
    bus.publish({"type": "knowledge_deleted", "file": filename})
    return {"deleted": filename}


def grep_notes(query: str) -> dict:
    if not NOTES_DIR.exists():
        return {"matches": []}
    pattern = re.compile(query, re.IGNORECASE)
    matches = []
    for p in sorted(NOTES_DIR.glob("*.md")):
        content = p.read_text(encoding="utf-8")
        hits = [line for line in content.splitlines() if pattern.search(line)]
        if hits:
            matches.append({"filename": p.name, "lines": hits})
    return {"matches": matches}
