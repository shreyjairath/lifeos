"""Assemble the system prompt from notes, projects, active instructions, and session context."""
import datetime
import re
from pathlib import Path

from core.events import bus

_USER_DATA = Path(__file__).parent.parent.parent / ".user-data"
_NOTES_DIR = _USER_DATA / "knowledge" / "notes"
_PROJECTS_DIR = _USER_DATA / "projects"
_PROMPT_PARTS_FS = _USER_DATA / "prompt-parts"
_ACTIVE_INSTRUCTIONS_FILE = _PROMPT_PARTS_FS / ".active-instructions"
_PARTS_CLASSPATH = Path(__file__).parent / "system_prompt_parts"

_DEFAULT_INSTRUCTIONS = "assistant-instructions.md"

_SAFE_NAME = re.compile(r"^[a-zA-Z0-9._-]+\.md$")


# ── Active instructions ───────────────────────────────────────────────────────

def load_active_instructions() -> str:
    """Return the filename of the currently active instructions file."""
    if _ACTIVE_INSTRUCTIONS_FILE.exists():
        name = _ACTIVE_INSTRUCTIONS_FILE.read_text(encoding="utf-8").strip()
        if name and _SAFE_NAME.match(name):
            return name
    return _DEFAULT_INSTRUCTIONS


def save_active_instructions(name: str) -> None:
    _PROMPT_PARTS_FS.mkdir(parents=True, exist_ok=True)
    _ACTIVE_INSTRUCTIONS_FILE.write_text(name, encoding="utf-8")


def load_prompt_part(name: str) -> str:
    """Load a prompt part: filesystem override takes priority over classpath."""
    fs_path = _PROMPT_PARTS_FS / name
    if fs_path.exists():
        return fs_path.read_text(encoding="utf-8").strip()
    cp_path = _PARTS_CLASSPATH / name
    if cp_path.exists():
        return cp_path.read_text(encoding="utf-8").strip()
    return ""


# ── System prompt assembly ────────────────────────────────────────────────────

def prepare_system_prompt(config: dict, session_id: str = None) -> str:
    """Assemble the full system prompt."""
    bus.publish({"type": "boot_start"})

    instructions = load_prompt_part(load_active_instructions())
    notes = _read_notes()
    projects = _read_projects()
    session_context = _load_session_context(session_id)

    parts = [instructions]
    if notes:
        parts.append(notes)
    if projects:
        parts.append(projects)
    if session_context:
        parts.append(session_context)

    system = "\n\n".join(p for p in parts if p).strip()
    bus.publish({"type": "system_prompt", "chars": len(system)})
    bus.publish({"type": "boot_done"})
    return system


# ── Notes ─────────────────────────────────────────────────────────────────────

def _read_notes() -> str:
    if not _NOTES_DIR.exists():
        return ""
    sections = []
    for md_file in sorted(_NOTES_DIR.glob("*.md")):
        content = md_file.read_text(encoding="utf-8").strip()
        status = "loaded" if content else "empty"
        bus.publish({"type": "knowledge_file", "file": md_file.stem, "label": "Notes", "status": status, "chars": len(content)})
        if content:
            sections.append(f"### {md_file.name}\n{content}")
    if not sections:
        return ""
    return "## Notes\n\n" + "\n\n".join(sections)


# ── Projects ──────────────────────────────────────────────────────────────────

def _read_projects() -> str:
    if not _PROJECTS_DIR.exists():
        return ""
    projects = []
    for proj_dir in sorted(_PROJECTS_DIR.iterdir()):
        if not proj_dir.is_dir():
            continue
        md = proj_dir / "project.md"
        if not md.exists():
            continue
        content = md.read_text(encoding="utf-8").strip()
        bus.publish({"type": "knowledge_file", "file": proj_dir.name, "label": "Projects", "status": "loaded" if content else "empty", "chars": len(content)})
        if content:
            projects.append(content)
    if not projects:
        return ""
    return "## Active Projects\n\n" + "\n\n---\n\n".join(projects)


# ── Session context ───────────────────────────────────────────────────────────

def _load_session_context(session_id: str = None) -> str:
    if not session_id:
        return ""
    from core.memory import get_parent_summary, get_session_meta
    meta = get_session_meta(session_id)
    parent_id = meta.get("parent_session_id") if meta else None
    if not parent_id:
        return ""

    summary = get_parent_summary(session_id)
    if not summary:
        return ""

    # Use parent's created_at for date label
    from core.memory import _load_meta
    parent_meta = _load_meta(parent_id)
    ts = parent_meta.get("created_at", 0)
    date_str = datetime.datetime.fromtimestamp(ts).strftime("%b %d, %Y %H:%M") if ts else ""

    label = f"## Last Session — {date_str}" if date_str else "## Last Session"
    bus.publish({"type": "knowledge_file", "file": "last_session", "label": "Session Context", "status": "loaded", "chars": len(summary)})
    return f"# Session Context\n\n{label}\n\n{summary}"


# ── Prompt parts listing ──────────────────────────────────────────────────────

_CLASSPATH_PARTS = {
    "assistant-instructions.md",
    "assistant-instructions-simple.md",
    "reflect-notes.md",
    "reflect-projects.md",
    "summarize-session.md",
}


def list_prompt_parts() -> list[dict]:
    """Return all prompt part names with their active status."""
    active = load_active_instructions()
    names = set(_CLASSPATH_PARTS)
    if _PROMPT_PARTS_FS.exists():
        for p in _PROMPT_PARTS_FS.glob("*.md"):
            if _SAFE_NAME.match(p.name):
                names.add(p.name)
    return sorted(
        [{"name": n, "active": n == active} for n in names],
        key=lambda x: x["name"],
    )
