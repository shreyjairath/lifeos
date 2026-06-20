import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve, extname, basename } from 'path';
import type { ToolDefinition, ToolInvoker } from '../agent/types.js';
import type { ClientConfig } from '../config.js';

// Tool implementations
import { Bash } from './tools/bash.js';
import { FileTools } from './tools/file-tools.js';
import type { GmailClient } from './tools/gmail.js';
import { ScheduledTasks } from './tools/scheduled-tasks.js';
import { SessionToolsImpl } from './tools/session-tools.js';
import { SessionStore } from '../agent/session/session-store.js';
import { AgentTopics } from './tools/agent-topics.js';
import { EmailThreadStore } from './tools/email-thread-store.js';
import { Redfin } from './tools/redfin.js';

// These are imported lazily to break circular deps
type AgentToolsImpl = import('./tools/agent-tools.js').AgentTools;
type WebSearchImpl = import('./tools/web-search.js').WebSearch;
type BrowseImpl = import('./tools/browse.js').Browse;
import { BrowseJs } from './tools/browse-js.js';
import type { Verifier as VerifierImpl } from './tools/verifier.js';

// ── ToolsRegistry ─────────────────────────────────────────────────────────────

export class ToolsRegistry {
  private readonly agentsDir: string;
  private readonly sharedDir: string;
  private readonly journalDir: string;
  private readonly disabledFile: string;
  private readonly agentBash = new Map<string, Bash>();
  private readonly agentBashReadonly = new Map<string, Bash>();
  private readonly agentFileTools = new Map<string, FileTools>();
  private readonly agentTitles = new Map<string, string>();
  private readonly sharedTasks: ScheduledTasks;
  private readonly sessionTools: SessionToolsImpl;
  readonly topics: AgentTopics;
  private readonly sharedBash: Bash;
  private readonly redfin = new Redfin();
  private browseJs!: BrowseJs;
  private gmailClient: GmailClient | null = null;
  clientEmail: string;
  private readonly mailboxAddress: string;
  private readonly allowedEmailAddresses: Set<string>;

  constructor(clientDataDir: string, clientConfig: ClientConfig) {
    this.agentsDir = resolve(clientDataDir, 'agents');
    this.sharedDir = resolve(clientDataDir, 'shared');
    this.journalDir = resolve(clientDataDir, 'journal');
    this.disabledFile = resolve(clientDataDir, 'disabled-tools.json');
    this.sharedTasks = new ScheduledTasks(resolve(clientDataDir, 'tasks.json'));
    this.sessionTools = new SessionToolsImpl((name) => new SessionStore(this.agentsDir, name));
    this.topics = new AgentTopics(resolve(clientDataDir, 'topics'));
    this.sharedBash = new Bash(this.sharedDir, false);
    this.clientEmail = clientConfig.email;
    this.mailboxAddress = clientConfig.mailboxAddress;
    this.allowedEmailAddresses = new Set([
      clientConfig.email.toLowerCase(),
      ...clientConfig.contacts.map((c) => c.email.toLowerCase()),
    ]);
  }

  setGmailClient(client: GmailClient): void {
    this.gmailClient = client;
  }

  getGmailClient(): GmailClient | null {
    return this.gmailClient;
  }

  getScheduledTasks(): ScheduledTasks {
    return this.sharedTasks;
  }

  getAgentsDir(): string {
    return this.agentsDir;
  }

  // Injected by createApp() after construction
  agentTools!: AgentToolsImpl;
  webSearch!: WebSearchImpl;
  browse!: BrowseImpl;
  set verifier(v: VerifierImpl) { this.browseJs = new BrowseJs(v); }
  eventBusPublish!: (event: Record<string, any>) => void;

  init(clientDataDir: string): void {
    mkdirSync(resolve(clientDataDir, 'system'), { recursive: true });
    mkdirSync(this.sharedDir, { recursive: true });
  }

  registerAgentWorkspace(name: string, workspacePath: string, title?: string): void {
    this.agentBash.set(name, new Bash(workspacePath, false));
    this.agentBashReadonly.set(name, new Bash(workspacePath, true));
    this.agentFileTools.set(name, new FileTools(workspacePath));
    if (title) this.agentTitles.set(name, title);
  }

  // ── Tool definitions ────────────────────────────────────────────────────────

  getTools(): ToolDefinition[] {
    const all: ToolDefinition[] = [...TOOLS, ...SESSION_TOOLS];
    const disabled = this.loadDisabledTools();
    if (disabled.size === 0) return all;
    return all.filter((t) => !disabled.has(t.name));
  }

  allToolNames(): string[] {
    return [...TOOLS, ...SESSION_TOOLS].map((t) => t.name);
  }

  loadDisabledTools(): Set<string> {
    if (!existsSync(this.disabledFile)) return new Set();
    try {
      const arr = JSON.parse(readFileSync(this.disabledFile, 'utf-8')) as string[];
      return new Set(arr);
    } catch {
      return new Set();
    }
  }

