# lifeos — Claude Code Configuration

This project is a personal life-OS agent. Claude Code sessions here act as the development partner.

## Project Structure

```
lifeos/
├── environment/        # Knowledge: the world the agent operates in
│   ├── tools.md        # Available tools and how to invoke them
│   ├── services.md     # External services (fill this in)
│   └── integrations.md # API keys, auth, MCP connections
│
├── user/               # Knowledge: about the user
│   ├── identity.md     # Who they are, values, goals (fill this in)
│   ├── routines.md     # Daily/weekly patterns (fill this in)
│   └── projects/       # One .md file per active project (auto-managed)
│
└── agent/              # The agent application (Python FastAPI)
    ├── main.py         # FastAPI server
    ├── core/
    │   ├── agent.py    # Claude API loop + streaming
    │   ├── knowledge.py# Loads environment/ + user/ → system prompt
    │   └── memory.py   # Per-session conversation history
    ├── tools/
    │   ├── projects.py # CRUD on user/projects/
    │   ├── files.py    # Read/write knowledge files
    │   └── web.py      # Web search
    └── static/         # HTML/CSS/JS frontend
```

## Running the Agent

```bash
cd agent
pip install -r requirements.txt
export ANTHROPIC_API_KEY=your_key_here
uvicorn main:app --reload
# Open http://localhost:8000
```

## Filling In Your Knowledge Base

Before the agent knows you, fill in:
1. `user/identity.md` — who you are, your values, goals, preferences
2. `user/routines.md` — your daily/weekly patterns
3. `environment/services.md` — your key services and accounts

The agent automatically loads all of these at startup.

## Adding New Tools

1. Implement the function in `agent/tools/`
2. Add a tool definition to `TOOLS` in `agent/core/agent.py`
3. Add dispatch logic to `_dispatch_tool()` in `agent/core/agent.py`

## Adding New Knowledge Files

1. Create the .md file in `environment/` or `user/`
2. It will be auto-loaded by `agent/core/knowledge.py`
3. Add it to `ALLOWED_FILES` in `agent/tools/files.py` if you want the agent to update it
