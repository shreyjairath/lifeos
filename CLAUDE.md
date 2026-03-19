# lifeos — Claude Code Configuration

lifeos is a personal life-OS: a Spring Boot (Java 25) + WebFlux backend with a vanilla JS frontend, wrapping Claude (raw Anthropic HTTP API) into a persistent multi-agent personal assistant called **chief**.

## Product Vision

An agent team that knows you deeply and grows with you over time. Each agent is a specialist — therapist, dating coach, chief of staff, real estate advisor — sharing a common runtime but operating independently. The long-term vision: autocomplete everything in a person's life that can be automated or assisted.

## Running

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home
export ANTHROPIC_API_KEY=your_key_here
./gradlew bootRun
# Open http://localhost:8000
```

## Project Structure

```
lifeos/
├── src/main/java/com/lifeos/
│   ├── api/
│   │   ├── ChatController          # POST /api/chat — SSE stream
│   │   ├── SessionController       # /api/sessions CRUD + prune
│   │   ├── AgentsController        # /api/agents list + /trigger/{eventType}
│   │   ├── AgentRunsController     # /api/agents/{name}/runs
│   │   ├── EventsController        # /api/events SSE + /api/events/history
│   │   └── CcController            # /api/cc/chat — Claude Code sidecar
│   ├── config/
│   │   └── AppConfig               # @ConfigurationProperties record
│   ├── core/
│   │   ├── agents/
│   │   │   ├── Agent               # Config-driven agent (no subclass needed)
│   │   │   ├── AgentDefinition     # Parsed agent.yml
│   │   │   ├── AgentRegistry       # Loads agents from classpath + .user-data/agents/
│   │   │   ├── SessionSummarizer   # Writes summary.md + title on session_closed
│   │   │   ├── executor/
│   │   │   │   ├── BaseAgent       # Abstract base: chat/post-session/heartbeat/self-eval/message modes
│   │   │   │   ├── Executor        # Agentic loop (Flux.defer().repeat().takeUntil())
│   │   │   │   ├── LlmClient       # Raw HTTP POST to Anthropic API; SSE line parsing
│   │   │   │   ├── ToolsClient     # Tool dispatch, gating, confirmation
│   │   │   │   ├── Cancellation    # Per-session stop support
│   │   │   │   └── Confirmations   # Tool confirmation request/response
│   │   │   ├── store/
│   │   │   │   └── AgentRunStore   # Persists agent run records
│   │   │   └── tools/
│   │   │       └── ToolsRegistry   # Tool definitions + dispatch; provisions agent workspaces
│   │   ├── helpers/
│   │   │   ├── EventBus            # In-memory SSE event bus (publish/subscribe)
│   │   │   ├── Hooks               # Shell lifecycle hooks
│   │   │   └── PromptParts         # Loads prompt files from classpath with .user-data/ override
│   │   ├── managers/
│   │   │   ├── ChatManager         # SSE serialization; rotation detection; routes to agent
│   │   │   ├── SessionManager      # Session CRUD, token tracking, rotation, history
│   │   │   ├── SessionExpiryCheckScheduler # @Scheduled every 30min → session_expiry_check_trigger event
│   │   │   ├── HeartbeatScheduler  # @Scheduled every 6h → heartbeat_trigger event
│   │   │   ├── SelfEvalScheduler   # @Scheduled every 12h → self_eval_trigger event
│   │   │   ├── WebPushService      # Web Push notifications
│   │   │   └── ReminderScheduler   # Reminder polling
│   │   └── store/
│   │       └── SessionStore        # File I/O for .user-data/sessions/
│   └── (legacy tools — see ToolsRegistry for current tool list)
│
├── src/main/resources/
│   ├── application.yml             # server.port, model, api-key, heartbeat/self-eval intervals
│   ├── agents/cos/                 # Built-in Chief of Staff agent
│   │   ├── agent.yml
│   │   ├── identity.md             # Who the agent is (all modes)
│   │   ├── chat.md                 # Chat-only framing
│   │   ├── post-session.md
│   │   ├── heartbeat.md
│   │   └── self-eval.md
│   └── static/                     # Served at /
│       ├── index.html, app.js, styles.css
│       └── modules/
│           ├── chat.js             # Chat UI + SSE streaming
│           ├── events-panel.js     # Live event stream
│           ├── agent-debug.js      # Agent run history
│           ├── cc.js               # Claude Code sidecar
│           └── inspector.js        # Request JSON inspector
│
└── .user-data/                     # Runtime data (gitignored)
    ├── sessions/
    │   └── session-{agent}-{datetime}/
    │       ├── meta.json           # { id, title, agent, created_at, last_message_at, last_input_tokens }
    │       ├── messages.json       # Full message history
    │       └── summary.md          # Written at session close
    ├── agents/
    │   └── {name}/
    │       ├── agent.yml           # Dynamic agent config
    │       ├── identity.md, chat.md, post-session.md, heartbeat.md, self-eval.md
    │       └── workspace/          # Agent's private read/write directory (agent_bash)
    └── system/                     # vapid-keys.json, push-subscriptions.json, reminders.json
