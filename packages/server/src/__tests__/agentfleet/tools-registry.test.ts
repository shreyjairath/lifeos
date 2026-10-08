import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { ToolsRegistry } from '../../agentfleet/tools-registry.js';
import { makeTempDir, cleanupDir } from '../helpers.js';
import { fakeClientConfig } from '../fakes.js';

let tmpDir: string;
let registry: ToolsRegistry;

beforeEach(() => {
  tmpDir = makeTempDir('tools-registry');
  registry = new ToolsRegistry(tmpDir, fakeClientConfig());
});

afterEach(() => {
  cleanupDir(tmpDir);
});

// ── getTools ──────────────────────────────────────────────────────────────────

describe('ToolsRegistry.getTools', () => {
  it('returns all tools when none disabled', () => {
    const tools = registry.getTools();
    expect(tools.length).toBeGreaterThan(0);
    expect(tools.every((t) => t.name && t.description)).toBe(true);
  });

  it('filters out disabled tools', () => {
    registry.saveDisabledTools(new Set(['web_search']));
    const tools = registry.getTools();
    expect(tools.every((t) => t.name !== 'web_search')).toBe(true);
  });
});

describe('ToolsRegistry.allToolNames', () => {
  it('returns a list of strings', () => {
    const names = registry.allToolNames();
    expect(names.length).toBeGreaterThan(0);
    expect(names.every((n) => typeof n === 'string')).toBe(true);
  });

  it('includes common tools', () => {
    const names = registry.allToolNames();
    expect(names).toContain('agent_bash');
    expect(names).toContain('shared_bash');
  });
});

// ── loadDisabledTools / saveDisabledTools ──────────────────────────────────────

describe('ToolsRegistry disabled tools', () => {
  it('loadDisabledTools returns empty set when no file', () => {
    expect(registry.loadDisabledTools().size).toBe(0);
  });

  it('saveDisabledTools and loadDisabledTools round-trip', () => {
    registry.saveDisabledTools(new Set(['web_search', 'browse_page']));
    const loaded = registry.loadDisabledTools();
    expect(loaded.has('web_search')).toBe(true);
    expect(loaded.has('browse_page')).toBe(true);
    expect(loaded.size).toBe(2);
  });
});

// ── registerAgentWorkspace ────────────────────────────────────────────────────

describe('ToolsRegistry.registerAgentWorkspace', () => {
  it('registers a workspace without throwing', () => {
    const workspace = resolve(tmpDir, 'cos', 'workspace');
    mkdirSync(workspace, { recursive: true });
    expect(() => registry.registerAgentWorkspace('cos', workspace, 'Chief of Staff')).not.toThrow();
  });
});

// ── init ──────────────────────────────────────────────────────────────────────

describe('ToolsRegistry.init', () => {
  it('creates system and shared directories', () => {
    registry.init(tmpDir);
    expect(existsSync(resolve(tmpDir, 'system'))).toBe(true);
    expect(existsSync(resolve(tmpDir, 'shared'))).toBe(true);
  });
});

// ── makeInvoker ───────────────────────────────────────────────────────────────

describe('ToolsRegistry.makeInvoker', () => {
  it('returns invoker with given definitions', () => {
    const tools = registry.getTools().slice(0, 3);
    const invoker = registry.makeInvoker(tools);
    expect(invoker.definitions()).toHaveLength(3);
    expect(invoker.definitions()[0].name).toBeDefined();
  });

  it('invoker.invoke delegates to dispatch', async () => {
    const tools = registry.getTools();
    const invoker = registry.makeInvoker(tools);
    const r = await invoker.invoke('get_current_datetime', {}, 'cos');
    expect(r.datetime).toBeDefined();
  });
});

// ── dispatch — unknown tool ───────────────────────────────────────────────────

describe('ToolsRegistry.dispatch unknown tool', () => {
  it('returns error for unrecognised tool name', async () => {
    const r = await registry.dispatch('no_such_tool', {}, 'cos');
    expect(r.error).toContain('Unknown tool');
  });
});

// ── dispatch — agent_bash ─────────────────────────────────────────────────────

describe('ToolsRegistry.dispatch agent_bash', () => {
  it('returns error when no workspace registered', async () => {
    const r = await registry.dispatch('agent_bash', { command: 'echo hi' }, 'cos');
    expect(r.error).toBeDefined();
  });

  it('runs command in registered workspace', async () => {
    const workspace = resolve(tmpDir, 'cos', 'workspace');
    mkdirSync(workspace, { recursive: true });
    registry.registerAgentWorkspace('cos', workspace);
    const r = await registry.dispatch('agent_bash', { command: 'echo hello' }, 'cos');
    expect(r.output ?? r.stdout).toContain('hello');
  });
});

// ── dispatch — shared_bash ────────────────────────────────────────────────────

describe('ToolsRegistry.dispatch shared_bash', () => {
  it('runs echo command', async () => {
    registry.init(tmpDir);
    const r = await registry.dispatch('shared_bash', { command: 'echo world' }, 'cos');
    const out = r.output ?? r.stdout;
    expect(typeof out === 'string' && out.includes('world')).toBe(true);
  });
});

// ── dispatch — file tools ─────────────────────────────────────────────────────

