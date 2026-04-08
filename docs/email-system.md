# Email System

The email system routes inbound Gmail messages to the appropriate agent(s), delivers them as background runs, and tracks per-agent read state locally — without relying on Gmail's read/unread labels for routing decisions.

---

## Overview

```
Gmail inbox
    │
    ▼
fetchInboxThreads()          ← in:inbox newer_than:3d, full thread data
    │
    ▼
Per-thread: find involved agents   ← @mentions anywhere in thread
    │
    ▼
Per-agent cursor check             ← email-threads.json lastSeenMessageId
    │
    ├── new messages → deliver to agent (handleEmailCheck)
    └── no new messages → skip
          │
          ▼
       onComplete
          ├── agent tagged @other → set other's cursor behind sent reply
          └── no tagging → advance cursor; if all agents caught up → markAsRead
```

---

## Email Poll

**Trigger:** `POST /api/agents/trigger/check_email_trigger` or cron via `AgentFleet.triggerEmailCheck()`

**Gmail query:** `in:inbox newer_than:3d` — fetches all threads with inbox activity in the last 3 days. Threads are deduplicated by `threadId`; one `threads.get` call per unique thread. All messages in the thread are returned, oldest first.

**Why `newer_than:3d` instead of `is:unread`:** Gmail's unread label is no longer used for routing. Per-agent local cursors determine what each agent has seen. The 3-day window ensures active threads stay in scope across multiple polls.

---

## Per-Agent Read State

Each agent maintains its own cursor per thread, stored in `.user-data/agents/{name}/email-threads.json`:

```json
{
  "19d5aab88ee54f0c": {
    "lastActivityAt": 1775344200000,
    "lastSeenMessageId": "18f3c9a2b4d1e507",
    "content": "..."
  }
}
```

| Field | Purpose |
|-------|---------|
| `lastSeenMessageId` | The last Gmail message ID this agent has processed in this thread. `null` = never seen. |
| `lastActivityAt` | Updated on every `markSeen` call. Used for dormant thread detection. |
| `content` | Formatted email content from the most recent delivery — used for post-email dormancy runs. |

**`EmailThreadStore` API** (`packages/server/src/agentfleet/tools/email-thread-store.ts`):
- `getLastSeen(threadId)` — returns `lastSeenMessageId` or `null`
- `markSeen(threadId, messageId)` — updates cursor and `lastActivityAt`
- `upsert(threadId, content)` — preserves existing cursor, updates content
- `getDormant(thresholdMs)` — returns threads with no activity for `thresholdMs`

---

## Involved Agent Determination

For each thread, all messages are concatenated and scanned for `@agent_name` mentions. Every agent whose name appears anywhere in the thread is considered "involved" and will receive new messages.

**Contact-gated routing** (senders in `config.yml contacts`): only agents listed in the contact's `agents` array are eligible. If no mentions found, falls back to `contact.fallback`.

**Default routing** (other senders):
1. Direct address match — if any agent has the sender's email in `email-addresses`, that agent takes sole ownership
2. @mention scan across all agents
3. Fallback to `cos` if no mentions found

This replaces the previous single-owner "winner" routing. Multiple agents can be involved in the same thread simultaneously.

---

## Delivery

For each involved agent:

1. Find messages in the thread after `lastSeenMessageId` (or all messages if `null`)
2. If none → agent is up to date, skip
3. Build `EmailMessage[]` from new messages with prior messages as thread context
4. Call `agent.handleEmailCheck(emails, onComplete)`

Each agent runs independently via its `BackgroundQueue` — multiple agents on the same thread run concurrently.

**`EmailMessage` structure** (what agents receive):

| Field | Contents |
|-------|---------|
| `messageId` | Gmail message ID of this message |
| `rfcMessageId` | RFC 2822 Message-ID header — use as `in_reply_to` when replying |
| `threadId` | Gmail thread ID — use as `thread_id` when replying |
| `from` / `to` / `cc` | Headers from this message |
| `subject` | Thread subject |
| `body` | Message body, HTML converted to markdown via cheerio |
| `thread` | Prior messages in the thread (older than this message), oldest first |

**Body processing:** `extractBody` prefers `text/plain`. If only `text/html` is available (e.g. agent-sent HTML emails), `htmlToText` converts it to markdown — tables become pipe-delimited, headings become `#`, lists become `-`.

---

## Agent Tagging Handoff

Agents can route a thread to a peer by tagging them in a reply body:

```
Thanks for the update. @chicago_realestate can you confirm the suburb shortlist?

@relocation
```

After the agent's run completes, `onComplete` calls `getLatestSentMessage(threadId, checkStartTime)` to check if the agent sent a reply tagging another agent during this run (only messages sent *after* the poll started count — prevents old @mentions from triggering handoffs).

