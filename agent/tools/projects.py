"""Project management tools — CRUD on user/projects/*.md"""
import re
from datetime import datetime
from pathlib import Path

from tools.files import USER_DATA


def _projects_dir(config: dict) -> Path:
    return USER_DATA / "user" / "projects"


def _slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9-]", "-", name.lower().strip()).strip("-")


def create_project(name: str, goal: str, tasks: list[str], config: dict) -> dict:
    projects_dir = _projects_dir(config)
    projects_dir.mkdir(parents=True, exist_ok=True)
    slug = _slugify(name)
    path = projects_dir / f"{slug}.md"
    if path.exists():
        return {"error": f"Project '{name}' already exists. Use update_project to modify it."}
    task_list = "\n".join(f"- [ ] {t}" for t in tasks) if tasks else "- [ ] Define first steps"
    content = f"""# {name}

**Goal:** {goal}

**Created:** {datetime.now().strftime("%Y-%m-%d")}
**Status:** active

## Tasks
{task_list}

## Updates
"""
    path.write_text(content, encoding="utf-8")
    return {"created": str(path.name), "name": name, "goal": goal}


def list_projects(config: dict) -> dict:
    projects_dir = _projects_dir(config)
    if not projects_dir.exists():
        return {"projects": []}
    projects = []
    for md_file in sorted(projects_dir.glob("*.md")):
        content = md_file.read_text(encoding="utf-8")
        status_match = re.search(r"\*\*Status:\*\*\s*(.+)", content)
        goal_match = re.search(r"\*\*Goal:\*\*\s*(.+)", content)
        projects.append({
            "name": md_file.stem,
            "status": status_match.group(1).strip() if status_match else "unknown",
            "goal": goal_match.group(1).strip() if goal_match else "",
        })
    return {"projects": projects}


def update_project(name: str, update: str, config: dict) -> dict:
    projects_dir = _projects_dir(config)
    slug = _slugify(name)
    path = projects_dir / f"{slug}.md"
    if not path.exists():
        # try to find by partial match
        matches = list(projects_dir.glob(f"*{slug}*.md"))
        if not matches:
            return {"error": f"Project '{name}' not found."}
        path = matches[0]
    content = path.read_text(encoding="utf-8")
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M")
    content += f"\n**{timestamp}:** {update}\n"
    path.write_text(content, encoding="utf-8")
    return {"updated": path.name, "update": update}


def read_project(name: str, config: dict) -> dict:
    projects_dir = _projects_dir(config)
    slug = _slugify(name)
    path = projects_dir / f"{slug}.md"
    if not path.exists():
        matches = list(projects_dir.glob(f"*{slug}*.md"))
        if not matches:
            return {"error": f"Project '{name}' not found."}
        path = matches[0]
    return {"name": path.stem, "content": path.read_text(encoding="utf-8")}