describe('ToolsRegistry.dispatch file tools', () => {
  let reg: ToolsRegistry;
  let dir: string;
  let workspace: string;

  beforeEach(() => {
    dir = makeTempDir('tools-registry-files');
    reg = new ToolsRegistry(dir, fakeClientConfig());
    workspace = resolve(dir, 'agents', 'cos', 'workspace');
    mkdirSync(workspace, { recursive: true });
    reg.registerAgentWorkspace('cos', workspace);
  });

  afterEach(() => cleanupDir(dir));

  // write_file
  it('write_file creates the file and returns written:true', async () => {
    const r = await reg.dispatch('write_file', { path: 'notes.md', content: 'hello world' }, 'cos');
    expect(r.written).toBe(true);
    expect(r.path).toBe('notes.md');
    expect(existsSync(resolve(workspace, 'notes.md'))).toBe(true);
  });

  it('write_file creates parent directories', async () => {
    const r = await reg.dispatch('write_file', { path: 'subdir/file.txt', content: 'data' }, 'cos');
    expect(r.written).toBe(true);
  });

  it('write_file blocks path traversal', async () => {
    const r = await reg.dispatch('write_file', { path: '../escape.txt', content: 'bad' }, 'cos');
    expect(r.error).toBeDefined();
  });

  it('write_file returns error when no workspace registered', async () => {
    const r = await reg.dispatch('write_file', { path: 'file.txt', content: 'x' }, 'unregistered');
    expect(r.error).toBeDefined();
  });

  // read_file
  it('read_file returns content and total_chars', async () => {
    writeFileSync(resolve(workspace, 'data.txt'), 'line1\nline2');
    const r = await reg.dispatch('read_file', { path: 'data.txt' }, 'cos');
    expect(r.content).toContain('line1');
    expect(typeof r.total_chars).toBe('number');
  });

  it('read_file returns error for missing file', async () => {
    const r = await reg.dispatch('read_file', { path: 'missing.txt' }, 'cos');
    expect(r.error).toBeDefined();
  });

  it('read_file blocks path traversal', async () => {
    const r = await reg.dispatch('read_file', { path: '../secret' }, 'cos');
    expect(r.error).toBeDefined();
  });

  it('read_file returns remaining_chars when file exceeds length', async () => {
    writeFileSync(resolve(workspace, 'big.txt'), 'a'.repeat(200));
    const r = await reg.dispatch('read_file', { path: 'big.txt', length: 100 }, 'cos');
    expect(r.remaining_chars).toBeGreaterThan(0);
  });

  // patch_file
  it('patch_file replaces exact string and returns patched:true', async () => {
    writeFileSync(resolve(workspace, 'doc.md'), 'hello world');
    const r = await reg.dispatch('patch_file', { path: 'doc.md', old_string: 'world', new_string: 'earth' }, 'cos');
    expect(r.patched).toBe(true);
    expect(r.snippet).toContain('earth');
  });

  it('patch_file returns error when old_string not found', async () => {
    writeFileSync(resolve(workspace, 'doc.md'), 'hello world');
    const r = await reg.dispatch('patch_file', { path: 'doc.md', old_string: 'missing', new_string: 'x' }, 'cos');
    expect(r.error).toBeDefined();
  });

  it('patch_file returns error when old_string matches multiple times', async () => {
    writeFileSync(resolve(workspace, 'doc.md'), 'abc abc abc');
    const r = await reg.dispatch('patch_file', { path: 'doc.md', old_string: 'abc', new_string: 'xyz' }, 'cos');
    expect(r.error).toBeDefined();
  });

  it('patch_file returns error for missing file', async () => {
    const r = await reg.dispatch('patch_file', { path: 'ghost.md', old_string: 'x', new_string: 'y' }, 'cos');
    expect(r.error).toBeDefined();
  });

  // append_file
  it('append_file creates file when it does not exist', async () => {
    const r = await reg.dispatch('append_file', { path: 'log.txt', content: 'entry 1' }, 'cos');
    expect(r.appended).toBe(true);
    expect(existsSync(resolve(workspace, 'log.txt'))).toBe(true);
  });

  it('append_file adds newline separator to existing content', async () => {
    writeFileSync(resolve(workspace, 'log.txt'), 'entry 1');
    await reg.dispatch('append_file', { path: 'log.txt', content: 'entry 2' }, 'cos');
    const { readFileSync } = await import('fs');
    const content = readFileSync(resolve(workspace, 'log.txt'), 'utf-8');
    expect(content).toContain('entry 1\nentry 2');
  });

  it('append_file returns total_chars', async () => {
    const r = await reg.dispatch('append_file', { path: 'log.txt', content: 'hello' }, 'cos');
    expect(typeof r.total_chars).toBe('number');
  });

  // read_agent_workspace
  it('read_agent_workspace returns error for unregistered agent', async () => {
    const r = await reg.dispatch('read_agent_workspace', { agent: 'ghost', command: 'ls' }, 'cos');
    expect(r.error).toBeDefined();
  });

  it('read_agent_workspace runs read-only command in target workspace', async () => {
    const otherWorkspace = resolve(dir, 'agents', 'other', 'workspace');
    mkdirSync(otherWorkspace, { recursive: true });
    writeFileSync(resolve(otherWorkspace, 'hello.txt'), 'other content');
    reg.registerAgentWorkspace('other', otherWorkspace);
    const r = await reg.dispatch('read_agent_workspace', { agent: 'other', command: 'cat hello.txt' }, 'cos');
    expect(r.output ?? r.stdout).toContain('other content');
  });
});

