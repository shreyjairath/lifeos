"""Tool definitions and dispatch for the agent."""
from typing import Any

from tools.projects import create_project, list_projects, update_project, read_project
from tools.files import read_knowledge, update_knowledge, set_onboarding_status
from tools.web import web_search
from tools.claude_code import run_claude_code

TOOLS: list[dict] = [
    {
        "name": "create_project",
        "description": "Create a new project with a goal and optional initial tasks. Use when the user wants to start tracking a new goal or initiative.",
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Short project name"},
                "goal": {"type": "string", "description": "What success looks like"},
                "tasks": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Initial task list (optional)",
                },
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
        "description": "Add a progress update, note, or status change to a project.",
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Project name or slug"},
                "update": {"type": "string", "description": "The update or note to append"},
            },
            "required": ["name", "update"],
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
            tool_input.get("tasks", []),
            config,
        )
    elif tool_name == "list_projects":
        return list_projects(config)
    elif tool_name == "update_project":
        return update_project(tool_input["name"], tool_input["update"], config)
    elif tool_name == "read_project":
        return read_project(tool_input["name"], config)
    elif tool_name == "web_search":
        return web_search(tool_input["query"])
    elif tool_name == "read_knowledge":
        return read_knowledge(tool_input["file"])
    elif tool_name == "update_knowledge":
        return update_knowledge(tool_input["file"], tool_input["content"])
    elif tool_name == "set_onboarding_status":
        return set_onboarding_status(tool_input["file"], tool_input["status"])
    elif tool_name == "claude_code":
        return run_claude_code(tool_input["prompt"], tool_input.get("working_dir"))
    else:
        return {"error": f"Unknown tool: {tool_name}"}
