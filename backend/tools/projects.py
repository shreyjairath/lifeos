"""Project management tools — folder-based projects at .user-data/projects/<name>/project.md"""
import re
from datetime import datetime
from pathlib import Path
from typing import Optional

from tools.files import USER_DATA

SECTIONS = ["context", "snapshot", "next_action", "waiting_on", "files", "log"]

SECTION_HEADERS = {
    "context": "## Context",
    "snapshot": "## Snapshot",
    "next_action": "## Next Action",
    "waiting_on": "## Waiting On",
    "files": "## Files",
    "log": "## Log",
}


def _projects_dir() -> Path:
    return USER_DATA / "projects"


def _slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9-]", "-", name.lower().strip()).strip("-")


def _project_dir(name: str) -> Path:
    return _projects_dir() / _slugify(name)


def _project_file(name: str) -> Path:
    return _project_dir(name) / "project.md"


def _data_dir(proj_dir: Path) -> Path:
    return proj_dir / "data"


def _find_project(name: str) -> Optional[Path]:
    """Find a project dir by exact slug or partial match. Returns None if not found."""
    slug = _slugify(name)
    exact = _projects_dir() / slug
    if exact.is_dir() and (exact / "project.md").exists():
        return exact / "project.md"
    # partial match
    for d in _projects_dir().iterdir():
        if d.is_dir() and slug in d.name and (d / "project.md").exists():
            return d / "project.md"
    return None


def _build_project_md(name: str, goal: str, context: str = "") -> str:
    today = datetime.now().strftime("%Y-%m-%d")
    context_body = context.strip() if context else "*The setting. Who's involved, why this matters, constraints and background that shape every decision. Written once, rarely changes.*"
    return f"""# {name}

**Goal:** {goal}
**Created:** {today}
**Status:** active

## Context
{context_body}

## Snapshot
*Current state. Where we are, what's been tried/dropped and why, key decisions made. Overwritten each session.*

## Next Action
**Owner:** User
**Action:** Define first steps.
**Why:** Project just created — needs direction.

## Waiting On
*Nothing blocked.*

## Files
*No files yet.*

## Log
**{today}:** Project created.
"""


def create_project(name: str, goal: str, context: str = "") -> dict:
    projects_dir = _projects_dir()
    projects_dir.mkdir(parents=True, exist_ok=True)
    slug = _slugify(name)
    proj_dir = projects_dir / slug
    if proj_dir.exists():
        return {"error": f"Project '{name}' already exists. Use update_project to modify it."}
    proj_dir.mkdir(parents=True)
    _data_dir(proj_dir).mkdir()
    path = proj_dir / "project.md"
    path.write_text(_build_project_md(name, goal, context), encoding="utf-8")
    return {"created": str(proj_dir), "name": name, "goal": goal}


def read_project(name: str) -> dict:
    path = _find_project(name)
    if path is None:
        return {"error": f"Project '{name}' not found."}
    return {"name": path.parent.name, "content": path.read_text(encoding="utf-8")}


def _replace_section(content: str, section: str, new_body: str) -> str:
    """Replace the body of a section (between its header and the next ## header or EOF)."""
    header = SECTION_HEADERS[section]
    # Find all section header positions
    header_pattern = re.compile(r"^## .+$", re.MULTILINE)
    headers = list(header_pattern.finditer(content))

    target_idx = None
    for i, m in enumerate(headers):
        if m.group().strip() == header:
            target_idx = i
            break

    if target_idx is None:
        # Section not found — append it
        return content.rstrip() + f"\n\n{header}\n{new_body.strip()}\n"

    start = headers[target_idx].end()
    end = headers[target_idx + 1].start() if target_idx + 1 < len(headers) else len(content)

    # Preserve trailing newline before next section
    return content[:start] + "\n" + new_body.strip() + "\n\n" + content[end:].lstrip("\n")


def update_project(name: str, section: str, content: str) -> dict:
    if section not in SECTIONS:
        return {"error": f"Invalid section '{section}'. Must be one of: {', '.join(SECTIONS)}"}

    path = _find_project(name)
    if path is None:
        return {"error": f"Project '{name}' not found."}

    current = path.read_text(encoding="utf-8")

    if section == "log":
        today = datetime.now().strftime("%Y-%m-%d")
        entry = f"**{today}:** {content.strip()}"
        # Append to log section
        header = SECTION_HEADERS["log"]
        if header in current:
            # Find the log section and append
            log_start = current.index(header) + len(header)
            current = current[:log_start] + "\n" + entry + "\n" + current[log_start:].lstrip("\n")
        else:
            current = current.rstrip() + f"\n\n{header}\n{entry}\n"
    else:
        current = _replace_section(current, section, content)

    path.write_text(current, encoding="utf-8")
    return {"updated": path.name, "project": path.parent.name, "section": section}