// ── dispatch — datetime tools ─────────────────────────────────────────────────

describe('ToolsRegistry.dispatch datetime tools', () => {
  it('get_current_datetime returns datetime and iso8601', async () => {
    const r = await registry.dispatch('get_current_datetime', {}, 'cos');
    expect(r.datetime).toBeDefined();
    expect(r.iso8601).toBeDefined();
  });

  it('format_timestamp converts epoch to human-readable', async () => {
    const epoch = 1704067200; // 2024-01-01T00:00:00Z
    const r = await registry.dispatch('format_timestamp', { timestamp: epoch }, 'cos');
    expect(r.datetime).toBeDefined();
    expect(r.iso8601).toContain('2024-01-01');
  });

  it('format_timestamp returns error for NaN input', async () => {
    const r = await registry.dispatch('format_timestamp', { timestamp: 'not-a-number' }, 'cos');
    expect(r.error).toBeDefined();
  });

  it('parse_datetime parses ISO string', async () => {
    const r = await registry.dispatch('parse_datetime', { datetime: '2024-01-15T00:00:00Z' }, 'cos');
    expect(r.epoch).toBeDefined();
    expect(r.iso8601).toContain('2024-01-15');
  });

  it('parse_datetime returns error for invalid', async () => {
    const r = await registry.dispatch('parse_datetime', { datetime: 'not-a-date' }, 'cos');
    expect(r.error).toBeDefined();
  });

  it('time_diff returns human-readable ago string', async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const r = await registry.dispatch('time_diff', { from: past }, 'cos');
    expect(r.human).toContain('ago');
    expect(typeof r.seconds).toBe('number');
  });

  it('time_diff returns "in X" for future timestamp', async () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const r = await registry.dispatch('time_diff', { from: future }, 'cos');
    expect(r.human).toContain('in ');
  });

  it('time_diff uses explicit "to" when provided', async () => {
    const r = await registry.dispatch('time_diff', { from: 1000, to: 4600 }, 'cos');
    expect(r.seconds).toBe(3600);
    expect(r.human).toContain('1h');
  });
});

// ── dispatch — task tools ─────────────────────────────────────────────────────

describe('ToolsRegistry.dispatch task tools', () => {
  const futureIso = new Date(Date.now() + 3_600_000).toISOString();
  const pastIso = new Date(Date.now() - 3_600_000).toISOString();

  it('create_task returns ok:true with an id', async () => {
    const r = await registry.dispatch('create_task', { name: 'test-task', description: 'do something', run_at: futureIso }, 'cos');
    expect(r.ok).toBe(true);
    expect(typeof r.id).toBe('string');
  });

  it('create_task returns error for missing run_at', async () => {
    const r = await registry.dispatch('create_task', { name: 'task', description: 'desc', run_at: '' }, 'cos');
    expect(r.error).toBeDefined();
  });

  it('get_my_tasks returns tasks array', async () => {
    await registry.dispatch('create_task', { name: 'my-task', description: 'desc', run_at: futureIso }, 'cos');
    const r = await registry.dispatch('get_my_tasks', {}, 'cos');
    expect(Array.isArray(r.tasks)).toBe(true);
    expect(r.tasks.length).toBeGreaterThan(0);
  });

  it('get_tasks returns tasks across all agents', async () => {
    await registry.dispatch('create_task', { name: 'cos-task', description: 'desc', run_at: futureIso }, 'cos');
    await registry.dispatch('create_task', { name: 'other-task', description: 'desc', run_at: futureIso }, 'other');
    const r = await registry.dispatch('get_tasks', {}, 'cos');
    expect(r.tasks.length).toBeGreaterThanOrEqual(2);
  });

  it('get_tasks filters by assignee', async () => {
    await registry.dispatch('create_task', { name: 'cos-task', description: 'desc', assignee: 'cos', run_at: futureIso }, 'cos');
    await registry.dispatch('create_task', { name: 'other-task', description: 'desc', assignee: 'other', run_at: futureIso }, 'cos');
    const r = await registry.dispatch('get_tasks', { assignee: 'cos' }, 'cos');
    expect(r.tasks.every((t: any) => t.assignee === 'cos')).toBe(true);
  });

  it('get_overdue_tasks returns past-due tasks', async () => {
    await registry.dispatch('create_task', { name: 'overdue', description: 'desc', run_at: pastIso }, 'cos');
    const r = await registry.dispatch('get_overdue_tasks', {}, 'cos');
    expect(r.tasks.length).toBeGreaterThan(0);
  });

  it('get_overdue_tasks does not include future tasks', async () => {
    await registry.dispatch('create_task', { name: 'future-task', description: 'desc', run_at: futureIso }, 'cos');
    const r = await registry.dispatch('get_overdue_tasks', {}, 'cos');
    expect(r.tasks.every((t: any) => t.name !== 'future-task')).toBe(true);
  });

  it('mark_task_complete marks the task', async () => {
    await registry.dispatch('create_task', { name: 'to-complete', description: 'desc', run_at: futureIso }, 'cos');
    const list = await registry.dispatch('get_my_tasks', {}, 'cos');
    const id = list.tasks[0].id;
    const r = await registry.dispatch('mark_task_complete', { id }, 'cos');
    expect(r.error).toBeUndefined();
  });

  it('mark_task_complete returns error for unknown id', async () => {
    const r = await registry.dispatch('mark_task_complete', { id: 'nonexistent' }, 'cos');
    expect(r.error).toBeDefined();
  });

  it('delete_task removes the task', async () => {
    await registry.dispatch('create_task', { name: 'to-delete', description: 'desc', run_at: futureIso }, 'cos');
    const list = await registry.dispatch('get_my_tasks', {}, 'cos');
    const id = list.tasks[0].id;
    const r = await registry.dispatch('delete_task', { id }, 'cos');
    expect(r.ok).toBe(true);
    const after = await registry.dispatch('get_my_tasks', {}, 'cos');
    expect(after.tasks.find((t: any) => t.id === id)).toBeUndefined();
  });

  it('delete_task returns error for unknown id', async () => {
    const r = await registry.dispatch('delete_task', { id: 'nonexistent' }, 'cos');
    expect(r.error).toBeDefined();
  });
});

