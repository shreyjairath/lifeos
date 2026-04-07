import { Executor, prepareMessages } from './executor/executor.js';
import { LlmClient } from './executor/llm-client.js';
import { Confirmations } from './executor/confirmations.js';
import { SessionHandler } from './session/session-handler.js';
import type { EmailMessage } from '../agentfleet/tools/gmail.js';
import { EmailThreadStore } from '../agentfleet/tools/email-thread-store.js';
import {
  createRunRecord,
  finishRunRecord,
  addTokens,
  addTurn,
  setInitialMessages,
  saveRunRecord,
  type RunRecord,
} from './agent-run-logs.js';
import { loadPrompt, loadGenericPrompt } from './prompt-parts.js';
import type { AgentDefinition } from './agent-definition.js';
import type { Agent, ToolInvoker, ExecutorEvent } from './types.js';
import type { AppConfig } from '../config.js';


// Shared prompt scaffolding — loaded once at module init
const LIFEOS_PROMPT = loadGenericPrompt('lifeos-prompt.md');
const CHAT_SCAFFOLD = loadGenericPrompt('chat.md');
const CHECK_EMAIL = loadGenericPrompt('check-email.md');
const TASK_TRIGGER = loadGenericPrompt('task-trigger.md');
const INTER_AGENT = loadGenericPrompt('inter-agent-message.md');

// ── EventBus minimal interface (circular dep avoided by duck-typing) ──────────

export interface EventBusLike {
  subscribe(): AsyncIterableIterator<Record<string, any>>;
  publish(event: Record<string, any>): void;
}

// ── BackgroundQueue ────────────────────────────────────────────────────────────

class BackgroundQueue {
  private queue: Promise<void> = Promise.resolve();

  enqueue(fn: () => Promise<void>): void {
    this.queue = this.queue.then(fn).catch((err) => {
      console.error('[BackgroundQueue]', err);
    });
  }
}

// ── BaseAgent ─────────────────────────────────────────────────────────────────

export class BaseAgent implements Agent {
  private readonly def: AgentDefinition;
  private readonly toolInvoker: ToolInvoker;
  private readonly confirmations: Confirmations;
  private readonly config: AppConfig;
  private readonly eventBus: EventBusLike;
  private readonly hiresProvider: () => string[];
  readonly session: SessionHandler;

  /** Serializes all background runs per agent */
  private readonly backgroundQueue = new BackgroundQueue();
  readonly emailThreadStore: EmailThreadStore;
  /** Active executor keyed by sessionId; allows cancellation */
  private readonly activeRuns = new Map<string, Executor>();

  constructor(
    def: AgentDefinition,
    toolInvoker: ToolInvoker,
    confirmations: Confirmations,
    config: AppConfig,
    eventBus: EventBusLike,
    hiresProvider: () => string[],
  ) {
    this.def = def;
    this.toolInvoker = toolInvoker;
    this.confirmations = confirmations;
    this.config = config;
    this.eventBus = eventBus;
    this.hiresProvider = hiresProvider;
    this.emailThreadStore = new EmailThreadStore(def.name);
    this.session = new SessionHandler(config, def.name);
    this.session.setLlmClientFactory(() => new LlmClient(config.apiKey));
    this.initListeners();
  }

  // ── Agent interface ──────────────────────────────────────────────────────────

  getName(): string { return this.def.name; }
  getTitle(): string { return this.def.title; }
  getDescription(): string { return this.def.description; }
  getDefinition(): AgentDefinition { return this.def; }
  getSessionHandler(): SessionHandler { return this.session; }

  cancel(sessionId: string): void {
    this.activeRuns.get(sessionId)?.cancel();
  }

