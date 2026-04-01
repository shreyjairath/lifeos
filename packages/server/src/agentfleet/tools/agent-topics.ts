import { MONOREPO_ROOT } from '../../root.js';
import {
  existsSync, mkdirSync, readdirSync,
  readFileSync, appendFileSync, writeFileSync,
} from 'fs';
import { resolve, dirname } from 'path';

const TOPICS_DIR = resolve(MONOREPO_ROOT, '.user-data', 'topics');
const CURSORS_DIR = resolve(TOPICS_DIR, '.cursors');
const MAX_ENTRIES = 100;
const DEFAULT_FIRST_READ = 20;
const HEADER_RE = /^## (\S+) \| (.+)$/;

export class AgentTopics {
  constructor() {
    mkdirSync(TOPICS_DIR, { recursive: true });
    mkdirSync(CURSORS_DIR, { recursive: true });
  }

  writeTopic(fromAgent: string, topic: string, message: string): Record<string, any> {
    if (!topic || !/^[a-z0-9_-]+$/.test(topic)) {
      return { error: 'topic must only contain lowercase letters, digits, underscores, or hyphens' };
    }
    if (!message?.trim()) return { error: 'message is required' };

    const ts = new Date().toISOString();
    const entry = `## ${ts} | ${fromAgent}\n\n${message.trim()}\n\n---\n\n`;
    const file = resolve(TOPICS_DIR, `${topic}.md`);
    try {
      appendFileSync(file, entry, 'utf-8');
      pruneFile(file);
      return { status: 'written', topic };
    } catch (err: any) {
      return { error: err?.message ?? 'unknown' };
    }
  }

  readTopic(agentName: string, topic: string): Record<string, any> {
    if (!topic?.trim()) return { error: 'topic is required' };

    const file = resolve(TOPICS_DIR, `${topic}.md`);
    if (!existsSync(file)) return { topic, messages: [], count: 0 };

    try {
      const raw = readFileSync(file, 'utf-8');
      const allEntries = raw.split(/(?<=\n---\n\n)/).filter((e) => e.trim());

      const cursor = this.readCursor(agentName, topic);
      const firstRead = cursor === null;
      this.writeCursor(agentName, topic, new Date().toISOString());

      let messages: Record<string, any>[];
      if (firstRead) {
        const subset = allEntries.length > DEFAULT_FIRST_READ
          ? allEntries.slice(-DEFAULT_FIRST_READ)
          : allEntries;
        messages = subset.map(parseEntry).filter(Boolean) as Record<string, any>[];
      } else {
        const cursorTs = new Date(cursor!).getTime();
        messages = allEntries
          .map((e) => parseEntryAfter(e, cursorTs))
          .filter(Boolean) as Record<string, any>[];
      }

      return { topic, messages, count: messages.length };
    } catch (err: any) {
      return { error: err?.message ?? 'unknown' };
    }
  }

  listTopics(callerAgent: string): Record<string, any> {
    try {
      if (!existsSync(TOPICS_DIR)) return { topics: [] };
      const files = readdirSync(TOPICS_DIR)
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
    const file = resolve(CURSORS_DIR, agentName, topic);
    if (!existsSync(file)) return null;
    try {
      return readFileSync(file, 'utf-8').trim();
    } catch {
      return null;
    }
  }

  private writeCursor(agentName: string, topic: string, ts: string): void {
    const file = resolve(CURSORS_DIR, agentName, topic);
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, ts, 'utf-8');
    } catch { /* ignore */ }
  }
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
    const content = lines.slice(2).join('\n').trim();
    return { timestamp: m[1], from: m[2], message: content };
  } catch {
    return null;
  }
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
