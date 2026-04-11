# System Prompt Structure

Every agent run gets a freshly assembled system prompt built in `BaseAgent.buildSystemPrompt()` (`src/agent/base-agent.ts`).

---

## Structure

Every prompt has these sections in this order:

```
1. Platform context        ← prompt-parts/lifeos-prompt.md — identical for every agent and mode
2. # The Client            ← client name + email from ClientConfig
3. # Your Identity         ← agent name, manager, hires, identity.md content
4. # Your Goal             ← goal: field from agent.yml (omitted if not set)
5. # Current Mode: {mode}  ← mode name + mode-specific content + injected context
6. # Current Date & Time   ← live timestamp
```

---

## Modes

| Mode | Triggered by | Prompt file | User message |
|------|-------------|-------------|--------------|
| `chat` | User message via `/api/chat` | `prompt-parts/chat.md` | User's message |
| `check_email_trigger` | New inbound email | `prompt-parts/check-email.md` | Formatted email(s) + thread history |
| `task_trigger` | Overdue task fired by scheduler | `prompt-parts/task-trigger.md` | `# Task: {name}\n\n{description}` |
| `inter-agent-message` | `message_agent` / `message_agent_async` | `prompt-parts/inter-agent-message.md` | `[From: {sender}]\n\n{content}` |

**Model used:**
- `chat` — full chat model (`def.model ?? config.model`)
- all others — background model (`def.backgroundModel ?? config.backgroundModel`)

**Reasoning:** enabled only in `chat` mode; disabled in all background modes.

---

## Mode-specific injected context

### `chat`

```
# Current Mode: chat

{chat.md content}

**Session ID:** {sessionId}

## Last Session — {date}       ← omitted if no parent session summary exists
{parent session summary.md content}
```

### `check_email_trigger`

```
# Current Mode: check_email_trigger

{check-email.md content}

**You are processing these threads — use the fields below when calling `send_email`...**

- thread_id: `{id}` | in_reply_to: `{msgId}` | subject: {subject} | reply_to: {from}
...

**Shared mailbox:** `{mailboxAddress}` — all agents share this address. Always close every
outbound email with your name so recipients know who they are speaking with:

— {title} (@{name})
```

User message: formatted email bodies with thread history (last N messages per thread, truncated at 20k chars).

### `task_trigger`

```
# Current Mode: task_trigger

{task-trigger.md content}
```

User message: `# Task: {name}\n\n{description}`

All recurring tasks (reconcile_workspace, self_eval, self_learning, workspace_reorg, system_feedback) run through `task_trigger` — the task description is the full instructions.

### `inter-agent-message`

```
# Current Mode: inter-agent-message

{inter-agent-message.md content}

> **Async message** — the sender has moved on and will not receive your text directly.
> Your response is written to the feed.
> Call `post_message` if you need to send them an explicit reply.

    ← OR for sync calls:

> **Sync message** — the sender is blocking and waiting.
> Your text response will be returned to them directly.
> Do NOT call `message_agent` (sync) to reply — deadlock.
```

User message: `[From: {sender}]\n\n{message content}`

---

## Identity section

```
# Your Identity

Your name is **{name}**. [Your manager is **{manager}**.]   ← manager line omitted if not set
[Your hires: **hire1**, **hire2**]                           ← omitted if no hires

Use `read_agent_definition` with your own name to review your full definition...

{identity.md content}
```

---

## Implementation reference

| What | Where |
|------|-------|
| Prompt assembly | `BaseAgent.buildSystemPrompt()` — `src/agent/base-agent.ts` |
| Identity header | `BaseAgent.identityWithName()` |
| Platform context | `LIFEOS_PROMPT` — `loadGenericPrompt('lifeos-prompt.md')` |
| Chat scaffold | `CHAT_SCAFFOLD` — `loadGenericPrompt('chat.md')` |
| Email scaffold | `CHECK_EMAIL` — `loadGenericPrompt('check-email.md')` |
| Task scaffold | `TASK_TRIGGER` — `loadGenericPrompt('task-trigger.md')` |
| Inter-agent scaffold | `INTER_AGENT` — `loadGenericPrompt('inter-agent-message.md')` |
| Parent session summary | `SessionHandler.getParentSummary()` |
| Sync/async flag | Set in `runInterAgentMessage()` — passed as `opts.async` |
| Email thread metadata | Built in `handleEmailCheck()` from `EmailMessage[]` |

---

## Prompt file locations

| File | Purpose |
|------|---------|
| `prompt-parts/lifeos-prompt.md` | Platform context — org, responsibilities, operating model, tools, modes |
| `prompt-parts/chat.md` | Chat mode framing |
| `prompt-parts/check-email.md` | Email triage and reply rules |
| `prompt-parts/task-trigger.md` | Task execution framing |
| `prompt-parts/inter-agent-message.md` | Inter-agent protocol |
| `prompt-parts/reconcile-workspace.md` | Workspace reconciliation (delivered as task description) |
| `prompt-parts/self-eval.md` | Self-evaluation (delivered as task description) |
| `prompt-parts/self-learning.md` | Self-learning (delivered as task description) |
| `prompt-parts/workspace-reorg.md` | Workspace reorganization (delivered as task description) |
| `prompt-parts/system-feedback.md` | System feedback (delivered as task description) |

Any prompt file can be overridden per-agent by placing it in the agent's own directory (`.user-data/agents/{name}/`). Generic files (`prompt-parts/`) apply to all agents.
