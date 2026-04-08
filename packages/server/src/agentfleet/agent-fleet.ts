import { AgentRegistry } from './agent-registry.js';
import { AgentRouter } from './agent-router.js';
import { EventBus } from './event-bus.js';
import type { ToolsRegistry } from './tools-registry.js';
import { ScheduledTasks } from './tools/scheduled-tasks.js';
import { loadPrompt } from '../agent/prompt-parts.js';
import { resolve } from 'path';
import { AGENTS_DIR } from './tools-registry.js';
import type { AppConfig } from '../config.js';
import { MONOREPO_ROOT } from '../root.js';

const USER_DATA = resolve(MONOREPO_ROOT, '.user-data');

/**
 * Public surface of the platform layer.
 * Exposes chat routing, agent enumeration, session management, and event triggers
 * without leaking internal components to the routes layer.
 */
export class AgentFleet {
  readonly eventBus: EventBus;
  private readonly registry: AgentRegistry;
  private readonly router: AgentRouter;
  private readonly inFlightTaskIds = new Set<string>();

  constructor(
    registry: AgentRegistry,
    eventBus: EventBus,
    router: AgentRouter,
    private readonly config: AppConfig,
    private readonly toolsRegistry: ToolsRegistry,
  ) {
    this.registry = registry;
    this.eventBus = eventBus;
    this.router = router;
  }

  // ── Chat routing ─────────────────────────────────────────────────────────────

  handleMessage(
    sessionId: string | undefined,
    message: string,
    agentName: string,
    model?: string,
  ) {
    return this.router.handleMessage(sessionId, message, agentName, model);
  }

  // ── Agent enumeration ─────────────────────────────────────────────────────────

  allAgents() {
    return this.registry.all();
  }

  agentInfo(agentName: string): Record<string, any> {
    const a = this.registry.get(agentName);
    const def = a.getDefinition();
    return {
      name: def.name,
      title: def.title,
      description: def.description,
      model: def.model,
      effectiveModel: def.model ?? this.config.model,
      backgroundModel: def.backgroundModel,
      manager: def.manager,
      reasoning: def.reasoning,
      tools: def.tools,
      disabledModes: [...def.disabledModes],
    };
  }

  agentDefinitionText(name: string): Record<string, any> {
    const a = this.registry.get(name);
    const def = a.getDefinition();
    const identityText = def.identity
      .map((f) => loadPrompt(def.promptBase, f))
      .join('\n\n');
    return { identityText };
  }

  // ── Session management ────────────────────────────────────────────────────────

  getHistory(agentName: string, sessionId: string): Record<string, any> {
    const messages = this.registry.get(agentName).getSessionHandler().getHistory(sessionId);
    return { messages, session_id: sessionId };
  }

  clearSession(agentName: string, sessionId: string): void {
    this.registry.get(agentName).getSessionHandler().clearSession(sessionId);
  }

  truncateSession(agentName: string, sessionId: string, fromIndex: number): number {
    return this.registry.get(agentName).getSessionHandler().truncateSession(sessionId, fromIndex);
  }

  listAllSessions(): Record<string, any>[] {
    return this.registry.all().flatMap((a) => a.getSessionHandler().listSessions());
  }

  listSessions(agentName: string): Record<string, any>[] {
    return this.registry.get(agentName).getSessionHandler().listSessions();
  }

  createSession(agentName: string): string {
    return this.registry.get(agentName).getSessionHandler().createNew(agentName);
  }

  deleteSession(agentName: string, sessionId: string): void {
    this.registry.get(agentName).getSessionHandler().delete(sessionId);
  }

  pruneSessions(agentName: string): void {
    this.registry.get(agentName).getSessionHandler().pruneEmptySessions();
  }

  checkExpiredSessions(): void {
    for (const a of this.registry.all()) {
      a.getSessionHandler().checkExpiredSessions();
    }
  }

  // ── Run control ───────────────────────────────────────────────────────────────

  cancel(agentName: string, sessionId: string): void {
    this.registry.get(agentName).cancel(sessionId);
  }

  // ── Event triggers ─────────────────────────────────────────────────────────────

  trigger(eventType: string, extra?: Record<string, any>): void {
    this.eventBus.publish({ ...extra, type: eventType });
  }

