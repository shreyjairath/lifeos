# Platform Layer

The `com.lifeos.agentfleet` package is the third layer in the stack:

```
executor  ←  agent  ←  platform  ←  app
```

The platform assembles the agent layer's abstractions into a running multi-agent runtime.
It owns everything needed to wire agents together and keep them operating — the registry,
tools, event bus, schedulers, and notification delivery.

The app layer consumes exactly one surface the platform exposes:
- `AgentFleet` — everything: chat routing, session management, agent enumeration, and event triggering

---

## Public Surface (what `app` uses)

### `AgentFleet`

The single facade the app layer imports from platform. Wraps `AgentRegistry`, `AgentRouter`,
and `EventBus` so controllers never reach into platform internals directly.

```java
// Chat
Flux<ServerSentEvent<String>> handleMessage(String sessionId, String message, String agentName)

// Agent enumeration
Collection<Agent> all()

// Session management
Map<String, Object> getHistory(String agentName, String sessionId)
void clearSession(String agentName, String sessionId)
int truncateSession(String agentName, String sessionId, int fromIndex)
List<Map<String, Object>> listSessions(String agentName)
String createSession(String agentName)
void deleteSession(String agentName, String sessionId)
void pruneSessions(String agentName)
void cancel(String agentName, String sessionId)

// Events
void trigger(String eventType, Map<String, Object> extra)
```

`all()` and `handleMessage()` return `Agent`-typed values — the app never sees `BaseAgent`,
`AgentRouter`, or any construction detail. `trigger()` is the only way for app to publish
events onto the bus.

---

## Agent Bootstrap

`AgentRegistry` runs `@PostConstruct load()` at startup and wires every agent in two passes:

**1. Classpath scan** — finds all `agents/*/agent.yml` files on the classpath (i.e. `src/main/resources/agents/`). These are the app's built-in agents.

**2. User-data scan** — finds all `.user-data/agents/*/agent.yml` files on disk. These are agents created dynamically at runtime (e.g. by the `create_agent` tool).

For each `agent.yml` found, `loadAgent()` does four things:

1. Parses the YAML into an `AgentDefinition` (name, title, prompt files, tool filter, disabled modes)
2. Provisions a workspace directory at `.user-data/agents/{name}/workspace/` and registers it with `ToolsRegistry`
3. Builds a `ToolInvoker` by filtering the full tool catalogue through the agent's `ToolsFilter` (include/exclude list, or all tools if null)
4. Constructs a `BaseAgent` with the definition + invoker + all injected platform dependencies, calls `initListeners()` to subscribe to `EventBus` triggers, and stores it by name

Agents can also be registered at runtime via `register(yamlMap, promptBase)` — called by the `create_agent` tool when an agent spins up a new peer.

