# Architecture

lifeos is a multi-agent personal assistant built on a strict 4-layer stack. Each layer depends
only on the layer directly below it. No layer imports from a layer above it.

```
app          com.lifeos.app
  ↑
agentfleet   com.lifeos.agentfleet
  ↑
agent        com.lifeos.agent
  ↑
executor     com.lifeos.agent.executor
```

`config` (`com.lifeos.config.AppConfig`) is cross-cutting — a plain `@ConfigurationProperties`
record with no business logic, injected by Spring into any layer that needs it.

---

## Layers

### executor — raw LLM loop

Knows nothing about agents, sessions, or tools beyond invocation. Given a message list and a
system prompt, it drives the Anthropic API call/response/tool-use loop and emits a stream of
typed events (`ExecutorEvent`).

**Public surface:** `Executor.runLoop()`, `ToolInvoker` interface, `Confirmations`

### agent — agent identity and memory

Takes the raw executor loop and adds the concept of an agent: who it is, what it remembers,
and how it runs. A `BaseAgent` holds a session store, builds system prompts from identity files,
and dispatches across run modes (chat, post-session, background).

**Public surface:** `Agent` interface — the only type agentfleet ever holds a reference to.
`agentfleet` never sees `BaseAgent`.

### agentfleet — multi-agent runtime

Assembles agents into a fleet. Owns everything needed to keep agents running: registry,
router, tools, event bus, schedulers, and push delivery. Agents are loaded from config
at startup; new agents can be registered at runtime.

**Public surface:** `AgentFleet` — the single class app imports from agentfleet. Wraps
`AgentRegistry`, `AgentRouter`, and `EventBus` so controllers never reach into internals.

### app — the lifeos application

The use case. Owns the HTTP controllers, frontend assets, the specific agents bundled with the
product (`src/main/resources/agents/`), and the scheduled triggers defined in `application.yml`.
The app decides what agents exist, what tools they get, and what background modes they run on.

---

## Key Design Decisions

### Agent interface over concrete class

`agentfleet` codes against `Agent` (interface), never `BaseAgent` (concrete). This means
`agentfleet` can't accidentally depend on implementation details — it only sees what the
interface exposes. `BaseAgent` is constructed once in `AgentRegistry.loadAgent()` and then
stored as `Agent`.

### AgentFleet as single facade

`app` imports exactly one class from `agentfleet`: `AgentFleet`. It provides chat routing,
session management, agent enumeration, event triggering, and run cancellation. Everything else
— `AgentRegistry`, `AgentRouter`, `EventBus`, `SessionHandler` — is platform-internal.

### Config-driven agents

No per-agent Java class is needed. Drop an `agent.yml` in `src/main/resources/agents/{name}/`
(built-in) or `.user-data/agents/{name}/` (dynamic) and the registry loads it at startup.
`AgentDefinition` is the parsed representation; `BaseAgent` uses it for identity, tools, and modes.

### Config-driven background modes

Each agent declares its event-triggered background runs in `agent.yml`:

```yaml
background-modes:
  - trigger: heartbeat_trigger
    mode: heartbeat
    prompt: heartbeat.md
```

`BaseAgent` subscribes dynamically — no event type strings are hardcoded in Java. Adding a new
background mode is a YAML edit plus a prompt file, with no Java changes required.

### Config-driven scheduled triggers

The app declares which events to fire and on what schedule in `application.yml`:

```yaml
lifeos:
  scheduled-triggers:
    - type: heartbeat_trigger
      cron: "0 0 */6 * * *"
```

`agentfleet`'s `DynamicEventScheduler` reads this list and registers the cron tasks. The app
owns the schedule; agentfleet owns the execution machinery.

---

## Dependency Summary

| Layer | May import from |
|-------|----------------|
| `executor` | Nothing in `com.lifeos` |
| `agent` | `executor`, `config` |
| `agentfleet` | `agent`, `executor`, `config` |
| `app` | `agentfleet`, `config` |

---

## Detailed Layer Docs

- [agent-layer.md](agent-layer.md) — Agent interface, BaseAgent, SessionHandler, run modes
- [platform-layer.md](platform-layer.md) — AgentFleet surface, bootstrap, tools, schedulers
- [getting-started.md](getting-started.md) — Step-by-step guide: bootstrap a new app with two agents
