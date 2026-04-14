import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

type ThreadEntry = {
  lastSeenMessageId: string | null;
  subject?: string;
  summary?: string;
  latestRfcMessageId?: string;
  latestFrom?: string;
  latestTo?: string;
  latestCc?: string;
};

type Store = Record<string, ThreadEntry>;

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

  markSeen(
    threadId: string,
    messageId: string,
    subject?: string,
    meta?: { latestRfcMessageId?: string; latestFrom?: string; latestTo?: string; latestCc?: string },
  ): void {
    const store = this.load();
    const existing = store[threadId];
    store[threadId] = {
      ...existing,
      lastSeenMessageId: messageId,
      ...(subject && !existing?.subject ? { subject: subject.replace(/^(Re:\s*)+/i, '') } : {}),
      ...(meta?.latestRfcMessageId !== undefined ? { latestRfcMessageId: meta.latestRfcMessageId } : {}),
      ...(meta?.latestFrom !== undefined ? { latestFrom: meta.latestFrom } : {}),
      ...(meta?.latestTo !== undefined ? { latestTo: meta.latestTo } : {}),
      ...(meta?.latestCc !== undefined ? { latestCc: meta.latestCc } : {}),
    };
    this.save(store);
  }

  readSummary(threadId: string): string | null {
    return this.load()[threadId]?.summary ?? null;
  }

  readEntry(threadId: string): ThreadEntry | null {
    return this.load()[threadId] ?? null;
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
