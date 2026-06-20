import { resolve } from 'path';
import { Executor, prepareMessages } from './executor/executor.js';
import { LlmClient } from './executor/llm-client.js';
import { Confirmations } from './executor/confirmations.js';
import { SessionHandler, type SessionSummary } from './session/session-handler.js';
import type { InboundThread } from './types.js';
import { EmailThreadStore } from '../agentfleet/tools/email-thread-store.js';
import {
  createRunRecord,
  finishRunRecord,
  addTokens,
  addTurn,
  setInitialMessages,
  saveRunRecord,
  type RunRecord,
  type RunStatus,
} from './agent-run-logs.js';
import { loadPrompt, loadGenericPrompt } from './prompt-parts.js';
import type { AgentDefinition } from './agent-definition.js';
import type { Agent, ToolInvoker, ExecutorEvent } from './types.js';
import type { AppConfig, ClientConfig } from '../config.js';


// Shared prompt scaffolding — loaded once at module init
const LIFEOS_PROMPT = loadGenericPrompt('lifeos-prompt.md');
const CHAT_SCAFFOLD = loadGenericPrompt('chat.md');
const CHECK_EMAIL = loadGenericPrompt('check-email.md');
const TASK_TRIGGER = loadGenericPrompt('task-trigger.md');
const INTER_AGENT = loadGenericPrompt('inter-agent-message.md');

// Tools only relevant when the client is present (chat UI)
const CHAT_ONLY_TOOLS = new Set(['render_artifact']);

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

export type ExecutorFactory = (llmClient: LlmClient, confirmations: Confirmations) => Executor;

const defaultExecutorFactory: ExecutorFactory = (llm, conf) => new Executor(llm, conf);