  saveDisabledTools(names: Set<string>): void {
    writeFileSync(this.disabledFile, JSON.stringify([...names], null, 2), 'utf-8');
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
      case 'read_file': {
        const rft = this.agentFileTools.get(agentName);
        return rft ? rft.read(input.path as string, input.offset as number | undefined, input.length as number | undefined) : { error: `No workspace registered for agent: ${agentName}` };
      }
      case 'write_file': {
        const wft = this.agentFileTools.get(agentName);
        return wft ? wft.write(input.path as string, input.content as string) : { error: `No workspace registered for agent: ${agentName}` };
      }
      case 'patch_file': {
        const pft = this.agentFileTools.get(agentName);
        return pft ? pft.patch(input.path as string, input.old_string as string, input.new_string as string) : { error: `No workspace registered for agent: ${agentName}` };
      }
      case 'append_file': {
        const aft = this.agentFileTools.get(agentName);
        return aft ? aft.append(input.path as string, input.content as string) : { error: `No workspace registered for agent: ${agentName}` };
      }
      case 'read_agent_workspace': {
        const bash = this.agentBashReadonly.get(input.agent as string);
        return bash
          ? bash.run(input.command as string)
          : { error: `No workspace registered for agent: ${input.agent}` };
      }
      case 'shared_bash':
        return this.sharedBash.run(input.command as string);
      case 'send_file_email': {
        if (!this.gmailClient) return { error: 'Gmail not configured — add credentials to .user-data/system/gmail-credentials.json' };
        const sendFileTo = (input.to as string | undefined)?.trim() || this.clientEmail;
        if (!sendFileTo) return { error: 'No recipient: provide to or configure client-email in config.yml' };
        if (!this.allowedEmailAddresses.has(extractEmail(sendFileTo))) return { error: `Not allowed to send email to ${sendFileTo} — only client and registered contacts are permitted recipients` };
        const workspace = resolve(this.agentsDir, agentName, 'workspace');
        const filePath = resolve(workspace, input.file_path as string);
        if (!filePath.startsWith(workspace)) return { error: 'Path outside workspace' };
        if (!existsSync(filePath)) return { error: `File not found: ${input.file_path}` };
        const fileFromName = this.agentTitles.get(agentName);
        const sendFileResult = await this.gmailClient.sendFile(
          sendFileTo,
          input.subject as string,
          filePath,
          input.thread_id as string | undefined,
          input.in_reply_to as string | undefined,
          fileFromName,
          input.cc as string | undefined,
          this.mailboxAddress || undefined,
        );
        return { sent: true, thread_id: sendFileResult.threadId, message_id: sendFileResult.messageId };
      }
      case 'send_email': {
        if (input.body !== undefined && input.html_body !== undefined) return { error: 'Provide either body or html_body, not both.' };
        if (!this.gmailClient) return { error: 'Gmail not configured — add credentials to .user-data/system/gmail-credentials.json' };
        const sendTo = (input.to as string | undefined)?.trim() || this.clientEmail;
        if (!sendTo) return { error: 'No recipient: provide to or configure client-email in config.yml' };
        if (!this.allowedEmailAddresses.has(extractEmail(sendTo))) return { error: `Not allowed to send email to ${sendTo} — only client and registered contacts are permitted recipients` };
        let attachments: { filename: string; mimeType: string; data: Buffer }[] | undefined;
        if (Array.isArray(input.attachments) && input.attachments.length > 0) {
          const workspace = resolve(this.agentsDir, agentName, 'workspace');
          attachments = [];
          for (const rel of input.attachments as string[]) {
            const filePath = resolve(workspace, rel);
            if (!filePath.startsWith(workspace)) return { error: `Path outside workspace: ${rel}` };
            if (!existsSync(filePath)) return { error: `Attachment not found: ${rel}` };
            attachments.push({
              filename: basename(filePath),
              mimeType: mimeTypeFromExt(extname(filePath)),
              data: readFileSync(filePath),
            });
          }
        }
        const fromName = this.agentTitles.get(agentName);
        const sendResult = await this.gmailClient.send(
          sendTo,
          input.subject as string,
          input.body as string | undefined,
          input.thread_id as string | undefined,
          input.html_body as string | undefined,
          input.in_reply_to as string | undefined,
          fromName,
          input.cc as string | undefined,
          attachments,
          this.mailboxAddress || undefined,
        );
        return { sent: true, thread_id: sendResult.threadId, message_id: sendResult.messageId };
      }
      case 'read_emails': {
        if (!this.gmailClient) return { error: 'Gmail not configured — add credentials to .user-data/system/gmail-credentials.json' };
        let emailQuery = (input.query as string | undefined) ?? `in:inbox "@${agentName}"`;
        // Restrict to inbound emails only (to: this client's mailbox).
        // Do NOT include from:mailboxAddress — sent messages get the INBOX label,
        // so including outbound would surface other clients' emails on a shared mailbox.
        if (this.mailboxAddress && !emailQuery.includes('to:') && !emailQuery.includes('from:')) {
          emailQuery += ` to:${this.mailboxAddress}`;
        }
        const threadMetas = await this.gmailClient.fetchThreadsMeta(
          emailQuery,
          input.max_results != null ? Number(input.max_results) : undefined,
        );
        const store = new EmailThreadStore(this.agentsDir, agentName);
        const threads = threadMetas.map((meta) => ({
          thread_id: meta.threadId,
          subject: meta.subject,
          from: meta.from,
          date: meta.date,
          message_count: meta.messageCount,
          summary: store.readSummary(meta.threadId) || null,
        }));
        return { threads };
      }
      case 'read_email_thread': {
        if (!this.gmailClient) return { error: 'Gmail not configured — add credentials to .user-data/system/gmail-credentials.json' };
        const threadWorkspace = resolve(this.agentsDir, agentName, 'workspace');
        const thread = await this.gmailClient.fetchThreadFull(input.thread_id as string, threadWorkspace);
        if (!thread) return { error: `Thread '${input.thread_id as string}' not found or empty` };
        if (this.mailboxAddress) {
          const titleToAgent = new Map([...this.agentTitles.entries()].map(([k, v]) => [v.toLowerCase(), k]));
          for (const msg of thread.messages) {
            if (msg.from.toLowerCase().includes(this.mailboxAddress.toLowerCase())) {
              const displayName = msg.from.replace(/<[^>]+>/, '').trim().toLowerCase();
              const agentMatch = titleToAgent.get(displayName);
              if (agentMatch) msg.sent_by = agentMatch;
            }
          }
        }
        return { thread };
      }
      case 'read_email_message': {
        if (!this.gmailClient) return { error: 'Gmail not configured — add credentials to .user-data/system/gmail-credentials.json' };
        const msg = await this.gmailClient.fetchMessage(input.message_id as string);
        if (!msg) return { error: `Message '${input.message_id as string}' not found` };
        return { message: msg };
      }
      case 'fetch_email_attachment': {
        if (!this.gmailClient) return { error: 'Gmail not configured — add credentials to .user-data/system/gmail-credentials.json' };
        const workspace = resolve(this.agentsDir, agentName, 'workspace');
        const savedPath = await this.gmailClient.fetchAttachment(
          input.message_id as string,
          input.attachment_id as string,
          input.filename as string,
          workspace,
        );
        return { saved_to: savedPath };
      }
      case 'read_email_thread_summary': {
        const store = new EmailThreadStore(this.agentsDir, agentName);
        const entry = store.readEntry(input.thread_id as string);
        if (!entry?.summary) return { error: `No summary found for thread ${input.thread_id as string}` };
        return {
          thread_id: input.thread_id,
          subject: entry.subject ?? null,
          summary: entry.summary,
          in_reply_to: entry.latestRfcMessageId ?? null,
          latest_from: entry.latestFrom ?? null,
          latest_to: entry.latestTo ?? null,
          latest_cc: entry.latestCc ?? null,
        };
      }
      case 'write_email_thread_summary': {
        const store = new EmailThreadStore(this.agentsDir, agentName);
        store.writeSummary(input.thread_id as string, input.summary as string);
        return { status: 'written', thread_id: input.thread_id };
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
      case 'format_timestamp': {
        const epoch = Number(input.timestamp);
        if (isNaN(epoch)) return { error: 'Invalid timestamp' };
        const d = new Date(epoch * 1000);
        return {
          datetime: new Intl.DateTimeFormat('en-US', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
            hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
          }).format(d),
          iso8601: d.toISOString(),
        };
      }
      case 'time_diff': {
        const from = Number(input.from);
        if (isNaN(from)) return { error: 'Invalid from timestamp' };
        const to = input.to != null ? Number(input.to) : Math.floor(Date.now() / 1000);
        const diff = to - from;
        const abs = Math.abs(diff);
        const days = Math.floor(abs / 86400);
        const hours = Math.floor((abs % 86400) / 3600);
        const mins = Math.floor((abs % 3600) / 60);
        const parts = [days && `${days}d`, hours && `${hours}h`, mins && `${mins}m`].filter(Boolean);
        const human = parts.length ? parts.join(' ') : 'just now';
        return {
          human: diff >= 0 ? `${human} ago` : `in ${human}`,
          seconds: diff,
        };
      }
      case 'parse_datetime': {
        const d = new Date(input.datetime as string);
        if (isNaN(d.getTime())) return { error: `Could not parse: ${input.datetime as string}` };
        return {
          epoch: Math.floor(d.getTime() / 1000),
          iso8601: d.toISOString(),
          datetime: new Intl.DateTimeFormat('en-US', {
            weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
            hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
          }).format(d),
        };
      }
      case 'web_search':
        return this.webSearch.search(input.query as string, 5, input.verify === true);
      case 'brave_search':
        return this.webSearch.search(input.query as string, input.max_results != null ? Number(input.max_results) : 5, input.verify === true);
      case 'browse_page': {
        const raw = input.raw !== false; // default true
        const result = await this.browse.fetch(input.url as string, input.verify === true, raw);
        if (result._js_fallback) return this.browseJs.fetch(input.url as string, input.verify === true, raw);
        return result;
      }
      case 'browse_page_js':
        return this.browseJs.fetch(input.url as string, input.verify === true, input.raw === true);
      case 'system_feedback': {
        const { category, subject, detail, severity = 'medium' } = input as any;
        const message = `**[${String(severity).toUpperCase()}] ${subject}**\n- Category: ${category}\n\n${detail}`;
        return this.topics.writeTopic(agentName, 'system_feedback', message);
      }
      case 'parse_redfin_listing':
        return this.redfin.parseListing(input.url as string);
      case 'parse_redfin_search':
        return this.redfin.parseSearch(input as any);
      case 'property_report':
        return this.redfin.propertyReport(input.address as string);
      case 'show_image':
        return { url: input.url, caption: input.caption ?? '' };
      case 'create_task':
        return this.sharedTasks.upsert(
          agentName,
          input.name as string,
          input.description as string,
          input.cadence_hours != null ? Number(input.cadence_hours) : null,
          input.run_at as string,
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
        const mode = input.mode as string;
        const summary = input.summary as string;
        const sessionId = input.session_id as string | undefined;
        const emailThreadIds = Array.isArray(input.email_thread_ids) ? (input.email_thread_ids as string[]) : undefined;
        const read = input.read as string | undefined;
        const changed = input.changed as string | undefined;
        const notes = input.notes as string | undefined;
        let msg = `**Mode:** ${mode}\n**Summary:** ${summary.trim()}`;
        if (sessionId?.trim()) msg += `\n**Session:** ${sessionId.trim()}`;
        if (emailThreadIds?.length) msg += `\n**Email Threads:** ${emailThreadIds.join(', ')}`;
        if (read?.trim()) msg += `\n**Read:**\n${read.trim()}`;
        if (changed?.trim()) msg += `\n**Changed:**\n${changed.trim()}`;
        if (notes?.trim()) msg += `\n**Notes:** ${notes.trim()}`;
        return this.topics.writeTopic(agentName, `${agentName}_log`, msg);
      }
      case 'read_log': {
        const consume = input.consume as boolean ?? false;
        return this.topics.readTopic(agentName, `${agentName}_log`, consume, input.filter as string | undefined, input.page as number ?? 1, input.page_size as number ?? 20);
      }
      case 'message_agent':
        return this.agentTools.messageAgent(agentName, input.agent as string, input.message as string);
      case 'post_message':
        return this.agentTools.postMessage(agentName, input.message as string, Array.isArray(input.to) ? input.to.map(String) : [], input.wakeup === true);
      case 'read_messages':
        return this.topics.readTopic(agentName, 'feed', input.consume as boolean ?? true, (input.filter as string | undefined) ?? `@${agentName}`, input.page as number ?? 1, input.page_size as number ?? 20);
      case 'read_topic':
        return this.topics.readTopic(agentName, input.topic as string, input.consume as boolean ?? true, input.filter as string | undefined, input.page as number ?? 1, input.page_size as number ?? 20);
      case 'read_agent_definition':
        return this.agentTools.readAgentDefinition(input.agent as string);
      case 'update_agent':
        return this.agentTools.updateAgent(
          input.name as string,
          input.title as string ?? null,
          input.description as string ?? null,
          input.goal as string ?? null,
          input.manager as string ?? null,
          Array.isArray(input.tools) ? input.tools.map(String) : null,
          input.identity as string ?? null,
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
          Array.isArray(input.tools) ? input.tools.map(String) : [],
        );
      case 'render_artifact': {
        const path = input.path as string;
        const title = (input.title as string) ?? '';
        if (!path?.trim()) return { error: 'path is required' };
        if (path.startsWith('https://') || path.startsWith('http://')) {
          return { url: path, title, path };
        }
        const artifactsDir = resolve(this.agentsDir, agentName, 'workspace', '_artifacts');
        const file = resolve(artifactsDir, path);
        if (!file.startsWith(artifactsDir)) return { error: `Path outside _artifacts folder: ${path}` };
        if (!existsSync(file)) return { error: `File not found in _artifacts/: ${path}` };
        const url = `/api/artifacts/${agentName}/${path}`;
        this.eventBusPublish({ type: 'artifact_updated', agent: agentName, url, title, path });
        return { url, title, path };
      }
      case 'save_plan': {
        const plansDir = resolve(this.agentsDir, agentName, 'workspace', '_plans');
        mkdirSync(plansDir, { recursive: true });
        const title = input.title as string;
        const steps = Array.isArray(input.steps) ? (input.steps as string[]) : [];
        const now = new Date();
        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
        const planId = `${now.toISOString().slice(0, 19).replace(/:/g, '').replace('T', '-')}-${slug}`;
        const lines = [
          `# ${title}`,
          '',
          `**Created:** ${now.toISOString()}`,
          `**Plan ID:** ${planId}`,
          '',
          '## Steps',
          '',
          ...steps.map((s) => `- [ ] ${s}`),
        ];
        writeFileSync(resolve(plansDir, `${planId}.md`), lines.join('\n'), 'utf-8');
        return { plan_id: planId, path: `_plans/${planId}.md`, step_count: steps.length };
      }
      case 'get_plan': {
        const plansDir = resolve(this.agentsDir, agentName, 'workspace', '_plans');
        if (!existsSync(plansDir)) return { plans: [] };
        const planId = input.plan_id as string | undefined;
        if (planId) {
          const file = resolve(plansDir, `${planId}.md`);
          if (!existsSync(file)) return { error: `Plan not found: ${planId}` };
          return { plan_id: planId, content: readFileSync(file, 'utf-8') };
        }
        const files = readdirSync(plansDir).filter((f) => f.endsWith('.md')).sort().reverse();
        return { plans: files.map((f) => ({ plan_id: f.slice(0, -3), path: `_plans/${f}` })) };
      }
      case 'update_plan': {
        const plansDir = resolve(this.agentsDir, agentName, 'workspace', '_plans');
        const planId = input.plan_id as string;
        const file = resolve(plansDir, `${planId}.md`);
        if (!existsSync(file)) return { error: `Plan not found: ${planId}` };
        const stepIndex = input.step_index as number;
        const status = input.status as 'done' | 'skip';
        if (status !== 'done' && status !== 'skip') return { error: `Invalid status "${status}" — must be "done" or "skip"` };
        const note = input.note as string | undefined;
        const content = readFileSync(file, 'utf-8');
        const lines = content.split('\n');
        let checkboxCount = -1;
        let updated = false;
        const newLines = lines.map((line) => {
          if (/^- \[[ x]\]/.test(line)) {
            checkboxCount++;
            if (checkboxCount === stepIndex) {
              const mark = status === 'done' ? 'x' : '-';
              const base = line.replace(/^- \[[ x\-]\]/, `- [${mark}]`);
              updated = true;
              return note ? `${base} *(${note})*` : base;
            }
          }
          return line;
        });
        if (!updated) return { error: `Step index ${stepIndex} out of range` };
        writeFileSync(file, newLines.join('\n'), 'utf-8');
        return { plan_id: planId, step_index: stepIndex, status };
      }
      case 'read_journal': {
        if (!existsSync(this.journalDir)) return { entries: [] };
        const limit = typeof input.limit === 'number' ? input.limit : 10;
        const files = readdirSync(this.journalDir)
          .filter(f => f.endsWith('.md'))
          .sort()
          .reverse()
          .slice(0, limit);
        const entries = files.map(f => {
          const id = f.slice(0, -3);
          const content = readFileSync(resolve(this.journalDir, f), 'utf-8');
          const m = id.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/);
          const date = m ? `${m[1]}-${m[2]}-${m[3]}` : id;
          return { id, date, content };
        });
        return { entries };
      }
      default:
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
    'Run shell commands in your workspace. Use for shell operations: ls, grep, find, diff, cp, mv, mkdir, rm, python3 scripts, etc. ' +
    'Do NOT use for file reads or writes — use read_file, write_file, and patch_file instead. ' +
    'The shell starts in your workspace — use relative paths only. ' +
    'Do not use ~/, $HOME, or absolute paths. ' +
    'Path traversal (../), ~/, $HOME, network tools, and privilege escalation are blocked.',
    props(prop('command', 'string', 'Bash command to run.')), ['command']),

  tool('read_file',
    'Read a file from your workspace. Returns file contents as a string. ' +
    'Default reads up to 100,000 characters — enough for most files. Call with no offset first; only paginate if total_chars exceeds the length. ' +
    'The response includes total_chars and remaining_chars so you know if there is more. ' +
    'Always prefer this over agent_bash cat/sed/tail.',
    props(
      prop('path', 'string', 'Relative path from your workspace root (e.g. "notes.md", "reports/summary.txt").'),
      prop('offset', 'number', 'Character offset to start reading from (default: 0).'),
      prop('length', 'number', 'Max number of characters to read (default: 100000).'),
    ),
    ['path']),

  tool('write_file',
    'Write text content to a file in your workspace. Creates parent directories if needed. Overwrites the file if it already exists — ' +
    'use read_file first if you need to preserve existing content. ' +
    'Always use this instead of agent_bash echo/printf/heredoc — never write files through bash. ' +
    'When making multiple edits to a file, read it once, apply all changes, then write once — do not call patch_file in a loop.',
    props(
      prop('path', 'string', 'Relative path from your workspace root (e.g. "notes.md", "reports/summary.txt").'),
      prop('content', 'string', 'Text content to write to the file.'),
    ),
    ['path', 'content']),

  tool('patch_file',
    'Replace an exact string in a file with new content. Edits in place — no need to read and rewrite the whole file. ' +
    'old_string must match exactly (including whitespace and newlines) and must be unique in the file — add more surrounding context if it appears more than once. ' +
    'Returns a snippet of the file around the patched region so you can verify the change without re-reading the file. ' +
    'Use for a single targeted change. If you need to make multiple edits to the same file, use read_file + write_file instead of calling patch_file in a loop.',
    props(
      prop('path', 'string', 'Relative path from your workspace root.'),
      prop('old_string', 'string', 'Exact string to find and replace. Must appear exactly once in the file.'),
      prop('new_string', 'string', 'Replacement string.'),
    ),
    ['path', 'old_string', 'new_string']),

  tool('append_file',
    'Append text to the end of a file in your workspace. Creates the file if it does not exist. ' +
    'Ensures a newline separator between existing content and the appended text. ' +
    'Use this instead of patch_file or agent_bash cat >> when adding to the end of a file.',
    props(
      prop('path', 'string', 'Relative path from your workspace root.'),
      prop('content', 'string', 'Text to append.'),
    ),
    ['path', 'content']),

  tool('save_plan',
    'Save a structured plan to your workspace before starting a complex multi-step task. ' +
    'Writes a markdown checklist to _plans/ that you can reference throughout execution. ' +
    'Call this before taking any actions on multi-step tasks — commit the plan first, then execute. ' +
    'Use update_plan to tick off steps as you go. Returns a plan_id you can pass to get_plan to retrieve it.',
    props(
      prop('title', 'string', 'Short descriptive title for the plan (e.g. "Research Chicago neighborhoods").'),
      ['steps', { type: 'array', items: { type: 'string' }, description: 'Ordered list of steps to execute. Each step is a short action statement.' }],
    ),
    ['title', 'steps']),

  tool('get_plan',
    'Read a saved plan from _plans/. Pass plan_id to read a specific plan; omit to list all plans.',
    props(
      prop('plan_id', 'string', 'Plan ID returned by save_plan. Omit to list all plans.'),
    ),
    []),

  tool('update_plan',
    'Mark a step in a saved plan as done or skipped. Use this instead of rewriting the plan file via agent_bash. ' +
    'Pass the plan_id from save_plan and the 0-based index of the step to update. ' +
    'Optionally add a short note (e.g. outcome, reason for skip) that gets appended inline.',
    props(
      prop('plan_id', 'string', 'Plan ID returned by save_plan.'),
      prop('step_index', 'number', '0-based index of the step to update.'),
      ['status', { type: 'string', enum: ['done', 'skip'], description: '"done" to check the step off, "skip" to mark it skipped.' }],
      prop('note', 'string', 'Optional short note appended inline (e.g. outcome or skip reason).'),
    ),
    ['plan_id', 'step_index', 'status']),

  tool('read_emails',
    'List email threads from the shared mailbox. ' +
    'Returns { threads } — each with thread_id, subject, from, date, message_count, and summary (if one has been written). ' +
    'Threads with summary=null have not been processed yet. ' +
    'Use this to get an overview of active threads. Call read_email_thread with a thread_id to read the full content.',
    props(
      prop('query', 'string', 'Gmail search query. Default: "in:inbox \\"@{your_agent_name}\\"" — threads that mention you. Override to broaden (e.g. "in:inbox" for all inbox threads) or narrow (e.g. add "is:unread", "from:someone@example.com"). When a shared mailbox is configured, "to:{mailboxAddress}" is automatically appended to queries that do not already include "to:" or "from:" — limiting results to inbound emails only.'),
      prop('max_results', 'number', 'Max number of threads to return (default: 10)'),
    ),
    []),

  tool('read_email_thread',
    'Fetch a Gmail thread by thread ID. Returns { thread_id, subject, messages[] } — messages are sorted oldest-first, ' +
    'each with message_id, rfc_message_id, from, to, cc, date, body, attachments (if present), and sent_by (agent name, if the message was sent by an agent via the shared mailbox).',
    props(
      prop('thread_id', 'string', 'Gmail thread ID from a previous log entry email_thread_ids field.'),
    ),
    ['thread_id']),

  tool('read_email_message',
    'Fetch a single email message by message_id with no body truncation. ' +
    'Use this when read_email_thread returns a truncated body (10k char limit) and you need the full content. ' +
    'Returns { message_id, rfc_message_id, from, to, cc, date, body, attachments? }.',
    props(
      prop('message_id', 'string', 'Gmail message ID from a read_email_thread response.'),
    ),
    ['message_id']),

  tool('read_email_thread_summary',
    'Read the locally stored summary of an email thread. No Gmail API call. ' +
    'Returns { thread_id, subject, summary, in_reply_to, latest_from, latest_to, latest_cc } — ' +
    'in_reply_to is the RFC 2822 Message-ID to pass when replying; latest_from/to/cc are the participants from when the thread was last processed. ' +
    'Use during log processing before falling back to read_email_thread.',
    props(
      prop('thread_id', 'string', 'Gmail thread ID from a log entry email_thread_ids field.'),
    ),
    ['thread_id']),

  tool('write_email_thread_summary',
    'Store a summary of an email thread. Call this after reviewing a thread via read_email_thread. ' +
    'Stored locally — future runs use read_email_thread_summary instead of hitting Gmail.',
    props(
      prop('thread_id', 'string', 'Gmail thread ID.'),
      prop('summary', 'string', '2-3 paragraph summary: who the thread is with, what was exchanged, decisions made, open follow-ups, and what action you took.'),
    ),
    ['thread_id', 'summary']),

  tool('fetch_email_attachment',
    'Download an email attachment to your workspace. ' +
    'Use this when read_emails or read_email_thread returns an attachments[] field and the file was not auto-downloaded. ' +
    'PDFs are automatically extracted to a .txt file — the saved_to path will point to the text file. ' +
    'All other types are saved as-is to _downloads/.',
    props(
      prop('message_id', 'string', 'Gmail message ID from the email (messageId field).'),
      prop('attachment_id', 'string', 'Attachment ID from the attachments[] array (attachmentId field).'),
      prop('filename', 'string', 'Filename from the attachments[] array — used as the saved filename.'),
    ),
    ['message_id', 'attachment_id', 'filename']),

  tool('send_file_email',
    'Send an HTML file from your workspace as the email body. The file content becomes the email body — this is NOT an attachment. ' +
    'Use this when you have an HTML report already saved in _artifacts/ and want to avoid reading it into a tool call. ' +
    'For inline HTML content you are constructing now, use send_email with html_body instead. ' +
    'Returns { sent, thread_id, message_id } — save thread_id so you can track replies and pass it as thread_id on future replies. ' +
    'For files recipients should download (PDFs, CSVs), use send_email with attachments instead. ' +
    'The From header is automatically set to your agent title and the shared mailbox address. ' +
    'Always include a signature line in the HTML file: "@{your agent name}" (e.g. "@chicago_childcare"). This is used to route future replies back to you. ' +
    'When replying, you MUST set thread_id and in_reply_to — both required for the reply to stay in the correct thread.',
    props(
      prop('to', 'string', 'Recipient email address. Omit when emailing the client — the configured client address is used by default. Required for all other recipients.'),
      prop('cc', 'string', 'CC recipients — comma-separated. When replying to a group thread, include the To and CC participants from the original email to reply-all.'),
      prop('subject', 'string', 'Email subject'),
      prop('file_path', 'string', 'Path to HTML file relative to your workspace root (e.g. "_artifacts/report.html")'),
      prop('thread_id', 'string', 'Thread ID from the email context. Always set when replying.'),
      prop('in_reply_to', 'string', 'RFC 2822 Message-ID from the email context (rfcMessageId). Always set when replying — required for proper threading in mail clients.'),
    ),
    ['subject', 'file_path']),

  tool('send_email',
    'Send an email on behalf of the user. ' +
    'The From header is automatically set to your agent title and the shared mailbox address. ' +
    'Body options — pick one: ' +
    '(1) html_body: inline HTML you construct now — use for formatted replies and reports. Clean HTML, inline CSS — clear hierarchy, readable spacing, minimal color, minimal styling. No decorative elements. ' +
    '(2) body: plain text — use only for short conversational replies (2–3 sentences). No markdown syntax. ' +
    'Do not provide both body and html_body. ' +
    'Attachments can be included alongside either body option — use for large, durable artifacts that will be referenced repeatedly (PDFs, CSVs, PPTs, interactive web pages). ' +
    'Always end your email with a signature line: "@{your agent name}" (e.g. "@cos", "@chicago_childcare"). This is used to route future replies back to you. ' +
    'When replying, you MUST set thread_id and in_reply_to — both required for the reply to stay in the correct thread. ' +
    'Returns { sent, thread_id, message_id } — save thread_id so you can track replies and pass it as thread_id on future replies.',
    props(
      prop('to', 'string', 'Recipient email address. Omit when emailing the client — the configured client address is used by default. Required for all other recipients. When replying, set this to the sender\'s address (the From field of the incoming email).'),
      prop('cc', 'string', 'CC recipients — comma-separated. When replying to a group thread, include the To and CC participants from the original email to reply-all.'),
      prop('subject', 'string', 'Email subject'),
      prop('html_body', 'string', 'HTML email body. Use for formatted replies and reports. Do not include body when using this.'),
      prop('body', 'string', 'Plain text email body. Only for short conversational replies. No markdown syntax.'),
      prop('thread_id', 'string', 'Thread ID from the email context. Always set when replying.'),
      prop('in_reply_to', 'string', 'RFC 2822 Message-ID from the email context (rfcMessageId). Always set when replying — required for proper threading in mail clients.'),
      ['attachments', { type: 'array', items: { type: 'string' }, description: 'Workspace-relative file paths to send as downloadable attachments (e.g. ["_artifacts/report.pdf", "_artifacts/slides.pptx"]). Any file type is supported.' }],
    ),
    ['subject']),

  tool('shared_bash',
    'Shared folder for passing files between agents — NOT for your own notes (use agent_bash for that). ' +
    'Use this when you need another agent to read something you produced, or to read what another agent left for you. ' +
    'The shell starts in the shared folder — use relative paths. ' +
    'Same restrictions as agent_bash: no path traversal, no network tools, no absolute paths.',
    props(prop('command', 'string', 'Bash command to run in the shared folder.')), ['command']),

  tool('browse_page',
    'Fetch a web page and return its full text content. Automatically retries with JS rendering if the page is JavaScript-rendered. ' +
    'Pass raw: false to get a concise LLM-generated summary instead of full text. For discovery, use web_search first.',
    props(
      prop('url', 'string', 'Full URL to fetch'),
      prop('raw', 'boolean', 'If true (default), return full page text instead of a summary. Pass false to get a concise LLM-generated summary.'),
      prop('verify', 'boolean', 'If true, also run a credibility assessment and return source_quality, published date, and flags.'),
    ), ['url']),

  tool('browse_page_js',
    'Fetch a JS-rendered web page and return an LLM-generated summary of its key content. Use when browse_page returns empty or incomplete content because the page relies on JavaScript to render. Slower — only use when needed.',
    props(
      prop('url', 'string', 'Full URL to fetch'),
      prop('raw', 'boolean', 'If true, return full page text instead of a summary. Default: false (returns summary).'),
      prop('verify', 'boolean', 'If true, also run a credibility assessment and return source_quality, published date, and flags.'),
    ), ['url']),

  tool('parse_redfin_listing',
    'Parse a Redfin listing URL and return structured property data: price, beds/baths, sq ft, HOA, year built, amenities, coordinates, MLS number, description, and photo URLs.',
    props(prop('url', 'string', 'Redfin listing URL')), ['url']),

  tool('parse_redfin_search',
    'Search Redfin listings by location and filters. Returns properties with price, beds, baths, sq ft, and listing URL.',
    props(
      prop('zipcode', 'string', 'ZIP code to search (e.g. "60614")'),
      prop('listing_type', 'string', 'Type of listing: "for_sale" (default) or "for_rent"'),
      prop('min_beds', 'number', 'Minimum bedrooms'),
      prop('max_beds', 'number', 'Maximum bedrooms'),
      prop('min_price', 'number', 'Minimum price (dollars for sale, $/mo for rent)'),
      prop('max_price', 'number', 'Maximum price (dollars for sale, $/mo for rent)'),
      prop('property_type', 'string', 'Property type: "house", "condo", "townhouse", "multi-family" (comma-separate multiple)'),
      prop('min_sqft', 'number', 'Minimum square footage'),
      prop('max_sqft', 'number', 'Maximum square footage'),
    ), ['zipcode']),

  tool('property_report',
    'Generate a comprehensive property report for any address. Includes building obstruction analysis, sun exposure, corner unit detection, floor number, street noise, neighborhood walkability, transit access, parks, flood zone, and elevation.',
    props(prop('address', 'string', "Full street address including unit number if applicable (e.g. '123 Main St #4N, Chicago, IL')")),
    ['address']),

  tool('web_search',
    'Search the web via Exa (OpenRouter). ' +
    'Use for discovery and finding URLs. Follow up with browse_page to read specific pages in full. ' +
    'If results are missing or insufficient, use brave_search as a fallback with a different search index.',
    props(
      prop('query', 'string', 'Search query'),
      prop('verify', 'boolean', 'If true, annotate each result with source_quality (high/medium/low based on domain) and published date extracted from the snippet.'),
    ), ['query']),

  tool('brave_search',
    'Search the web via Brave Search API — a direct call to Brave\'s independent index. ' +
    'Use as a fallback when web_search returns no results or poor results, or when you want a second search engine\'s perspective. ' +
    'Follow up with browse_page to read specific pages in full.',
    props(
      prop('query', 'string', 'Search query'),
      prop('max_results', 'number', 'Max results to return (default: 5, max: 20)'),
      prop('verify', 'boolean', 'If true, annotate each result with source_quality and published date.'),
    ), ['query']),

  tool('show_image', 'Display an image inline in the chat.',
    props(prop('url', 'string', 'Image URL'), prop('caption', 'string', 'Optional caption')),
    ['url']),

  tool('get_current_datetime',
    'Get the current date and time as an ISO8601 string. ' +
    'The current time is already in your system prompt — only call this tool when you need a fresh ISO8601 timestamp for create_task run_at or precise time-diff calculations.',
    props(), []),

  tool('format_timestamp',
    'Convert a Unix epoch timestamp (seconds) to a human-readable date and ISO8601 string. ' +
    'Use when reading raw timestamps from tasks (run_at, last_run) or run filenames.',
    props(prop('timestamp', 'number', 'Unix epoch seconds.')),
    ['timestamp']),

  tool('time_diff',
    'Compute the human-readable difference between two Unix epoch timestamps. ' +
    '"to" defaults to now if omitted. Returns e.g. "2h 15m ago" or "in 3d 4h".',
    props(
      prop('from', 'number', 'Start Unix epoch seconds.'),
      prop('to', 'number', 'End Unix epoch seconds. Defaults to now.'),
    ),
    ['from']),

  tool('parse_datetime',
    'Parse an ISO8601 or common date string into a Unix epoch timestamp. ' +
    'Use before create_task when the due date comes from user input or a natural language date.',
    props(prop('datetime', 'string', 'Date string to parse (e.g. "2026-04-15T09:00:00-07:00", "April 15 2026 9am PDT").')),
    ['datetime']),

  tool('create_task',
    'Create or update a task on the shared task board. ' +
    'Upserts by name within your namespace (same name + you = update). ' +
    'run_at is always required. Add cadence_hours to make it recurring.',
    props(
      prop('name', 'string', 'Short task name (unique per creator — upsert)'),
      prop('description', 'string', 'What needs to be done. Write this as a self-contained brief — the executing agent will have no memory of why this task was created. Include: what to do, why it matters, any key facts needed to act, and workspace file paths where full context lives (e.g. "See plan/resume.md for current draft").'),
      prop('assignee', 'string', 'Who is responsible: "user", an agent name, or omit for self'),
      prop('run_at', 'string', 'ISO-8601 datetime when the task should execute (e.g. 2026-04-01T09:00:00-05:00). Use now for immediate execution. Required.'),
      prop('cadence_hours', 'number', 'Recurring interval in hours (e.g. 24, 168). Omit for one-off.'),
    ),
    ['name', 'description', 'run_at']),

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
    'Record what happened at the end of any run — chat, email, task, or inter-agent message. ' +
    'Written to your private log — only you read it.',
    props(
      ['mode', { type: 'string', enum: ['chat', 'inter-agent-message', 'email-check', 'task-trigger'], description: 'Run mode: chat, inter-agent-message, email-check, or task-trigger' }],
      prop('summary', 'string', 'What happened and what you decided — be thorough, this is your memory'),
      prop('session_id', 'string', 'Session ID for this run. Always include during chat mode — used to pull transcripts later.'),
      ['email_thread_ids', { type: 'array', items: { type: 'string' }, description: 'Gmail thread IDs processed during this run. Always include during email-check mode — used to pull threads later.' }],
      prop('read', 'string', 'Workspace files read during this run, one per line (e.g. "clarity/status.md"). Used to identify which files are actively referenced.'),
      prop('changed', 'string', 'Workspace changes made during this run — list each file and the specific section or value that changed (e.g. "_memory.md § Goals: updated relocation timeline to end of 2026"). Be precise — this is used during log processing to reconcile workspace state.'),
      prop('notes', 'string', 'Loose observations, open questions, or things to follow up on (optional)'),
    ),
    ['mode', 'summary']),

  tool('read_log',
    'Read your private activity log written by log_entry. ' +
    'Safe to call anytime — does not advance the cursor by default. ' +
    'Returns newest entries first. Use consume: true during log-processing runs to mark entries as seen.',
    props(
      prop('consume', 'boolean', 'Advance cursor after reading (default: false). When true, returns all new entries since last consume — pagination ignored.'),
      prop('filter', 'string', 'Return only entries containing this string — useful for searching by mode or keyword (optional)'),
      prop('page', 'number', 'Page number, 1-based (default: 1 = most recent entries)'),
      prop('page_size', 'number', 'Entries per page (default: 20)'),
    ),
    []),

  tool('message_agent',
    'Send a message to another agent and block until they respond. ' +
    'Use only in background modes (task-trigger, inter-agent-message) — never during user chat. ' +
    'Use post_message with wakeup: true instead when you do not need an immediate reply. ' +
    'Keep messages short and specific — each call runs a full agent loop. One focused question is cheaper than a long brief.',
    props(
      prop('agent', 'string', "Agent to message. Use list_agents to see available agents."),
      prop('message', 'string', 'Message to send. Be concise — state exactly what you need and nothing more.'),
    ),
    ['agent', 'message']),

  tool('post_message',
    'Post a message to the shared feed. Safe to call during user chat. ' +
    'By default just writes to the feed — recipients see it on their next check. ' +
    'Set wakeup: true to wake recipients immediately and have their reply written back to the feed. ' +
    'Only use wakeup when the agent genuinely needs to act now — each wakeup triggers a full agent run.',
    props(
      prop('message', 'string', 'Message content'),
      ['to', { type: 'array', items: { type: 'string' }, description: 'Agent names to address, e.g. ["cos"] or ["therapist", "advisor"]. Omit for broadcast.' }],
      ['wakeup', { type: 'boolean', description: 'If true, wake each recipient immediately and write their reply to the feed. Default: false.' }],
    ),
    ['message']),

  tool('read_messages',
    'Read messages from the feed since your last check. ' +
    'By default returns only messages addressed to you. ' +
    'Pass filter: "broadcast" to read team-wide posts, or any other string to search across all entries. ' +
    'Set consume: false to browse history without advancing the cursor — supports pagination.',
    props(
      prop('consume', 'boolean', 'Advance cursor after reading (default: true). When true, returns all new entries since last consume — pagination ignored.'),
      prop('filter', 'string', 'Return only entries containing this string. Default: "@yourname". Use "broadcast" for team posts.'),
      prop('page', 'number', 'Page number when browsing history (consume: false only). 1 = most recent (default: 1)'),
      prop('page_size', 'number', 'Entries per page when browsing history (default: 20)'),
    ),
    []),

  tool('read_topic',
    'Read all new entries from a named topic since your last check. ' +
    'Use topic: "feed" to read the full team feed — all messages and broadcasts in one call, no implicit filtering. ' +
    'Use topic: "{agentname}_log" to read another agent\'s log (read-only, no cursor advance for you). ' +
    'Set consume: false to browse history without advancing the cursor.',
    props(
      prop('topic', 'string', 'Topic name, e.g. "feed", "cos_log", "system_feedback"'),
      prop('consume', 'boolean', 'Advance cursor after reading (default: true).'),
      prop('filter', 'string', 'Optional: return only entries containing this string.'),
      prop('page', 'number', 'Page number when browsing history (consume: false only). 1 = most recent (default: 1)'),
      prop('page_size', 'number', 'Entries per page when browsing history (default: 20)'),
    ),
    ['topic']),

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
    'Update a dynamic agent\'s definition. Only the fields you provide are changed. Use read_agent_definition first to read the current state before making changes. Parameter is "name" (not "agent") — use list_agents to find the agent\'s slug.',
    props(
      prop('name', 'string', 'Agent slug to update — same as the "name" field from list_agents (e.g. "pm_coach", not a display title)'),
      prop('title', 'string', 'New display name'),
      prop('description', 'string', 'New one-sentence description'),
      prop('goal', 'string', 'Durable, concrete purpose statement'),
      prop('manager', 'string', 'Agent name of the manager (e.g. "cos", "advisor")'),
      prop('identity', 'string', 'Replaces identity.md entirely — whatever you pass here becomes the full file. Read the current identity first via read_agent_definition, then incorporate your changes and pass the complete updated content. Partial updates will erase the rest. Identity covers: who the agent is, what they own, how they operate, guiding principles, and standing rules. Write it as a direct operational brief, not a job description.'),
      ['tools', { type: 'array', items: { type: 'string' }, description: 'New tool list (replaces current list)' }],
    ),
    ['name']),

  tool('list_agents',
    'List all agents currently registered in the system with their name and title.',
    props(), []),

  tool('list_tools',
    'List all tools available in the system with their names and descriptions.',
    props(), []),

  tool('system_feedback',
    'Submit feedback about the system — tools, triggers, prompts, or missing capabilities. ' +
    'Use when you notice something broken, unhelpful, or missing that is blocking your work.',
    props(
      ['category', { type: 'string', enum: ['tool', 'trigger', 'prompt', 'capability', 'other'], description: 'Area of feedback: "tool", "trigger", "prompt", "capability", or "other"' }],
      prop('subject',  'string', 'Short title describing the issue or suggestion'),
      prop('detail',   'string', 'Full description — what happened, what you expected, and what the impact is'),
      ['severity', { type: 'string', enum: ['low', 'medium', 'high'], description: 'Impact level: "low", "medium" (default), or "high"' }],
    ),
    ['category', 'subject', 'detail']),

  tool('read_journal',
    'Read recent journal entries written by the client. Use to understand the client\'s current state, recent thoughts, or context before a session.',
    props(
      prop('limit', 'number', 'Number of recent entries to return (default: 10)'),
    ),
    []),

  tool('render_artifact',
    'Display a file in the client\'s chat UI in a persistent panel next to the conversation. ' +
    'Only works in chat mode — the client must be present and active. ' +
    'Use for long-form content you want the client to read: reports, summaries, plans, HTML visualizations. ' +
    'For sharing content in background modes, use send_email to reach the client or post_message/message_agent to reach teammates.',
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
      prop('identity', 'string', 'Durable identity prompt — who the agent is and their standing capabilities. All mode-specific framing goes here.'),
      ['tools', { type: 'array', items: { type: 'string' }, description: 'Additional tool names beyond the basic toolkit (which is always included automatically). Only list tools specific to this agent\'s domain.' }],
    ),
    ['name', 'identity']),
];

const SESSION_TOOLS: ToolDefinition[] = [
  tool('list_sessions',
    'List past sessions with their date, title, and summary. Use this to get an overview of all sessions. Call read_session_transcript only if you need the full conversation.',
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

  tool('write_session_summary',
    'Store a summary of a session you just read. Call this after reviewing a transcript via read_session_transcript. ' +
    'Overwrites any existing server-generated summary.',
    props(
      prop('session_id', 'string', 'Session ID.'),
      prop('summary', 'string', '2-3 paragraph summary: what was discussed, decisions made, actions committed to, open threads.'),
    ),
    ['session_id', 'summary']),
];

function extractEmail(address: string): string {
  const m = address.match(/<([^>]+)>/);
  return (m ? m[1]! : address).trim().toLowerCase();
}

function mimeTypeFromExt(ext: string): string {
  const map: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.csv': 'text/csv',
    '.json': 'application/json',
    '.txt': 'text/plain',
    '.md': 'text/plain',
    '.html': 'text/html',
    '.svg': 'image/svg+xml',
  };
  return map[ext.toLowerCase()] ?? 'application/octet-stream';
}