// ── dispatch — log tools ──────────────────────────────────────────────────────

describe('ToolsRegistry.dispatch log_entry / read_log', () => {
  it('log_entry writes to agent log and returns status:written', async () => {
    const r = await registry.dispatch('log_entry', { mode: 'chat', summary: 'Had a conversation about goals' }, 'cos');
    expect(r.status).toBe('written');
  });

  it('read_log returns messages array', async () => {
    await registry.dispatch('log_entry', { mode: 'chat', summary: 'Test summary' }, 'cos');
    const r = await registry.dispatch('read_log', { consume: false }, 'cos');
    expect(Array.isArray(r.messages)).toBe(true);
    expect(r.messages.length).toBeGreaterThan(0);
  });

  it('read_log with consume:false does not advance cursor on second read', async () => {
    await registry.dispatch('log_entry', { mode: 'chat', summary: 'Entry one' }, 'cos');
    const first = await registry.dispatch('read_log', { consume: false }, 'cos');
    const second = await registry.dispatch('read_log', { consume: false }, 'cos');
    expect(second.messages.length).toBe(first.messages.length);
  });

  it('read_log with consume:true advances the cursor', async () => {
    await registry.dispatch('log_entry', { mode: 'chat', summary: 'Entry one' }, 'cos');
    await registry.dispatch('log_entry', { mode: 'chat', summary: 'Entry two' }, 'cos');
    // Consume both entries — cursor is now set past them
    const first = await registry.dispatch('read_log', { consume: true }, 'cos');
    expect(first.messages.length).toBe(2);
    // Second consume with no new entries returns zero
    const second = await registry.dispatch('read_log', { consume: true }, 'cos');
    expect(second.messages.length).toBe(0);
  });

  it('log_entry includes session_id and email_thread_ids when provided', async () => {
    const r = await registry.dispatch('log_entry', {
      mode: 'chat',
      summary: 'Complex run',
      session_id: 'sess-123',
      email_thread_ids: ['thread-1', 'thread-2'],
      changed: '_memory.md',
    }, 'cos');
    expect(r.status).toBe('written');
  });
});

// ── dispatch — plan tools ─────────────────────────────────────────────────────

