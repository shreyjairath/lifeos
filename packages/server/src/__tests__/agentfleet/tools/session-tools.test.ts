import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionToolsImpl } from '../../../agentfleet/tools/session-tools.js';
import { SessionStore } from '../../../agent/session/session-store.js';
import { makeTempDir, cleanupDir } from '../../helpers.js';

let tmpDir: string;
let sessionTools: SessionToolsImpl;
let store: SessionStore;

beforeEach(() => {
  tmpDir = makeTempDir('session-tools');
  store = new SessionStore(tmpDir, 'cos');
  sessionTools = new SessionToolsImpl(() => store);
});

afterEach(() => {
  cleanupDir(tmpDir);
});

describe('SessionToolsImpl.dispatch — list_sessions', () => {
  it('returns empty sessions when none exist', () => {
    const r = sessionTools.dispatch('list_sessions', {}, 'cos');
    expect(r).not.toBeNull();
    expect(r!.sessions).toEqual([]);
  });

  it('lists sessions sorted newest-first', () => {
    store.saveMeta('sess-a', { id: 'sess-a', title: 'Alpha', created_at: 1000 });
    store.saveMeta('sess-b', { id: 'sess-b', title: 'Beta', created_at: 2000 });
    const r = sessionTools.dispatch('list_sessions', {}, 'cos');
    expect(r!.sessions).toHaveLength(2);
    expect(r!.sessions[0].title).toBe('Beta'); // higher created_at first
  });

  it('skips sessions with empty meta', () => {
    store.saveMeta('sess-empty', {});
    const r = sessionTools.dispatch('list_sessions', {}, 'cos');
    expect(r!.sessions).toHaveLength(0);
  });
});

describe('SessionToolsImpl.dispatch — read_session_summary', () => {
  it('returns summary when it exists', () => {
    store.saveMeta('sess-1', { id: 'sess-1' });
    store.writeSummary('sess-1', 'Great session about finance.');
    const r = sessionTools.dispatch('read_session_summary', { session_id: 'sess-1' }, 'cos');
    expect(r!.summary).toBe('Great session about finance.');
    expect(r!.session_id).toBe('sess-1');
  });

  it('returns error for missing session', () => {
    const r = sessionTools.dispatch('read_session_summary', { session_id: 'nonexistent' }, 'cos');
    expect(r!.error).toBeDefined();
  });

  it('returns error for missing session_id param', () => {
    const r = sessionTools.dispatch('read_session_summary', {}, 'cos');
    expect(r!.error).toBeDefined();
  });
});

describe('SessionToolsImpl.dispatch — write_session_summary', () => {
  it('writes summary and returns ok', () => {
    store.saveMeta('sess-1', { id: 'sess-1' });
    const r = sessionTools.dispatch('write_session_summary', { session_id: 'sess-1', summary: 'My summary' }, 'cos');
    expect(r!.status).toBe('written');
    expect(store.readSummary('sess-1')).toBe('My summary');
  });

  it('returns error for missing session_id', () => {
    const r = sessionTools.dispatch('write_session_summary', { summary: 'text' }, 'cos');
    expect(r!.error).toBeDefined();
  });

  it('returns error for empty summary', () => {
    const r = sessionTools.dispatch('write_session_summary', { session_id: 'sess-1', summary: '' }, 'cos');
    expect(r!.error).toBeDefined();
  });
});

describe('SessionToolsImpl.dispatch — read_session_transcript', () => {
  it('returns transcript for a session with messages', () => {
    store.saveMeta('sess-1', { id: 'sess-1' });
    store.saveMessages('sess-1', [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]);
    const r = sessionTools.dispatch('read_session_transcript', { session_id: 'sess-1' }, 'cos');
    expect(r!.transcript).toContain('USER: hello');
    expect(r!.transcript).toContain('ASSISTANT: hi there');
  });

  it('returns error for session with no messages', () => {
    const r = sessionTools.dispatch('read_session_transcript', { session_id: 'empty-sess' }, 'cos');
    expect(r!.error).toBeDefined();
  });

  it('returns error for missing session_id', () => {
    const r = sessionTools.dispatch('read_session_transcript', {}, 'cos');
    expect(r!.error).toBeDefined();
  });
});

describe('SessionToolsImpl.dispatch — unknown tool', () => {
  it('returns null for unknown tool', () => {
    expect(sessionTools.dispatch('unknown_tool', {}, 'cos')).toBeNull();
  });
});