export class BaseAgent implements Agent {
  private readonly def: AgentDefinition;
  private readonly toolInvoker: ToolInvoker;
  private readonly confirmations: Confirmations;
  private readonly config: AppConfig;
  private readonly clientConfig: ClientConfig;
  private readonly agentsDir: string;
  private readonly eventBus: EventBusLike;
  private readonly hiresProvider: () => string[];
  private readonly executorFactory: ExecutorFactory;
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
    clientConfig: ClientConfig,
    agentsDir: string,
    eventBus: EventBusLike,
    hiresProvider: () => string[],
    session: SessionHandler,
    emailThreadStore: EmailThreadStore,
    executorFactory?: ExecutorFactory,
  ) {
    this.def = def;
    this.toolInvoker = toolInvoker;
    this.confirmations = confirmations;
    this.config = config;
    this.clientConfig = clientConfig;
    this.agentsDir = agentsDir;
    this.eventBus = eventBus;
    this.hiresProvider = hiresProvider;
    this.session = session;
    this.session.setLlmClientFactory(() => new LlmClient(config.apiKey));
    this.emailThreadStore = emailThreadStore;
    this.executorFactory = executorFactory ?? defaultExecutorFactory;
    this.initListeners();
  }

  // ── Agent interface ──────────────────────────────────────────────────────────

  getName(): string { return this.def.name; }
  getTitle(): string { return this.def.title; }
  getDescription(): string { return this.def.description; }
  getDefinition(): AgentDefinition { return this.def; }
  getSessionHandler(): SessionHandler { return this.session; }
  getWorkspaceDir(): string { return resolve(this.agentsDir, this.def.name, 'workspace'); }

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

    const exec = this.executorFactory(new LlmClient(this.config.apiKey), this.confirmations);
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
      saveRunRecord(record, this.agentsDir);
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
  async handleAgentMessage(fromAgent: string, content: string, threadId?: string): Promise<string> {
    return this.runInterAgentMessage(fromAgent, content, false, undefined, threadId);
  }

  /** Async variant — submits to the background queue and returns immediately. */
  handleAgentMessageAsync(fromAgent: string, content: string, onComplete?: (response: string) => void, threadId?: string): void {
    this.backgroundQueue.enqueue(() =>
      this.runInterAgentMessage(fromAgent, content, true, onComplete, threadId).then(() => {}),
    );
  }

  handleEmailCheck(threads: InboundThread[], onComplete?: (status: RunStatus) => Promise<void>): void {
    console.log(`[${this.def.name}] handleEmailCheck: received ${threads.length} thread(s), enqueueing`);
    const lines = threads.map((t) => {
      const ids = t.messageIds.map((id) => `\`${id}\``).join(', ');
      const ccLine = t.latestCc ? ` | **cc:** ${t.latestCc}` : '';
      return `- **thread_id:** \`${t.threadId}\` | **in_reply_to:** \`${t.latestRfcMessageId}\` | **from:** ${t.latestFrom} | **to:** ${t.latestTo}${ccLine} | **new_message_ids:** ${ids} | **subject:** ${t.subject}`;
    });
    const append = `\n\n# Email(s) for You\n\nCall \`read_email_thread\` on each thread before acting.\n\nWhen replying, you MUST:\n- Pass \`thread_id\` and \`in_reply_to\` (shown below) to keep the thread intact\n- Set \`to\` to the **from** address shown below\n- Set \`cc\` to all other participants in **to** and **cc** below (reply-all), omitting your own mailbox address\n\n${lines.join('\n')}`;
    this.backgroundQueue.enqueue(async () => {
      const status = await this.handleSystemMessage('check_email_trigger', append);
      if (onComplete) await onComplete(status);
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
    threadId?: string,
  ): Promise<string> {
    const system = this.buildSystemPrompt('inter-agent-message', { fromAgent, async });
    const header = threadId ? `[From: ${fromAgent} | thread: ${threadId}]` : `[From: ${fromAgent}]`;
    const messages: Record<string, any>[] = [
      { role: 'user', content: `${header}\n\n${content}` },
    ];
    prepareMessages(messages);

    const model = this.backgroundModel();
    const mode = `inter-agent-message (from: ${fromAgent})`;
    const userMsg = messages[0]?.content as string ?? '';
    const record = createRunRecord(this.def.name, mode, system, userMsg, model);
    this.eventBus.publish({ type: 'agent_run_start', agent: this.def.name, mode: 'inter-agent-message', from: fromAgent });

    let result = '';
    try {
      const exec = this.executorFactory(new LlmClient(this.config.apiKey), this.confirmations);
      const interAgentDefs = this.toolInvoker.definitions().filter((t) => !CHAT_ONLY_TOOLS.has(t.name));
      for await (const event of exec.runLoop(
        messages,
        system,
        model,
        interAgentDefs,
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

    saveRunRecord(record, this.agentsDir);
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

  private async handleSystemMessage(mode: string, userMsgAppend?: string): Promise<RunStatus> {
    if (this.def.disabledModes.has(mode)) return 'success';

    const system = this.buildSystemPrompt(mode);
    const userMsg = userMsgAppend?.trim() ? userMsgAppend : `[${mode}]`;

    const messages: Record<string, any>[] = [{ role: 'user', content: userMsg }];
    const bgModel = this.backgroundModel();
    const record = createRunRecord(this.def.name, mode, system, userMsg, bgModel);
    this.eventBus.publish({ type: 'agent_run_start', agent: this.def.name, mode });

    const invoker = this.toolInvoker;
    const bgDefs = invoker.definitions().filter((t) => !CHAT_ONLY_TOOLS.has(t.name));

    let result = '';
    let status: RunStatus = 'success';
    try {
      const exec = this.executorFactory(new LlmClient(this.config.apiKey), this.confirmations);
      for await (const event of exec.runLoop(
        messages,
        system,
        bgModel,
        bgDefs,
        this.def.name,
        null,
        invoker,
      )) {
        withRecordLogging(event, record);
        if (event.type === 'llm_text' && typeof (event as any).text === 'string' && (event as any).text.startsWith('[max turns')) {
          status = 'max_turns';
        }
        if (event.type === 'agent_append' && event.role === 'assistant' && typeof event.message.content === 'string') {
          result += event.message.content;
        }
      }
      finishRunRecord(record, result, status);
    } catch (err: any) {
      status = 'error';
      result = `ERROR: ${err?.message ?? 'unknown'}`;
      finishRunRecord(record, result, status);
    }

    saveRunRecord(record, this.agentsDir);
    this.eventBus.publish({
      type: 'agent_run_end',
      agent: this.def.name,
      mode,
      duration_ms: record.durationMs,
      result_preview: resultPreview(result),
    });
    return status;
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
    opts: { sessionId?: string; fromAgent?: string; async?: boolean } = {},
  ): string {
    const identityText = this.def.identity.length
      ? this.def.identity.map((f) => loadPrompt(this.def.promptBase, f)).join('\n\n')
      : '';
    const parentSummary = opts.sessionId
      ? this.session.getParentSummary(opts.sessionId) ?? undefined
      : undefined;

    return buildSystemPrompt(this.def, this.clientConfig, this.hiresProvider(), mode, {
      sessionId: opts.sessionId,
      fromAgent: opts.fromAgent,
      async: opts.async,
      parentSummary,
      identityText,
    });
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

// ── Exported pure function for prompt building ──────────────────────────────

export interface BuildSystemPromptOpts {
  sessionId?: string;
  fromAgent?: string;
  async?: boolean;
  parentSummary?: SessionSummary;
  identityText?: string;
}

export function buildSystemPrompt(
  def: AgentDefinition,
  clientConfig: ClientConfig,
  hires: string[],
  mode: string,
  opts: BuildSystemPromptOpts = {},
): string {
  const parts: string[] = [LIFEOS_PROMPT];

  const clientLines: string[] = [];
  if (clientConfig.name) clientLines.push(`**Name:** ${clientConfig.name}`);
  if (clientConfig.email) clientLines.push(`**Email:** ${clientConfig.email}`);
  if (clientConfig.timezone) clientLines.push(`**Timezone:** ${clientConfig.timezone}`);
  if (clientLines.length) parts.push('\n\n# The Client\n\n' + clientLines.join('\n'));

  // Identity
  const idText = opts.identityText ?? '';
  const header: string[] = [`Your name is **${def.name}**.`];
  if (def.manager) header.push(` Your manager is **${def.manager}**.`);
  if (hires.length > 0) {
    header.push('\n\nYour hires: ' + hires.map((h) => `**${h}**`).join(', '));
  }
  header.push(
    '\n\nUse `read_agent_definition` with your own name to review your full definition — ' +
    'identity, goal, and instructions — and make sure your work is aligned with it.',
  );
  const headerStr = header.join('');
  const identityBlock = idText.trim() ? headerStr + '\n\n' + idText : headerStr;
  parts.push('\n\n# Your Identity\n\n' + identityBlock);

  if (def.goal) parts.push('\n\n# Your Goal\n\n' + def.goal);

  parts.push('\n\n# Current Mode: ' + mode);

  if (mode === 'chat') {
    parts.push('\n\n' + CHAT_SCAFFOLD);
    if (opts.sessionId) {
      parts.push(`\n\n**Session ID:** ${opts.sessionId}`);
      if (opts.parentSummary) {
        parts.push(`\n\n## Last Session — ${opts.parentSummary.dateStr}\n\n${opts.parentSummary.content}`);
      }
    }
  } else if (mode === 'inter-agent-message') {
    parts.push('\n\n' + INTER_AGENT);
    if (opts.async) {
      parts.push(
        '\n\n> **Async message** — the sender has moved on and will not receive your text directly. ' +
        'Your response is written to the feed. ' +
        'Call `post_message` with `wakeup: true` if you need to wake them with an explicit reply.',
      );
    } else {
      parts.push(
        '\n\n> **Sync message** — the sender is blocking and waiting. ' +
        'Your text response will be returned to them directly. ' +
        'Do NOT call `message_agent` (sync) to reply — deadlock.',
      );
    }
  } else {
    if (mode === 'check_email_trigger') parts.push('\n\n' + CHECK_EMAIL);
    else if (mode === 'task_trigger') parts.push('\n\n' + TASK_TRIGGER);
    else throw new Error(`Unknown system mode: ${mode}`);

    if (mode === 'check_email_trigger' && clientConfig.mailboxAddress) {
      parts.push(
        `\n\n**Shared mailbox:** \`${clientConfig.mailboxAddress}\` — all agents share this address. ` +
        `Always close every outbound email with your name so recipients know who they are speaking with:\n\n` +
        `— ${def.title} (@${def.name})`,
      );
    }
  }

  const nowDate = new Date();
  const nowHuman = new Intl.DateTimeFormat('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  }).format(nowDate);
  parts.push('\n\n# Current Date & Time\n\n' + nowHuman + '\n\nISO8601: ' + nowDate.toISOString());

  return parts.join('').trim();
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

