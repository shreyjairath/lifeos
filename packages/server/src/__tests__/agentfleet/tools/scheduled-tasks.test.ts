import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { ScheduledTasks } from '../../../agentfleet/tools/scheduled-tasks.js';
import { makeTempDir, cleanupDir } from '../../helpers.js';

let tmpDir: string;
let tasks: ScheduledTasks;

const pastIso = new Date(Date.now() - 3600_000).toISOString();
const futureIso = new Date(Date.now() + 3600_000).toISOString();

beforeEach(() => {
  tmpDir = makeTempDir('scheduled-tasks');
  tasks = new ScheduledTasks(join(tmpDir, 'tasks.json'));
});

afterEach(() => {
  cleanupDir(tmpDir);
});

describe('ScheduledTasks.upsert', () => {
  it('creates a new task and returns ok:true with id', () => {
    const r = tasks.upsert('cos', 'daily-review', 'Review things', 24, futureIso, null);
    expect(r.ok).toBe(true);
    expect(typeof r.id).toBe('string');
  });

  it('returns error for missing dueAtIso', () => {
    const r = tasks.upsert('cos', 'task', 'desc', null, '', null);
    expect(r.error).toBeDefined();
  });

  it('returns error for invalid dueAtIso', () => {
    const r = tasks.upsert('cos', 'task', 'desc', null, 'not-a-date', null);
    expect(r.error).toBeDefined();
  });

  it('deduplicates by name+assignee — second upsert updates existing', () => {
    tasks.upsert('cos', 'review', 'old desc', 24, futureIso, 'cos');
    tasks.upsert('cos', 'review', 'new desc', 24, futureIso, 'cos');
    const result = tasks.list('cos');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].description).toBe('new desc');
  });

  it('defaults assignee to createdBy when null', () => {
    tasks.upsert('cos', 'task', 'desc', null, futureIso, null);
    const result = tasks.list('cos');
    expect(result.tasks[0].assignee).toBe('cos');
  });
});

describe('ScheduledTasks.list', () => {
  it('returns all tasks when filter is null', () => {
    tasks.upsert('cos', 'task-1', 'a', null, futureIso, 'cos');
    tasks.upsert('cos', 'task-2', 'b', null, futureIso, 'other');
    const result = tasks.list(null);
    expect(result.tasks).toHaveLength(2);
  });

  it('filters by assignee', () => {
    tasks.upsert('cos', 'task-1', 'a', null, futureIso, 'cos');
    tasks.upsert('cos', 'task-2', 'b', null, futureIso, 'other');
    const result = tasks.list('cos');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].assignee).toBe('cos');
  });
});

describe('ScheduledTasks.getOverdue', () => {
  it('returns past-due tasks', () => {
    tasks.upsert('cos', 'overdue-task', 'was due', 24, pastIso, 'cos');
    const result = tasks.getOverdue(null);
    expect(result.tasks).toHaveLength(1);
  });

  it('does not return future tasks', () => {
    tasks.upsert('cos', 'future-task', 'not yet', null, futureIso, null);
    const result = tasks.getOverdue(null);
    expect(result.tasks).toHaveLength(0);
  });

  it('skips one-off tasks that have already been run', () => {
    tasks.upsert('cos', 'done-task', 'done', null, pastIso, 'cos');
    tasks.markComplete(tasks.list('cos').tasks[0].id, 'cos');
    const result = tasks.getOverdue('cos');
    expect(result.tasks).toHaveLength(0);
  });
});

describe('ScheduledTasks.getAllOverdue', () => {
  it('returns raw array of overdue tasks', () => {
    tasks.upsert('cos', 'task', 'desc', 24, pastIso, null);
    const result = tasks.getAllOverdue();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
  });

  it('returns empty array when none overdue', () => {
    tasks.upsert('cos', 'task', 'desc', null, futureIso, null);
    expect(tasks.getAllOverdue()).toHaveLength(0);
  });
});

