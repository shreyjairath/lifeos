import {
  existsSync, mkdirSync, readdirSync,
  readFileSync, appendFileSync, writeFileSync,
} from 'fs';
import { resolve, dirname } from 'path';

const MAX_ENTRIES = 100;
const DEFAULT_PAGE_SIZE = 20;
const HEADER_RE = /^## (\S+) \| (.+)$/;

export class AgentTopics {
  private readonly topicsDir: string;
  private readonly cursorsDir: string;

  constructor(topicsDir: string) {
    this.topicsDir = topicsDir;
    this.cursorsDir = resolve(topicsDir, '.cursors');
    mkdirSync(this.topicsDir, { recursive: true });
    mkdirSync(this.cursorsDir, { recursive: true });
  }

  getTopicsDir(): string { return this.topicsDir; }

  writeTopic(fromAgent: string, topic: string, message: string, to?: string[], threadId?: string): Record<string, any> {
    if (!topic || !/^[a-z0-9_-]+$/.test(topic)) {
      return { error: 'topic must only contain lowercase letters, digits, underscores, or hyphens' };
    }
    if (!message?.trim()) return { error: 'message is required' };

    const ts = new Date().toISOString();
    let header: string;
    if (to !== undefined || threadId !== undefined) {
      const toStr = to && to.length > 0 ? to.map((a) => `@${a}`).join(' ') : 'broadcast';
      const tid = threadId ?? randomId();
      header = `## ${ts} | from: ${fromAgent} | to: ${toStr} | thread: ${tid}`;
    } else {
      header = `## ${ts} | ${fromAgent}`;
    }
    const entry = `${header}\n\n${message.trim()}\n\n---\n\n`;
    const file = resolve(this.topicsDir, `${topic}.md`);
    try {
      appendFileSync(file, entry, 'utf-8');
      pruneFile(file);
      return { status: 'written', topic };
    } catch (err: any) {
      return { error: err?.message ?? 'unknown' };
    }
  }

  readTopic(agentName: string, topic: string, consume = true, filter?: string, page = 1, pageSize = DEFAULT_PAGE_SIZE): Record<string, any> {
    if (!topic?.trim()) return { error: 'topic is required' };

    const file = resolve(this.topicsDir, `${topic}.md`);
    if (!existsSync(file)) return { topic, messages: [], count: 0 };

    try {
      const raw = readFileSync(file, 'utf-8');
      const allEntries = raw.split(/(?<=\n---\n\n)/).filter((e) => e.trim());

      // Both modes apply the cursor as a lower bound — only entries after the last
      // reconcile (consume: true) are visible. consume: false peeks at the same
      // unreconciled window without advancing the cursor; consume: true advances it.
      const cursor = this.readCursor(agentName, topic);
      const cursorMs = cursor ? new Date(cursor).getTime() : null;

      if (!consume) {
        // Peek: unreconciled window only, paginated newest-first, cursor not advanced
        const sinceFilter = allEntries.filter((e) => !cursorMs || entryTimestamp(e) > cursorMs);
        const filtered = filter ? sinceFilter.filter((e) => e.includes(filter)) : sinceFilter;
        const total = filtered.length;
        const p = Math.max(1, page);
        const ps = Math.max(1, pageSize);
        const end = total - (p - 1) * ps;
        const start = Math.max(0, end - ps);
        const page_entries = filtered.slice(start, end).reverse();
        const messages = page_entries.map(parseEntry).filter(Boolean) as Record<string, any>[];
        return { topic, messages, count: messages.length, total, page: p, page_size: ps, pages: Math.ceil(total / ps) };
      }

      // Consume: unreconciled window, advance cursor, no pagination
      this.writeCursor(agentName, topic, new Date().toISOString());

      const filtered = filter ? allEntries.filter((e) => e.includes(filter)) : allEntries;
      const messages = filtered
        .map((e) => parseEntryAfter(e, cursorMs))
        .filter(Boolean) as Record<string, any>[];
      return { topic, messages, count: messages.length };
    } catch (err: any) {
      return { error: err?.message ?? 'unknown' };
    }
  }

  listTopics(callerAgent: string): Record<string, any> {
    try {
      if (!existsSync(this.topicsDir)) return { topics: [] };
      const files = readdirSync(this.topicsDir)
        .filter((f) => f.endsWith('.md'))
        .sort();
      const topics = files.map((f) => ({
        name: f.replace('.md', ''),
      }));
      return { topics };
    } catch {
      return { topics: [] };
    }
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private readCursor(agentName: string, topic: string): string | null {
    const file = resolve(this.cursorsDir, agentName, topic);
    if (!existsSync(file)) return null;
    try {
      return readFileSync(file, 'utf-8').trim();
    } catch {
      return null;
    }
  }

  private writeCursor(agentName: string, topic: string, ts: string): void {
    const file = resolve(this.cursorsDir, agentName, topic);
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, ts, 'utf-8');
    } catch { /* ignore */ }
  }
}

function entryTimestamp(entry: string): number {
  const m = HEADER_RE.exec(entry.trim().split('\n')[0]?.trim() ?? '');
  if (!m) return 0;
  try { return new Date(m[1]!).getTime(); } catch { return 0; }
}

function parseEntry(entry: string): Record<string, any> | null {
  return parseEntryAfter(entry, null);
}

function parseEntryAfter(entry: string, cursorMs: number | null): Record<string, any> | null {
  const lines = entry.trim().split('\n');
  if (!lines.length) return null;
  const m = HEADER_RE.exec(lines[0]!.trim());
  if (!m) return null;
  try {
    const ts = new Date(m[1]!).getTime();
    if (cursorMs !== null && ts <= cursorMs) return null;
    const content = lines.slice(2).join('\n').replace(/\n\n---$/, '').trim();
    return { timestamp: m[1], from: m[2], message: content };
  } catch {
    return null;
  }
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 8);
}

function pruneFile(file: string): void {
  try {
    const raw = readFileSync(file, 'utf-8');
    const entries = raw.split(/(?<=\n---\n\n)/);
    if (entries.length > MAX_ENTRIES) {
      writeFileSync(file, entries.slice(-MAX_ENTRIES).join(''), 'utf-8');
    }
  } catch { /* ignore */ }
}
