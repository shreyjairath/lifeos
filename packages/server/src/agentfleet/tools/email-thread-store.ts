import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

type Store = Record<string, { lastSeenMessageId: string | null; subject?: string; summary?: string }>;

export class EmailThreadStore {
  private readonly path: string;

  constructor(agentsDir: string, agentName: string) {
    const dir = resolve(agentsDir, agentName);
    mkdirSync(dir, { recursive: true });
    this.path = resolve(dir, 'email-threads.json');
  }

  getLastSeen(threadId: string): string | null {
    return this.load()[threadId]?.lastSeenMessageId ?? null;
  }

  markSeen(threadId: string, messageId: string, subject?: string): void {
    const store = this.load();
    const existing = store[threadId];
    store[threadId] = {
      ...existing,
      lastSeenMessageId: messageId,
      ...(subject && !existing?.subject ? { subject: subject.replace(/^(Re:\s*)+/i, '') } : {}),
    };
    this.save(store);
  }

  readSummary(threadId: string): string {
    return this.load()[threadId]?.summary ?? '';
  }

  writeSummary(threadId: string, summary: string): void {
    const store = this.load();
    store[threadId] = { ...store[threadId], lastSeenMessageId: store[threadId]?.lastSeenMessageId ?? null, summary };
    this.save(store);
  }

  remove(threadId: string): void {
    const store = this.load();
    delete store[threadId];
    this.save(store);
  }

  private load(): Store {
    if (!existsSync(this.path)) return {};
    try {
      return JSON.parse(readFileSync(this.path, 'utf-8')) as Store;
    } catch {
      return {};
    }
  }

  private save(store: Store): void {
    writeFileSync(this.path, JSON.stringify(store, null, 2), 'utf-8');
  }
}