If a tagged agent is found:
1. **Sending agent's cursor** → advanced to the sent reply's message ID (agent won't reprocess its own reply)
2. **Tagged agent's cursor** → set to the message just *before* the sent reply (agent will see the reply as new on next poll)
3. No Gmail manipulation — the original inbound message is still in inbox and will re-appear in `newer_than:3d` on the next poll, at which point the tagged agent's cursor will be behind the sent reply and it will be delivered

---

## Mark-as-Read Coordination

Gmail messages are marked as read only after **all** involved agents have processed the thread up to its latest message.

At poll start, `threadMeta` is built (in-memory, captured by `onComplete` closures):

```typescript
{
  involvedAgents: Agent[];      // all agents involved in this thread
  latestInboxMsgId: string;     // latest message with INBOX label — what gets marked read
  latestMsgId: string;          // latest message overall (including SENT replies)
}
```

After each agent advances its cursor, the system checks whether every involved agent's `lastSeenMessageId` equals `latestMsgId`. If yes → `markAsRead([latestInboxMsgId])`.

When agent A tags agent B, agent B's cursor is deliberately set *behind* `latestMsgId`, so `allCaughtUp` returns `false` and the thread stays unread until agent B processes it.

---

## Dormant Thread Detection

After every poll, `agent.checkDormantThreads()` is called for all agents. Any thread in `email-threads.json` with `lastActivityAt` older than 2 hours triggers a `post-email` background run — the agent reviews the thread and decides if a follow-up is needed.

After the dormant run fires, the thread entry is removed from `email-threads.json`.

---

## HTML → Markdown Conversion

HTML email bodies (from agent-sent `html_body` emails) are converted before delivery:

| HTML element | Converted to |
|-------------|-------------|
| `<h1>`–`<h6>` | `#`–`######` headings |
| `<table>` | Pipe-delimited markdown table |
| `<li>` | `- ` bullet |
| `<br>` | space (inside cells) / newline (block context) |
| `<p>`, `<div>` | trailing newline |
| `<style>`, `<script>` | removed |

Implemented in `htmlToText()` in `packages/server/src/agentfleet/tools/gmail.ts`.

---

## Gmail Client Methods

All in `GmailClient` (`packages/server/src/agentfleet/tools/gmail.ts`). All calls have a 15s timeout.

| Method | Purpose |
|--------|---------|
| `fetchInboxThreads(query?)` | Fetch full thread data for routing — returns `RawThread[]` |
| `fetchRecent(query?)` | Legacy: fetch formatted `EmailMessage[]` for a specific query |
| `send(to, subject, body?, threadId?, html?, inReplyTo?, fromName?, cc?)` | Send email |
| `sendFile(to, subject, filePath, ...)` | Send HTML file as email body |
| `getLatestSentMessage(threadId, afterMs)` | Returns `{id, body}` of most recent SENT message after `afterMs`, or `null` |
| `markAsRead(messageIds[])` | Remove UNREAD label from messages |
| `markAsUnreadInInbox(messageId)` | Add INBOX + UNREAD labels — not used in current routing |

---

## Configuration

**Gmail credentials:** `.user-data/system/gmail-credentials.json`
```json
{
  "clientId": "...",
  "clientSecret": "...",
  "refreshToken": "..."
}
```

**Contacts** (`config.yml`): map sender emails to allowed agents and a fallback:
```yaml
lifeos:
  contacts:
    - email: nishant@example.com
      agents: [relocation, chicago_childcare, chicago_realestate]
      fallback: relocation
```

**Agent email addresses** (`agent.yml`): direct address routing — emails FROM this address go solely to this agent:
```yaml
email-addresses:
  - nishant@example.com
```

---

## Key Files

| File | Purpose |
|------|---------|
| `packages/server/src/agentfleet/agent-fleet.ts` | `triggerEmailCheck()` — full routing and dispatch logic |
| `packages/server/src/agentfleet/tools/gmail.ts` | `GmailClient` — all Gmail API calls, body parsing, HTML conversion |
| `packages/server/src/agentfleet/tools/email-thread-store.ts` | Per-agent cursor persistence |
| `packages/server/src/agent/base-agent.ts` | `handleEmailCheck()`, `checkDormantThreads()`, `formatEmailsForAgent()` |
| `prompt-parts/check-email.md` | System prompt injected for `check_email_trigger` runs |
| `prompt-parts/post-email.md` | System prompt injected for dormant thread follow-up runs |
| `.user-data/agents/{name}/email-threads.json` | Per-agent thread state (cursor + dormancy) |
