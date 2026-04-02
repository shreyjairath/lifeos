import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import type { ToolDefinition, ToolInvoker, ChannelLog } from '../agent/types.js';
import { MONOREPO_ROOT } from '../root.js';

// Tool implementations — filled in Phase 5
import { Bash } from './tools/bash.js';
import { AgentLog } from './tools/agent-log.js';
import type { GmailClient } from './tools/gmail.js';
import { ScheduledTasks } from './tools/scheduled-tasks.js';
import { SessionToolsImpl } from './tools/session-tools.js';
import { AgentChannels } from './tools/agent-channels.js';
import { AgentTopics } from './tools/agent-topics.js';

// These are imported lazily to break circular deps
type AgentToolsImpl = import('./tools/agent-tools.js').AgentTools;
type WebSearchImpl = import('./tools/web-search.js').WebSearch;
type BrowseImpl = import('./tools/browse.js').Browse;
type NotificationsImpl = import('./tools/notifications.js').Notifications;
type RemindersStoreImpl = import('./tools/reminders.js').ReminderStore;
type McpToolsClientImpl = import('./tools/mcp-tools-client.js').McpToolsClient;

const USER_DATA = resolve(MONOREPO_ROOT, '.user-data');
export const AGENTS_DIR = resolve(USER_DATA, 'agents');
const SHARED_DIR = resolve(USER_DATA, 'shared');
const DISABLED_FILE = resolve(USER_DATA, 'disabled-tools.json');

// ── ToolsRegistry ─────────────────────────────────────────────────────────────

export class ToolsRegistry {
  private readonly agentBash = new Map<string, Bash>();
  private readonly agentBashReadonly = new Map<string, Bash>();
  private readonly agentLogs = new Map<string, AgentLog>();
  private readonly sharedTasks = new ScheduledTasks(resolve(USER_DATA, 'tasks.json'));
  private readonly sessionTools = new SessionToolsImpl();
  readonly channels: AgentChannels = new AgentChannels();
  readonly topics: AgentTopics = new AgentTopics();
  private readonly sharedBash = new Bash(SHARED_DIR, false);
  private gmailClient: GmailClient | null = null;

  setGmailClient(client: GmailClient): void {
    this.gmailClient = client;
  }

  // Injected by createApp() after construction
  agentTools!: AgentToolsImpl;
  webSearch!: WebSearchImpl;
  browse!: BrowseImpl;
  notifications!: NotificationsImpl;
  reminderStore!: RemindersStoreImpl;
  mcpClient!: McpToolsClientImpl;
  eventBusPublish!: (event: Record<string, any>) => void;

  init(): void {
    mkdirSync(resolve(USER_DATA, 'system'), { recursive: true });
    mkdirSync(SHARED_DIR, { recursive: true });
  }

  registerAgentWorkspace(name: string, workspacePath: string): void {
    this.agentBash.set(name, new Bash(workspacePath, false));
    this.agentBashReadonly.set(name, new Bash(workspacePath, true));
    this.agentLogs.set(name, new AgentLog(workspacePath));
  }

  agentChannels(): ChannelLog {
    return this.channels;
  }

  // ── Tool definitions ────────────────────────────────────────────────────────

  getTools(): ToolDefinition[] {
    const all: ToolDefinition[] = [...TOOLS, ...SESSION_TOOLS];
    const mcpTools = this.mcpClient?.getTools() ?? [];
    all.push(...mcpTools);
    const disabled = this.loadDisabledTools();
    if (disabled.size === 0) return all;
    return all.filter((t) => !disabled.has(t.name));
  }

  allToolNames(): string[] {
    return [...TOOLS, ...SESSION_TOOLS].map((t) => t.name);
  }

  loadDisabledTools(): Set<string> {
    if (!existsSync(DISABLED_FILE)) return new Set();
    try {
      const arr = JSON.parse(readFileSync(DISABLED_FILE, 'utf-8')) as string[];
      return new Set(arr);
    } catch {
      return new Set();
    }
  }