describe('ToolsRegistry.dispatch plan tools', () => {
  let reg: ToolsRegistry;
  let dir: string;
  let workspace: string;

  beforeEach(() => {
    dir = makeTempDir('tools-registry-plans');
    reg = new ToolsRegistry(dir, fakeClientConfig());
    workspace = resolve(dir, 'agents', 'cos', 'workspace');
    mkdirSync(workspace, { recursive: true });
    reg.registerAgentWorkspace('cos', workspace);
  });

  afterEach(() => cleanupDir(dir));

  it('save_plan creates a plan and returns plan_id', async () => {
    const r = await reg.dispatch('save_plan', {
      title: 'Research neighborhoods',
      steps: ['Search online', 'Compare schools', 'Visit in person'],
    }, 'cos');
    expect(typeof r.plan_id).toBe('string');
    expect(r.step_count).toBe(3);
  });

  it('get_plan with plan_id returns plan content', async () => {
    const saved = await reg.dispatch('save_plan', { title: 'My plan', steps: ['Step 1', 'Step 2'] }, 'cos');
    const r = await reg.dispatch('get_plan', { plan_id: saved.plan_id }, 'cos');
    expect(r.content).toContain('My plan');
    expect(r.content).toContain('Step 1');
  });

  it('get_plan without plan_id lists all plans', async () => {
    await reg.dispatch('save_plan', { title: 'Plan A', steps: ['x'] }, 'cos');
    await reg.dispatch('save_plan', { title: 'Plan B', steps: ['y'] }, 'cos');
    const r = await reg.dispatch('get_plan', {}, 'cos');
    expect(Array.isArray(r.plans)).toBe(true);
    expect(r.plans.length).toBeGreaterThanOrEqual(2);
  });

  it('get_plan returns error for unknown plan_id', async () => {
    // Save a plan first so _plans/ dir exists, then request a nonexistent id
    await reg.dispatch('save_plan', { title: 'Seed', steps: ['x'] }, 'cos');
    const r = await reg.dispatch('get_plan', { plan_id: 'nonexistent' }, 'cos');
    expect(r.error).toBeDefined();
  });

  it('update_plan marks a step as done', async () => {
    const saved = await reg.dispatch('save_plan', { title: 'Plan', steps: ['Step 1', 'Step 2'] }, 'cos');
    const r = await reg.dispatch('update_plan', { plan_id: saved.plan_id, step_index: 0, status: 'done' }, 'cos');
    expect(r.step_index).toBe(0);
    expect(r.status).toBe('done');
    const plan = await reg.dispatch('get_plan', { plan_id: saved.plan_id }, 'cos');
    expect(plan.content).toContain('[x]');
  });

  it('update_plan marks a step as skipped', async () => {
    const saved = await reg.dispatch('save_plan', { title: 'Plan', steps: ['Step 1'] }, 'cos');
    const r = await reg.dispatch('update_plan', { plan_id: saved.plan_id, step_index: 0, status: 'skip' }, 'cos');
    expect(r.status).toBe('skip');
  });

  it('update_plan returns error for out-of-range step_index', async () => {
    const saved = await reg.dispatch('save_plan', { title: 'Plan', steps: ['Step 1'] }, 'cos');
    const r = await reg.dispatch('update_plan', { plan_id: saved.plan_id, step_index: 99, status: 'done' }, 'cos');
    expect(r.error).toBeDefined();
  });

  it('update_plan returns error for invalid status value', async () => {
    const saved = await reg.dispatch('save_plan', { title: 'Plan', steps: ['Step 1'] }, 'cos');
    const r = await reg.dispatch('update_plan', { plan_id: saved.plan_id, step_index: 0, status: 'completed' }, 'cos');
    expect(r.error).toContain('must be "done" or "skip"');
  });
});

// ── dispatch — journal ────────────────────────────────────────────────────────

describe('ToolsRegistry.dispatch read_journal', () => {
  it('returns empty entries when no journal directory', async () => {
    const r = await registry.dispatch('read_journal', {}, 'cos');
    expect(Array.isArray(r.entries)).toBe(true);
    expect(r.entries.length).toBe(0);
  });

  it('returns journal entries when files exist', async () => {
    const journalDir = resolve(tmpDir, 'journal');
    mkdirSync(journalDir, { recursive: true });
    writeFileSync(resolve(journalDir, '2024-01-15-120000.md'), '# Feeling good today');
    writeFileSync(resolve(journalDir, '2024-01-16-090000.md'), '# Another day');
    const r = await registry.dispatch('read_journal', {}, 'cos');
    expect(r.entries.length).toBe(2);
    expect(r.entries[0].content).toBeDefined();
    expect(r.entries[0].date).toBeDefined();
  });

  it('respects the limit parameter', async () => {
    const journalDir = resolve(tmpDir, 'journal');
    mkdirSync(journalDir, { recursive: true });
    for (let i = 1; i <= 5; i++) {
      writeFileSync(resolve(journalDir, `2024-01-${String(i).padStart(2, '0')}-120000.md`), `Entry ${i}`);
    }
    const r = await registry.dispatch('read_journal', { limit: 2 }, 'cos');
    expect(r.entries.length).toBe(2);
  });
});

// ── dispatch — topics / messaging ─────────────────────────────────────────────

describe('ToolsRegistry.dispatch topics and messaging', () => {
  it('system_feedback returns status:written', async () => {
    const r = await registry.dispatch('system_feedback', {
      category: 'tool',
      subject: 'agent_bash timeout',
      detail: 'Commands taking over 30s have no graceful timeout',
    }, 'cos');
    expect(r.status).toBe('written');
  });

  it('read_messages returns messages array', async () => {
    const r = await registry.dispatch('read_messages', { consume: false }, 'cos');
    expect(Array.isArray(r.messages)).toBe(true);
  });

  it('read_topic returns messages from named topic', async () => {
    await registry.dispatch('log_entry', { mode: 'chat', summary: 'Test' }, 'cos');
    const r = await registry.dispatch('read_topic', { topic: 'cos_log', consume: false }, 'cos');
    expect(Array.isArray(r.messages)).toBe(true);
    expect(r.topic).toBe('cos_log');
  });

  it('read_topic returns error for empty topic name', async () => {
    const r = await registry.dispatch('read_topic', { topic: '' }, 'cos');
    expect(r.error).toBeDefined();
  });
});

// ── dispatch — email thread summary (local, no Gmail) ─────────────────────────

describe('ToolsRegistry.dispatch email thread summary', () => {
  it('write_email_thread_summary stores a summary', async () => {
    const r = await registry.dispatch('write_email_thread_summary', {
      thread_id: 'thread-abc',
      summary: 'Discussion about project timeline.',
    }, 'cos');
    expect(r.status).toBe('written');
    expect(r.thread_id).toBe('thread-abc');
  });

  it('read_email_thread_summary returns stored summary', async () => {
    await registry.dispatch('write_email_thread_summary', {
      thread_id: 'thread-abc',
      summary: 'Discussion about project timeline.',
    }, 'cos');
    const r = await registry.dispatch('read_email_thread_summary', { thread_id: 'thread-abc' }, 'cos');
    expect(r.summary).toContain('timeline');
    expect(r.thread_id).toBe('thread-abc');
  });

  it('read_email_thread_summary returns error for unknown thread', async () => {
    const r = await registry.dispatch('read_email_thread_summary', { thread_id: 'unknown-thread' }, 'cos');
    expect(r.error).toBeDefined();
  });
});

