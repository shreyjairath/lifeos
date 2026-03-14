"""Tool definitions and dispatch for the agent."""
import json
from pathlib import Path
from typing import Any

from tools.projects import (
    create_project, list_projects, update_project, read_project,
    add_project_file, read_project_file, update_project_file, delete_project_file,
)
from tools.knowledge_files import list_notes, read_note, write_note, delete_note, grep_notes
from tools.fs import write_file, read_file, update_file, list_dir
from tools.web import web_search
from tools.browse import browse_page
from tools.browse_js import browse_page_js
from tools.claude_code import run_claude_code
from tools.run_python import run_python
from tools.property_report import property_report
from tools.media import show_image
from tools.redfin import parse_redfin_listing, parse_redfin_search

_USER_DATA = Path(__file__).parent.parent.parent / ".user-data"
_DISABLED_TOOLS_FILE = _USER_DATA / "disabled-tools.json"

TOOLS: list[dict] = [
    {
        "name": "create_project",
        "description": "Create a new project with a goal and optional context. Use when the user wants to start tracking a new goal or initiative.",
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Short project name"},
                "goal": {"type": "string", "description": "What success looks like"},
                "context": {"type": "string", "description": "Background, constraints, and why this matters (optional)"},
            },
            "required": ["name", "goal"],
        },
    },
    {
        "name": "list_projects",
        "description": "List all active projects with their status and goals.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "update_project",
        "description": "Update a specific section of a project. Use 'log' to append a dated entry; use other sections to overwrite in place.",
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Project name or slug"},
                "section": {
                    "type": "string",
                    "enum": ["context", "snapshot", "next_action", "waiting_on", "files", "log"],
                    "description": "Which section to update",
                },
                "content": {"type": "string", "description": "New content for the section (log entries are appended with today's date)"},
            },
            "required": ["name", "section", "content"],
        },
    },
    {
        "name": "read_project",
        "description": "Read the full details of a specific project.",
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Project name or slug"},
            },
            "required": ["name"],
        },
    },
    {
        "name": "add_project_file",
        "description": "Attach a named document to a project.",
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Project name or slug"},
                "filename": {"type": "string", "description": "Name for the document (e.g. shortlist.md)"},
                "description": {"type": "string", "description": "One-line description of what this document contains"},
                "content": {"type": "string", "description": "Full document content"},
            },
            "required": ["name", "filename", "description", "content"],
        },
    },
    {
        "name": "read_project_file",
        "description": "Read a document attached to a project.",
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Project name or slug"},
                "filename": {"type": "string", "description": "Document name to read"},
            },
            "required": ["name", "filename"],
        },
    },
    {
        "name": "update_project_file",
        "description": "Overwrite a document attached to a project with new content.",
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Project name or slug"},
                "filename": {"type": "string", "description": "Document name to update"},
                "content": {"type": "string", "description": "New full content"},
            },
            "required": ["name", "filename", "content"],
        },
    },
    {
        "name": "delete_project_file",
        "description": "Remove a document attached to a project.",
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Project name or slug"},
                "filename": {"type": "string", "description": "Document name to delete"},
            },
            "required": ["name", "filename"],
        },
    },
    {
        "name": "list_notes",
        "description": "List all note files in the agent's notes directory.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "read_note",
        "description": "Read the content of a note file.",
        "input_schema": {
            "type": "object",
            "properties": {
                "filename": {"type": "string", "description": "Note filename, e.g. user.md"},
            },
            "required": ["filename"],
        },
    },
    {
        "name": "write_note",
        "description": "Write (create or overwrite) a note file. Use for persisting knowledge about the user.",
        "input_schema": {
            "type": "object",
            "properties": {
                "filename": {"type": "string", "description": "Note filename, e.g. user.md, preferences.md"},
                "content": {"type": "string", "description": "Full content to write"},
            },
            "required": ["filename", "content"],
        },
    },
    {
        "name": "delete_note",
        "description": "Delete a note file.",
        "input_schema": {
            "type": "object",
            "properties": {
                "filename": {"type": "string", "description": "Note filename to delete"},
            },
            "required": ["filename"],
        },
    },
    {
        "name": "grep_notes",
        "description": "Search notes for a keyword or pattern.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Regex or keyword to search for"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "browse_page",
        "description": "Fetch and read the content of a web page.",
        "input_schema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "Full URL to fetch (must start with http:// or https://)"},
            },
            "required": ["url"],
        },
    },
    {
        "name": "browse_page_js",
        "description": "Fetch and read a JS-rendered or SPA page using a headless browser.",
        "input_schema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "Full URL to fetch (must start with http:// or https://)"},
            },
            "required": ["url"],
        },
    },
    {
        "name": "web_search",
        "description": "Search the web for information.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "write_file",
        "description": "Create or overwrite a file anywhere under the project root.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Path relative to project root"},
                "content": {"type": "string", "description": "Full file content to write"},
            },
            "required": ["path", "content"],
        },
    },
    {
        "name": "read_file",
        "description": "Read any file under the project root.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Path relative to project root"},
            },
            "required": ["path"],
        },
    },
    {
        "name": "update_file",
        "description": "Edit a file by replacing a specific string with new content.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Path relative to project root"},
                "old_str": {"type": "string", "description": "Exact string to find and replace"},
                "new_str": {"type": "string", "description": "Replacement string"},
            },
            "required": ["path", "old_str", "new_str"],
        },
    },
    {
        "name": "list_dir",
        "description": "List files and subdirectories under a path in the project root.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Path relative to project root (defaults to root)"},
            },
        },
    },
    {
        "name": "property_report",
        "description": "Analyze sun exposure for a property address.",
        "input_schema": {
            "type": "object",
            "properties": {
                "address": {"type": "string", "description": "Full street address"},
            },
            "required": ["address"],
        },
    },
    {
        "name": "parse_redfin_search",
        "description": "Parse a Redfin search or neighborhood results page.",
        "input_schema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "Redfin search or neighborhood URL"},
            },
            "required": ["url"],
        },
    },
    {
        "name": "parse_redfin_listing",
        "description": "Parse a Redfin listing URL and return structured property data.",
        "input_schema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "Full Redfin listing URL"},
            },
            "required": ["url"],
        },
    },
    {
        "name": "show_image",
        "description": "Display an image inline in the chat UI.",
        "input_schema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "Direct image URL"},
                "caption": {"type": "string", "description": "Optional caption"},
            },
            "required": ["url"],
        },
    },
    {
        "name": "run_python",
        "description": "Execute a Python snippet and get stdout/stderr back. Always ask user permission before running.",
        "input_schema": {
            "type": "object",
            "properties": {
                "code": {"type": "string", "description": "Python source code to execute"},
            },
            "required": ["code"],
        },
    },
    {
        "name": "claude_code",
        "description": (
            "Delegate a software engineering task to Claude Code (the AI coding agent). "
            "Describe WHAT to build — not HOW. Runs in the lifeos project directory by default."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "prompt": {"type": "string", "description": "What to build"},
                "working_dir": {"type": "string", "description": "Absolute path to run Claude Code in (optional)"},
            },
            "required": ["prompt"],
        },
    },
]


