"""Read/write knowledge base files (user/identity, user/routines, environment/*)."""
import json
from pathlib import Path

from core.events import bus

USER_DATA = Path(__file__).parent.parent.parent / ".user-data"
_USER_DATA = USER_DATA  # backward compat alias
_STATUS_FILE = _USER_DATA / "status.json"

ALLOWED_FILES = {
    "identity": ("user", "identity.md"),
    "routines": ("user", "routines.md"),
    "tools": ("environment", "tools.md"),
    "services": ("environment", "services.md"),
    "integrations": ("environment", "integrations.md"),
}

ONBOARDING_FILES = list(ALLOWED_FILES.keys())


def _resolve(file_key: str) -> tuple[str, str]:
    if file_key not in ALLOWED_FILES:
        raise ValueError(f"Unknown file '{file_key}'. Allowed: {list(ALLOWED_FILES)}")
    return ALLOWED_FILES[file_key]


def read_knowledge(file_key: str) -> dict:
    subdir, filename = _resolve(file_key)
    path = _USER_DATA / subdir / filename
    if not path.exists():
        return {"error": f"{path} does not exist."}
    return {"file": file_key, "content": path.read_text(encoding="utf-8")}


def update_knowledge(file_key: str, content: str) -> dict:
    subdir, filename = _resolve(file_key)
    path = _USER_DATA / subdir / filename
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    bus.publish({"type": "knowledge_updated", "file": file_key, "chars": len(content)})
    return {"updated": file_key, "path": str(path)}


def read_status() -> dict:
    if not _STATUS_FILE.exists():
        return {"onboarding": {f: "pending" for f in ONBOARDING_FILES}}
    try:
        return json.loads(_STATUS_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {"onboarding": {f: "pending" for f in ONBOARDING_FILES}}


def set_onboarding_status(file_key: str, status: str) -> dict:
    if file_key not in ALLOWED_FILES:
        return {"error": f"Unknown file '{file_key}'"}
    if status not in ("pending", "done"):
        return {"error": "status must be 'pending' or 'done'"}
    data = read_status()
    data.setdefault("onboarding", {})[file_key] = status
    _STATUS_FILE.parent.mkdir(parents=True, exist_ok=True)
    _STATUS_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")
    bus.publish({"type": "onboarding_updated", "file": file_key, "status": status})
    if all(data["onboarding"].get(f) == "done" for f in ONBOARDING_FILES):
        bus.publish({"type": "onboarding_complete"})
    return {"file": file_key, "onboarding_status": status}