  async *handleUserMessage(
    sessionId: string,
    userMessage: string,
    modelOverride?: string,
  ): AsyncGenerator<ExecutorEvent> {
    const system = this.buildSystemPrompt('chat', { sessionId });
    this.session.appendMessage(sessionId, { role: 'user', content: userMessage });
    const messages = this.session.getHistory(sessionId);
    prepareMessages(messages);

    const model = this.effectiveChatModel(modelOverride);
    const record = createRunRecord(this.def.name, 'chat', system, userMessage, model, sessionId);
    this.eventBus.publish({ type: 'agent_run_start', agent: this.def.name, mode: 'chat' });

    const exec = new Executor(this.config.apiKey, this.confirmations);
    this.activeRuns.set(sessionId, exec);

    // Buffer assistant+tool_use messages — only persist once the matching tool_result arrives
    let pendingToolUse: Record<string, any> | null = null;
    const resultAccum: string[] = [];

    try {
      for await (const event of exec.runLoop(
        messages,
        system,
        model,
        this.toolInvoker.definitions(),
        this.def.name,
        this.reasoningConfig(),
        this.toolInvoker,
      )) {
        // Log into run record
        withRecordLogging(event, record);

        // Persist messages
        if (event.type === 'agent_append') {
          const msg = event.message;
          if (event.role === 'assistant' && hasToolUse(msg)) {
            pendingToolUse = msg;
          } else {
            if (pendingToolUse) {
              this.session.appendMessage(sessionId, pendingToolUse);
              pendingToolUse = null;
            }
            this.session.appendMessage(sessionId, msg);
          }
          if (event.role === 'assistant' && typeof msg.content === 'string') {
            resultAccum.push(msg.content);
          }
        } else if (event.type === 'llm_response') {
          this.session.updateSessionMeta(sessionId, event.usage.input_tokens);
        }

        yield event;
      }
    } finally {
      this.activeRuns.delete(sessionId);
      const result = resultAccum.join('');
      finishRunRecord(record, result);
      saveRunRecord(record);
      this.eventBus.publish({
        type: 'agent_run_end',
        agent: this.def.name,
        mode: 'chat',
        duration_ms: record.durationMs,
        result_preview: resultPreview(result),
      });
    }
  }

  /** Sync variant — blocks until the agent finishes responding. Use from background only. */
  async handleAgentMessage(fromAgent: string, content: string): Promise<string> {
    return this.runInterAgentMessage(fromAgent, content, false);
  }

  /** Async variant — submits to the background queue and returns immediately. */
  handleAgentMessageAsync(fromAgent: string, content: string, onComplete?: (response: string) => void): void {
    this.backgroundQueue.enqueue(() =>
      this.runInterAgentMessage(fromAgent, content, true, onComplete).then(() => {}),
    );
  }

  handleEmailCheck(emails: EmailMessage[], onComplete?: () => Promise<void>): void {
    console.log(`[${this.def.name}] handleEmailCheck: received ${emails.length} email(s), enqueueing`);
    // Build per-thread reply metadata
    const threadMeta = new Map<string, { threadId: string; inReplyTo: string; subject: string; replyTo: string }>();
    for (const email of emails) {
      if (!threadMeta.has(email.threadId)) {
        threadMeta.set(email.threadId, {
          threadId: email.threadId,
          inReplyTo: email.rfcMessageId.replace(/^<|>$/g, ''),
          subject: email.subject.startsWith('Re:') ? email.subject : `Re: ${email.subject}`,
          replyTo: email.from,
        });
      } else {
        // Update to latest message in thread
        const meta = threadMeta.get(email.threadId)!;
        meta.inReplyTo = email.rfcMessageId.replace(/^<|>$/g, '');
        meta.replyTo = email.from;
      }
    }
    const append = formatEmailsForAgent(emails);
    this.backgroundQueue.enqueue(async () => {
      await this.handleSystemMessage('check_email_trigger', append, { emailThreadMeta: [...threadMeta.values()] });
      if (onComplete) await onComplete();
    });
  }

  handleOverdueTask(task: Record<string, any>, onComplete?: () => void): void {
    const taskContent = `# Task: ${task.name as string}\n\n${task.description as string}`;
    console.log(`[${this.def.name}] handleOverdueTask: enqueueing "${task.name as string}"`);
    this.backgroundQueue.enqueue(async () => {
      await this.handleSystemMessage('task_trigger', taskContent);
      onComplete?.();
    });
  }

// ── Private ────────────────────────────────────────────────────────────────

