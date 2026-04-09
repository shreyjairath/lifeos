import type { AgentRegistry } from './agent-registry.js';
import type { EventBus } from './event-bus.js';
import type { ExecutorEvent, Agent } from '../agent/types.js';
import type { GmailClient, RawThread, EmailMessage, ThreadMessage } from './tools/gmail.js';
import type { Contact } from '../config.js';

/**
 * Serialized SSE event from an agent run.
 * The data field is a JSON string — the frontend parses it.
 */
export interface SseFrame {
  data: string;
  event?: string;
}

/**
 * Orchestrates an incoming message:
 *   1. Rotation check
 *   2. Agent run (async generator)
 *   3. SSE serialization
 */
export class AgentRouter {
  constructor(
    private readonly registry: AgentRegistry,
    private readonly eventBus: EventBus,
  ) {}

  async *handleMessage(
    sessionId: string | undefined,
    message: string,
    agentName: string,
    model?: string,
  ): AsyncGenerator<SseFrame> {
    try {
      yield* this.handleInner(sessionId, message, agentName, model);
    } catch (err: any) {
      const text = err?.message ?? 'Unknown error';
      this.eventBus.publish({ type: 'error', text });
      yield sse({ type: 'error', text });
    }
  }

  // ── Email routing ─────────────────────────────────────────────────────────────