// ── dispatch — meta tools ─────────────────────────────────────────────────────

describe('ToolsRegistry.dispatch meta tools', () => {
  it('list_tools returns tools with name and description', async () => {
    const r = await registry.dispatch('list_tools', {}, 'cos');
    expect(Array.isArray(r.tools)).toBe(true);
    expect(r.tools.length).toBeGreaterThan(0);
    expect(r.tools[0].name).toBeDefined();
    expect(r.tools[0].description).toBeDefined();
  });

  it('list_tools excludes disabled tools', async () => {
    registry.saveDisabledTools(new Set(['agent_bash']));
    const r = await registry.dispatch('list_tools', {}, 'cos');
    expect(r.tools.every((t: any) => t.name !== 'agent_bash')).toBe(true);
  });

  it('show_image returns url and caption', async () => {
    const r = await registry.dispatch('show_image', { url: 'https://example.com/img.png', caption: 'A photo' }, 'cos');
    expect(r.url).toBe('https://example.com/img.png');
    expect(r.caption).toBe('A photo');
  });

  it('show_image returns empty string caption when omitted', async () => {
    const r = await registry.dispatch('show_image', { url: 'https://example.com/img.png' }, 'cos');
    expect(r.caption).toBe('');
  });
});

// ── dispatch — render_artifact ────────────────────────────────────────────────

describe('ToolsRegistry.dispatch render_artifact', () => {
  let reg: ToolsRegistry;
  let dir: string;
  let workspace: string;
  let publishedEvents: Record<string, any>[];

  beforeEach(() => {
    dir = makeTempDir('tools-registry-artifact');
    reg = new ToolsRegistry(dir, fakeClientConfig());
    workspace = resolve(dir, 'agents', 'cos', 'workspace');
    mkdirSync(workspace, { recursive: true });
    reg.registerAgentWorkspace('cos', workspace);
    publishedEvents = [];
    reg.eventBusPublish = (e) => { publishedEvents.push(e); };
  });

  afterEach(() => cleanupDir(dir));

  it('returns error when path is empty', async () => {
    const r = await reg.dispatch('render_artifact', { path: '' }, 'cos');
    expect(r.error).toBeDefined();
  });

  it('returns url directly for https:// paths', async () => {
    const r = await reg.dispatch('render_artifact', { path: 'https://example.com/report.html', title: 'Report' }, 'cos');
    expect(r.url).toBe('https://example.com/report.html');
    expect(publishedEvents.length).toBe(0);
  });

  it('returns error when file not found in _artifacts/', async () => {
    const r = await reg.dispatch('render_artifact', { path: 'missing.html' }, 'cos');
    expect(r.error).toBeDefined();
  });

  it('publishes event and returns url for existing artifact', async () => {
    const artifactsDir = resolve(workspace, '_artifacts');
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(resolve(artifactsDir, 'report.html'), '<h1>Report</h1>');
    const r = await reg.dispatch('render_artifact', { path: 'report.html', title: 'My Report' }, 'cos');
    expect(r.url).toContain('/api/artifacts/cos/report.html');
    expect(r.title).toBe('My Report');
    expect(publishedEvents.length).toBe(1);
    expect(publishedEvents[0].type).toBe('artifact_updated');
  });
});

// ── dispatch — session tools ──────────────────────────────────────────────────

describe('ToolsRegistry.dispatch session tools', () => {
  it('list_sessions returns sessions field', async () => {
    const r = await registry.dispatch('list_sessions', {}, 'cos');
    expect(r.sessions).toBeDefined();
  });

  it('read_session_summary returns error for missing session_id', async () => {
    const r = await registry.dispatch('read_session_summary', {}, 'cos');
    expect(r.error).toBeDefined();
  });

  it('read_session_transcript returns error for unknown session_id', async () => {
    const r = await registry.dispatch('read_session_transcript', { session_id: 'nonexistent' }, 'cos');
    expect(r.error).toBeDefined();
  });
});

// ── dispatch — injected tools (stubbed) ───────────────────────────────────────

