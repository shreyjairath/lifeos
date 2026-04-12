import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import yaml from 'js-yaml';
import type { AgentRegistry } from '../agent-registry.js';
import type { EventBus } from '../event-bus.js';
import type { AgentTopics } from './agent-topics.js';
import type { AgentDefinition } from '../../agent/agent-definition.js';

function randomId(): string {
  return Math.random().toString(36).slice(2, 8);
}

export class AgentTools {
  /** Called after a new agent is registered. Wired up by index.ts to init platform tasks. */
  onAgentCreated?: (def: AgentDefinition) => void;

  constructor(
    private readonly agentsDir: string,
    private readonly getRegistry: () => AgentRegistry,
    private readonly eventBus: EventBus,
    private readonly topics: AgentTopics,
  ) {}

  async messageAgent(fromAgent: string, targetAgent: string, message: string): Promise<Record<string, any>> {
    if (fromAgent === targetAgent) {
      return { error: 'Cannot message yourself. Use your workspace files to record notes and track state.' };
    }
    const registry = this.getRegistry();
    const agent = registry.get(targetAgent);
    if (!agent) return { error: `Agent '${targetAgent}' not found. Use list_agents to see available agents.` };
    const threadId = randomId();
    this.topics.writeTopic(fromAgent, 'feed', message, [targetAgent], threadId);
    try {
      const response = await agent.handleAgentMessage(fromAgent, message);
      this.topics.writeTopic(targetAgent, 'feed', response, [fromAgent], threadId);
      return { agent: targetAgent, response };
    } catch (err: any) {
      return { error: `Failed to message agent '${targetAgent}': ${err?.message ?? 'unknown'}` };
    }
  }

  postMessage(fromAgent: string, message: string, to: string[]): Record<string, any> {
    const threadId = randomId();
    this.topics.writeTopic(fromAgent, 'feed', message, to, threadId);
    if (to.length === 0) return { status: 'broadcast', thread_id: threadId };
    const registry = this.getRegistry();
    for (const target of to) {
      const agent = registry.get(target);
      if (!agent) continue;
      agent.handleAgentMessageAsync(fromAgent, message, (response) => {
        this.topics.writeTopic(target, 'feed', response, [fromAgent], threadId);
      });
    }
    return { status: 'queued', thread_id: threadId };
  }

  messageAgentAsync(fromAgent: string, targetAgent: string, message: string): Record<string, any> {
    if (fromAgent === targetAgent) return { error: 'Cannot message yourself.' };
    const registry = this.getRegistry();
    const agent = registry.get(targetAgent);
    if (!agent) return { error: `Agent '${targetAgent}' not found. Use list_agents to see available agents.` };
    const threadId = randomId();
    this.topics.writeTopic(fromAgent, 'feed', message, [targetAgent], threadId);
    agent.handleAgentMessageAsync(fromAgent, message, (response) => {
      this.topics.writeTopic(targetAgent, 'feed', response, [fromAgent], threadId);
    });
    return { status: 'queued', thread_id: threadId };
  }

  listAgents(callerName: string): Record<string, any> {
    const registry = this.getRegistry();
    const all = registry.all();
    return {
      agents: all.map((a) => {
        const entry: Record<string, any> = {
          name: a.getName(),
          title: a.getTitle(),
          description: a.getDescription(),
        };
        const def = a.getDefinition();
        if (def.goal) entry.goal = def.goal;
        if (def.manager) entry.manager = def.manager;
        const hires = all
          .filter((h) => h.getDefinition().manager === a.getName())
          .map((h) => h.getName());
        if (hires.length) entry.hires = hires;
        if (a.getName() === callerName) entry.self = true;
        return entry;
      }),
    };
  }

  readAgentDefinition(name: string): Record<string, any> {
    const agentDir = resolve(this.agentsDir, name);
    if (!existsSync(agentDir)) {
      return { error: `Agent '${name}' is not a dynamic agent or does not exist.` };
    }
    try {
      const agentYml = readFileSync(resolve(agentDir, 'agent.yml'), 'utf-8');
      const parsed = yaml.load(agentYml) as Record<string, any>;
      const result: Record<string, any> = { ...parsed };
      for (const file of ['identity.md', 'self-eval.md', 'heartbeat.md']) {
        const path = resolve(agentDir, file);
        if (existsSync(path)) result[file] = readFileSync(path, 'utf-8');
      }
      return result;
    } catch (err: any) {
      return { error: `Failed to read agent '${name}': ${err?.message}` };
    }
  }

