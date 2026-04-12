import { AgentRegistry } from './agent-registry.js';
import { AgentRouter } from './agent-router.js';
import { EventBus } from './event-bus.js';
import type { ToolsRegistry } from './tools-registry.js';
import { loadPrompt } from '../agent/prompt-parts.js';
import type { AppConfig, ClientConfig } from '../config.js';
import type { Confirmations } from '../agent/executor/confirmations.js';

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
    private readonly clientConfig: ClientConfig,
    private readonly toolsRegistry: ToolsRegistry,
    private readonly confirmations: Confirmations,
  ) {
    this.registry = registry;
    this.eventBus = eventBus;
    this.router = router;
  }

  getEventBus(): EventBus { return this.eventBus; }
  getConfirmations(): Confirmations { return this.confirmations; }

  // ── Directory / resource access ───────────────────────────────────────────────

  getAgentsDir(): string {
    return this.toolsRegistry.getAgentsDir();
  }

  getTopicsDir(): string {
    return this.toolsRegistry.topics.getTopicsDir();
  }

  getScheduledTasks() {
    return this.toolsRegistry.getScheduledTasks();
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
    if (!gmail) {
      console.log(`[EmailCheck:${this.clientConfig.id}] skipped — Gmail not configured`);
      return;
    }
    await this.router.handleEmailCheck(gmail, this.clientConfig.contacts, this.clientConfig.mailboxAddress, this.clientConfig.email);
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
    for (const agent of this.registry.all()) {
      this.initTasksForAgent(agent.getDefinition());
    }
  }

  /** Upserts recurring tasks for a single agent. Called for dynamically created agents. */
  initTasksForAgent(def: import('../agent/agent-definition.js').AgentDefinition): void {
    const tasks = this.toolsRegistry.getScheduledTasks();
    for (const rt of def.recurringTasks) {
      if (rt.disabled) continue;
      const description = loadPrompt(def.promptBase, rt.promptFile);
      tasks.upsert(
        'platform',
        rt.name,
        description,
        rt.cadenceHours,
        new Date().toISOString(),
        def.name,
      );
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


