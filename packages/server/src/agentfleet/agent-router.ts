import type { AgentRegistry } from './agent-registry.js';
import type { EventBus } from './event-bus.js';
import type { ExecutorEvent, Agent, InboundThread } from '../agent/types.js';
import type { GmailClient, RawThread } from './tools/gmail.js';
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
    // Check any message in the thread — not just the latest, which may be an outbound reply
    if (mailboxAddress) {
      const addr = mailboxAddress.toLowerCase();
      rawThreads = rawThreads.filter((t) =>
        t.messages.some((m) =>
          (m.to ?? '').toLowerCase().includes(addr) ||
          (m.cc ?? '').toLowerCase().includes(addr),
        ),
      );
      if (rawThreads.length === 0) {
        console.log(`[EmailCheck] no threads addressed to ${mailboxAddress}`);
        return;
      }
      console.log(`[EmailCheck] ${rawThreads.length} thread(s) addressed to ${mailboxAddress}`);
    }
    if (!rawThreads.length) return;

    console.log(`[EmailCheck] threads to process: ${rawThreads.map((t) => t.threadId).join(', ')}`);
    const allAgents = this.registry.all();
    const checkStartTime = Date.now();

    const resolveInvolved = (rawThread: RawThread): Agent[] | null => {
      const fullThreadText = rawThread.messages.map((m) => m.mentionText).join('\n');
      const latestInbox = [...rawThread.messages].reverse().find((m) => m.labelIds.includes('INBOX') && !m.labelIds.includes('SENT'));
      const senderEmail = extractEmail(latestInbox ? latestInbox.from : rawThread.messages[rawThread.messages.length - 1]!.from);

      // Client (owner) — route by @mention only; no fallback agent
      if (clientEmail && senderEmail === clientEmail.toLowerCase()) {
        const involved = allAgents.filter((a) => fullThreadText.includes(`@${a.getName()}`));
        if (involved.length === 0) {
          console.log(`[EmailCheck] dropping thread from client with no @mention: ${rawThread.threadId}`);
          return null;
        }
        return involved;
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
    type Bucket = { agent: Agent; inbound: InboundThread; rawThread: RawThread };
    const buckets = new Map<string, Bucket[]>();
    // Cache resolveInvolved results — used again when building threadMeta below
    const involvedCache = new Map<string, Agent[] | null>();

    for (const rawThread of rawThreads) {
      const allMsgs = rawThread.messages;
      const subject = allMsgs[allMsgs.length - 1]!.subject;
      const involved = resolveInvolved(rawThread);
      involvedCache.set(rawThread.threadId, involved);
      if (!involved) continue;

      for (const agent of involved) {
        const lastSeen = agent.emailThreadStore.getLastSeen(rawThread.threadId);
        const lastSeenIdx = lastSeen ? allMsgs.findIndex((m) => m.id === lastSeen) : -1;
        if (lastSeen && lastSeenIdx === -1) {
          console.warn(`[EmailCheck] cursor miss on thread ${rawThread.threadId} for ${agent.getName()} — cursor message not found, re-delivering all messages`);
        } else {
          console.log(`[EmailCheck] thread "${subject}" (${rawThread.threadId}) for ${agent.getName()} — cursor=${lastSeen ?? 'none'} at idx=${lastSeenIdx}, total=${allMsgs.length} messages`);
        }
        const newMsgs = allMsgs.slice(lastSeenIdx + 1).filter((m) => !m.labelIds.includes('SENT'));
        const skippedSent = allMsgs.slice(lastSeenIdx + 1).length - newMsgs.length;
        if (newMsgs.length === 0) {
          console.log(`[EmailCheck] thread "${subject}" → ${agent.getName()} skipped — 0 new messages (${skippedSent} SENT filtered)`);
          continue;
        }

        console.log(`[EmailCheck] routing "${subject}" → ${agent.getName()} (${newMsgs.length} new message(s))`);
        if (!buckets.has(agent.getName())) buckets.set(agent.getName(), []);
        buckets.get(agent.getName())!.push({
          agent,
          inbound: {
            threadId: rawThread.threadId,
            messageIds: newMsgs.map((m) => m.id),
            latestRfcMessageId: newMsgs[newMsgs.length - 1]!.rfcMessageId,
            latestFrom: newMsgs[newMsgs.length - 1]!.from,
            latestTo: newMsgs[newMsgs.length - 1]!.to,
            latestCc: newMsgs[newMsgs.length - 1]!.cc,
            subject,
          },
          rawThread,
        });
      }
    }

    // Per-thread metadata for mark-as-read coordination
    const threadMeta = new Map<string, { involvedAgents: Agent[]; latestMsgId: string }>();
    for (const rawThread of rawThreads) {
      const latestMsgId = rawThread.messages[rawThread.messages.length - 1]!.id;
      threadMeta.set(rawThread.threadId, {
        involvedAgents: involvedCache.get(rawThread.threadId) ?? [],
        latestMsgId,
      });
    }

    console.log(`[EmailCheck] dispatching to ${buckets.size} agent(s): ${[...buckets.keys()].join(', ')}`);

    for (const agentBuckets of buckets.values()) {
      const agent = agentBuckets[0]!.agent;
      for (const { inbound, rawThread } of agentBuckets) {
        // Pre-advance cursor optimistically — revert on error
        const prevCursor = agent.emailThreadStore.getLastSeen(rawThread.threadId);
        const latestMsgId = inbound.messageIds[inbound.messageIds.length - 1]!;
        agent.emailThreadStore.markSeen(rawThread.threadId, latestMsgId, inbound.subject, {
          latestRfcMessageId: inbound.latestRfcMessageId,
          latestFrom: inbound.latestFrom,
          latestTo: inbound.latestTo,
          latestCc: inbound.latestCc,
        });
        console.log(`[EmailCheck] ${agent.getName()} cursor pre-advanced to ${latestMsgId} on thread ${rawThread.threadId}`);

        agent.handleEmailCheck([inbound], async (status) => {
          if (status === 'error') {
            // Revert cursor so the email is retried next poll
            if (prevCursor) {
              agent.emailThreadStore.markSeen(rawThread.threadId, prevCursor, inbound.subject);
            } else {
              agent.emailThreadStore.remove(rawThread.threadId);
            }
            console.log(`[EmailCheck] ${agent.getName()} run errored on thread ${rawThread.threadId} — cursor reverted to ${prevCursor ?? 'start'}`);
            return;
          }

          // Success — handle tagged agent routing
          const sent = await gmail.getLatestSentMessage(rawThread.threadId, checkStartTime);
          if (sent) {
            const tagged = allAgents.find((a) => a !== agent && sent.body.includes(`@${a.getName()}`));
            if (tagged) {
              const sentIdx = rawThread.messages.findIndex((m) => m.id === sent.id);
              const prevMsgId = sentIdx > 0 ? rawThread.messages[sentIdx - 1]!.id : null;
              if (prevMsgId) tagged.emailThreadStore.markSeen(rawThread.threadId, prevMsgId, inbound.subject);
              console.log(`[EmailCheck] ${agent.getName()} tagged @${tagged.getName()} — ${tagged.getName()} cursor set to ${prevMsgId ?? 'start'}`);
            }
          }

          // Mark thread as read when all involved agents have caught up
          const meta = threadMeta.get(rawThread.threadId);
          if (meta) {
            const allCaughtUp = meta.involvedAgents.every((a) => a.emailThreadStore.getLastSeen(rawThread.threadId) === meta.latestMsgId);
            if (allCaughtUp) {
              try {
                await gmail.markAsRead([meta.latestMsgId]);
                console.log(`[EmailCheck] all agents caught up on thread ${rawThread.threadId} — marked as read`);
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
      payload = { type: 'tool_result', id: event.id, name: event.name, result: null };
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
