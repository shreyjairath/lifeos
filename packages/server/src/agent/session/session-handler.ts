import { SessionStore } from './session-store.js';
import { loadPrompt } from '../prompt-parts.js';
import type { AppConfig } from '../../config.js';

const DATE_FMT = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit',
});

function epochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function newSessionId(agent: string): string {
  const now = new Date();
  const ts = now.toISOString().replace('T', '-').replace(/:/g, '').slice(0, 17);
  return agent ? `session-${agent}-${ts}` : `session-${ts}`;
}

function extractTitle(message: Record<string, any>): string {
  const content = message.content;
  let text: string | null = null;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'text') { text = block.text; break; }
    }
  }
  if (!text?.trim()) return 'New session';
  text = text.trim();
  return text.length <= 50 ? text : text.slice(0, 47) + '…';
}

export function buildTranscript(history: Record<string, any>[]): string {
  const lines: string[] = [];
  for (const msg of history) {
    const role = ((msg.role as string) ?? '').toUpperCase();
    const content = msg.content;
    if (typeof content === 'string') {
      lines.push(`${role}: ${content}`);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'text') lines.push(`${role}: ${block.text}`);
        else if (block?.type === 'tool_use') lines.push(`TOOL CALL [${block.name}]: ${JSON.stringify(block.input ?? {})}`);
        else if (block?.type === 'tool_result') lines.push(`TOOL RESULT: ${block.content ?? ''}`);
      }
    }
  }
  return lines.join('\n\n');
}

export interface RotationCheck {
  shouldRotate: boolean;
  reason: string;
}

export interface SessionSummary {
  content: string;
  dateStr: string;
}

export class SessionHandler {
  private store: SessionStore;
  private config: AppConfig;
  private agentName: string;
  // LlmClient injected lazily to avoid circular dep at construction time
  private getLlmClient?: () => { streamBlocking(model: string, system: string, messages: Record<string, any>[], maxTokens: number): Promise<string> };

  constructor(
    config: AppConfig,
    agentsDir: string,
    agentName: string,
  ) {
    this.config = config;
    this.agentName = agentName;
    this.store = new SessionStore(agentsDir, agentName);
  }

  /** Inject LlmClient after construction to avoid circular dependency */
  setLlmClientFactory(fn: () => { streamBlocking(model: string, system: string, messages: Record<string, any>[], maxTokens: number): Promise<string> }): void {
    this.getLlmClient = fn;
  }

  // ── Session lifecycle ─────────────────────────────────────────────────────

  createNew(agent: string): string {
    this.pruneEmpty();
    const sessionId = newSessionId(agent);
    const meta = this.buildMeta(sessionId, agent);
    this.store.saveMeta(sessionId, meta);
    this.store.saveMessages(sessionId, []);
    return sessionId;
  }

  rotate(oldSessionId: string): string {
    const oldMeta = this.store.loadMeta(oldSessionId);
    const agent = (oldMeta.agent as string) ?? this.agentName;
    oldMeta.closed = true;
    this.store.saveMeta(oldSessionId, oldMeta);

    const newSessionId_ = newSessionId(agent);
    const meta = this.buildMeta(newSessionId_, agent);
    meta.parent_session_id = oldSessionId;
    this.store.saveMeta(newSessionId_, meta);
    this.store.saveMessages(newSessionId_, []);

    // Run summarization asynchronously (don't block)
    const closedId = oldSessionId;
    void this.summarize(closedId, buildTranscript(this.getHistory(closedId)));

    return newSessionId_;
  }

  checkRotation(sessionId: string): RotationCheck {
    const meta = this.getSessionMeta(sessionId);
    if (!meta || Object.keys(meta).length === 0) return { shouldRotate: false, reason: '' };

    const { tokenThreshold, timeThresholdHours } = this.config.session;
    const lastInputTokens = Number(meta.last_input_tokens ?? 0);
    if (lastInputTokens >= tokenThreshold) {
      return { shouldRotate: true, reason: `context window (${lastInputTokens.toLocaleString()} input tokens)` };
    }
    if (meta.last_message_at) {
      const elapsed = epochSeconds() - Number(meta.last_message_at);
      if (elapsed >= timeThresholdHours * 3600) {
        return { shouldRotate: true, reason: `inactivity (${(elapsed / 3600).toFixed(0)}h since last message)` };
      }
    }
    return { shouldRotate: false, reason: '' };
  }

  // ── Messages ──────────────────────────────────────────────────────────────

  getHistory(sessionId: string): Record<string, any>[] {
    return [...this.store.loadMessages(sessionId)];
  }

  appendMessage(sessionId: string, message: Record<string, any>): void {
    const messages = this.store.loadMessages(sessionId);
    if (messages.length === 0 && message.role === 'user') {
      const meta = this.store.loadMeta(sessionId);
      if (!meta.title || meta.title === 'New Chat') {
        meta.title = extractTitle(message);
        this.store.saveMeta(sessionId, meta);
      }
    }
    const tagged = { ...message };
    if (!tagged._ts) tagged._ts = epochSeconds();
    messages.push(tagged);
    this.store.saveMessages(sessionId, messages);
  }

  delete(sessionId: string): void {
    this.store.deleteSession(sessionId);
  }

  clearSession(sessionId: string): void {
    this.store.saveMessages(sessionId, []);
  }

  truncateSession(sessionId: string, fromIndex: number): number {
    const messages = this.store.loadMessages(sessionId);
    const truncated = messages.slice(0, Math.min(fromIndex, messages.length));
    this.store.saveMessages(sessionId, truncated);
    return truncated.length;
  }

  // ── Meta ──────────────────────────────────────────────────────────────────