  async triggerEmailCheck(): Promise<void> {
    const gmail = this.toolsRegistry.getGmailClient();
    if (!gmail) return;

    console.log('[EmailCheck] starting poll');

    let rawThreads: import('../agentfleet/tools/gmail.js').RawThread[];
    try {
      rawThreads = await gmail.fetchInboxThreads();
    } catch (err: any) {
      console.warn('[EmailCheck] fetch failed:', err?.message);
      return;
    }
    console.log(`[EmailCheck] fetched ${rawThreads.length} inbox thread(s)`);
    if (!rawThreads.length) return;

    const allAgents = this.registry.all();
    const cosAgent = this.registry.get('cos');
    const agentNames = new Set(allAgents.map((a) => a.getName()));
    const checkStartTime = Date.now();

    // bucket: agentName → { agent, emails[], rawThread[] (parallel array) }
    type Bucket = { agent: import('../agent/types.js').Agent; emails: import('../agentfleet/tools/gmail.js').EmailMessage[]; thread: import('../agentfleet/tools/gmail.js').RawThread };
    const buckets = new Map<string, Bucket[]>();

    for (const rawThread of rawThreads) {
      const allMsgs = rawThread.messages;
      const latestMsg = allMsgs[allMsgs.length - 1]!;

      // Determine the "sender" of the latest inbox message for contact lookup
      const latestInbox = [...allMsgs].reverse().find((m) => m.labelIds.includes('INBOX') && !m.labelIds.includes('SENT'));
      const senderEmail = latestInbox ? extractEmail(latestInbox.from) : extractEmail(latestMsg.from);
      const contact = this.config.contacts.find((c) => c.email === senderEmail);

      // Collect all @mentions across the entire thread to find involved agents
      const fullThreadText = allMsgs.map((m) => m.mentionText).join('\n');

      const findInvolved = (allowed: import('../agent/types.js').Agent[]): import('../agent/types.js').Agent[] => {
        const involved = allowed.filter((a) => fullThreadText.includes(`@${a.getName()}`));
        return involved;
      };

      let involved: import('../agent/types.js').Agent[];
      if (contact) {
        const allowed = allAgents.filter((a) => contact.agents.includes(a.getName()));
        involved = findInvolved(allowed);
        if (involved.length === 0) involved = [this.registry.get(contact.fallback)];
      } else {
        involved = findInvolved(allAgents);
        if (involved.length === 0) involved = [cosAgent];
      }

      // For each involved agent, check what messages are new to them
      for (const agent of involved) {
        const lastSeen = agent.emailThreadStore.getLastSeen(rawThread.threadId);
        const lastSeenIdx = lastSeen ? allMsgs.findIndex((m) => m.id === lastSeen) : -1;
        const newMsgs = allMsgs.slice(lastSeenIdx + 1).filter((m) => !m.labelIds.includes('SENT'));
        if (newMsgs.length === 0) continue; // agent is up to date

        // Build EmailMessage[] from newMsgs with prior context
        const priorMsgs = allMsgs.slice(0, lastSeenIdx + 1);
        const prior: import('../agentfleet/tools/gmail.js').ThreadMessage[] = priorMsgs.map((m) => ({
          from: m.from,
          date: new Date(m.internalDate).toUTCString(),
          body: m.body,
        }));
        const emailMsgs: import('../agentfleet/tools/gmail.js').EmailMessage[] = newMsgs.map((m) => ({
          messageId: m.id,
          rfcMessageId: m.rfcMessageId,
          threadId: rawThread.threadId,
          from: m.from,
          to: m.to,
          cc: m.cc,
          subject: m.subject,
          body: m.body,
          thread: prior,
        }));

        console.log(`[EmailCheck] routing "${latestMsg.subject}" → ${agent.getName()} (${newMsgs.length} new message(s))`);
        if (!buckets.has(agent.getName())) buckets.set(agent.getName(), []);
        buckets.get(agent.getName())!.push({ agent, emails: emailMsgs, thread: rawThread });
      }
    }

    // Per-thread metadata for mark-as-read coordination across agents
    const threadMeta = new Map<string, {
      involvedAgents: import('../agent/types.js').Agent[];
      latestInboxMsgId: string;
      latestMsgId: string;
    }>();
    for (const rawThread of rawThreads) {
      const latestInboxMsg = [...rawThread.messages].reverse().find((m) => m.labelIds.includes('INBOX') && !m.labelIds.includes('SENT'));
      if (!latestInboxMsg) continue;
      // Recompute involved for this thread (same logic as above)
      const fullThreadText = rawThread.messages.map((m) => m.mentionText).join('\n');
      const latestInboxSender = extractEmail(latestInboxMsg.from);
      const contact = this.config.contacts.find((c) => c.email === latestInboxSender);
      let involved: import('../agent/types.js').Agent[];
      if (contact) {
        const allowed = allAgents.filter((a) => contact.agents.includes(a.getName()));
        involved = allowed.filter((a) => fullThreadText.includes(`@${a.getName()}`));
        if (involved.length === 0) involved = [this.registry.get(contact.fallback)];
      } else {
        involved = allAgents.filter((a) => fullThreadText.includes(`@${a.getName()}`));
        if (involved.length === 0) involved = [cosAgent];
      }
      threadMeta.set(rawThread.threadId, {
        involvedAgents: involved,
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

          // Check if agent sent a reply tagging another agent
          const sent = await gmail.getLatestSentMessage(thread.threadId, checkStartTime);
          if (sent) {
            const tagged = allAgents.find((a) => a !== agent && sent.body.includes(`@${a.getName()}`));
            if (tagged) {
              const sentIdx = thread.messages.findIndex((m) => m.id === sent.id);
              const prevMsgId = sentIdx > 0 ? thread.messages[sentIdx - 1]!.id : null;
              if (prevMsgId) tagged.emailThreadStore.markSeen(thread.threadId, prevMsgId);
              agent.emailThreadStore.markSeen(thread.threadId, sent.id);
              console.log(`[EmailCheck] ${agent.getName()} tagged @${tagged.getName()} — ${tagged.getName()} cursor set to ${prevMsgId ?? 'start'}`);
              return;
            }
          }

          // No tagging — advance cursor
          agent.emailThreadStore.markSeen(thread.threadId, latestNewMsg.messageId);
          console.log(`[EmailCheck] ${agent.getName()} cursor advanced to ${latestNewMsg.messageId} on thread ${thread.threadId}`);

          // Mark as read in Gmail if all involved agents are now caught up
          const meta = threadMeta.get(thread.threadId);
          if (meta) {
            const allCaughtUp = meta.involvedAgents.every((a) => {
              const seen = a.emailThreadStore.getLastSeen(thread.threadId);
              return seen === meta.latestMsgId;
            });
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

  async triggerTaskCheck(): Promise<void> {
    const tasks = this.toolsRegistry.getScheduledTasks();
    const overdue = tasks.getAllOverdue()
      .filter((t) => !this.inFlightTaskIds.has(t.id as string));

    if (!overdue.length) {
      console.log('[TaskCheck] no overdue tasks');
      return;
    }

    console.log(`[TaskCheck] found ${overdue.length} overdue task(s)`);

    const buckets = new Map<string, { agent: import('../agent/types.js').Agent; tasks: Record<string, any>[] }>();
    for (const task of overdue) {
      const assigneeName = task.assignee as string | null;
      if (!assigneeName) continue;
      let agent: import('../agent/types.js').Agent;
      try {
        agent = this.registry.get(assigneeName);
      } catch {
        console.warn(`[TaskCheck] assignee "${assigneeName}" not found for task "${task.name as string}" — skipping`);
        continue;
      }
      if (!buckets.has(assigneeName)) buckets.set(assigneeName, { agent, tasks: [] });
      buckets.get(assigneeName)!.tasks.push(task);
    }

    console.log(`[TaskCheck] dispatching to ${buckets.size} agent(s): ${[...buckets.keys()].join(', ')}`);
    for (const { agent, tasks: agentTasks } of buckets.values()) {
      for (const task of agentTasks) {
        this.inFlightTaskIds.add(task.id as string);
        agent.handleOverdueTask(task, () => {
          this.inFlightTaskIds.delete(task.id as string);
          tasks.markComplete(task.id as string, 'platform');
          console.log(`[TaskCheck] marked task "${task.name as string}" complete after ${agent.getName()} run`);
        });
      }
    }
  }

  // ── Background task board ──────────────────────────────────────────────────────

  /**
   * Called on startup — upserts recurring tasks from agent.yml into tasks.json.
   * Agents pick these up during heartbeat via get_overdue_tasks.
   */
  initBackgroundTasks(): void {
    const tasks = new ScheduledTasks(resolve(USER_DATA, 'tasks.json'));
    for (const agent of this.registry.all()) {
      const def = agent.getDefinition();
      for (const rt of def.recurringTasks) {
        const description = loadPrompt(def.promptBase, rt.promptFile);
        tasks.upsert(
          'platform',
          `${def.name}.${rt.name}`,
          description,
          rt.cadenceHours,
          new Date().toISOString(),
          def.name,
        );
      }
    }
  }

  // ── Tools management ──────────────────────────────────────────────────────────

  getAllToolsInfo(): { tools: string[]; disabled: string[] } {
    return {
      tools: this.toolsRegistry.allToolNames(),
      disabled: [...this.toolsRegistry.loadDisabledTools()],
    };
  }

  getDisabledTools(): string[] {
    return [...this.toolsRegistry.loadDisabledTools()];
  }

  setDisabledTools(names: string[]): void {
    this.toolsRegistry.saveDisabledTools(new Set(names));
  }
}

function extractEmail(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1]! : from).trim().toLowerCase();
}