  async handleEmailCheck(gmail: GmailClient, contacts: Contact[], mailboxAddress?: string, clientEmail?: string): Promise<void> {
    console.log('[EmailCheck] starting poll');

    let rawThreads: RawThread[];
    try {
      rawThreads = await gmail.fetchInboxThreads();
    } catch (err: any) {
      console.warn('[EmailCheck] fetch failed:', err?.message);
      return;
    }
    console.log(`[EmailCheck] fetched ${rawThreads.length} inbox thread(s)`);

    // Filter by To: address if mailboxAddress is set (multi-client isolation)
    if (mailboxAddress) {
      const addr = mailboxAddress.toLowerCase();
      rawThreads = rawThreads.filter((t) => {
        const latest = t.messages[t.messages.length - 1]!;
        const to = (latest.to ?? '').toLowerCase();
        const cc = (latest.cc ?? '').toLowerCase();
        return to.includes(addr) || cc.includes(addr);
      });
      if (rawThreads.length === 0) {
        console.log(`[EmailCheck] no threads addressed to ${mailboxAddress}`);
        return;
      }
      console.log(`[EmailCheck] ${rawThreads.length} thread(s) addressed to ${mailboxAddress}`);
    }
    if (!rawThreads.length) return;

    const allAgents = this.registry.all();
    const cosAgent = this.registry.get('cos');
    const checkStartTime = Date.now();

    const resolveInvolved = (rawThread: RawThread): Agent[] | null => {
      const fullThreadText = rawThread.messages.map((m) => m.mentionText).join('\n');
      const latestInbox = [...rawThread.messages].reverse().find((m) => m.labelIds.includes('INBOX') && !m.labelIds.includes('SENT'));
      const senderEmail = extractEmail(latestInbox ? latestInbox.from : rawThread.messages[rawThread.messages.length - 1]!.from);

      // Client (owner) — defaults to cos
      if (clientEmail && senderEmail === clientEmail.toLowerCase()) {
        return [cosAgent];
      }

      // Known contact — restricted to their allowed agents
      const contact = contacts.find((c) => c.email === senderEmail);
      if (contact) {
        const allowed = allAgents.filter((a) => contact.agents.includes(a.getName()));
        const involved = allowed.filter((a) => fullThreadText.includes(`@${a.getName()}`));
        return involved.length > 0 ? involved : [this.registry.get(contact.fallback)];
      }

      // Unknown sender — drop
      console.log(`[EmailCheck] dropping thread from unknown sender: ${senderEmail}`);
      return null;
    };

    // Build per-agent delivery buckets
    type Bucket = { agent: Agent; emails: EmailMessage[]; thread: RawThread };
    const buckets = new Map<string, Bucket[]>();

    for (const rawThread of rawThreads) {
      const allMsgs = rawThread.messages;
      const involved = resolveInvolved(rawThread);
      if (!involved) continue;

      for (const agent of involved) {
        const lastSeen = agent.emailThreadStore.getLastSeen(rawThread.threadId);
        const lastSeenIdx = lastSeen ? allMsgs.findIndex((m) => m.id === lastSeen) : -1;
        const newMsgs = allMsgs.slice(lastSeenIdx + 1).filter((m) => !m.labelIds.includes('SENT'));
        if (newMsgs.length === 0) continue;

        const prior: ThreadMessage[] = allMsgs.slice(0, lastSeenIdx + 1).map((m) => ({
          from: m.from, date: new Date(m.internalDate).toUTCString(), body: m.body,
        }));
        const emailMsgs: EmailMessage[] = newMsgs.map((m) => ({
          messageId: m.id, rfcMessageId: m.rfcMessageId, threadId: rawThread.threadId,
          from: m.from, to: m.to, cc: m.cc, subject: m.subject, body: m.body, thread: prior,
        }));

        const latestMsg = allMsgs[allMsgs.length - 1]!;
        console.log(`[EmailCheck] routing "${latestMsg.subject}" → ${agent.getName()} (${newMsgs.length} new message(s))`);
        if (!buckets.has(agent.getName())) buckets.set(agent.getName(), []);
        buckets.get(agent.getName())!.push({ agent, emails: emailMsgs, thread: rawThread });
      }
    }

    // Per-thread metadata for mark-as-read coordination
    const threadMeta = new Map<string, { involvedAgents: Agent[]; latestInboxMsgId: string; latestMsgId: string }>();
    for (const rawThread of rawThreads) {
      const latestInboxMsg = [...rawThread.messages].reverse().find((m) => m.labelIds.includes('INBOX') && !m.labelIds.includes('SENT'));
      if (!latestInboxMsg) continue;
      threadMeta.set(rawThread.threadId, {
        involvedAgents: resolveInvolved(rawThread) ?? [],
        latestInboxMsgId: latestInboxMsg.id,
        latestMsgId: rawThread.messages[rawThread.messages.length - 1]!.id,
      });
    }

    console.log(`[EmailCheck] dispatching to ${buckets.size} agent(s): ${[...buckets.keys()].join(', ')}`);

    for (const agentBuckets of buckets.values()) {
      const agent = agentBuckets[0]!.agent;
      for (const { emails: agentEmails, thread } of agentBuckets) {
        agent.handleEmailCheck(agentEmails, async () => {
          const latestNewMsg = agentEmails[agentEmails.length - 1]!;

          const sent = await gmail.getLatestSentMessage(thread.threadId, checkStartTime);
          if (sent) {
            const tagged = allAgents.find((a) => a !== agent && sent.body.includes(`@${a.getName()}`));
            if (tagged) {
              const sentIdx = thread.messages.findIndex((m) => m.id === sent.id);
              const prevMsgId = sentIdx > 0 ? thread.messages[sentIdx - 1]!.id : null;
              if (prevMsgId) tagged.emailThreadStore.markSeen(thread.threadId, prevMsgId);
              agent.emailThreadStore.markSeen(thread.threadId, sent.id);
              console.log(`[EmailCheck] ${agent.getName()} tagged @${tagged.getName()} — cursor set to ${prevMsgId ?? 'start'}`);
              return;
            }
          }

          agent.emailThreadStore.markSeen(thread.threadId, latestNewMsg.messageId);
          console.log(`[EmailCheck] ${agent.getName()} cursor advanced to ${latestNewMsg.messageId} on thread ${thread.threadId}`);

          const meta = threadMeta.get(thread.threadId);
          if (meta) {
            const allCaughtUp = meta.involvedAgents.every((a) => a.emailThreadStore.getLastSeen(thread.threadId) === meta.latestMsgId);
            if (allCaughtUp) {
              try {
                await gmail.markAsRead([meta.latestInboxMsgId]);
                console.log(`[EmailCheck] all agents caught up on thread ${thread.threadId} — marked as read`);
              } catch (err: any) {
                console.warn('[EmailCheck] failed to mark as read:', err?.message);
              }
            }
          }
        });
      }
    }
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private async *handleInner(
    sessionId: string | undefined,
    message: string,
    agentName: string,
    model?: string,
  ): AsyncGenerator<SseFrame> {
    const agent = this.registry.get(agentName);

    // Auto-create session if not provided
    if (!sessionId) {
      sessionId = agent.getSessionHandler().createNew(agentName);
      yield sse({ type: 'session_id', session_id: sessionId });
    }

    const rotation = agent.getSessionHandler().checkRotation(sessionId);

    let activeSessionId = sessionId;

    if (rotation.shouldRotate) {
      const newSessionId = agent.getSessionHandler().rotate(sessionId);
      yield sse({ type: 'session_rotating', reason: rotation.reason });
      yield sse({ type: 'session_rotated', old_session_id: sessionId, new_session_id: newSessionId, reason: rotation.reason });
      activeSessionId = newSessionId;
    }

    let stopped = false;
    for await (const event of agent.handleUserMessage(activeSessionId, message, model)) {
      if (event.type === 'tool_cancelled') stopped = true;
      const frame = toSse(event);
      if (frame) yield frame;
    }
    yield sse({ type: stopped ? 'stopped' : 'done' });
  }
}

// ── SSE serialization ─────────────────────────────────────────────────────────

function toSse(event: ExecutorEvent): SseFrame | null {
  let payload: Record<string, any> | null = null;

  switch (event.type) {
    case 'llm_request':
      return null;
    case 'llm_text':
      payload = { type: 'llm_text', text: event.text };
      break;
    case 'llm_reasoning':
      payload = { type: 'llm_reasoning', text: event.text };
      break;
    case 'llm_tool_call':
      payload = { type: 'llm_tool_call', name: event.name, input: event.input };
      break;
    case 'llm_response':
      return null;
    case 'tool_confirm_request':
      payload = { type: 'tool_confirm_request', requestId: event.requestId, name: event.name, input: event.input };
      break;
    case 'tool_confirm_denied':
      payload = { type: 'tool_confirm_denied', name: event.name };
      break;
    case 'tool_result':
      payload = { type: 'tool_result', id: event.id, name: event.name, result: event.result };
      break;
    case 'agent_append':
    case 'tool_cancelled':
      return null; // internal — not surfaced to frontend
    default:
      return null;
  }

  return payload ? sse(payload) : null;
}

function sse(data: Record<string, any>): SseFrame {
  return { data: JSON.stringify(data) };
}

function extractEmail(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1]! : from).trim().toLowerCase();
}
