"""Read/write knowledge base files (user/identity, user/routines, environment/*)."""
from pathlib import Path

ALLOWED_FILES = {
    "identity": ("user", "identity.md"),
    "routines": ("user", "routines.md"),
    "tools": ("environment", "tools.md"),
    "services": ("environment", "services.md"),
    "integrations": ("environment", "integrations.md"),
}


def _resolve(file_key: str) -> tuple[str, str]:
    if file_key not in ALLOWED_FILES:
        raise ValueError(f"Unknown file '{file_key}'. Allowed: {list(ALLOWED_FILES)}")
    return ALLOWED_FILES[file_key]


def read_knowledge(file_key: str) -> dict:
    subdir, filename = _resolve(file_key)
    base = Path(__file__).parent.parent.parent / ".user-data"
    path = base / subdir / filename
    if not path.exists():
        return {"error": f"{path} does not exist."}
    return {"file": file_key, "content": path.read_text(encoding="utf-8")}


def update_knowledge(file_key: str, content: str) -> dict:
    subdir, filename = _resolve(file_key)
    base = Path(__file__).parent.parent.parent / ".user-data"
    path = base / subdir / filename
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return {"updated": file_key, "path": str(path)}
