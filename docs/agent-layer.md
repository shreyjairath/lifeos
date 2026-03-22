# Agent Layer

The `com.lifeos.agent` package is the second layer in the stack:

```
executor  ←  agent  ←  platform  ←  app
```

It owns the concept of an agent — what it is, how it runs, and how its conversation history is stored.
It knows nothing about HTTP, Spring beans, or tool implementations.

---

## Public Interface — `Agent`

Everything the agentfleet layer needs is exposed through a single interface:

```java
public interface Agent {
    String getName();
    String getTitle();
    String getDescription();

    SessionHandler getSessionHandler();
    void initListeners();               // subscribe to EventBus triggers after construction
    void cancel(String sessionId);      // cancel an in-progress run

    Flux<ExecutorEvent> handleUserMessage(String sessionId, String message);
    void handleAgentMessageAsync(String fromAgent, String content);  // fire-and-forget
    String handleAgentMessage(String fromAgent, String content);     // blocking
}
```

`agentfleet` always codes against `Agent` — it never reaches into `BaseAgent` or any concrete class.

---

## Core Classes

### `BaseAgent` — concrete implementation of `Agent`

The only concrete agent class. Constructed by `AgentRegistry` (in `agentfleet`) with an
`AgentDefinition` parsed from `agent.yml`.

**What it does:**
- Builds a system prompt for each run mode by composing identity files + shared scaffolding
- Drives the agentic loop via `Executor.runLoop()` (in the executor layer)
- Persists messages to and reads history from `SessionHandler`
- Serializes background runs (post-session, heartbeat, self-eval) on a single-threaded executor
- Publishes `agent_run_start` / `agent_run_end` events and optionally fires a push notification
  when a background run contains a `push_to_user:"..."` line

**Run modes:**

| Mode | Trigger | System prompt |
|------|---------|---------------|
| `chat` | User message | identity + scaffolding + session context + chat.md |
| `post-session` | Session closed | identity + scaffolding + post-session.md |
| `heartbeat` | `heartbeat_trigger` event | identity + scaffolding + heartbeat.md |
| `self-eval` | `self_eval_trigger` event | identity + scaffolding + self-eval.md |
| `inter-agent-message` | Direct agent call | identity + scaffolding + channel history |

Modes can be disabled per-agent via `disabled-modes` in `agent.yml`.

**Dependencies injected at construction:**

| Dependency | Type | Purpose |
|-----------|------|---------|
| `def` | `AgentDefinition` | Name, identity files, tool filter, disabled modes |
| `toolInvoker` | `ToolInvoker` | Tool schema (for LLM) + dispatch (for execution) |
| `agentChannels` | `ChannelLog` | Inter-agent conversation log (read/append) |
| `eventBus` | `EventBus` | Publish run events; subscribe to trigger events |
| `confirmations` | `Confirmations` | Tool confirmation gating |
| `config` | `AppConfig` | Model name, API key, session thresholds |
| `webPush` | `PushNotifier` | Send push notification after background run |
| `agentRunStore` | `AgentRunLogs` | Persist run records to JSONL |

### `AgentDefinition` — parsed `agent.yml`

Immutable record loaded at startup. Fields:

```
name          — unique identifier (e.g. "cos", "therapist")
title         — human-readable display name
description   — one-line summary
promptBase    — filesystem or classpath prefix for resolving identity files
identity      — list of .md filenames loaded in all modes
tools         — ToolsFilter (include/exclude list), or null for all tools
disabledModes — set of mode names to skip (e.g. ["heartbeat", "self-eval"])
```

### `SessionHandler` — session lifecycle per agent

One instance per agent, created inside `BaseAgent`. Handles:

- **Creating** sessions (`createNew`) — initialises `meta.json` + empty `messages.json`
- **Rotating** sessions (`rotate`) — closes old, creates new with `parent_session_id`, triggers
  async summarization via Haiku then fires `onSessionClosed` callback
- **Rotation check** (`checkRotation`) — rotate if `last_input_tokens >= threshold` or inactivity
  exceeds `timeThresholdHours` (both configured in `AppConfig`)
- **Expiry scan** (`initListeners`) — subscribes to `session_expiry_check_trigger` to close stale
  sessions on a schedule
- **Message persistence** — `appendMessage`, `getHistory`, `clearSession`, `truncateSession`
- **Display history** — strips tool internals for the frontend
- **Parent summary injection** — `getParentSummary` returns `summary.md` from the parent session
  (or a transcript fallback if summarization is still running) for injection into the chat system prompt

Storage layout for each session:
```
.user-data/sessions/{session-id}/
    meta.json       — id, title, agent, created_at, last_message_at, last_input_tokens, closed
    messages.json   — full Anthropic-format message array
    summary.md      — written by Haiku on session close; presence marks session as closed
```

### `AgentRunLogs` — run record persistence

Spring `@Component`. Appends one JSON line per completed run to
`.user-data/agents/{name}/_runs.json` (JSONL format). Written automatically by `BaseAgent`
infrastructure — agents do not call this directly.

Each record captures: agent, mode, model, timestamps, token counts, system prompt, tool names,
full turn history (truncated), and the final text result.

---

## Supporting Types

### `ToolInvoker` (interface)

Extends `executor.ToolInvoker` (which only has `invoke`), adding:

```java
List<Map<String, Object>> definitions();  // Anthropic tool schema for the LLM
```

Implemented anonymously by `AgentRegistry` per agent — wraps `ToolsRegistry.getTools()` (filtered
by the agent's `ToolsFilter`) and `ToolsRegistry.dispatch()`.

### `ChannelLog` (interface)

```java
String loadFull(String agentA, String agentB);
void append(String agentA, String agentB, String inbound, String response);
```

Implemented by `platform.tools.AgentChannels`. Injected as an interface so the agent layer has
no dependency on the platform.

### `PushNotifier` (interface)

```java
void sendToAll(String title, String body);
```

Implemented by `platform.WebPushService`. Same inversion pattern as `ChannelLog`.

### `PromptParts` — prompt file loader

Static utility. Loads a `.md` file from the classpath, with a `.user-data/` override:

```java
PromptParts.load("agents/cos", "identity.md")  // loads classpath:agents/cos/identity.md
                                                // or .user-data/agents/cos/identity.md if present
PromptParts.load("workspace-setup.md")         // loads from classpath root prompt-parts/
```

Used by `BaseAgent` to assemble system prompts.

---

## What the agent layer does NOT own

- Tool implementations — owned by `platform.tools`
- Agent registry / wiring — owned by `platform.AgentRegistry`
- HTTP / SSE serialization — owned by `platform.AgentRouter`
- EventBus — owned by `agentfleet` (injected as a concrete type; a future `EventPublisher`
  interface extraction would complete the isolation)
- Scheduler triggers — owned by `platform.schedulers`
