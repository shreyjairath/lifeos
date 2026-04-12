import { SessionStore } from '../../agent/session/session-store.js';

const DATE_FMT = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit',
});

export class SessionToolsImpl {
  constructor(private readonly storeFactory: (agentName: string) => SessionStore) {}

  dispatch(toolName: string, input: Record<string, any>, agentName: string): Record<string, any> | null {
    const store = this.storeFactory(agentName);
    switch (toolName) {
      case 'list_sessions':           return this.listSessions(store);
      case 'read_session_summary':    return this.readSessionSummary(store, input.session_id as string);
      case 'read_session_transcript': return this.readSessionTranscript(store, input.session_id as string);
      case 'write_session_summary':   return this.writeSessionSummary(store, input.session_id as string, input.summary as string);
      default: return null;
    }
  }

  private listSessions(store: SessionStore): Record<string, any> {
    const entries: { createdAt: number; data: Record<string, any> }[] = [];
    for (const sessionId of store.listSessionDirs()) {
      const meta = store.loadMeta(sessionId);
      if (!meta || Object.keys(meta).length === 0) continue;
      const createdAt = Number(meta.created_at ?? 0);
      entries.push({
        createdAt,
        data: {
          session_id: sessionId,
          title: meta.title ?? meta.name ?? sessionId,
          date: createdAt > 0 ? DATE_FMT.format(new Date(createdAt * 1000)) : 'unknown',
          summary: store.readSummary(sessionId) ?? null,
        },
      });
    }
    entries.sort((a, b) => b.createdAt - a.createdAt);
    return { sessions: entries.map((e) => e.data) };
  }

  private readSessionSummary(store: SessionStore, sessionId: string): Record<string, any> {
    if (!sessionId?.trim()) return { error: 'session_id required' };
    const summary = store.readSummary(sessionId);
    if (!summary) return { error: `No summary found for session: ${sessionId}` };
    return { session_id: sessionId, summary };
  }

  private writeSessionSummary(store: SessionStore, sessionId: string, summary: string): Record<string, any> {
    if (!sessionId?.trim()) return { error: 'session_id required' };
    if (!summary?.trim()) return { error: 'summary required' };
    store.writeSummary(sessionId, summary.trim());
    return { status: 'written', session_id: sessionId };
  }

  private readSessionTranscript(store: SessionStore, sessionId: string): Record<string, any> {
    if (!sessionId?.trim()) return { error: 'session_id required' };
    const messages = store.loadMessages(sessionId);
    if (!messages.length) return { error: `No messages found for session: ${sessionId}` };
    const lines: string[] = [];
    for (const msg of messages) {
      const role = (msg.role as string) ?? '';
      if (role !== 'user' && role !== 'assistant') continue;
      const content = msg.content;
      if (typeof content === 'string' && content.trim()) {
        lines.push(`${role.toUpperCase()}: ${content}`);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'text' && block.text?.trim()) {
            lines.push(`${role.toUpperCase()}: ${block.text}`);
          }
        }
      }
    }
    return { session_id: sessionId, transcript: lines.join('\n\n') };
  }
}
