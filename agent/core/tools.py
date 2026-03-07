"""Tool definitions and dispatch for the agent."""
from typing import Any

from tools.projects import (
    create_project, list_projects, update_project, read_project,
    add_project_file, read_project_file, update_project_file, delete_project_file,
)
from tools.files import read_knowledge, update_knowledge, set_onboarding_status
from tools.fs import write_file, read_file, update_file, list_dir
from tools.web import web_search
from tools.browse import browse_page
from tools.claude_code import run_claude_code

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
        "description": "Create a new file inside a project folder and register it in the project's Files section.",
        "input_schema": {
            "type": "object",
            "properties": {
                "project": {"type": "string", "description": "Project name or slug"},
                "filename": {"type": "string", "description": "Filename (e.g. notes.md)"},
                "description": {"type": "string", "description": "One-line description for the Files section"},
                "content": {"type": "string", "description": "Full file content"},
            },
            "required": ["project", "filename", "description", "content"],
        },
    },
    {
        "name": "read_project_file",
        "description": "Read a file that lives inside a project folder.",
        "input_schema": {
            "type": "object",
            "properties": {
                "project": {"type": "string", "description": "Project name or slug"},
                "filename": {"type": "string", "description": "Filename to read"},
            },
            "required": ["project", "filename"],
        },
    },
    {
        "name": "update_project_file",
        "description": "Overwrite a file inside a project folder with new content.",
        "input_schema": {
            "type": "object",
            "properties": {
                "project": {"type": "string", "description": "Project name or slug"},
                "filename": {"type": "string", "description": "Filename to update"},
                "content": {"type": "string", "description": "New full content"},
            },
            "required": ["project", "filename", "content"],
        },
    },
    {
        "name": "delete_project_file",
        "description": "Delete a file from a project folder and remove its entry from the project's Files section.",
        "input_schema": {
            "type": "object",
            "properties": {
                "project": {"type": "string", "description": "Project name or slug"},
                "filename": {"type": "string", "description": "Filename to delete"},
            },
            "required": ["project", "filename"],
        },
    },
    {
        "name": "browse_page",
        "description": "Fetch and read the content of a web page. Use after web_search when you need the full content of a specific URL, not just a snippet. Also use when given a direct URL to retrieve listings, articles, or any web content.",
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
        "description": "Search the web for information. Use for research, finding resources, looking up facts.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Search query"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "read_knowledge",
        "description": "Read a knowledge base file about the user or environment.",
        "input_schema": {
            "type": "object",
            "properties": {
                "file": {
                    "type": "string",
                    "enum": ["identity", "routines", "tools", "services", "integrations"],
                    "description": "Which knowledge file to read",
                },
            },
            "required": ["file"],
        },
    },
    {
        "name": "update_knowledge",
        "description": "Update a knowledge base file. Use to persist new information the user shares about themselves or their environment.",
        "input_schema": {
            "type": "object",
            "properties": {
                "file": {
                    "type": "string",
                    "enum": ["identity", "routines", "tools", "services", "integrations"],
                },
                "content": {"type": "string", "description": "Full new content for the file"},
            },
            "required": ["file", "content"],
        },
    },
    {
        "name": "set_onboarding_status",
        "description": "Mark a knowledge area as done or pending in onboarding. Call with status='done' once you have a solid understanding of that area.",
        "input_schema": {
            "type": "object",
            "properties": {
                "file": {
                    "type": "string",
                    "enum": ["identity", "routines", "tools", "services", "integrations"],
                    "description": "The knowledge area to update",
                },
                "status": {
                    "type": "string",
                    "enum": ["pending", "done"],
                    "description": "Mark as done when you have a solid understanding of this area",
                },
            },
            "required": ["file", "status"],
        },
    },
    {
        "name": "write_file",
        "description": "Create or overwrite a file anywhere under the project root. Use for creating new files or fully replacing file contents.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Path relative to project root, e.g. 'notes/ideas.md'"},
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
        "description": "Edit a file by replacing a specific string with new content. Fails if old_str is not found or is ambiguous.",
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
        "name": "claude_code",
        "description": (
            "Run a task with Claude Code (the AI coding agent) in non-interactive mode. "
            "Use this to write or edit code, scaffold files, refactor, explain codebases, "
            "run shell commands, or do any software engineering task. "
            "Claude Code will operate in the lifeos project directory by default. "
            "Pass a clear, self-contained prompt describing the task."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": "The task to give Claude Code. Be specific and self-contained.",
                },
                "working_dir": {
                    "type": "string",
                    "description": "Absolute path to run Claude Code in. Defaults to the lifeos root.",
                },
            },
            "required": ["prompt"],
        },
    },
]


def dispatch_tool(tool_name: str, tool_input: dict, config: dict) -> Any:
    """Route a tool call to its implementation."""
    if tool_name == "create_project":
        return create_project(
            tool_input["name"],
            tool_input["goal"],
            tool_input.get("context", ""),
            config,
        )
    elif tool_name == "list_projects":
        return list_projects(config)
    elif tool_name == "update_project":
        return update_project(tool_input["name"], tool_input["section"], tool_input["content"], config)
    elif tool_name == "read_project":
        return read_project(tool_input["name"], config)
    elif tool_name == "add_project_file":
        return add_project_file(tool_input["project"], tool_input["filename"], tool_input["description"], tool_input["content"], config)
    elif tool_name == "read_project_file":
        return read_project_file(tool_input["project"], tool_input["filename"], config)
    elif tool_name == "update_project_file":
        return update_project_file(tool_input["project"], tool_input["filename"], tool_input["content"], config)
    elif tool_name == "delete_project_file":
        return delete_project_file(tool_input["project"], tool_input["filename"], config)
    elif tool_name == "browse_page":
        return browse_page(tool_input["url"])
    elif tool_name == "web_search":
        return web_search(tool_input["query"])
    elif tool_name == "read_knowledge":
        return read_knowledge(tool_input["file"])
    elif tool_name == "update_knowledge":
        return update_knowledge(tool_input["file"], tool_input["content"])
    elif tool_name == "set_onboarding_status":
        return set_onboarding_status(tool_input["file"], tool_input["status"])
    elif tool_name == "write_file":
        return write_file(tool_input["path"], tool_input["content"])
    elif tool_name == "read_file":
        return read_file(tool_input["path"])
    elif tool_name == "update_file":
        return update_file(tool_input["path"], tool_input["old_str"], tool_input["new_str"])
    elif tool_name == "list_dir":
        return list_dir(tool_input.get("path", "."))
    elif tool_name == "claude_code":
        return run_claude_code(tool_input["prompt"], tool_input.get("working_dir"))
    else:
        return {"error": f"Unknown tool: {tool_name}"}