  saveDisabledTools(names: Set<string>): void {
    mkdirSync(resolve(USER_DATA), { recursive: true });
    writeFileSync(DISABLED_FILE, JSON.stringify([...names], null, 2), 'utf-8');
  }

  // ── Dispatch ────────────────────────────────────────────────────────────────

  async dispatch(toolName: string, input: Record<string, any>, agentName: string): Promise<Record<string, any>> {
    // Session tools
    const sessionResult = this.sessionTools.dispatch(toolName, input, agentName);
    if (sessionResult) return sessionResult;

    switch (toolName) {
      case 'agent_bash': {
        const bash = this.agentBash.get(agentName);
        return bash
          ? bash.run(input.command as string)
          : { error: `No workspace registered for agent: ${agentName}` };
      }
      case 'read_agent_workspace': {
        const bash = this.agentBashReadonly.get(input.agent as string);
        return bash
          ? bash.run(input.command as string)
          : { error: `No workspace registered for agent: ${input.agent}` };
      }
      case 'shared_bash':
        return this.sharedBash.run(input.command as string);
      case 'send_email': {
        if (!this.gmailClient) return { error: 'Gmail not configured' };
        await this.gmailClient.send(
          input.to as string,
          input.subject as string,
          input.body as string,
          input.thread_id as string | undefined,
        );
        return { sent: true };
      }
      case 'get_current_datetime': {
        const now = new Date();
        return {
          datetime: new Intl.DateTimeFormat('en-US', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
            hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
          }).format(now),
          iso8601: now.toISOString(),
        };
      }
      case 'web_search':
        return this.webSearch.search(input.query as string);
      case 'browse_page':
        return this.browse.fetch(input.url as string);
      case 'show_image':
        return { url: input.url, caption: input.caption ?? '' };
      case 'notify_user':
        return this.notifications.notifyUser(
          agentName, input.message as string, input.urgency as string, input.context as string,
        );
      case 'set_reminder':
        return this.reminderStore.set(input.time as string, input.message as string);
      case 'list_reminders':
        return this.reminderStore.list();
      case 'delete_reminder':
        return this.reminderStore.delete(input.id as string);
      case 'create_task':
        return this.sharedTasks.upsert(
          agentName,
          input.name as string,
          input.description as string,
          input.cadence_hours != null ? Number(input.cadence_hours) : null,
          input.due_at as string,
          input.assignee as string ?? null,
        );
      case 'get_my_tasks':
        return this.sharedTasks.list(agentName);
      case 'get_tasks':
        return this.sharedTasks.list(input.assignee as string ?? null);
      case 'get_overdue_tasks':
        return this.sharedTasks.getOverdue(agentName);
      case 'mark_task_complete':
        return this.sharedTasks.markComplete(input.id as string, agentName);
      case 'delete_task':
        return this.sharedTasks.delete(input.id as string);
      case 'log_entry': {
        const log = this.agentLogs.get(agentName);
        return log
          ? log.append(input.mode as string, input.summary as string, input.changed as string, input.notes as string)
          : { error: `No workspace registered for agent: ${agentName}` };
      }
      case 'read_log': {
        const log = this.agentLogs.get(agentName);
        return log
          ? log.read(input.entries != null ? Number(input.entries) : undefined)
          : { error: `No workspace registered for agent: ${agentName}` };
      }
      case 'read_agent_message_history':
        return this.channels.readChannel(agentName, input.agent as string);
      case 'message_agent':
        return this.agentTools.messageAgent(agentName, input.agent as string, input.message as string);
      case 'message_agent_async':
        return this.agentTools.messageAgentAsync(agentName, input.agent as string, input.message as string);
      case 'write_to_topic':
        return this.topics.writeTopic(agentName, input.topic as string, input.message as string);
      case 'read_topic':
        return this.topics.readTopic(agentName, input.topic as string);
      case 'list_topics':
        return this.topics.listTopics(agentName);
      case 'read_agent_definition':
        return this.agentTools.readAgentDefinition(input.agent as string);
      case 'update_agent':
        return this.agentTools.updateAgent(
          input.name as string,
          input.title as string ?? null,
          input.description as string ?? null,
          input.goal as string ?? null,
          input.manager as string ?? null,
          input.identity as string ?? null,
          input.chat_instructions as string ?? null,
          Array.isArray(input.tools) ? input.tools.map(String) : null,
        );
      case 'list_agents':
        return this.agentTools.listAgents(agentName);
      case 'list_tools':
        return {
          tools: this.getTools().map((t) => ({ name: t.name, description: t.description })),
        };
      case 'create_agent':
        return this.agentTools.createAgent(
          input.name as string,
          input.title as string ?? null,
          input.description as string ?? null,
          input.goal as string ?? null,
          input.manager as string ?? null,
          input.identity as string,
          input.chat_instructions as string,
          Array.isArray(input.tools) ? input.tools.map(String) : [],
        );
      case 'render_artifact': {
        const path = input.path as string;
        const title = (input.title as string) ?? '';
        if (!path?.trim()) return { error: 'path is required' };
        if (path.startsWith('https://') || path.startsWith('http://')) {
          return { url: path, title, path };
        }
        const artifactsDir = resolve(AGENTS_DIR, agentName, 'workspace', '_artifacts');
        const file = resolve(artifactsDir, path);
        if (!file.startsWith(artifactsDir)) return { error: `Path outside _artifacts folder: ${path}` };
        if (!existsSync(file)) return { error: `File not found in _artifacts/: ${path}` };
        const url = `/api/artifacts/${agentName}/${path}`;
        this.eventBusPublish({ type: 'artifact_updated', agent: agentName, url, title, path });
        return { url, title, path };
      }
      default:
        if (toolName.startsWith('mcp_')) {
          return this.mcpClient.callTool(toolName, input);
        }
        return { error: `Unknown tool: ${toolName}` };
    }
  }

  makeInvoker(toolDefs: ToolDefinition[]): ToolInvoker {
    return {
      definitions: () => toolDefs,
      invoke: (name, input, agent) => this.dispatch(name, input, agent) as any,
    };
  }
}

