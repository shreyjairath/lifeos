import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { randomUUID } from 'crypto';

interface Task extends Record<string, any> {
  id: string;
  name: string;
  description: string;
  created_by: string;
  created_at: number;
  last_run: number | null;
  due_at: number;
  cadence_hours: number | null;
  assignee: string;
  last_modified_at: number;
  last_modified_by: string;
}

export class ScheduledTasks {
  constructor(private readonly file: string) {}

  upsert(
    createdBy: string,
    name: string,
    description: string,
    cadenceHours: number | null,
    dueAtIso: string,
    assignee: string | null,
  ): Record<string, any> {
    if (!dueAtIso) return { error: 'due_at is required.' };
    try {
      const dueAtEpoch = Math.floor(new Date(dueAtIso).getTime() / 1000);
      if (isNaN(dueAtEpoch)) return { error: `Invalid due_at: ${dueAtIso}` };

      const list = this.load();
      const existing = list.find((t) => t.created_by === createdBy && t.name === name);

      let task: Task;
      if (existing) {
        task = existing as Task;
      } else {
        task = {
          id: randomUUID().slice(0, 8),
          created_by: createdBy,
          created_at: epochNow(),
          last_run: null,
        } as any;
        list.push(task);
      }

      task.name = name;
      task.description = description;
      task.cadence_hours = cadenceHours ?? null;
      task.due_at = dueAtEpoch;
      task.assignee = assignee?.trim() || createdBy;
      task.last_modified_at = epochNow();
      task.last_modified_by = createdBy;

      this.save(list);
      return { ok: true, id: task.id, name, created_by: createdBy, next_due: nextDueIso(task) };
    } catch (err: any) {
      return { error: err?.message ?? 'unknown' };
    }
  }

  list(assigneeFilter: string | null): Record<string, any> {
    try {
      const tasks = this.load()
        .filter((t) => !assigneeFilter || t.assignee === assigneeFilter)
        .map(withNextDue);
      return { tasks };
    } catch (err: any) {
      return { error: err?.message ?? 'unknown' };
    }
  }

  getOverdue(assigneeFilter: string | null): Record<string, any> {
    try {
      const now = epochNow();
      const tasks = this.load()
        .filter((t) => !assigneeFilter || t.assignee === assigneeFilter)
        .filter((t) => isOverdue(t, now))
        .map(withNextDue);
      return { tasks };
    } catch (err: any) {
      return { error: err?.message ?? 'unknown' };
    }
  }

  /** System-only: returns all overdue tasks as a raw array. */
  getAllOverdue(): Record<string, any>[] {
    try {
      const now = epochNow();
      return this.load().filter((t) => isOverdue(t, now));
    } catch {
      return [];
    }
  }

  /** System-only: marks multiple tasks complete in a single write. */
  markAllComplete(ids: string[], calledBy: string): void {
    try {
      const list = this.load();
      const now = epochNow();
      for (const task of list) {
        if (ids.includes(task.id as string)) {
          task.last_run = now;
          task.last_modified_at = now;
          task.last_modified_by = calledBy;
        }
      }
      this.save(list);
    } catch (err: any) {
      console.warn('[ScheduledTasks] markAllComplete failed:', err?.message);
    }
  }

  markComplete(id: string, calledBy: string): Record<string, any> {
    try {
      const list = this.load();
      const task = list.find((t) => t.id === id);
      if (!task) return { error: `No task with id: ${id}` };
      const now = epochNow();
      task.last_run = now;
      task.last_modified_at = now;
      task.last_modified_by = calledBy;
      this.save(list);
      return { ok: true, id, next_due: nextDueIso(task) };
    } catch (err: any) {
      return { error: err?.message ?? 'unknown' };
    }
  }

  delete(id: string): Record<string, any> {
    try {
      const list = this.load();
      const before = list.length;
      const filtered = list.filter((t) => t.id !== id);
      if (filtered.length === before) return { error: `No task with id: ${id}` };
      this.save(filtered);
      return { ok: true, id };
    } catch (err: any) {
      return { error: err?.message ?? 'unknown' };
    }
  }

  // ── Private ──────────────────────────────────────────────────────────────────

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

function epochNow(): number {
  return Math.floor(Date.now() / 1000);
}

function isOverdue(task: Record<string, any>, now: number): boolean {
  const lastRun = task.last_run as number | null;
  const cadenceHours = task.cadence_hours as number | null;
  const dueAt = (task.due_at ?? task.run_at) as number | undefined;
  if (dueAt == null) return false;

  if (lastRun == null) return dueAt <= now;
  if (cadenceHours == null) return false; // one-off, already run
  return lastRun + cadenceHours * 3600 <= now;
}

function nextDueIso(task: Record<string, any>): string {
  const cadenceHours = task.cadence_hours as number | null;
  const dueAt = (task.due_at ?? task.run_at) as number | undefined;
  const lastRun = task.last_run as number | null;

  if (lastRun == null) {
    if (dueAt == null) return 'unknown';
    return new Date(dueAt * 1000).toISOString();
  }
  if (cadenceHours == null) return 'completed';
  return new Date((lastRun + cadenceHours * 3600) * 1000).toISOString();
}

function withNextDue(task: Record<string, any>): Record<string, any> {
  return { ...task, next_due: nextDueIso(task) };
}
