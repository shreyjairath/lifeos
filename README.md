# lifeos

A personal agent that runs locally. Talk to it like a chief of staff — it knows who you are, remembers your projects, and can take real actions on your behalf.

---

## What it does

lifeos is a web-based chat interface backed by Claude. Unlike a generic assistant, it is personalized: you fill in a knowledge base describing yourself (identity, routines, services, integrations), and the agent loads all of it as context on every request.

**Built-in capabilities:**
- Create, read, and update projects (tracked as markdown files)
- Read and update your personal knowledge base
- Search the web
- Delegate coding tasks to Claude Code as a subprocess

**Two chat panels:**
- **Main chat** — the primary agent, with tool use and full context
- **Claude Code sidecar** — a direct Claude Code session for software engineering tasks, with session resumption across turns

All user data (knowledge base, projects, conversation history) lives in `.user-data/` and is gitignored — the repo contains only code.

---

## System design

```
lifeos/
├── .user-data/             # All user data (gitignored)
│   ├── environment/        # tools.md, services.md, integrations.md
│   ├── user/               # identity.md, routines.md, projects/
│   ├── conversations.json  # Main chat history (per session)
│   └── cc_history.json     # Claude Code sidecar history
│
└── agent/                  # Application code
    ├── main.py             # FastAPI server + all HTTP routes
    ├── config.yaml         # Model, server settings, data paths
    ├── core/
    │   ├── agent.py        # Anthropic agentic loop with SSE streaming
    │   ├── tools.py        # Tool definitions (TOOLS list) + dispatch
    │   ├── knowledge.py    # Loads .user-data markdown → system prompt
    │   └── memory.py       # JSON-persisted conversation history
    ├── tools/
    │   ├── projects.py     # CRUD on .user-data/user/projects/
    │   ├── files.py        # Read/write named knowledge files
    │   ├── web.py          # DuckDuckGo search via httpx
    │   └── claude_code.py  # claude CLI subprocess wrapper
    └── static/             # Vanilla HTML/CSS/JS frontend
```

### Request flow

```
Browser → POST /api/chat
  → run_agent()           # agentic loop in core/agent.py
    → load_knowledge_base()  # builds system prompt from .user-data/
    → anthropic.messages.stream()
    → dispatch_tool()     # routes tool calls to tools/
    → SSE stream          # text deltas + tool events back to browser
```

### Key design decisions

- **SSE streaming** — the server streams Claude's response token by token. Tool calls and results are also emitted as SSE events so the frontend inspector can show them in real time.
- **Context windowing** — `_prepare_messages()` strips tool use/result blocks from older turns to keep context lean, while preserving the current live tool cycle.
- **Flat markdown knowledge base** — all context is plain `.md` files loaded at request time. No vector DB, no embeddings. Fast and transparent.
- **`.user-data/` separation** — all user-generated content is outside the codebase. The repo is safe to share; collaborators bring their own `.user-data/`.
- **Claude Code sidecar** — the CC panel runs `claude --resume <session_id>` in stream-json mode, enabling multi-turn coding sessions isolated from the main agent context.

---

## Dev onboarding

### Prerequisites

- Python 3.9+
- An Anthropic API key
- (Optional) Claude Code CLI installed for the sidecar panel

### Setup

```bash
git clone https://github.com/shreyjairath/lifeos
cd lifeos/agent

python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

export ANTHROPIC_API_KEY=sk-ant-...
```

### Run

```bash
uvicorn main:app --reload
# Open http://localhost:8000
```

### Adding a tool

1. Implement the function in `agent/tools/`
2. Add a tool definition to `TOOLS` in `agent/core/tools.py`
3. Add dispatch logic to `dispatch_tool()` in `agent/core/tools.py`

### Adding a knowledge file

1. Create the `.md` file in `.user-data/environment/` or `.user-data/user/`
2. It is auto-loaded by `core/knowledge.py` — no code change needed
3. Add it to `ALLOWED_FILES` in `agent/tools/files.py` if you want the agent to be able to update it via tool call