  private async runInterAgentMessage(
    fromAgent: string,
    content: string,
    async: boolean,
    onComplete?: (response: string) => void,
  ): Promise<string> {
    const system = this.buildSystemPrompt('inter-agent-message', { fromAgent, async });
    const messages: Record<string, any>[] = [
      { role: 'user', content: `[From: ${fromAgent}]\n\n${content}` },
    ];
    prepareMessages(messages);

    const model = this.chatModel();
    const mode = `inter-agent-message (from: ${fromAgent})`;
    const userMsg = messages[0]?.content as string ?? '';
    const record = createRunRecord(this.def.name, mode, system, userMsg, model);
    this.eventBus.publish({ type: 'agent_run_start', agent: this.def.name, mode: 'inter-agent-message', from: fromAgent });

    let result = '';
    try {
      const exec = new Executor(this.config.apiKey, this.confirmations);
      for await (const event of exec.runLoop(
        messages,
        system,
        model,
        this.toolInvoker.definitions(),
        this.def.name,
        this.reasoningConfig(),
        this.toolInvoker,
      )) {
        withRecordLogging(event, record);
        if (event.type === 'agent_append' && event.role === 'assistant' && typeof event.message.content === 'string') {
          result += event.message.content;
        }
      }
      onComplete?.(result);
      finishRunRecord(record, result);
    } catch (err: any) {
      const msg = err?.message ?? 'unknown error';
      result = `Error: ${msg}`;
      finishRunRecord(record, result);
    }

    saveRunRecord(record);
    this.eventBus.publish({
      type: 'agent_run_end',
      agent: this.def.name,
      mode: 'inter-agent-message',
      from: fromAgent,
      duration_ms: record.durationMs,
      result_preview: resultPreview(result),
    });
    return result;
  }

  private async handleSystemMessage(mode: string, userMsgAppend?: string, opts: { emailThreadMeta?: { threadId: string; inReplyTo: string; subject: string; replyTo: string }[] } = {}): Promise<void> {
    if (this.def.disabledModes.has(mode)) return;

    const system = this.buildSystemPrompt(mode, opts);
    const userMsg = userMsgAppend?.trim() ? userMsgAppend : `[${mode}]`;

    const messages: Record<string, any>[] = [{ role: 'user', content: userMsg }];
    const bgModel = this.backgroundModel();
    const record = createRunRecord(this.def.name, mode, system, userMsg, bgModel);
    this.eventBus.publish({ type: 'agent_run_start', agent: this.def.name, mode });

    const invoker = mode === 'check_email_trigger'
      ? {
          definitions: () => this.toolInvoker.definitions(),
          invoke: (name: string, input: Record<string, any>, agent: string) => {
            if (name === 'message_agent' || name === 'post_message') {
              return { error: 'message_agent and post_message are not allowed in check_email_trigger — tag the agent in your email reply instead.' };
            }
            return this.toolInvoker.invoke(name, input, agent);
          },
        }
      : this.toolInvoker;

    let result = '';
    try {
      const exec = new Executor(this.config.apiKey, this.confirmations);
      for await (const event of exec.runLoop(
        messages,
        system,
        bgModel,
        invoker.definitions(),
        this.def.name,
        null,
        invoker,
      )) {
        withRecordLogging(event, record);
        if (event.type === 'agent_append' && event.role === 'assistant' && typeof event.message.content === 'string') {
          result += event.message.content;
        }
      }
      finishRunRecord(record, result);
    } catch (err: any) {
      result = `ERROR: ${err?.message ?? 'unknown'}`;
      finishRunRecord(record, result);
    }

    saveRunRecord(record);
    this.eventBus.publish({
      type: 'agent_run_end',
      agent: this.def.name,
      mode,
      duration_ms: record.durationMs,
      result_preview: resultPreview(result),
    });
  }

  private initListeners(): void {
    void (async () => {
      try {
        for await (const event of this.eventBus.subscribe()) {
          const forMe = event.agent == null || event.agent === this.def.name;
          if (!forMe) continue;
        }
      } catch (err) {
        console.warn(`[${this.def.name}] event stream error:`, err);
      }
    })();
  }

  // ── Prompt building ────────────────────────────────────────────────────────

