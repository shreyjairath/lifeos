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
from tools.browse_js import browse_page_js
from tools.claude_code import run_claude_code
from tools.run_python import run_python
from tools.property_report import property_report
from tools.media import show_image
from tools.redfin import parse_redfin_listing, parse_redfin_search

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
        "description": "Attach a named document to a project. Use when a project needs structured data that would clutter project.md — e.g. a property shortlist, a workout plan, a spec doc.",
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
        "name": "browse_page_js",
        "description": "Fetch and read a JS-rendered or SPA page using a headless browser. Use when browse_page returns empty or insufficient content because the page requires JavaScript to render (React, Vue, Angular apps, etc.).",
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
        "name": "property_report",
        "description": "Analyze sun exposure for a property address. Returns street orientation, front/rear/left/right compass directions, open distances to neighboring buildings, and whether each side blocks light. Useful for evaluating real estate.",
        "input_schema": {
            "type": "object",
            "properties": {
                "address": {"type": "string", "description": "Full street address (e.g. '801 Hinman Ave #1, Evanston, IL')"},
            },
            "required": ["address"],
        },
    },
    {
        "name": "parse_redfin_search",
        "description": "Parse a Redfin search, neighborhood, or filter results page. Returns all listed properties with price, beds, baths, sq ft, and URL. Use when the user provides a Redfin search URL rather than a single listing.",
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
        "description": "Parse a Redfin listing URL and return structured property data: price, beds/baths, sq ft, HOA, year built, amenities, coordinates, MLS number, description, and photo URLs.",
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
        "description": "Display an image inline in the chat UI. Use when you have an image URL worth showing — e.g. a map, photo, diagram, or chart found during research. The image renders directly in the conversation.",
        "input_schema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "Direct image URL (must start with http:// or https://)"},
                "caption": {"type": "string", "description": "Optional caption shown below the image"},
            },
            "required": ["url"],
        },
    },
    {
        "name": "run_python",
        "description": "Execute a Python snippet and get stdout/stderr back. Always ask user permission before running. Use for: geocoding, bearing calculations, math, data processing.",
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
            "Describe WHAT to build — the feature, tool, or product spec — not HOW to implement it. "
            "Claude Code will figure out the implementation. "
            "Runs in the lifeos project directory by default."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": (
                        "What to build: the feature, tool, or product spec. "
                        "Include goals, inputs/outputs, and constraints. "
                        "Do NOT specify implementation details — Claude Code decides those."
                    ),
                },
                "working_dir": {
                    "type": "string",
                    "description": "Absolute path to run Claude Code in. Omit to use the lifeos root.",
                },
            },
            "required": ["prompt"],
        },
    },
]


def dispatch_tool(tool_name: str, tool_input: dict) -> Any:
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
    elif tool_name == "browse_page":
        return browse_page(tool_input["url"])
    elif tool_name == "browse_page_js":
        return browse_page_js(tool_input["url"])
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