describe('ToolsRegistry.dispatch injected tools', () => {
  let reg: ToolsRegistry;
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir('tools-registry-injected');
    reg = new ToolsRegistry(dir, fakeClientConfig());
    reg.webSearch = {
      search: async (query: string, max: number, verify: boolean) => ({ query, results: [{ title: 'T', url: 'https://example.com', snippet: 'S' }] }),
    } as any;
    reg.browse = {
      fetch: async (_url: string, _verify: boolean, _raw: boolean) => ({ content: 'page body', _js_fallback: false }),
    } as any;
    reg.agentTools = {
      listAgents: async (_caller: string) => ({ agents: [{ name: 'cos', title: 'Chief of Staff' }] }),
      messageAgent: async (_from: string, _to: string, msg: string) => ({ reply: 'ok' }),
      readAgentDefinition: async (_name: string) => ({ name: 'cos', identity: 'I am COS' }),
      postMessage: async () => ({ status: 'posted' }),
    } as any;
    reg.eventBusPublish = () => {};
  });

  afterEach(() => cleanupDir(dir));

  it('web_search delegates to webSearch.search', async () => {
    const r = await reg.dispatch('web_search', { query: 'best coffee' }, 'cos');
    expect(r.query).toBe('best coffee');
    expect(Array.isArray(r.results)).toBe(true);
  });

  it('brave_search delegates to webSearch.search with max_results', async () => {
    const r = await reg.dispatch('brave_search', { query: 'best coffee', max_results: 3 }, 'cos');
    expect(r.query).toBe('best coffee');
    expect(Array.isArray(r.results)).toBe(true);
  });

  it('browse_page delegates to browse.fetch', async () => {
    const r = await reg.dispatch('browse_page', { url: 'https://example.com' }, 'cos');
    expect(r.content).toBe('page body');
  });

  it('list_agents delegates to agentTools.listAgents', async () => {
    const r = await reg.dispatch('list_agents', {}, 'cos');
    expect(Array.isArray(r.agents)).toBe(true);
    expect(r.agents[0].name).toBe('cos');
  });

  it('message_agent delegates to agentTools.messageAgent', async () => {
    const r = await reg.dispatch('message_agent', { agent: 'other', message: 'hello' }, 'cos');
    expect(r.reply).toBe('ok');
  });

  it('read_agent_definition delegates to agentTools.readAgentDefinition', async () => {
    const r = await reg.dispatch('read_agent_definition', { agent: 'cos' }, 'cos');
    expect(r.name).toBe('cos');
  });

  it('post_message delegates to agentTools.postMessage', async () => {
    const r = await reg.dispatch('post_message', { message: 'broadcast update', to: ['other'] }, 'cos');
    expect(r.status).toBe('posted');
  });
});

// ── dispatch — Gmail tools (faked) ────────────────────────────────────────────

function fakeGmailClient() {
  return {
    send: async () => ({ threadId: 'thread-1', messageId: 'msg-1' }),
    sendFile: async () => ({ threadId: 'thread-1', messageId: 'msg-1' }),
    fetchThreadsMeta: async () => [
      { threadId: 'thread-1', subject: 'Hello', from: 'sender@example.com', date: '2024-01-01', messageCount: 2 },
    ],
    fetchThreadFull: async (_threadId: string) => ({
      thread_id: _threadId,
      subject: 'Hello',
      messages: [{ message_id: 'msg-1', from: 'sender@example.com', to: 'me@example.com', date: '2024-01-01', body: 'Hi there' }],
    }),
    fetchMessage: async (_messageId: string) => ({
      message_id: _messageId,
      from: 'sender@example.com',
      to: 'me@example.com',
      date: '2024-01-01',
      body: 'Full message body',
    }),
    fetchAttachment: async () => '/tmp/file.pdf',
  } as any;
}

describe('ToolsRegistry.dispatch Gmail tools', () => {
  let reg: ToolsRegistry;
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir('tools-registry-gmail');
    reg = new ToolsRegistry(dir, fakeClientConfig({
      email: 'client@example.com',
      contacts: [{ email: 'contact@example.com', agents: ['cos'], fallback: 'cos' }],
    }));
    reg.setGmailClient(fakeGmailClient());
    const workspace = resolve(dir, 'agents', 'cos', 'workspace');
    mkdirSync(workspace, { recursive: true });
    reg.registerAgentWorkspace('cos', workspace, 'Chief of Staff');
  });

  afterEach(() => cleanupDir(dir));

  it('read_emails returns threads list', async () => {
    const r = await reg.dispatch('read_emails', {}, 'cos');
    expect(Array.isArray(r.threads)).toBe(true);
    expect(r.threads[0].thread_id).toBe('thread-1');
    expect(r.threads[0].subject).toBe('Hello');
  });

  it('read_emails returns error when Gmail not configured', async () => {
    const bare = new ToolsRegistry(dir, fakeClientConfig());
    const r = await bare.dispatch('read_emails', {}, 'cos');
    expect(r.error).toBeDefined();
  });

  it('read_email_thread returns thread with messages', async () => {
    const r = await reg.dispatch('read_email_thread', { thread_id: 'thread-1' }, 'cos');
    expect(r.thread).toBeDefined();
    expect(Array.isArray(r.thread.messages)).toBe(true);
    expect(r.thread.messages[0].body).toBe('Hi there');
  });

  it('read_email_message returns full message body', async () => {
    const r = await reg.dispatch('read_email_message', { message_id: 'msg-1' }, 'cos');
    expect(r.message.body).toBe('Full message body');
  });

  it('fetch_email_attachment returns saved_to path', async () => {
    const r = await reg.dispatch('fetch_email_attachment', {
      message_id: 'msg-1',
      attachment_id: 'att-1',
      filename: 'report.pdf',
    }, 'cos');
    expect(r.saved_to).toBeDefined();
  });
});

// ── dispatch — send_email allowlist ──────────────────────────────────────────

