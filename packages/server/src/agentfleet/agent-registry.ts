import { existsSync, mkdirSync, readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
import yaml from 'js-yaml';
import { BaseAgent } from '../agent/base-agent.js';
import { parseAgentDefinition } from '../agent/agent-definition.js';
import { Confirmations } from '../agent/executor/confirmations.js';
import { SessionHandler } from '../agent/session/session-handler.js';
import { SessionStore } from '../agent/session/session-store.js';
import { EmailThreadStore } from './tools/email-thread-store.js';
import type { Agent } from '../agent/types.js';
import type { AppConfig, ClientConfig } from '../config.js';
import type { EventBus } from './event-bus.js';
import type { ToolsRegistry } from './tools-registry.js';
import { loadPrompt } from '../agent/prompt-parts.js';
import { MONOREPO_ROOT } from '../root.js';

// Built-in agents directory (relative to this package — next to prompt-parts/)
const BUILTIN_AGENTS_DIR = resolve(MONOREPO_ROOT, 'agents');

/**
 * Loads agent definitions from:
 *   1. {cwd}/agents/{name}/agent.yml  (built-in)
 *   2. .user-data/agents/{name}/agent.yml  (dynamic)
 *
 * To add a new agent: drop agent.yml + prompt files in either location.
 * No code changes needed.
 */
export class AgentRegistry {
  private readonly agentsMap = new Map<string, Agent>();
  private readonly dynamicAgentsDir: string;
  private readonly builtinAgentsDir: string;

  constructor(
    private readonly toolsRegistry: ToolsRegistry,
    private readonly eventBus: EventBus,
    private readonly confirmations: Confirmations,
    private readonly config: AppConfig,
    private readonly clientConfig: ClientConfig,
    clientDataDir: string,
    builtinAgentsDir: string = BUILTIN_AGENTS_DIR,
  ) {
    this.dynamicAgentsDir = resolve(clientDataDir, 'agents');
    this.builtinAgentsDir = builtinAgentsDir;
  }

  load(): void {
    // 1. Built-in agents
    this.loadDir(this.builtinAgentsDir);

    // 2. Dynamic agents from {clientDataDir}/agents/
    this.loadDir(this.dynamicAgentsDir);

    if (this.agentsMap.size === 0) {
      console.warn('[AgentRegistry] No agents loaded — check agents/*/agent.yml');
    }
  }

  /** Hot-register a dynamic agent. Called by AgentTools.createAgent(). */
  register(yamlContent: string, promptBase: string): Agent {
    const map = yaml.load(yamlContent) as Record<string, any>;
    return this.loadAgent(map, promptBase);
  }

  get(name: string): Agent {
    const a = this.agentsMap.get(name);
    if (a) return a;
    const first = this.agentsMap.values().next().value;
    if (!first) throw new Error('No agents loaded');
    return first;
  }

  all(): Agent[] {
    return [...this.agentsMap.values()];
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private loadDir(dir: string): void {
    if (!existsSync(dir)) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const agentDir = resolve(dir, entry);
      const agentYml = resolve(agentDir, 'agent.yml');
      if (!existsSync(agentYml)) continue;
      try {
        const map = yaml.load(readFileSync(agentYml, 'utf-8')) as Record<string, any>;
        this.loadAgent(map, agentDir);
      } catch (err: any) {
        console.warn(`[AgentRegistry] Failed to load ${agentYml}: ${err?.message}`);
      }
    }
  }

  private loadAgent(map: Record<string, any>, promptBase: string): Agent {
    const def = parseAgentDefinition(map, promptBase);

    // Provision workspace in the per-client agents directory
    const workspace = resolve(this.dynamicAgentsDir, def.name, 'workspace');
    try {
      mkdirSync(workspace, { recursive: true });
      this.toolsRegistry.registerAgentWorkspace(def.name, workspace, def.title);
    } catch (err: any) {
      console.warn(`[AgentRegistry] Failed to provision workspace for '${def.name}': ${err?.message}`);
    }

    // Build filtered tool list
    const filter = def.tools;
    const allTools = this.toolsRegistry.getTools();
    let toolDefs = allTools;
    if (filter) {
      const nameSet = new Set(filter.names);
      toolDefs = filter.mode === 'exclude'
        ? allTools.filter((t) => !nameSet.has(t.name))
        : allTools.filter((t) => nameSet.has(t.name));
    }
    // these tools are always available to every agent regardless of their filter
    // agent configs can only add to this set, not remove from it
    const ALWAYS_INCLUDE = [
      'agent_bash', 'shared_bash',
      'read_file', 'write_file', 'patch_file', 'append_file',
      'save_plan', 'get_plan', 'update_plan',
      'log_entry', 'read_log',
      'create_task', 'get_my_tasks', 'get_overdue_tasks', 'mark_task_complete', 'delete_task',
      'post_message', 'read_messages', 'read_topic', 'message_agent',
      'list_agents', 'read_agent_definition', 'update_agent',
      'get_current_datetime',
      'render_artifact', 'system_feedback',
      'read_emails', 'read_email_thread', 'read_email_message',
      'read_email_thread_summary', 'write_email_thread_summary',
      'fetch_email_attachment', 'send_file_email', 'send_email',
    ];
    for (const name of ALWAYS_INCLUDE) {
      if (!toolDefs.some((t) => t.name === name)) {
        const def = allTools.find((t) => t.name === name);
        if (def) toolDefs = [...toolDefs, def];
      }
    }
    const invoker = this.toolsRegistry.makeInvoker(toolDefs);

    // Hires provider: agents whose manager is this agent
    const hiresProvider = () =>
      this.all()
        .filter((a) => a.getDefinition().manager === def.name)
        .map((a) => a.getName());

    const store = new SessionStore(this.dynamicAgentsDir, def.name);
    const session = new SessionHandler(this.config, store, def.name);
    const emailThreadStore = new EmailThreadStore(this.dynamicAgentsDir, def.name);

    const agent = new BaseAgent(
      def,
      invoker,
      this.confirmations,
      this.config,
      this.clientConfig,
      this.dynamicAgentsDir,
      this.eventBus,
      hiresProvider,
      session,
      emailThreadStore,
    );
    this.agentsMap.set(def.name, agent);
    console.log(`[AgentRegistry] Loaded agent '${def.name}' from ${promptBase}`);
    return agent;
  }

  /** Returns resolved identity text for a named agent (used by AgentFleet). */
  identityText(name: string): string {
    const a = this.get(name);
    const def = a.getDefinition();
    if (!def.identity.length) return '';
    return def.identity.map((f) => loadPrompt(def.promptBase, f)).join('\n\n');
  }
}