// ── Tool definitions ─────────────────────────────────────────────────────────

function tool(
  name: string,
  description: string,
  properties: Record<string, any>,
  required: string[] = [],
): ToolDefinition {
  const schema: Record<string, any> = { type: 'object', properties };
  if (required.length > 0) schema.required = required;
  return { name, description, input_schema: schema };
}

function prop(name: string, type: string, description: string): [string, Record<string, any>] {
  return [name, { type, description }];
}

function props(...entries: [string, Record<string, any>][]): Record<string, any> {
  return Object.fromEntries(entries);
}

const TOOLS: ToolDefinition[] = [
  tool('agent_bash',
    'Your personal workspace. Use this to read and write your notes and files. ' +
    'The shell starts in your workspace — use relative paths (e.g. ls, cat file.md). ' +
    'Do not use ~/, $HOME, or absolute paths. ' +
    'Standard shell tools available: ls, cat, echo, grep, mkdir, rm, mv, cp, sed, awk, jq, python3, etc. ' +
    'Path traversal (../), ~/, $HOME, network tools, and privilege escalation are blocked.',
    props(prop('command', 'string', 'Bash command to run.')), ['command']),

  tool('send_email',
    'Send an email on behalf of the user. Use to reply to an incoming email or compose a new one. ' +
    'Provide thread_id when replying so the message stays in the same thread.',
    props(
      prop('to', 'string', 'Recipient email address'),
      prop('subject', 'string', 'Email subject'),
      prop('body', 'string', 'Plain text email body'),
      prop('thread_id', 'string', 'Thread ID to reply within (from incoming email context). Omit for a new email.'),
    ),
    ['to', 'subject', 'body']),

  tool('shared_bash',
    'Shared folder for passing files between agents — NOT for your own notes (use agent_bash for that). ' +
    'Use this when you need another agent to read something you produced, or to read what another agent left for you. ' +
    'The shell starts in the shared folder — use relative paths. ' +
    'Same restrictions as agent_bash: no path traversal, no network tools, no absolute paths.',
    props(prop('command', 'string', 'Bash command to run in the shared folder.')), ['command']),

  tool('browse_page',
    'Fetch and read the content of a web page. ' +
    'Use to read a specific URL in full. For discovery, use web_search first.',
    props(prop('url', 'string', 'Full URL to fetch')), ['url']),

  tool('parse_redfin_listing',
    'Parse a Redfin listing URL and return structured property data: price, beds/baths, sq ft, HOA, year built, amenities, coordinates, MLS number, description, and photo URLs.',
    props(prop('url', 'string', 'Redfin listing URL')), ['url']),

  tool('parse_redfin_search',
    'Parse a Redfin search results page and return all listed properties with price, beds, baths, sq ft, and URL. ' +
    'IMPORTANT: Use zipcode URLs (e.g. redfin.com/zipcode/60614/filter/...) — neighborhood URLs (/neighborhood/...) do not work. ' +
    'Filters can be appended: /filter/property-type=condo,min-beds=2,max-price=700k',
    props(prop('url', 'string', 'Redfin zipcode or city search URL. Do NOT use /neighborhood/ URLs.')), ['url']),

  tool('property_report',
    'Generate a comprehensive property report for any address. Includes building obstruction analysis, sun exposure, corner unit detection, floor number, street noise, neighborhood walkability, transit access, parks, flood zone, and elevation.',
    props(prop('address', 'string', "Full street address including unit number if applicable (e.g. '123 Main St #4N, Chicago, IL')")),
    ['address']),

  tool('web_search',
    'Search the web for information. ' +
    'Use for discovery and finding URLs. Follow up with browse_page to read specific pages in full.',
    props(prop('query', 'string', 'Search query')), ['query']),

  tool('show_image', 'Display an image inline in the chat.',
    props(prop('url', 'string', 'Image URL'), prop('caption', 'string', 'Optional caption')),
    ['url']),

  tool('get_current_datetime',
    'Get the current date and time. ' +
    'Call before set_reminder, create_task with due_at, or any time-relative calculation.',
    props(), []),

  tool('notify_user',
    'Send an immediate notification to the user. ' +
    'Use this when you find something genuinely important — a risk, a time-sensitive finding, or something requiring their attention. ' +
    'Available in background modes only (heartbeat, post-session). Do NOT use for routine updates or progress reports.',
    props(
      prop('message', 'string', 'Short, direct message — treat it like a text. No preamble, no pleasantries. 1–3 sentences max.'),
      ['urgency', { type: 'string', enum: ['low', 'medium', 'high'], description: 'low=informational, medium=action needed soon, high=time-sensitive/urgent' }],
      prop('context', 'string', 'Optional additional detail shown in-app (not in the OS push notification)'),
    ),
    ['message']),

  tool('set_reminder',
    'Schedule a reminder that fires at a specific future time. ' +
    'Always call get_current_datetime first to know the current time before computing the target time. ' +
    'time must be a full ISO-8601 datetime with timezone offset (e.g. 2026-03-15T15:00:00-05:00).',
    props(
      prop('time', 'string', 'ISO-8601 datetime with timezone offset when the reminder should fire'),
      prop('message', 'string', 'Reminder message shown to the user'),
    ),
    ['time', 'message']),

  tool('list_reminders', 'List all pending (not yet fired) reminders.', props(), []),

  tool('delete_reminder', 'Cancel a pending reminder by id.',
    props(prop('id', 'string', 'Reminder id from list_reminders')), ['id']),

  tool('create_task',
    'Create or update a task on the shared task board. ' +
    'Upserts by name within your namespace (same name + you = update). ' +
    'due_at is always required. Add cadence_hours to make it recurring.',
    props(
      prop('name', 'string', 'Short task name (unique per creator — upsert)'),
      prop('description', 'string', 'What needs to be done'),
      prop('assignee', 'string', 'Who is responsible: "user", an agent name, or omit for self'),
      prop('due_at', 'string', 'ISO-8601 due datetime (e.g. 2026-04-01T09:00:00-05:00). Required.'),
      prop('cadence_hours', 'number', 'Recurring interval in hours (e.g. 24, 168). Omit for one-off.'),
    ),
    ['name', 'description', 'due_at']),

  tool('get_my_tasks',
    'List tasks assigned to you on the shared board.',
    props(), []),

  tool('get_tasks',
    'List tasks on the shared board across all agents. Optionally filter by assignee.',
    props(prop('assignee', 'string', 'Filter by assignee: "user", an agent name, or omit for all')),
    []),

  tool('get_overdue_tasks',
    'List overdue tasks assigned to you.',
    props(), []),

  tool('mark_task_complete',
    'Mark a task as completed now. For recurring tasks, this resets the clock.',
    props(prop('id', 'string', 'Task id from get_my_tasks or get_overdue_tasks')),
    ['id']),

  tool('delete_task',
    'Permanently remove a task from the board.',
    props(prop('id', 'string', 'Task id from get_my_tasks or get_tasks')),
    ['id']),

  tool('log_entry',
    'Append a structured log entry to _log.md. ' +
    'Call at the end of every background run: post-session, heartbeat, self-eval, and inter-agent-message.',
    props(
      prop('mode', 'string', 'Run mode: chat, post-session, heartbeat, self-eval, or inter-agent-message'),
      prop('summary', 'string', '1–3 sentence summary of what happened'),
      prop('changed', 'string', 'Files changed and what changed in each (omit if nothing changed)'),
      prop('notes', 'string', 'Additional context, findings, or decisions (optional)'),
    ),
    ['mode', 'summary']),

  tool('read_log',
    'Read your own _log.md — past activity recorded by log_entry. ' +
    'Returns recent entries newest-last. Defaults to last 10 entries.',
    props(prop('entries', 'number', 'Number of recent entries to return (default: 10)')),
    []),

  tool('read_agent_message_history',
    'Read the message history between you and another agent (last 10 exchanges).',
    props(prop('agent', 'string', "Agent name (e.g. 'therapist'). Use list_agents to see available agents.")),
    ['agent']),

  tool('message_agent',
    'Send a message to another agent and receive their response synchronously. ' +
    'BLOCKING: waits for the full response — up to 90 seconds. ' +
    'NEVER call this during user chat — use message_agent_async instead. ' +
    'For background modes only: post-session, heartbeat, self-eval, inter-agent-message.',
    props(
      prop('agent', 'string', "Agent name to message (e.g. 'therapist'). Use list_agents to see available agents."),
      prop('message', 'string', 'Message to send to the agent.'),
    ),
    ['agent', 'message']),

  tool('message_agent_async',
    'Send a non-blocking message to another agent. Returns immediately — safe to use during user chat.',
    props(
      prop('agent', 'string', "Agent name to message (e.g. 'therapist'). Use list_agents to see available agents."),
      prop('message', 'string', 'Message to send to the agent.'),
    ),
    ['agent', 'message']),

  tool('write_to_topic',
    'Post a message to the shared team knowledge board. Use topic "knowledge" for all team-wide sharing.',
    props(
      prop('topic', 'string', 'Topic name — use "knowledge" for standard team-wide sharing'),
      prop('message', 'string', 'Message to post — be specific. State what changed, what it means, and what others should do with it.'),
    ),
    ['topic', 'message']),

  tool('read_topic',
    'Read new messages on a topic since your last check. ' +
    'On first read: returns up to the last 20 entries. On subsequent reads: returns only new messages.',
    props(prop('topic', 'string', 'Topic name — use "knowledge" for the shared team board')),
    ['topic']),

  tool('list_topics',
    'List all topics on the knowledge board with their subscriber lists.',
    props(), []),

  tool('read_agent_workspace',
    'Read-only access to another agent\'s workspace. Write operations are blocked.',
    props(
      prop('agent', 'string', "Agent name (e.g. 'therapist', 'pm_coach'). Use list_agents to see available agents."),
      prop('command', 'string', 'Read-only bash command (ls, cat, grep, etc.)'),
    ),
    ['agent', 'command']),

  tool('read_agent_definition',
    'Read the full definition of a dynamic agent — its agent.yml config and all prompt files.',
    props(prop('agent', 'string', "Agent name (e.g. 'pm_coach')")),
    ['agent']),

  tool('update_agent',
    'Update a dynamic agent\'s definition. Only the fields you provide are changed. Use read_agent_definition first.',
    props(
      prop('name', 'string', 'Agent slug to update'),
      prop('title', 'string', 'New display name'),
      prop('description', 'string', 'New one-sentence description'),
      prop('goal', 'string', 'Durable, concrete purpose statement'),
      prop('manager', 'string', 'Agent name of the manager (e.g. "cos", "advisor")'),
      prop('identity', 'string', 'New identity prompt'),
      prop('chat_instructions', 'string', 'New session-mode instructions'),
      ['tools', { type: 'array', items: { type: 'string' }, description: 'New tool list (replaces current list)' }],
    ),
    ['name']),

  tool('list_agents',
    'List all agents currently registered in the system with their name and title.',
    props(), []),

  tool('list_tools',
    'List all tools available in the system with their names and descriptions.',
    props(), []),

  tool('render_artifact',
    'Display a file in a persistent panel next to the chat. ' +
    'Use for anything long-form: reports, summaries, plans, HTML visualizations. ' +
    'Accepts a path relative to your workspace/_artifacts/ folder or a full URL.',
    props(
      prop('path', 'string', 'Filename within workspace/_artifacts/ (e.g. "report.md") or a full https:// URL'),
      prop('title', 'string', 'Optional title shown in the artifact panel header'),
    ),
    ['path']),

  tool('create_agent',
    'Create a new specialist agent and register it immediately.',
    props(
      prop('name', 'string', 'Agent slug: lowercase letters, digits, underscores (e.g. "pm_coach")'),
      prop('title', 'string', 'Display name shown in the UI (e.g. "PM Coach")'),
      prop('description', 'string', 'One-sentence description of what this agent does.'),
      prop('goal', 'string', 'Durable, concrete purpose statement'),
      prop('manager', 'string', 'Agent name of the manager who hired this agent (e.g. "cos", "advisor"). Omit if hired directly by the client.'),
      prop('identity', 'string', 'Durable identity prompt.'),
      prop('chat_instructions', 'string', 'Session-mode instructions — how the agent shows up when the user is present.'),
      ['tools', { type: 'array', items: { type: 'string' }, description: 'Tool names to expose to this agent in addition to agent_bash (always included automatically).' }],
    ),
    ['name', 'identity', 'chat_instructions', 'tools']),
];

const SESSION_TOOLS: ToolDefinition[] = [
  tool('list_sessions',
    'List past sessions with their date and title. Start here. Find the session_id, then call read_session_summary or read_session_transcript.',
    props(), []),

  tool('read_session_summary',
    'Read the summary of a past session by its session_id.',
    props(prop('session_id', 'string', 'Session ID from list_sessions')),
    ['session_id']),

  tool('read_session_transcript',
    'Read the conversation transcript of a past session (user and assistant messages only, no tool calls). ' +
    'Call list_sessions first to find the session_id. Use read_session_summary if you only need an overview.',
    props(prop('session_id', 'string', 'Session ID from list_sessions')),
    ['session_id']),
];
