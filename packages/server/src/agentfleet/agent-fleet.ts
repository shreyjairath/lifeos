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

  triggerHeartbeat(): void {
    for (const a of this.registry.all()) {
      const def = a.getDefinition();
      if (!def.disabledModes.has('heartbeat_trigger')) {
        this.trigger('heartbeat_trigger', { agent: def.name });
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