def list_projects(config: dict = None) -> dict:
    projects_dir = _projects_dir()
    if not projects_dir.exists():
        return {"projects": []}
    projects = []
    for proj_dir in sorted(projects_dir.iterdir()):
        if not proj_dir.is_dir():
            continue
        md = proj_dir / "project.md"
        if not md.exists():
            continue
        content = md.read_text(encoding="utf-8")
        status_match = re.search(r"\*\*Status:\*\*\s*(.+)", content)
        status = status_match.group(1).strip() if status_match else "unknown"
        if status == "deleted":
            continue
        goal_match = re.search(r"\*\*Goal:\*\*\s*(.+)", content)
        # Extract Next Action block
        next_action_match = re.search(
            r"## Next Action\n(.*?)(?=\n## |\Z)", content, re.DOTALL
        )
        next_action = next_action_match.group(1).strip() if next_action_match else ""
        projects.append({
            "name": proj_dir.name,
            "status": status,
            "goal": goal_match.group(1).strip() if goal_match else "",
            "next_action": next_action,
        })
    return {"projects": projects}


def add_project_file(project: str, filename: str, description: str, content: str) -> dict:
    path = _find_project(project)
    if path is None:
        return {"error": f"Project '{project}' not found."}
    proj_dir = path.parent
    data = _data_dir(proj_dir)
    data.mkdir(exist_ok=True)
    file_path = data / filename
    file_path.write_text(content, encoding="utf-8")

    # Add to Files section in project.md
    proj_content = path.read_text(encoding="utf-8")
    files_header = SECTION_HEADERS["files"]
    placeholder = "*No files yet.*"
    if files_header in proj_content:
        files_start = proj_content.index(files_header) + len(files_header)
        # Find end of files section
        rest = proj_content[files_start:]
        next_section = re.search(r"\n## ", rest)
        end_pos = files_start + next_section.start() if next_section else len(proj_content)

        current_files_body = proj_content[files_start:end_pos].strip()
        new_entry = f"- {filename} — {description}"

        if current_files_body == placeholder or not current_files_body:
            new_files_body = new_entry
        else:
            new_files_body = current_files_body + "\n" + new_entry

        proj_content = proj_content[:files_start] + "\n" + new_files_body + "\n\n" + proj_content[end_pos:].lstrip("\n")
    else:
        proj_content = proj_content.rstrip() + f"\n\n{files_header}\n- {filename} — {description}\n"

    path.write_text(proj_content, encoding="utf-8")
    return {"created": str(file_path), "project": proj_dir.name, "filename": filename}


def read_project_file(project: str, filename: str) -> dict:
    path = _find_project(project)
    if path is None:
        return {"error": f"Project '{project}' not found."}
    file_path = _data_dir(path.parent) / filename
    if not file_path.exists():
        return {"error": f"File '{filename}' not found in project '{project}'."}
    return {"project": path.parent.name, "filename": filename, "content": file_path.read_text(encoding="utf-8")}


def update_project_file(project: str, filename: str, content: str) -> dict:
    path = _find_project(project)
    if path is None:
        return {"error": f"Project '{project}' not found."}
    file_path = _data_dir(path.parent) / filename
    if not file_path.exists():
        return {"error": f"File '{filename}' not found in project '{project}'."}
    file_path.write_text(content, encoding="utf-8")
    return {"updated": str(file_path), "project": path.parent.name, "filename": filename}


def delete_project_file(project: str, filename: str) -> dict:
    path = _find_project(project)
    if path is None:
        return {"error": f"Project '{project}' not found."}
    file_path = _data_dir(path.parent) / filename
    if not file_path.exists():
        return {"error": f"File '{filename}' not found in project '{project}'."}
    file_path.unlink()

    # Remove from Files section in project.md
    proj_content = path.read_text(encoding="utf-8")
    lines = proj_content.splitlines(keepends=True)
    new_lines = [l for l in lines if not re.match(rf"^- {re.escape(filename)}\s*[—-]", l)]
    path.write_text("".join(new_lines), encoding="utf-8")
    return {"deleted": filename, "project": path.parent.name}