# ── Tool disabling ────────────────────────────────────────────────────────────

def load_disabled_tools() -> set[str]:
    if not _DISABLED_TOOLS_FILE.exists():
        return set()
    try:
        data = json.loads(_DISABLED_TOOLS_FILE.read_text(encoding="utf-8"))
        return set(data) if isinstance(data, list) else set()
    except (json.JSONDecodeError, OSError):
        return set()


def save_disabled_tools(disabled: set[str]) -> None:
    _DISABLED_TOOLS_FILE.parent.mkdir(parents=True, exist_ok=True)
    _DISABLED_TOOLS_FILE.write_text(json.dumps(sorted(disabled), indent=2), encoding="utf-8")


def all_tool_names() -> list[str]:
    return [t["name"] for t in TOOLS]


def get_tools() -> list[dict]:
    """Return TOOLS filtered by the disabled list."""
    disabled = load_disabled_tools()
    if not disabled:
        return TOOLS
    return [t for t in TOOLS if t["name"] not in disabled]


# ── Dispatch ──────────────────────────────────────────────────────────────────

def dispatch_tool(tool_name: str, tool_input: dict) -> Any:
    """Route a tool call to its implementation."""
    if tool_name == "create_project":
        return create_project(tool_input["name"], tool_input["goal"], tool_input.get("context", ""))
    elif tool_name == "list_projects":
        return list_projects()
    elif tool_name == "update_project":
        return update_project(tool_input["name"], tool_input["section"], tool_input["content"])
    elif tool_name == "read_project":
        return read_project(tool_input["name"])
    elif tool_name == "add_project_file":
        proj = tool_input.get("project") or tool_input.get("name")
        return add_project_file(proj, tool_input["filename"], tool_input.get("description", ""), tool_input.get("content", ""))
    elif tool_name == "read_project_file":
        proj = tool_input.get("project") or tool_input.get("name")
        return read_project_file(proj, tool_input["filename"])
    elif tool_name == "update_project_file":
        proj = tool_input.get("project") or tool_input.get("name")
        return update_project_file(proj, tool_input["filename"], tool_input.get("content", ""))
    elif tool_name == "delete_project_file":
        proj = tool_input.get("project") or tool_input.get("name")
        return delete_project_file(proj, tool_input["filename"])
    elif tool_name == "list_notes":
        return list_notes()
    elif tool_name == "read_note":
        return read_note(tool_input["filename"])
    elif tool_name == "write_note":
        return write_note(tool_input["filename"], tool_input["content"])
    elif tool_name == "delete_note":
        return delete_note(tool_input["filename"])
    elif tool_name == "grep_notes":
        return grep_notes(tool_input["query"])
    elif tool_name == "browse_page":
        return browse_page(tool_input["url"])
    elif tool_name == "browse_page_js":
        return browse_page_js(tool_input["url"])
    elif tool_name == "web_search":
        return web_search(tool_input["query"])
    elif tool_name == "write_file":
        return write_file(tool_input["path"], tool_input["content"])
    elif tool_name == "read_file":
        return read_file(tool_input["path"])
    elif tool_name == "update_file":
        return update_file(tool_input["path"], tool_input["old_str"], tool_input["new_str"])
    elif tool_name == "list_dir":
        return list_dir(tool_input.get("path", "."))
    elif tool_name == "parse_redfin_search":
        return parse_redfin_search(tool_input["url"])
    elif tool_name == "parse_redfin_listing":
        return parse_redfin_listing(tool_input["url"])
    elif tool_name == "show_image":
        return show_image(tool_input["url"], tool_input.get("caption", ""))
    elif tool_name == "property_report":
        return property_report(tool_input["address"])
    elif tool_name == "run_python":
        return run_python(tool_input["code"])
    elif tool_name == "claude_code":
        return run_claude_code(tool_input["prompt"], tool_input.get("working_dir"))
    elif tool_name.startswith("chrome_"):
        from tools.chrome_mcp import call_tool as chrome_call
        return chrome_call(tool_name[len("chrome_"):], tool_input)
    else:
        return {"error": f"Unknown tool: {tool_name}"}
