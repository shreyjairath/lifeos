"""Load environment/ and user/ knowledge base files into a system prompt."""
from pathlib import Path

from core.events import bus
from tools.files import USER_DATA, read_status, ONBOARDING_FILES

_PARTS_DIR = Path(__file__).parent / "system_prompt_parts"


def _load_part(name: str) -> str:
    return (_PARTS_DIR / name).read_text(encoding="utf-8").strip()


def _prepare_knowledge() -> str:
    parts = [
        _read_dir(USER_DATA / "environment", "Environment"),
        _read_dir(USER_DATA / "user", "About User"),
        _read_projects(USER_DATA / "user" / "projects"),
    ]
    return "\n\n".join(p for p in parts if p)


def prepare_system_prompt(config: dict) -> str:
    """Assemble the full system prompt from knowledge files and prompt parts.

    Loads user and environment knowledge, checks onboarding status, and
    selects the appropriate persona + onboarding template. Publishes boot
    events to the event bus as each step completes.
    """
    bus.publish({"type": "boot_start"})

    knowledge = _prepare_knowledge()
    incomplete_onboarding = _incomplete_onboarding_topics()

    if incomplete_onboarding:
        onboarding_block = _onboarding_prompt(incomplete_onboarding)
        system = f"{_load_part('persona.md')}\n\n{knowledge}\n\n{onboarding_block}"
    else:
        system = f"{_load_part('persona.md')}\n\n{knowledge}"

    system = system.strip()
    bus.publish({"type": "system_prompt", "chars": len(system)})
    bus.publish({"type": "boot_done"})
    return system


def _incomplete_onboarding_topics() -> list[str]:
    """Return knowledge areas not yet marked done. Publishes onboarding status for each to the event bus."""
    onboarding = read_status().get("onboarding", {})
    for topic in ONBOARDING_FILES:
        bus.publish({"type": "onboarding_status", "file": topic, "status": onboarding.get(topic, "pending")})
    return [topic for topic in ONBOARDING_FILES if onboarding.get(topic, "pending") != "done"]


def _onboarding_prompt(incomplete_topics: list[str]) -> str:
    topics_list = ", ".join(incomplete_topics)
    return _load_part("onboarding.md").format(pending_files=topics_list)


def _read_dir(dir_path: Path, label: str) -> str:
    """Read all .md files in a directory and return as a labeled block."""
    if not dir_path.exists():
        return ""
    sections = []
    for md_file in sorted(dir_path.glob("*.md")):
        content = md_file.read_text(encoding="utf-8").strip()
        status = "loaded" if content else "empty"
        bus.publish({"type": "knowledge_file", "file": md_file.stem, "label": label, "status": status, "chars": len(content)})
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
        bus.publish({"type": "knowledge_file", "file": md_file.stem, "label": "Projects", "status": "loaded" if content else "empty", "chars": len(content)})
        if content:
            projects.append(f"### {md_file.stem}\n{content}")
    if not projects:
        return "## Active Projects\n\nNo active projects yet."
    return "## Active Projects\n\n" + "\n\n".join(projects)
