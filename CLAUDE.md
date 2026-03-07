# lifeos — Claude Code Configuration

lifeos is a personal life-OS agent. It is a FastAPI backend + vanilla JS frontend that wraps Claude (via the Anthropic SDK) into a persistent, self-learning personal assistant. Claude Code sessions here act as the development partner.

## Product Vision

An agent that knows you deeply and grows with you over time. It maintains a knowledge base about the user (identity, routines, services, projects), learns from every conversation, and can take action through tools. The long-term vision: autocomplete everything in a person's life that can be automated or assisted.

## Project Structure

```
lifeos/
├── environment/              # Knowledge: world the agent operates in
│   ├── tools.md              # Available tools description
│   ├── services.md           # External services the user has
│   └── integrations.md       # API keys, auth, MCP connections
│
├── user/                     # Knowledge: about the user
│   ├── identity.md           # Who they are, values, goals, context
│   ├── routines.md           # Daily/weekly patterns
│   └── projects/             # One .md file per active project (auto-managed)
│
├── .user-data/               # Runtime data (gitignored)
│   └── conversations/
│       └── {conv_id}/
│           ├── meta.json         # name, project_name, sessions[], current_session
│           ├── summary.md        # Rolling conversation-level summary (updated at rotation)
│           ├── sessions/
│           │   └── {session_id}.json  # Full message history
│           └── summaries/
│               └── {timestamp}.md     # Per-session archives
│
└── agent/                    # The agent application
    ├── main.py               # FastAPI server + all API routes
    ├── config.yaml           # Model, session rotation thresholds
    ├── core/
    │   ├── agent.py          # Claude API agentic loop, streaming, reflection
    │   ├── knowledge.py      # Assembles system prompt from knowledge files
    │   ├── memory.py         # Conversation + session storage
    │   ├── events.py         # Event bus for SSE to frontend
    │   ├── tools.py          # Tool definitions (TOOLS list) + dispatch
    │   └── system_prompt_parts/
    │       ├── persona.md    # Agent identity, capabilities
    │       └── onboarding.md # Shown when knowledge files are incomplete
    ├── tools/
    │   ├── projects.py       # CRUD on user/projects/
    │   ├── files.py          # Read/write named knowledge files
    │   ├── fs.py             # Filesystem tools (write/read/update/list under project root)
    │   └── web.py            # DuckDuckGo web search
    └── static/               # Frontend
        ├── index.html
        ├── app.js            # Main entry, sidebar, conversation switching
        ├── styles.css
        └── modules/
            ├── chat.js       # Main chat UI + SSE streaming
            ├── cc.js         # Claude Code sidecar chat
            ├── inspector.js  # Request/response JSON inspector
            ├── events-panel.js # Live event stream panel
            └── prompt.js     # System prompt parts editor
```

## Running the Agent

```bash
cd agent
pip install -r requirements.txt
export ANTHROPIC_API_KEY=your_key_here
python run.py
# Open http://localhost:8000
```

## Conversation + Session Model

- **Conversation**: a named container scoped to a topic or project. The main conversation (`project_name: "__main__"`) always exists. Project conversations are created when the user clicks a project in the sidebar.
- **Session**: a window of message history within a conversation. Sessions rotate automatically when they hit 50k tokens or 4h of inactivity.
- **Data**: stored in `.user-data/conversations/{conv_id}/` — not in memory.

## System Prompt Structure

Assembled fresh on every request by `knowledge.py`:

```
[persona.md]
[## Environment]  ← all .md files in environment/
[## About User]   ← all .md files in user/
[## Active Projects] ← all .md files in user/projects/
[Onboarding block]   ← only if identity/routines/services incomplete
[# Session Context]  ← only if conv has history
  [## Conversation Summary]  ← summary.md (rolling, updated at rotation)
  [## Last Session — <date>] ← most recent summaries/{ts}.md
```

## Continuous Learning

Reflection runs **only at session rotation**, not after every turn:

1. **Tier 1 — Knowledge base update**: Haiku reviews the session and uses tools to persist new facts (identity, routines, services, projects).
2. **Tier 2 — Session archive**: Haiku writes a timestamped summary to `summaries/{ts}.md`.
3. **Tier 3 — Conversation summary**: Haiku merges the existing `summary.md` with the new session into an updated rolling summary.

## Adding New Tools

1. Implement in `agent/tools/`
2. Add tool definition to `TOOLS` in `agent/core/tools.py`
3. Add dispatch case to `dispatch_tool()` in `agent/core/tools.py`

## Adding New Knowledge Files

1. Create `.md` in `environment/` or `user/` — auto-loaded by `knowledge.py`
2. Add to `ALLOWED_FILES` in `agent/tools/files.py` if the agent should be able to write it

## Key API Routes

| Method | Route | Purpose |
|--------|-------|---------|
| POST | `/api/chat` | Send message, stream SSE response |
| GET | `/api/chat/{conv_id}/{session_id}` | Load chat history |
| DELETE | `/api/chat/{conv_id}/{session_id}` | Clear session |
| POST | `/api/chat/{conv_id}/{session_id}/truncate` | Rewind chat to index |
| GET | `/api/conversations` | List all conversations |
| GET | `/api/conversations/main` | Get/create main conversation |
| POST | `/api/conversations/for-project` | Get/create project conversation |
| GET | `/api/projects` | List projects |
| GET/PUT | `/api/knowledge/{file_key}` | Read/write knowledge files |
| GET/PUT | `/api/prompt-parts/{name}` | Read/write system prompt parts |
| GET | `/api/events` | SSE event stream |
| POST | `/api/cc/chat` | Claude Code sidecar chat |