  private buildSystemPrompt(
    mode: string,
    opts: { sessionId?: string; fromAgent?: string; async?: boolean; emailThreadMeta?: { threadId: string; inReplyTo: string; subject: string; replyTo: string }[] },
  ): string {
    const parts: string[] = [LIFEOS_PROMPT];

    parts.push('\n\n# Your Identity\n\n' + this.identityWithName());

    if (this.def.goal) parts.push('\n\n# Your Goal\n\n' + this.def.goal);

    parts.push('\n\n# Current Mode: ' + mode);

    if (mode === 'chat') {
      parts.push('\n\n' + CHAT_SCAFFOLD);
      if (opts.sessionId) {
        parts.push(`\n\n**Session ID:** ${opts.sessionId}`);
        const parentSummary = this.session.getParentSummary(opts.sessionId);
        if (parentSummary) {
          parts.push(`\n\n## Last Session — ${parentSummary.dateStr}\n\n${parentSummary.content}`);
        }
      }
    } else if (mode === 'inter-agent-message') {
      parts.push('\n\n' + INTER_AGENT);
      if (opts.async) {
        parts.push(
          '\n\n> **Async message** — the sender has moved on and will not receive your text directly. ' +
          'Your response is written to the feed. ' +
          'Call `post_message` if you need to send them an explicit reply.',
        );
      } else {
        parts.push(
          '\n\n> **Sync message** — the sender is blocking and waiting. ' +
          'Your text response will be returned to them directly. ' +
          'Do NOT call `message_agent` (sync) to reply — deadlock.',
        );
      }
    } else {
      parts.push('\n\n' + this.modePrompt(mode));
      if (mode === 'check_email_trigger') {
        if (opts.emailThreadMeta?.length) {
          const threadLines = opts.emailThreadMeta.map((t) =>
            `- **thread_id:** \`${t.threadId}\` | **in_reply_to:** \`${t.inReplyTo}\` | **subject:** ${t.subject} | **reply_to:** ${t.replyTo}`,
          );
          parts.push(
            `\n\n**You are processing ${opts.emailThreadMeta.length === 1 ? 'this thread' : 'these threads'} — use the fields below when calling \`send_email\` or \`send_file_email\` to reply, and pass all thread_ids to \`email_thread_ids\` in \`log_entry\`:**\n\n${threadLines.join('\n')}`,
          );
        }
        if (this.config.mailboxEmail) {
          parts.push(
            `\n\n**Shared mailbox:** \`${this.config.mailboxEmail}\` — all agents share this address. ` +
            `Always close every outbound email with your name so recipients know who they are speaking with:\n\n` +
            `— ${this.def.title} (@${this.def.name})`,
          );
        }
      }
    }

    const now = new Intl.DateTimeFormat('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    }).format(new Date());
    parts.push('\n\n# Current Date & Time\n\n' + now);

    return parts.join('').trim();
  }

  private identityWithName(): string {
    const id = this.identity();
    const header: string[] = [`Your name is **${this.def.name}**.`];
    if (this.def.manager) header.push(` Your manager is **${this.def.manager}**.`);
    const hires = this.hiresProvider();
    if (hires.length > 0) {
      header.push('\n\nYour hires: ' + hires.map((h) => `**${h}**`).join(', '));
    }
    header.push(
      '\n\nUse `read_agent_definition` with your own name to review your full definition — ' +
      'identity, goal, and instructions — and make sure your work is aligned with it.',
    );
    const headerStr = header.join('');
    return id.trim() ? headerStr + '\n\n' + id : headerStr;
  }

  private identity(): string {
    if (!this.def.identity.length) return '';
    return this.def.identity.map((f) => loadPrompt(this.def.promptBase, f)).join('\n\n');
  }

  private modePrompt(mode: string): string {
    if (mode === 'check_email_trigger') return CHECK_EMAIL;
    if (mode === 'task_trigger') return TASK_TRIGGER;
    throw new Error(`Unknown system mode: ${mode}`);
  }

  // ── Models ─────────────────────────────────────────────────────────────────

  private chatModel(): string {
    return this.def.model ?? this.config.model;
  }

  private effectiveChatModel(override?: string): string {
    if (override?.trim()) return override;
    return this.chatModel();
  }

  private backgroundModel(): string {
    if (this.def.backgroundModel?.trim()) return this.def.backgroundModel;
    return this.config.backgroundModel;
  }

  private reasoningConfig(): Record<string, any> | null {
    const r = this.def.reasoning ?? (this.config.reasoning
      ? { effort: this.config.reasoning.effort, maxTokens: this.config.reasoning.maxTokens }
      : null);
    if (!r) return null;
    const map: Record<string, any> = {};
    if (r.effort) map.effort = r.effort;
    else if (r.maxTokens) map.max_tokens = r.maxTokens;
    return Object.keys(map).length ? map : null;
  }

}

// ── Helpers ───────────────────────────────────────────────────────────────────

function withRecordLogging(event: ExecutorEvent, record: RunRecord): void {
  if (event.type === 'llm_request') {
    if (!record.initialMessages) setInitialMessages(record, event.messages);
    if (!record.toolNames) {
      record.toolNames = event.tools.map((t) => (t as any).name).filter(Boolean);
    }
  } else if (event.type === 'agent_append') {
    addTurn(record, event.role, event.message);
  } else if (event.type === 'llm_response') {
    addTokens(record, event.usage.input_tokens, event.usage.output_tokens);
  }
}

function hasToolUse(msg: Record<string, any>): boolean {
  return Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
}

function truncateTail(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  const cut = s.slice(s.length - maxChars);
  const nl = cut.indexOf('\n');
  return '[…]\n' + (nl >= 0 ? cut.slice(nl + 1) : cut);
}

function resultPreview(result: string): string {
  if (!result?.trim()) return 'no output';
  const s = result.trim();
  return s.length > 120 ? s.slice(0, 120) + '…' : s;
}

function formatEmailsForAgent(emails: EmailMessage[]): string {
  // Group by threadId — multiple unread messages on the same thread show as one entry
  const threads = new Map<string, EmailMessage[]>();
  for (const email of emails) {
    if (!threads.has(email.threadId)) threads.set(email.threadId, []);
    threads.get(email.threadId)!.push(email);
  }

  const lines: string[] = ['\n\n# Email(s) for You\n'];
  for (const threadEmails of threads.values()) {
    const first = threadEmails[0]!;
    const last = threadEmails[threadEmails.length - 1]!;
    lines.push('---');
    lines.push(`Subject: ${first.subject}`);
    lines.push(`From: ${last.from}`);
    if (last.to) lines.push(`To: ${last.to}`);
    if (last.cc) lines.push(`CC: ${last.cc}`);
    lines.push(`Message-ID: ${last.rfcMessageId.replace(/^<|>$/g, '')}`);
    if (first.thread.length > 0) {
      lines.push('\n**Thread history:**');
      const truncated = truncateThreadHistory(first.thread);
      if (truncated.dropped > 0) {
        lines.push(`> *[${truncated.dropped} earlier message(s) omitted for length]*`);
        lines.push('');
      }
      for (const msg of truncated.messages) {
        lines.push(`> From: ${msg.from} | ${msg.date}`);
        const stripped = stripQuotedLines(msg.body);
        lines.push(`> ${stripped.split('\n').join('\n> ')}`);
        lines.push('');
      }
    }
    lines.push('\n**New message(s):**');
    for (const email of threadEmails) {
      lines.push(`From: ${email.from}`);
      lines.push(stripQuotedLines(email.body));
      lines.push('');
    }
  }
  lines.push('---');
  return lines.join('\n');
}

const MAX_THREAD_HISTORY_CHARS = 20_000;

function truncateThreadHistory(msgs: { from: string; date: string; body: string }[]): {
  messages: { from: string; date: string; body: string }[];
  dropped: number;
} {
  // Keep the most recent messages that fit within the char budget (drop oldest first)
  let total = 0;
  let cutIdx = msgs.length;
  for (let i = msgs.length - 1; i >= 0; i--) {
    total += msgs[i]!.from.length + msgs[i]!.body.length;
    if (total > MAX_THREAD_HISTORY_CHARS) { cutIdx = i + 1; break; }
    cutIdx = i;
  }
  return { messages: msgs.slice(cutIdx), dropped: cutIdx };
}

function stripQuotedLines(body: string): string {
  return body
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('>'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
