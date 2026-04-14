import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync } from 'fs';
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
    registry.init(tmpDir); // creates the shared dir
    const r = await registry.dispatch('shared_bash', { command: 'echo world' }, 'cos');
    const out = r.output ?? r.stdout;
    expect(typeof out === 'string' && out.includes('world')).toBe(true);
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
});

// ── dispatch — datetime tools ─────────────────────────────────────────────────

describe('ToolsRegistry.dispatch datetime tools', () => {
  it('get_current_datetime returns datetime and iso8601', async () => {
    const r = await registry.dispatch('get_current_datetime', {}, 'cos');
    expect(r.datetime).toBeDefined();
    expect(r.iso8601).toBeDefined();
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

  it('time_diff computes difference', async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const r = await registry.dispatch('time_diff', { from: past }, 'cos');
    expect(r.human).toContain('ago');
    expect(typeof r.seconds).toBe('number');
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

// ── init ──────────────────────────────────────────────────────────────────────

describe('ToolsRegistry.init', () => {
  it('creates system and shared directories', () => {
    const { existsSync } = require('fs');
    registry.init(tmpDir);
    expect(existsSync(resolve(tmpDir, 'system'))).toBe(true);
    expect(existsSync(resolve(tmpDir, 'shared'))).toBe(true);
  });
});

// ── send_email allowlist ──────────────────────────────────────────────────────

function fakeGmailClient() {
  return {
    send: async () => ({ threadId: 'thread-1', messageId: 'msg-1' }),
    sendFile: async () => ({ threadId: 'thread-1', messageId: 'msg-1' }),
  } as any;
}

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

  afterEach(() => {
    cleanupDir(dir);
  });

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

// ── send_file_email allowlist ─────────────────────────────────────────────────

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

  afterEach(() => {
    cleanupDir(dir);
  });

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
});