`get(name)` returns the named agent, falling back to the first registered agent if the name is unknown (so clients that don't specify an agent always get a default).

---

## Internal Components

`AgentRegistry`, `AgentRouter`, and `EventBus` are platform-internal. App code never imports
them directly — all access goes through `AgentFleet`.



### `ToolsRegistry`

Owns the complete tool catalogue: definitions (Anthropic schema format passed to the LLM)
and dispatch (executing a named tool call).

```java
List<Map<String, Object>> getTools()                          // all enabled tool definitions
Map<String, Object> dispatch(name, input, agentName)         // execute a tool call
void registerAgentWorkspace(String name, Path workspace)     // provision a new agent's workspace
AgentChannels agentChannels()                                 // the ChannelLog implementation
```

`AgentRegistry` uses `getTools()` (filtered per agent's `ToolsFilter`) and `dispatch()` to
build each agent's `ToolInvoker`. The agent layer never touches `ToolsRegistry` directly.

### `EventBus`

In-memory pub/sub backbone. All platform components publish events; agents subscribe to
trigger events inside `initListeners()`.

```java
void publish(Map<String, Object> event)
Flux<Map<String, Object>> subscribe()
List<Map<String, Object>> getHistory()   // snapshot of last 500 events
```

Key event types flowing through the bus:

| Event type | Published by | Consumed by |
|-----------|-------------|-------------|
| `heartbeat_trigger` | `HeartbeatScheduler` | `BaseAgent.initListeners()` |
| `self_eval_trigger` | `SelfEvalScheduler` | `BaseAgent.initListeners()` |
| `session_expiry_check_trigger` | `SessionExpiryCheckScheduler` | `SessionHandler.initListeners()` |
| `agent_run_start` / `agent_run_end` | `BaseAgent` | `EventsController` (SSE to frontend) |
| `error` | `AgentRouter` | `EventsController` |

### `WebPushService`

Implements `agent.PushNotifier`. Delivers Web Push notifications to all subscribed browser
clients. Subscriptions and VAPID keys are stored in `.user-data/system/`.

```java
void sendToAll(String title, String body)  // Agent interface (PushNotifier)
```

Called by `BaseAgent` when a background run contains a `push_to_user:"..."` line, and by
`ReminderScheduler` for due reminders.

---

## Schedulers (`platform.schedulers`)

All schedulers are Spring `@Component`s. They only publish to `EventBus` — they have no
direct reference to agents. Agents react independently via their event subscriptions.

| Scheduler | Default schedule | Event published | Effect |
|-----------|-----------------|-----------------|--------|
| `HeartbeatScheduler` | Every 6h (`0 0 */6 * * *`) | `heartbeat_trigger` | Each agent runs its heartbeat check |
| `SelfEvalScheduler` | Daily at 5am (`0 0 5 * * *`) | `self_eval_trigger` | Each agent runs self-evaluation |
| `SessionExpiryCheckScheduler` | Every hour (`0 0 * * * *`) | `session_expiry_check_trigger` | Stale sessions are closed and summarized |
| `ReminderScheduler` | Every 30s | *(sends push directly)* | Due reminders fire Web Push |

Schedules are overridable via `application.yml` cron properties.
`ReminderScheduler` also exposes `store()` for the reminder tools to share the same instance.

---

## Tools (`platform.tools`)

Tool implementations. Each tool is a plain class (no Spring annotations) instantiated and
held by `ToolsRegistry`. Every tool method returns `Map<String, Object>` — the result
content returned to the LLM.

| Tool class | LLM tool name(s) | What it does |
|-----------|-----------------|-------------|
| `Bash` | `agent_bash` | Scoped shell execution in an agent's workspace; readonly mode blocks write ops |
| `Browse` | `browse_page` | Fetches a URL and returns readable text |
| `WebSearch` | `web_search` | Web search via configured search API |
| `AgentTools` | `message_agent`, `message_agent_async`, `list_agents` | Inter-agent messaging via `AgentRegistry` |
| `AgentChannels` | `read_channel` | Reads the full log of a conversation between two agents; implements `ChannelLog` |
| `AgentLog` | `append_agent_log`, `read_agent_log` | Append-only log in an agent's workspace for structured notes |
| `SessionTools` | `list_sessions`, `read_session_summary`, `read_session_transcript` | Read-only access to session history |
| `Reminders` | `set_reminder`, `list_reminders`, `delete_reminder` | CRUD for time-based push reminders |
| `ScheduledTasks` | `schedule_task`, `list_tasks`, `get_overdue_tasks` | Agent-managed task list with due dates |
| `Media` | `show_image` | Passes an image URL through to the frontend for display |
| `Redfin` | `parse_redfin_listing`, `parse_redfin_search` | Scrapes Redfin listing and search pages |
| `PropertyReport` | `property_report` | Aggregates property data into a structured report |

`Bash` is instantiated once per registered agent workspace, scoped to that agent's
`.user-data/agents/{name}/workspace/` directory.

---

## What the agentfleet layer does NOT own

- Agent behaviour, prompt construction, session persistence — owned by `agent`
- HTTP controllers and SSE endpoint definitions — owned by `app`
- LLM client and agentic loop — owned by `agent.executor`
- Agent configuration schema (`agent.yml` format) — owned by `agent.AgentDefinition`