  updateAgent(
    name: string,
    title: string | null,
    description: string | null,
    goal: string | null,
    manager: string | null,
    tools: string[] | null,
    identity: string | null,
  ): Record<string, any> {
    const agentDir = resolve(this.agentsDir, name);
    if (!existsSync(agentDir)) {
      return { error: `Agent '${name}' is not a dynamic agent or does not exist.` };
    }
    try {
      const currentYaml = yaml.load(readFileSync(resolve(agentDir, 'agent.yml'), 'utf-8')) as Record<string, any>;

      // Merge: start from existing YAML, only overwrite fields that were explicitly passed.
      // This preserves any keys not known to buildAgentYaml (recurring-tasks, disabled-modes, etc.)
      const merged = { ...currentYaml };
      if (title != null) merged.title = title.trim() || name;
      if (description != null) merged.description = description.trim();
      if (goal != null) merged.goal = goal.trim() || null;
      if (manager != null) merged.manager = manager.trim() || null;
      if (tools != null) {
        const allTools = tools.includes('agent_bash') ? tools : ['agent_bash', ...tools];
        merged.tools = { mode: 'include', names: allTools };
      }

      const yamlContent = yaml.dump(merged, { lineWidth: -1 });
      writeFileSync(resolve(agentDir, 'agent.yml'), yamlContent, 'utf-8');

      if (identity != null) {
        writeFileSync(resolve(agentDir, 'identity.md'), identity, 'utf-8');
      }

      this.getRegistry().register(yamlContent, agentDir);
      this.eventBus.publish({ type: 'agents_updated' });
      return { success: `Agent '${name}' updated and re-registered.` };
    } catch (err: any) {
      return { error: `Failed to update agent '${name}': ${err?.message}` };
    }
  }

  createAgent(
    name: string,
    title: string | null,
    description: string | null,
    goal: string | null,
    manager: string | null,
    identity: string,
    tools: string[],
  ): Record<string, any> {
    if (!name || !/^[a-z][a-z0-9_]*$/.test(name)) {
      return { error: 'Agent name must be lowercase alphanumeric + underscore, starting with a letter (e.g. "pm_coach")' };
    }
    const agentDir = resolve(this.agentsDir, name);
    try {
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(resolve(agentDir, 'identity.md'), identity, 'utf-8');

      const yamlContent = buildAgentYaml(name, title, description, goal, manager, tools);
      writeFileSync(resolve(agentDir, 'agent.yml'), yamlContent, 'utf-8');

      const agent = this.getRegistry().register(yamlContent, agentDir);
      this.onAgentCreated?.(agent.getDefinition());
      this.eventBus.publish({ type: 'agents_updated' });
      return { success: `Agent '${name}' created and registered. Switch to it with agent: "${name}"` };
    } catch (err: any) {
      return { error: `Failed to create agent '${name}': ${err?.message}` };
    }
  }
}

const BASIC_TOOLS = [
  'agent_bash',
  'save_plan', 'get_plan',
  'log_entry', 'read_log',
  'create_task', 'get_my_tasks', 'get_overdue_tasks', 'mark_task_complete', 'delete_task',
  'post_message', 'read_topic', 'message_agent',
  'list_agents', 'read_agent_definition',
  'get_current_datetime',
  'render_artifact', 'system_feedback',
  'read_emails', 'read_email_thread', 'read_email_message',
  'read_email_thread_summary', 'write_email_thread_summary',
  'fetch_email_attachment', 'send_file_email', 'send_email',
];

function buildAgentYaml(
  name: string,
  title: string | null,
  description: string | null,
  goal: string | null,
  manager: string | null,
  tools: string[],
): string {
  const allTools = [...new Set([...BASIC_TOOLS, ...tools])];
  const doc: Record<string, any> = { name };
  doc.title = title?.trim() || name;
  if (description?.trim()) doc.description = description.trim();
  if (goal?.trim()) doc.goal = goal.trim();
  if (manager?.trim()) doc.manager = manager.trim();
  doc.identity = ['identity.md'];
  doc.tools = { mode: 'include', names: allTools };
  doc['recurring-tasks'] = [
    { name: 'reconcile_workspace', prompt: 'reconcile-workspace.md', 'cadence-hours': 4 },
    { name: 'self_eval', prompt: 'self-eval.md', 'cadence-hours': 24 },
    { name: 'self_learning', prompt: 'self-learning.md', 'cadence-hours': 48 },
    { name: 'workspace_reorg', prompt: 'workspace-reorg.md', 'cadence-hours': 168 },
    { name: 'system_feedback', prompt: 'system-feedback.md', 'cadence-hours': 168 },
  ];
  return yaml.dump(doc, { lineWidth: -1 });
}
