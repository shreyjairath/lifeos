import { Executor, prepareMessages } from './executor/executor.js';
import { LlmClient } from './executor/llm-client.js';
import { Confirmations } from './executor/confirmations.js';
import { SessionHandler } from './session/session-handler.js';
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
const POST_SESSION = loadGenericPrompt('post-session.md');
const HEARTBEAT = loadGenericPrompt('heartbeat.md');
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

  /** Serializes all background runs (heartbeat, post-session) per agent */
  private readonly backgroundQueue = new BackgroundQueue();
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
    this.session = new SessionHandler(config, def.name, (sessionId) => {
      this.backgroundQueue.enqueue(() =>
        this.handleSystemMessage('post-session', `\n\n# Closed Session ID\n\n${sessionId}`),
      );
    });
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
    const record = createRunRecord(this.def.name, 'chat', userMessage, model);
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
  handleAgentMessageAsync(fromAgent: string, content: string): void {
    this.backgroundQueue.enqueue(() =>
      this.runInterAgentMessage(fromAgent, content, true).then(() => {}),
    );
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async runInterAgentMessage(
    fromAgent: string,
    content: string,
    async: boolean,
  ): Promise<string> {
    const channelLog = this.loadChannelLog(fromAgent);
    const system = this.buildSystemPrompt('inter-agent-message', { fromAgent, channelLog, async });
    const messages: Record<string, any>[] = [
      { role: 'user', content: `[From: ${fromAgent}]\n\n${content}` },
    ];
    prepareMessages(messages);

    const model = this.chatModel();
    const mode = `inter-agent-message (from: ${fromAgent})`;
    const record = createRunRecord(this.def.name, mode, system, model);
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
      this.appendChannelLog(fromAgent, content, result);
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

  private async handleSystemMessage(mode: string, userMsgAppend?: string): Promise<void> {
    if (this.def.disabledModes.has(mode)) return;

    const system = this.buildSystemPrompt(mode, {});
    let userMsg = this.modePrompt(mode);
    if (userMsgAppend) userMsg += userMsgAppend;

    const messages: Record<string, any>[] = [{ role: 'user', content: userMsg }];
    const bgModel = this.backgroundModel();
    const record = createRunRecord(this.def.name, mode, system, bgModel);
    this.eventBus.publish({ type: 'agent_run_start', agent: this.def.name, mode });

    let result = '';
    try {
      const exec = new Executor(this.config.apiKey, this.confirmations);
      for await (const event of exec.runLoop(
        messages,
        system,
        bgModel,
        this.toolInvoker.definitions(),
        this.def.name,
        null,
        this.toolInvoker,
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
    if (this.def.disabledModes.has('heartbeat_trigger')) return;
    void (async () => {
      try {
        for await (const event of this.eventBus.subscribe()) {
          if (
            event.type === 'heartbeat_trigger' &&
            (event.agent == null || event.agent === this.def.name)
          ) {
            this.backgroundQueue.enqueue(() => this.handleSystemMessage('heartbeat_trigger'));
          }
        }
      } catch (err) {
        console.warn(`[${this.def.name}] heartbeat stream error:`, err);
      }
    })();
  }

  // ── Prompt building ────────────────────────────────────────────────────────

  private buildSystemPrompt(
    mode: string,
    opts: { sessionId?: string; fromAgent?: string; channelLog?: string; async?: boolean },
  ): string {
    const parts: string[] = [LIFEOS_PROMPT];

    parts.push('\n\n# Your Identity\n\n' + this.identityWithName());

    if (this.def.goal) parts.push('\n\n# Your Goal\n\n' + this.def.goal);

    parts.push('\n\n# Current Mode: ' + mode);

    if (mode === 'chat') {
      parts.push('\n\n' + CHAT_SCAFFOLD);
      if (this.def.chatPrompt) {
        const agentChat = loadPrompt(this.def.promptBase, this.def.chatPrompt);
        if (agentChat.trim()) parts.push('\n\n' + agentChat);
      }
      if (opts.sessionId) {
        const parentSummary = this.session.getParentSummary(opts.sessionId);
        if (parentSummary) {
          parts.push(`\n\n## Last Session — ${parentSummary.dateStr}\n\n${parentSummary.content}`);
        }
      }
    } else if (mode === 'inter-agent-message') {
      const history = opts.channelLog?.trim()
        ? truncateTail(opts.channelLog, 8_000)
        : 'No prior exchanges.';
      parts.push('\n\n' + INTER_AGENT);
      if (opts.async) {
        parts.push(
          '\n\n> **Async message** — the sender has moved on and will not receive your text directly. ' +
          'Your response is stored in the channel history. ' +
          'Call `message_agent_async` if you need to send them an explicit reply.',
        );
      } else {
        parts.push(
          '\n\n> **Sync message** — the sender is blocking and waiting. ' +
          'Your text response will be returned to them directly. ' +
          'Do NOT call `message_agent` (sync) to reply — deadlock.',
        );
      }
      parts.push(`\n\n## Prior Exchanges with ${opts.fromAgent}\n\n${history}`);
    } else {
      parts.push('\n\n' + this.modePrompt(mode));
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
    if (mode === 'post-session') return POST_SESSION;
    if (mode === 'heartbeat_trigger') return HEARTBEAT;
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

  // ── Channel log stubs (filled in by platform layer via ChannelLog) ─────────
  // Base implementation is no-op; AgentFleet wires the real ChannelLog
  protected channelLogImpl: import('./types.js').ChannelLog | null = null;

  setChannelLog(cl: import('./types.js').ChannelLog): void {
    this.channelLogImpl = cl;
  }

  private loadChannelLog(fromAgent: string): string {
    return this.channelLogImpl?.loadFull(this.def.name, fromAgent) ?? '';
  }

  private appendChannelLog(fromAgent: string, inbound: string, response: string): void {
    this.channelLogImpl?.append(fromAgent, this.def.name, inbound, response);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function withRecordLogging(event: ExecutorEvent, record: RunRecord): void {
  if (event.type === 'llm_request') {
    setInitialMessages(record, event.messages);
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
