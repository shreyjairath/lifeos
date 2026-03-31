import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'fs';
import { resolve } from 'path';
import { MONOREPO_ROOT } from '../../root.js';

const AGENTS_DIR = resolve(MONOREPO_ROOT, '.user-data/agents');

/**
 * Raw file I/O for one agent's sessions subtree:
 *   .user-data/agents/{agent}/sessions/{sessionId}/
 *     meta.json       — { title, created_at, last_message_at, last_input_tokens, parent_session_id, agent, closed }
 *     messages.json   — OpenAI message array
 *     summary.md      — written at rotation time
 */
export class SessionStore {
  private root: string;

  constructor(agentName: string) {
    this.root = resolve(AGENTS_DIR, agentName, 'sessions');
  }

  // ── Meta ──────────────────────────────────────────────────────────────────

  loadMeta(sessionId: string): Record<string, any> {
    const path = resolve(this.sessionDir(sessionId), 'meta.json');
    if (!existsSync(path)) return {};
    try {
      return JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      return {};
    }
  }

  saveMeta(sessionId: string, meta: Record<string, any>): void {
    const dir = this.sessionDir(sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
  }

  // ── Messages ──────────────────────────────────────────────────────────────

  loadMessages(sessionId: string): Record<string, any>[] {
    const path = resolve(this.sessionDir(sessionId), 'messages.json');
    if (!existsSync(path)) return [];
    try {
      return JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      return [];
    }
  }

  saveMessages(sessionId: string, messages: Record<string, any>[]): void {
    const dir = this.sessionDir(sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'messages.json'), JSON.stringify(messages, null, 2), 'utf-8');
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  readSummary(sessionId: string): string {
    const path = resolve(this.sessionDir(sessionId), 'summary.md');
    if (!existsSync(path)) return '';
    try {
      return readFileSync(path, 'utf-8').trim();
    } catch {
      return '';
    }
  }

  writeSummary(sessionId: string, content: string): void {
    const dir = this.sessionDir(sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'summary.md'), content, 'utf-8');
  }

  // ── Listing ───────────────────────────────────────────────────────────────

  listSessionDirs(): string[] {
    if (!existsSync(this.root)) return [];
    try {
      return readdirSync(this.root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
    } catch {
      return [];
    }
  }

  deleteSession(sessionId: string): void {
    const dir = this.sessionDir(sessionId);
    if (!existsSync(dir)) return;
    rmSync(dir, { recursive: true, force: true });
  }

  // ── Path helpers ──────────────────────────────────────────────────────────

  sessionDir(sessionId: string): string {
    return resolve(this.root, sessionId);
  }
}
