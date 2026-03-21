# Background Triggers

The platform has three scheduled triggers and one event-driven trigger. All are mediated through the `EventBus` — schedulers publish events, components subscribe and react independently.

---

## Scheduled Triggers

### `session_expiry_check_trigger`
**Scheduler:** `SessionExpiryCheckScheduler`
**Cron:** `0 0 * * * *` — top of every hour
**Configured via:** `lifeos.session-expiry-check.cron`

Fires once an hour. `SessionManager` listens and scans every session directory for sessions that should be closed:
- No `summary.md` yet (not already summarized)
- Has at least one message
- Meets the rotation threshold: `last_input_tokens >= 50,000` OR `time since last message >= 4h`

For each expired session, emits `session_closed` (see below).

---

### `heartbeat_trigger`
**Scheduler:** `HeartbeatScheduler`
**Cron:** `0 0 */6 * * *` — midnight, 6am, noon, 6pm
**Configured via:** `lifeos.heartbeat.cron`

Fires four times a day. Every agent reacts: each `BaseAgent` subscribes to this event and submits `runHeartbeat()` to its own `backgroundExecutor` (single-threaded per agent, so heartbeats queue behind any in-progress background work).

The heartbeat run uses `reflectModel` and gives the agent its identity + workspace setup + team context + heartbeat instructions. The agent is expected to check for overdue tasks, scan for anything urgent, and optionally call `log_entry` to record what it did. If the result contains a `push_to_user:` line, a web push notification is sent.

Session ID used: `_heartbeat_{agentName}` — unique per agent so cancellation state doesn't bleed across agents.

---

### `self_eval_trigger`
**Scheduler:** `SelfEvalScheduler`
**Cron:** `0 0 5 * * *` — 5am daily
**Configured via:** `lifeos.self-eval.cron`

Fires once a day at 5am. Every agent reacts similarly to heartbeat, but the intent is deeper reflection: how well is the agent doing its job, what should it change about how it operates? Uses `reflectModel`. Non-blank output (not literally "nothing") is published to the event bus and sent as a push notification.

Session ID used: `_selfeval_{agentName}`

---

## Event-Driven Trigger

### `session_closed`
**Sources:**
1. `SessionManager.rotate()` — called inline when a chat message causes token/time threshold to be crossed
2. `SessionManager.checkExpiredSessions()` — called from `session_expiry_check_trigger` handler above

**Payload:** `{ type: "session_closed", sessionId: "...", agent: "..." }`

**Subscribers:**

- **`SessionSummarizer`** (all agents): writes `summary.md` and generates a 4–6 word title using Haiku. Fires for every agent's closed session.

- **`BaseAgent` (per agent)**: each agent subscribes filtering on its own name (`agentName().equals(e.get("agent"))`). On match, submits `runPostSession(sessionId)` to its `backgroundExecutor`. The post-session run reads recent session history and lets the agent reflect, update its workspace, or message teammates.

Session ID used: `_postsession_{agentName}`

---

## Execution Model

Each agent has a **single-threaded `backgroundExecutor`** (`Executors.newSingleThreadExecutor`, daemon thread). All background modes — heartbeat, self-eval, post-session, incoming inter-agent messages — are serialized through this executor. This means:

- Two background tasks for the same agent never run concurrently
- If an agent is mid-heartbeat when a `session_closed` fires, post-session queues and runs after
- Heartbeats across different agents run in parallel (separate executors)

---

## Manual Trigger

Any trigger event can be fired manually via:

```
POST /api/agents/trigger/{eventType}
```

Valid event types: `heartbeat_trigger`, `self_eval_trigger`, `session_expiry_check_trigger`

---

## Cron Reference (Spring 6-field format)

```
┌─ second (0)
│ ┌─ minute (0)
│ │ ┌─ hour
│ │ │    ┌─ day-of-month (*)
│ │ │    │ ┌─ month (*)
│ │ │    │ │ ┌─ day-of-week (*)
│ │ │    │ │ │
0 0 */6  * * *   →  midnight, 6am, noon, 6pm
0 0 *    * * *   →  top of every hour
0 0 5    * * *   →  5am daily
```
