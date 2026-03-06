"""Load environment/ and user/ knowledge base files into a system prompt."""
import os
from pathlib import Path


def load_knowledge_base(config: dict) -> str:
    """
    Load all knowledge files into a single system prompt string.
    """
    base = Path(__file__).parent.parent  # agent/

    env_dir = base / config["paths"]["environment"]
    user_dir = base / config["paths"]["user"]
    projects_dir = base / config["paths"]["projects"]

    parts = [
        load_knowledge_base.__doc__ and "",  # placeholder removed below
        _read_dir(env_dir, "Environment"),
        _read_dir(user_dir, "About User"),
        _read_projects(projects_dir),
    ]

    knowledge = "\n\n".join(p for p in parts if p)

    system = f"""You are a personal agent — a life OS for the user.
You know them deeply, operate in their digital environment, and help them execute both one-off projects and recurring routines.
Be direct, actionable, and treat the user's time as precious. Use tools to take real actions, not just give advice.
When asked to do something, do it — don't just explain how.

{knowledge}"""

    return system.strip()


def _read_dir(dir_path: Path, label: str) -> str:
    """Read all .md files in a directory and return as a labeled block."""
    if not dir_path.exists():
        return ""
    sections = []
    for md_file in sorted(dir_path.glob("*.md")):
        content = md_file.read_text(encoding="utf-8").strip()
        if content:
            title = md_file.stem.replace("-", " ").replace("_", " ").title()
            sections.append(f"### {title}\n{content}")
    if not sections:
        return ""
    return f"## {label}\n\n" + "\n\n".join(sections)


def _read_projects(projects_path: Path) -> str:
    """Read all project files."""
    if not projects_path.exists():
        return ""
    projects = []
    for md_file in sorted(projects_path.glob("*.md")):
        content = md_file.read_text(encoding="utf-8").strip()
        if content:
            projects.append(f"### {md_file.stem}\n{content}")
    if not projects:
        return "## Active Projects\n\nNo active projects yet."
    return "## Active Projects\n\n" + "\n\n".join(projects)
