import { existsSync, appendFileSync, readFileSync } from 'fs';
import { resolve } from 'path';

export class AgentLog {
  private readonly file: string;

  constructor(workspacePath: string) {
    this.file = resolve(workspacePath, '_log.md');
  }

  append(mode: string, summary: string, changed?: string, notes?: string): Record<string, any> {
    try {
      const now = new Date();
      const ts = now.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
      const iso = now.toISOString();

      let entry = `## ${ts} — ${mode}\n\n`;
      entry += `**Summary:** ${summary.trim()}\n`;
      if (changed?.trim()) entry += `\n**Changed:**\n${changed.trim()}\n`;
      if (notes?.trim()) entry += `\n**Notes:** ${notes.trim()}\n`;
      entry += '\n---\n\n';

      appendFileSync(this.file, entry, 'utf-8');
      return { ok: true, timestamp: iso };
    } catch (err: any) {
      return { error: err?.message ?? 'unknown' };
    }
  }

  read(lastN?: number): Record<string, any> {
    try {
      if (!existsSync(this.file)) return { log: '' };
      const content = readFileSync(this.file, 'utf-8');
      const n = lastN ?? 10;
      const entries = content.split('\n---\n');
      const from = Math.max(0, entries.length - n);
      return { log: entries.slice(from).join('\n---\n') };
    } catch (err: any) {
      return { error: err?.message ?? 'unknown' };
    }
  }
}