describe('ToolsRegistry send_email allowlist', () => {
  let reg: ToolsRegistry;
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir('tools-registry-email');
    reg = new ToolsRegistry(dir, fakeClientConfig({
      email: 'client@example.com',
      contacts: [{ email: 'contact@example.com', agents: ['cos'], fallback: 'cos' }],
    }));
    reg.setGmailClient(fakeGmailClient());
    const workspace = resolve(dir, 'agents', 'cos', 'workspace');
    mkdirSync(workspace, { recursive: true });
    reg.registerAgentWorkspace('cos', workspace, 'Chief of Staff');
  });

  afterEach(() => cleanupDir(dir));

  it('blocks send_email to an unknown address', async () => {
    const r = await reg.dispatch('send_email', { to: 'stranger@other.com', subject: 'Hi', body: 'Hello' }, 'cos');
    expect(r.error).toContain('Not allowed');
  });

  it('allows send_email to the client address', async () => {
    const r = await reg.dispatch('send_email', { to: 'client@example.com', subject: 'Hi', body: 'Hello' }, 'cos');
    expect(r.error).toBeUndefined();
    expect(r.sent).toBe(true);
  });

  it('allows send_email to a registered contact', async () => {
    const r = await reg.dispatch('send_email', { to: 'contact@example.com', subject: 'Hi', body: 'Hello' }, 'cos');
    expect(r.error).toBeUndefined();
    expect(r.sent).toBe(true);
  });

  it('allows send_email when to is omitted (defaults to client)', async () => {
    const r = await reg.dispatch('send_email', { subject: 'Hi', body: 'Hello' }, 'cos');
    expect(r.error).toBeUndefined();
    expect(r.sent).toBe(true);
  });

  it('handles RFC-formatted address for client', async () => {
    const r = await reg.dispatch('send_email', { to: 'Client Name <client@example.com>', subject: 'Hi', body: 'Hello' }, 'cos');
    expect(r.error).toBeUndefined();
    expect(r.sent).toBe(true);
  });

  it('handles RFC-formatted address for contact', async () => {
    const r = await reg.dispatch('send_email', { to: 'Contact Name <contact@example.com>', subject: 'Hi', body: 'Hello' }, 'cos');
    expect(r.error).toBeUndefined();
    expect(r.sent).toBe(true);
  });

  it('blocks RFC-formatted address with unknown email', async () => {
    const r = await reg.dispatch('send_email', { to: 'Stranger <stranger@other.com>', subject: 'Hi', body: 'Hello' }, 'cos');
    expect(r.error).toContain('Not allowed');
  });

  it('returns error when both body and html_body are provided', async () => {
    const r = await reg.dispatch('send_email', { to: 'client@example.com', subject: 'Hi', body: 'plain', html_body: '<p>html</p>' }, 'cos');
    expect(r.error).toContain('not both');
  });

  it('fromName is always the agent title', async () => {
    let capturedFromName: string | undefined;
    const gmail = {
      send: async (_to: string, _subj: string, _body: any, _tid: any, _html: any, _irt: any, fromName: string) => {
        capturedFromName = fromName;
        return { threadId: 't', messageId: 'm' };
      },
    } as any;
    reg.setGmailClient(gmail);
    await reg.dispatch('send_email', { to: 'client@example.com', subject: 'Hi', body: 'Hello' }, 'cos');
    expect(capturedFromName).toBe('Chief of Staff');
  });
});

// ── dispatch — send_file_email allowlist ─────────────────────────────────────

describe('ToolsRegistry send_file_email allowlist', () => {
  let reg: ToolsRegistry;
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir('tools-registry-file-email');
    reg = new ToolsRegistry(dir, fakeClientConfig({
      email: 'client@example.com',
      contacts: [{ email: 'contact@example.com', agents: ['cos'], fallback: 'cos' }],
    }));
    reg.setGmailClient(fakeGmailClient());
    const workspace = resolve(dir, 'agents', 'cos', 'workspace');
    mkdirSync(workspace, { recursive: true });
    reg.registerAgentWorkspace('cos', workspace, 'Chief of Staff');
  });

  afterEach(() => cleanupDir(dir));

  it('blocks send_file_email to an unknown address', async () => {
    const r = await reg.dispatch('send_file_email', { to: 'stranger@other.com', subject: 'Report', file_path: '_artifacts/report.html' }, 'cos');
    expect(r.error).toContain('Not allowed');
  });

  it('allows send_file_email to client (error is file-not-found, not allowlist)', async () => {
    const r = await reg.dispatch('send_file_email', { to: 'client@example.com', subject: 'Report', file_path: '_artifacts/report.html' }, 'cos');
    expect(r.error).not.toContain('Not allowed');
  });

  it('handles RFC-formatted unknown address', async () => {
    const r = await reg.dispatch('send_file_email', { to: 'Stranger <stranger@other.com>', subject: 'Report', file_path: 'report.html' }, 'cos');
    expect(r.error).toContain('Not allowed');
  });

  it('sends the file when it exists and recipient is allowed', async () => {
    const workspace = resolve(dir, 'agents', 'cos', 'workspace');
    writeFileSync(resolve(workspace, 'report.html'), '<h1>Report</h1>');
    const r = await reg.dispatch('send_file_email', { to: 'client@example.com', subject: 'Report', file_path: 'report.html' }, 'cos');
    expect(r.sent).toBe(true);
    expect(r.thread_id).toBeDefined();
  });
});