describe('ScheduledTasks.markComplete', () => {
  it('advances run_at by cadenceHours for recurring tasks', () => {
    tasks.upsert('cos', 'recurring', 'desc', 24, pastIso, 'cos');
    const { tasks: [t] } = tasks.list('cos');
    const originalRunAt = t.run_at;
    tasks.markComplete(t.id, 'cos');
    const { tasks: [updated] } = tasks.list('cos');
    expect(updated.last_run).toBeDefined();
    expect(updated.run_at).toBe(originalRunAt + 24 * 3600);
  });

  it('advances run_at past now when task is multiple periods overdue', () => {
    // Task is 3 cadence periods behind — run_at must land in the future, not one step back
    const threePeriodsPastIso = new Date(Date.now() - 3 * 24 * 3600_000).toISOString();
    tasks.upsert('cos', 'stale', 'desc', 24, threePeriodsPastIso, 'cos');
    const { tasks: [t] } = tasks.list('cos');
    tasks.markComplete(t.id, 'cos');
    const { tasks: [updated] } = tasks.list('cos');
    expect(updated.run_at * 1000).toBeGreaterThan(Date.now());
    // Should not appear overdue again immediately
    expect(tasks.getOverdue('cos').tasks).toHaveLength(0);
  });

  it('sets last_run for one-off tasks', () => {
    tasks.upsert('cos', 'one-off', 'desc', null, futureIso, 'cos');
    const { tasks: [t] } = tasks.list('cos');
    tasks.markComplete(t.id, 'cos');
    const { tasks: [updated] } = tasks.list('cos');
    expect(updated.last_run).toBeGreaterThan(0);
  });

  it('returns error for unknown id', () => {
    const r = tasks.markComplete('nonexistent', 'cos');
    expect(r.error).toBeDefined();
  });

  it('returns error for platform tasks — agents cannot complete platform tasks', () => {
    tasks.upsert('platform', 'reconcile_workspace', 'desc', 12, pastIso, 'cos', true);
    const { tasks: [t] } = tasks.list('cos');
    const r = tasks.markComplete(t.id, 'cos');
    expect(r.error).toBeDefined();
    // last_run must not have been updated
    const { tasks: [unchanged] } = tasks.list('cos');
    expect(unchanged.last_run).toBeNull();
  });
});

describe('ScheduledTasks.markAllComplete', () => {
  it('marks multiple tasks complete', () => {
    tasks.upsert('cos', 't1', 'd', null, pastIso, 'cos');
    tasks.upsert('cos', 't2', 'd', null, pastIso, 'cos');
    const ids = tasks.list('cos').tasks.map((t: any) => t.id);
    tasks.markAllComplete(ids, 'cos');
    const overdue = tasks.getAllOverdue();
    expect(overdue).toHaveLength(0);
  });

  it('can mark platform tasks complete — the system path bypasses the agent guard', () => {
    tasks.upsert('platform', 'reconcile_workspace', 'desc', 12, pastIso, 'cos', true);
    const { tasks: [t] } = tasks.list('cos');
    tasks.markAllComplete([t.id], 'platform');
    const { tasks: [updated] } = tasks.list('cos');
    expect(updated.last_run).toBeGreaterThan(0);
    expect(updated.run_at * 1000).toBeGreaterThan(Date.now());
    expect(tasks.getAllOverdue()).toHaveLength(0);
  });

  it('advances run_at past now for platform tasks that are multiple periods behind', () => {
    const threePeriodsPast = new Date(Date.now() - 3 * 12 * 3600_000).toISOString();
    tasks.upsert('platform', 'reconcile_workspace', 'desc', 12, threePeriodsPast, 'cos', true);
    const { tasks: [t] } = tasks.list('cos');
    tasks.markAllComplete([t.id], 'platform');
    const { tasks: [updated] } = tasks.list('cos');
    expect(updated.run_at * 1000).toBeGreaterThan(Date.now());
    expect(tasks.getAllOverdue()).toHaveLength(0);
  });
});

describe('ScheduledTasks.delete', () => {
  it('removes the task', () => {
    tasks.upsert('cos', 'to-delete', 'desc', null, futureIso, null);
    const { tasks: [t] } = tasks.list(null);
    const r = tasks.delete(t.id);
    expect(r.ok).toBe(true);
    expect(tasks.list(null).tasks).toHaveLength(0);
  });

  it('returns error for unknown id', () => {
    const r = tasks.delete('nonexistent');
    expect(r.error).toBeDefined();
  });
});