```

## Agent Architecture

Agents are fully config-driven — no per-agent Java class needed. Drop an `agent.yml` in `src/main/resources/agents/{name}/` (built-in) or `.user-data/agents/{name}/` (dynamic) and the `AgentRegistry` loads it at startup.

### agent.yml schema

```yaml
name: my_agent
title: My Agent
description: What this agent does.
identity:           # Loaded in ALL modes (chat, post-session, heartbeat, self-eval, inter-agent-message)
  - identity.md
chat-prompt:        # Loaded ONLY in user-facing chat system prompt
  - chat.md
post-session-prompt:
  - post-session.md
heartbeat-prompt: heartbeat.md
self-eval-prompt: self-eval.md
chat-tools:         # null = all tools
  mode: include
  names: [agent_bash, web_search, ...]
post-session-tools:
  mode: include
  names: [agent_bash, message_agent, ...]
```

### System Prompt per Mode

| Mode | System prompt |
|------|--------------|
| `chat` | `identity` + `chat-prompt` + session context + timestamp |
| `post-session` | `identity` + `post-session-prompt` |
| `heartbeat` | `identity` + `heartbeat-prompt` |
| `self-eval` | `identity` + `self-eval-prompt` |
| `inter-agent-message` | `identity` only |

### Per-Message Flow

```
POST /api/chat
  → ChatManager
    → SessionManager.checkRotation()     # rotate if 50k tokens or 4h inactive
    → Agent.chat(sessionId, message)
      → BaseAgent.buildPrompt()          # identity + chat-prompt + session context + timestamp
      → Executor.runLoop()               # Flux.defer().repeat().takeUntil() agentic loop
        → LlmClient → Anthropic API (SSE)
        → ToolsClient → tool dispatch
      → SessionManager.appendMessage()
    → SSE stream → frontend
```

### Session Lifecycle

```
Sessions: .user-data/sessions/session-{agent}-{datetime}/

Rotation triggers:
  1. On message:  last_input_tokens >= 50,000
  2. Scheduled:   SessionExpiryCheckScheduler fires session_expiry_check_trigger every 30min
                  → SessionManager.checkExpiredSessions()
                  → publishes session_closed for each stale session (no summary + >4h inactive)

On session_closed:
  → SessionSummarizer  — writes summary.md + generates title (Haiku)
  → Agent.postSession() — runs post-session reflection
```

### Background Schedulers

| Scheduler | Default interval | Event emitted | Effect |
|-----------|-----------------|---------------|--------|
| `SessionExpiryCheckScheduler` | 30min | `session_expiry_check_trigger` | Close stale sessions |
| `HeartbeatScheduler` | 6h | `heartbeat_trigger` | Per-agent heartbeat check |
| `SelfEvalScheduler` | 12h | `self_eval_trigger` | Per-agent self-evaluation |

Both use `initialDelay = interval`, so first fire is one full interval after server start. Manually triggerable via `POST /api/agents/trigger/{eventType}`.

## Adding a New Agent

1. Create `.user-data/agents/{name}/agent.yml` with the schema above
2. Add prompt files alongside it (`identity.md`, `chat.md`, etc.)
3. Restart the server — `AgentRegistry` auto-discovers it

No Java changes needed.

## Adding New Tools

1. Implement in `src/main/java/com/lifeos/core/agents/tools/`
2. Add tool definition to `ToolsRegistry.getTools()`
3. Add dispatch case to `ToolsRegistry.dispatch()`
4. Register workspace if tool is workspace-scoped

## Key API Routes

| Method | Route | Purpose |
|--------|-------|---------|
| POST | `/api/chat` | Send message, stream SSE response |
| GET | `/api/chat/{sessionId}` | Load chat history |
| POST | `/api/chat/{sessionId}/stop` | Cancel in-progress response |
| POST | `/api/tool-confirm/{requestId}` | Confirm/deny a tool call |
| GET | `/api/sessions` | List sessions |
| POST | `/api/sessions` | Create session |
| DELETE | `/api/sessions/{id}` | Hard delete session |
| POST | `/api/sessions/prune` | Remove empty sessions |
| GET | `/api/agents` | List agents |
| GET | `/api/agents/{name}/runs` | Agent run history |
| POST | `/api/agents/trigger/{eventType}` | Manually fire any event |
| GET | `/api/events` | SSE event bus (live) |
| GET | `/api/events/history` | Event history snapshot |
| POST | `/api/cc/chat` | Claude Code sidecar chat |
| POST | `/api/push/subscribe` | Web Push subscription |