  getSessionMeta(sessionId: string): Record<string, any> {
    return { ...this.store.loadMeta(sessionId) };
  }

  updateSessionMeta(sessionId: string, inputTokens: number): void {
    const meta = this.store.loadMeta(sessionId);
    meta.last_message_at = epochSeconds();
    meta.last_input_tokens = inputTokens;
    this.store.saveMeta(sessionId, meta);
  }

  // ── Listing ───────────────────────────────────────────────────────────────

  pruneEmptySessions(): void {
    this.pruneEmpty();
  }

  listSessions(): Record<string, any>[] {
    const result: Record<string, any>[] = [];
    for (const sessionId of this.store.listSessionDirs()) {
      const meta = this.store.loadMeta(sessionId);
      if (!meta || Object.keys(meta).length === 0) continue;
      if (meta.closed) continue;
      result.push({
        id: sessionId,
        title: meta.title ?? sessionId,
        created_at: meta.created_at ?? 0,
        last_message_at: meta.last_message_at ?? 0,
        last_input_tokens: meta.last_input_tokens ?? 0,
        agent: meta.agent ?? 'cos',
      });
    }
    return result.sort((a, b) => {
      const aTime = (a.last_message_at || a.created_at || 0) as number;
      const bTime = (b.last_message_at || b.created_at || 0) as number;
      return bTime - aTime;
    });
  }

  // ── Display history ───────────────────────────────────────────────────────

  getDisplayHistory(sessionId: string): Record<string, any> {
    const history = this.getHistory(sessionId);
    return { messages: this.buildDisplayMessages(history), total: history.length, session_id: sessionId };
  }

  // ── Summary / parent context ──────────────────────────────────────────────

  getParentSummary(sessionId: string): SessionSummary | null {
    const meta = this.getSessionMeta(sessionId);
    const parentId = meta.parent_session_id as string | undefined;
    if (!parentId) return null;

    const parentMeta = this.store.loadMeta(parentId);
    const createdAt = Number(parentMeta.created_at ?? 0);
    const dateStr = createdAt > 0
      ? DATE_FMT.format(new Date(createdAt * 1000))
      : 'unknown';

    const summary = this.store.readSummary(parentId);
    if (summary) return { content: summary, dateStr };

    // Summary not ready — fall back to tail of parent history
    const history = this.getHistory(parentId);
    if (history.length === 0) return null;
    const tail = history.length > 20 ? history.slice(-20) : history;
    const transcript = buildTranscript(tail);
    if (!transcript.trim()) return null;
    return { content: `*(summary pending — recent transcript)*\n\n${transcript}`, dateStr };
  }

  // ── Expiry check ──────────────────────────────────────────────────────────

  checkExpiredSessions(): void {
    for (const sessionId of this.store.listSessionDirs()) {
      try {
        const meta = this.store.loadMeta(sessionId);
        if (this.store.readSummary(sessionId)) continue;
        if (this.store.loadMessages(sessionId).length === 0) continue;
        const rotation = this.checkRotation(sessionId);
        if (!rotation.shouldRotate) continue;
        console.log(`[SessionHandler] session ${sessionId} expired (${rotation.reason})`);
        meta.closed = true;
        this.store.saveMeta(sessionId, meta);
        void this.summarize(sessionId, buildTranscript(this.getHistory(sessionId)));
      } catch (e) {
        console.warn(`[SessionHandler] error checking session ${sessionId}:`, e);
      }
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async summarize(sessionId: string, transcript: string): Promise<void> {
    if (!transcript.trim() || !this.getLlmClient) return;
    try {
      const llm = this.getLlmClient();
      const systemPrompt = loadPrompt('agents/session_summarizer', 'summarize.md');
      const text = await llm.streamBlocking(
        this.config.backgroundModel,
        systemPrompt,
        [{ role: 'user', content: transcript }],
        1024,
      );
      if (!text.trim()) return;

      let title: string | null = null;
      let summary = text.trim();
      if (summary.startsWith('TITLE:')) {
        const nl = summary.indexOf('\n');
        if (nl > 0) {
          title = summary.slice('TITLE:'.length, nl).trim();
          summary = summary.slice(nl).trim();
        }
      }
      if (summary) this.store.writeSummary(sessionId, summary);
      if (title) {
        const meta = { ...this.store.loadMeta(sessionId), title };
        this.store.saveMeta(sessionId, meta);
      }
    } catch (e) {
      console.warn(`[SessionHandler] summarization failed for ${sessionId}:`, e);
    }
  }

  private buildMeta(sessionId: string, agent: string): Record<string, any> {
    return { id: sessionId, title: 'New Chat', created_at: epochSeconds(), agent };
  }

  private buildDisplayMessages(messages: Record<string, any>[]): Record<string, any>[] {
    const display: Record<string, any>[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      const role = msg.role as string;
      if (role !== 'user' && role !== 'assistant') continue;
      const content = msg.content;
      const ts = Number(msg._ts ?? 0);
      const reasoning = typeof msg.reasoning === 'string' ? msg.reasoning : undefined;
      let text: string | null = null;
      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        text = content.filter((b) => b?.type === 'text').map((b) => b.text).join(' ');
      }
      if (text) {
        const entry: Record<string, any> = { role, text, raw_index: i, ts };
        if (reasoning) entry.reasoning = reasoning;
        display.push(entry);
      }
    }
    return display;
  }

  private pruneEmpty(): void {
    for (const sessionId of this.store.listSessionDirs()) {
      if (this.store.loadMessages(sessionId).length === 0) {
        this.store.deleteSession(sessionId);
      }
    }
  }
}
