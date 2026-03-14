# lifeos — Claude Code Configuration

lifeos is a personal life-OS agent. It is a Spring Boot (Java 25) + WebFlux backend with a vanilla JS frontend that wraps Claude (via raw Anthropic HTTP API) into a persistent, self-learning personal assistant.

## Product Vision

An agent that knows you deeply and grows with you over time. It maintains notes about the user, tracks active projects, learns from every conversation, and can take action through tools. The long-term vision: autocomplete everything in a person's life that can be automated or assisted.

## Project Structure

```
lifeos/                          # Project root IS the Java application
│
├── src/main/java/com/lifeos/
│   ├── api/                     # REST controllers
│   │   ├── ChatController       # POST /api/chat (SSE stream)
│   │   ├── ConversationController
│   │   ├── KnowledgeController  # /api/knowledge, /api/prompt-parts
│   │   └── CcController         # /api/cc/chat (Claude Code sidecar)
│   ├── config/
│   │   └── AppConfig            # @ConfigurationProperties record
│   ├── core/
│   │   ├── ChatManager          # Session lifecycle, SSE serialization, rotation
│   │   ├── Knowledge            # System prompt assembly + reflection runner
│   │   ├── Session              # Message history, session summarization
│   │   ├── SystemPrompt         # Builds the full system prompt per request
│   │   ├── EventBus             # SSE event bus (GET /api/events)
│   │   └── Hooks                # Shell hooks (on_kb_reflect, on_session_rotate, etc.)
│   ├── executor/
│   │   ├── LlmClient            # Raw HTTP streaming to Anthropic API
│   │   ├── Executor             # Agentic loop (LLM turns + tool turns)
│   │   ├── ToolsClient          # Tool dispatch, gating, confirmation
│   │   ├── ToolsRegistry        # Tool definitions (Anthropic format) + dispatch
│   │   ├── Cancellation         # Per-session stop support
│   │   ├── Confirmations        # Tool confirmation request/response
│   │   └── events/              # Typed executor events (LlmEvent, ToolEvent, AgentAppendEvent)
│   ├── store/
│   │   ├── KnowledgeStore       # File I/O for .user-data/knowledge/ and notes/
│   │   ├── ProjectStore         # File I/O for .user-data/projects/
│   │   └── SessionStore         # File I/O for .user-data/conversations/
│   └── tools/
│       ├── KnowledgeFiles       # Notes dir tools (list/read/write/delete/grep)
│       ├── Projects             # Project CRUD
│       ├── FileSystem           # General file tools under .user-data/
│       ├── WebSearch            # DuckDuckGo search
│       ├── Browse               # Web page fetch (Jsoup)
│       ├── Media                # Image display
│       ├── Redfin               # Redfin listing/search parser
│       └── PropertyReport       # Property analysis tool
│
├── src/main/resources/
│   ├── application.yml          # server.port, lifeos.model, lifeos.anthropic-api-key, lifeos.paths, lifeos.session
│   ├── prompt-parts/
│   │   ├── system-instructions.md  # Agent identity and capabilities
│   │   ├── onboarding.md           # (unused — onboarding disabled)
│   │   ├── reflect.md              # Haiku memory agent prompt (runs at session rotation)
│   │   └── summarize-session.md    # Haiku session summarization prompt
│   └── static/                  # Served by Spring Boot at /
│       ├── index.html
│       ├── app.js               # Main entry, sidebar, session switching
│       ├── styles.css
│       └── modules/
│           ├── chat.js          # Chat UI + SSE streaming
│           ├── cc.js            # Claude Code sidecar chat
│           ├── inspector.js     # Request/response JSON inspector
│           ├── events-panel.js  # Live event stream panel
│           └── prompt.js        # System prompt parts editor
│
├── .user-data/                  # Runtime data (gitignored)
│   ├── conversations/
│   │   └── {conv_id}/
│   │       ├── meta.json            # name, project_name, sessions[], current_session
│   │       ├── summary.md           # Rolling conversation-level summary
│   │       └── sessions/
│   │           └── {session_id}.json  # Full message history (messages tagged with _ts)
│   ├── knowledge/
│   │   └── notes/               # Agent notes directory (persistent memory)
│   │       └── *.md             # One file per topic (e.g. user.md, preferences.md)
│   ├── projects/
│   │   └── {slug}/
│   │       ├── project.md       # Structured project doc (goal, snapshot, next_action, etc.)
│   │       └── data/            # Project file attachments
│   └── prompt-parts/            # User overrides for prompt-parts (takes precedence over classpath)
│
└── build.gradle.kts             # Spring Boot 3.5.3, Java 25, WebFlux, Jackson, Jsoup
```

## Running

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home
export ANTHROPIC_API_KEY=your_key_here
./gradlew bootRun
# Open http://localhost:8000
```

## Conversation + Session Model

- **Conversation**: a named container scoped to a topic or project. A main conversation always exists; project conversations are created when the user opens a project.
- **Session**: a time-bounded window of messages within a conversation. Rotates at 50k tokens or 4h inactivity.
- **Data**: stored in `.user-data/conversations/{conv_id}/` — not in memory.

## System Prompt Structure

Assembled fresh on every request by `SystemPrompt.java`:

```
[system-instructions.md]
[## Notes]        ← all files in .user-data/knowledge/notes/
[## Active Projects] ← all project.md files in .user-data/projects/
[# Session Context]  ← only if conversation has history
  [## Conversation Summary]   ← summary.md (rolling, updated at rotation)
  [## Last Session — <date>]  ← most recent session summary
```

## Continuous Learning

Reflection runs **only at session rotation**, not after every turn:

1. **Knowledge update**: Haiku reviews the session transcript and uses `list_notes`/`read_note`/`write_note`/`delete_note` to persist new facts about the user, and `update_project` to keep project state current.
2. **Session archive**: The session is summarized and stored.
3. **Conversation summary**: Rolling `summary.md` is updated to carry context forward.

## Adding New Tools

1. Implement in `src/main/java/com/lifeos/tools/`
2. Inject into `ToolsRegistry` constructor
3. Add tool definition to `TOOLS` list in `ToolsRegistry.getTools()`
4. Add dispatch case to `ToolsRegistry.dispatch()`

## Key API Routes

| Method | Route | Purpose |
|--------|-------|---------|
| POST | `/api/chat` | Send message, stream SSE response |
| POST | `/api/chat/{convId}/{sessionId}/stop` | Cancel in-progress response |
| POST | `/api/chat/{convId}/{sessionId}/tool-confirm` | Confirm/deny a tool call |
| GET | `/api/chat/{convId}/{sessionId}` | Load chat history |
| DELETE | `/api/chat/{convId}/{sessionId}` | Clear session |
| GET | `/api/conversations` | List conversations |
| GET | `/api/conversations/main` | Get/create main conversation |
| POST | `/api/conversations/for-project` | Get/create project conversation |
| GET | `/api/sessions` | List recent sessions |
| GET | `/api/projects` | List projects |
| GET/PUT | `/api/knowledge/{fileKey}` | Read/write knowledge (legacy single-file view) |
| GET/PUT | `/api/prompt-parts/{name}` | Read/write system prompt parts |
| GET | `/api/events` | SSE event bus stream |
| POST | `/api/cc/chat` | Claude Code sidecar chat |
