import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { randomUUID } from 'crypto';
import { MONOREPO_ROOT } from '../../root.js';

const SYSTEM_DIR = resolve(MONOREPO_ROOT, '.user-data', 'system');

export class ReminderStore {
  private readonly file: string;

  constructor() {
    this.file = resolve(SYSTEM_DIR, 'reminders.json');
  }

  set(isoTime: string, message: string): Record<string, any> {
    try {
      const time = Math.floor(new Date(isoTime).getTime() / 1000);
      if (isNaN(time)) return { error: `Invalid time: ${isoTime}` };

      const list = this.load();
      const entry: Record<string, any> = {
        id: randomUUID().slice(0, 8),
        time,
        message,
      };
      list.push(entry);
      this.save(list);
      return { ok: true, id: entry.id, time: isoTime, message };
    } catch (err: any) {
      return { error: err?.message ?? 'unknown' };
    }
  }

  list(): Record<string, any> {
    try {
      return { reminders: this.load() };
    } catch (err: any) {
      return { error: err?.message ?? 'unknown' };
    }
  }

  delete(id: string): Record<string, any> {
    try {
      const list = this.load();
      const filtered = list.filter((r) => r.id !== id);
      if (filtered.length === list.length) return { error: `No reminder with id: ${id}` };
      this.save(filtered);
      return { ok: true };
    } catch (err: any) {
      return { error: err?.message ?? 'unknown' };
    }
  }

  /** Returns and removes all reminders whose time <= now. */
  pollDue(): Record<string, any>[] {
    try {
      const list = this.load();
      const now = Math.floor(Date.now() / 1000);
      const due = list.filter((r) => (r.time as number) <= now);
      if (!due.length) return [];
      this.save(list.filter((r) => (r.time as number) > now));
      return due;
    } catch {
      return [];
    }
  }

  private load(): Record<string, any>[] {
    if (!existsSync(this.file)) return [];
    try {
      return JSON.parse(readFileSync(this.file, 'utf-8'));
    } catch {
      return [];
    }
  }

  private save(list: Record<string, any>[]): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(list, null, 2), 'utf-8');
  }
}
