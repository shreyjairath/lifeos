import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SessionHandler, buildTranscript } from '../../../agent/session/session-handler.js';
import { SessionStore } from '../../../agent/session/session-store.js';
import { makeTempDir, cleanupDir } from '../../helpers.js';
import { fakeAppConfig } from '../../fakes.js';

let tmpDir: string;
let store: SessionStore;
let handler: SessionHandler;

beforeEach(() => {
  tmpDir = makeTempDir('session-handler');
  store = new SessionStore(tmpDir, 'cos');
  handler = new SessionHandler(fakeAppConfig(), store, 'cos');
});

afterEach(() => {
  cleanupDir(tmpDir);
});

// ── createNew ─────────────────────────────────────────────────────────────────

describe('SessionHandler.createNew', () => {
  it('returns a session ID', () => {
    const id = handler.createNew('cos');
    expect(typeof id).toBe('string');
    expect(id).toContain('session-cos');
  });

  it('prunes empty sessions before creating', () => {
    const id1 = handler.createNew('cos');
    // id1 is empty — createNew should prune it
    const id2 = handler.createNew('cos');
    expect(id1).not.toBe(id2);
    expect(handler.listSessions()).toHaveLength(1);
  });
});

// ── rotate ────────────────────────────────────────────────────────────────────

describe('SessionHandler.rotate', () => {
  it('marks old session closed and returns new session ID', async () => {
    const old = handler.createNew('cos');
    handler.appendMessage(old, { role: 'user', content: 'hello' });
    await Bun.sleep(2);
    const newId = handler.rotate(old);

    expect(typeof newId).toBe('string');
    expect(newId).not.toBe(old);

    const oldMeta = store.loadMeta(old);
    expect(oldMeta.closed).toBe(true);
  });

  it('new session has parent_session_id set', async () => {
    const old = handler.createNew('cos');
    handler.appendMessage(old, { role: 'user', content: 'hi' });
    await Bun.sleep(2);
    const newId = handler.rotate(old);
    const newMeta = store.loadMeta(newId);
    expect(newMeta.parent_session_id).toBe(old);
  });
});

// ── checkRotation ─────────────────────────────────────────────────────────────

describe('SessionHandler.checkRotation', () => {
  it('returns shouldRotate false for fresh session', () => {
    const id = handler.createNew('cos');
    const r = handler.checkRotation(id);
    expect(r.shouldRotate).toBe(false);
  });

  it('returns shouldRotate true when token threshold exceeded', () => {
    const id = handler.createNew('cos');
    handler.updateSessionMeta(id, 100_001); // above default threshold
    const r = handler.checkRotation(id);
    expect(r.shouldRotate).toBe(true);
    expect(r.reason).toContain('tokens');
  });

  it('returns shouldRotate true when inactive too long', () => {
    const id = handler.createNew('cos');
    const oldTime = Math.floor(Date.now() / 1000) - 5 * 3600; // 5h ago
    const meta = store.loadMeta(id);
    meta.last_message_at = oldTime;
    store.saveMeta(id, meta);
    const r = handler.checkRotation(id);
    expect(r.shouldRotate).toBe(true);
    expect(r.reason).toContain('inactivity');
  });

  it('returns shouldRotate false for missing session', () => {
    const r = handler.checkRotation('nonexistent');
    expect(r.shouldRotate).toBe(false);
  });
});

// ── appendMessage ─────────────────────────────────────────────────────────────

describe('SessionHandler.appendMessage', () => {
  it('appends a message and auto-titles from first user message', () => {
    const id = handler.createNew('cos');
    handler.appendMessage(id, { role: 'user', content: 'What is the meaning of life?' });
    const meta = store.loadMeta(id);
    expect(meta.title).toBe('What is the meaning of life?');
  });

  it('truncates auto-title at 50 chars', () => {
    const id = handler.createNew('cos');
    const longMsg = 'A'.repeat(60);
    handler.appendMessage(id, { role: 'user', content: longMsg });
    const meta = store.loadMeta(id);
    expect(meta.title!.length).toBeLessThanOrEqual(50);
    expect(meta.title).toContain('…');
  });

  it('adds _ts to messages', () => {
    const id = handler.createNew('cos');
    handler.appendMessage(id, { role: 'user', content: 'hi' });
    const msgs = store.loadMessages(id);
    expect(msgs[0]._ts).toBeDefined();
    expect(typeof msgs[0]._ts).toBe('number');
  });

  it('does not overwrite existing title', () => {
    const id = handler.createNew('cos');
    store.saveMeta(id, { ...store.loadMeta(id), title: 'Custom Title' });
    handler.appendMessage(id, { role: 'user', content: 'different message' });
    const meta = store.loadMeta(id);
    expect(meta.title).toBe('Custom Title');
  });
});

// ── getHistory ────────────────────────────────────────────────────────────────

describe('SessionHandler.getHistory', () => {
  it('returns messages in order', () => {
    const id = handler.createNew('cos');
    handler.appendMessage(id, { role: 'user', content: 'a' });
    handler.appendMessage(id, { role: 'assistant', content: 'b' });
    const hist = handler.getHistory(id);
    expect(hist).toHaveLength(2);
    expect(hist[0].content).toBe('a');
    expect(hist[1].content).toBe('b');
  });
});

// ── clearSession / truncateSession ────────────────────────────────────────────

describe('SessionHandler.clearSession', () => {
  it('removes all messages', () => {
    const id = handler.createNew('cos');
    handler.appendMessage(id, { role: 'user', content: 'hi' });
    handler.clearSession(id);
    expect(handler.getHistory(id)).toHaveLength(0);
  });
});

describe('SessionHandler.truncateSession', () => {
  it('truncates to fromIndex messages', () => {
    const id = handler.createNew('cos');
    for (let i = 0; i < 5; i++) {
      handler.appendMessage(id, { role: 'user', content: `msg-${i}` });
    }
    const remaining = handler.truncateSession(id, 3);
    expect(remaining).toBe(3);
    expect(handler.getHistory(id)).toHaveLength(3);
  });
});

// ── delete ────────────────────────────────────────────────────────────────────

describe('SessionHandler.delete', () => {
  it('removes session dir', () => {
    const id = handler.createNew('cos');
    handler.appendMessage(id, { role: 'user', content: 'hi' });
    handler.delete(id);
    expect(store.loadMessages(id)).toEqual([]);
    expect(store.loadMeta(id)).toEqual({});
  });
});

// ── getSessionMeta / updateSessionMeta ────────────────────────────────────────

describe('SessionHandler.getSessionMeta', () => {
  it('returns meta for existing session', () => {
    const id = handler.createNew('cos');
    const meta = handler.getSessionMeta(id);
    expect(meta.id).toBe(id);
    expect(meta.agent).toBe('cos');
  });
});

describe('SessionHandler.updateSessionMeta', () => {
  it('updates last_message_at and last_input_tokens', () => {
    const id = handler.createNew('cos');
    handler.updateSessionMeta(id, 12345);
    const meta = handler.getSessionMeta(id);
    expect(meta.last_input_tokens).toBe(12345);
    expect(typeof meta.last_message_at).toBe('number');
  });
});

// ── pruneEmptySessions / listSessions ─────────────────────────────────────────

describe('SessionHandler.pruneEmptySessions', () => {
  it('removes sessions with no messages', () => {
    const id = handler.createNew('cos');
    expect(store.loadMessages(id)).toHaveLength(0);
    handler.pruneEmptySessions();
    expect(store.listSessionDirs()).toHaveLength(0);
  });

  it('keeps sessions that have messages', () => {
    const id = handler.createNew('cos');
    handler.appendMessage(id, { role: 'user', content: 'hi' });
    handler.pruneEmptySessions();
    expect(store.listSessionDirs()).toHaveLength(1);
  });
});

describe('SessionHandler.listSessions', () => {
  it('returns non-closed sessions sorted by activity', async () => {
    const id1 = handler.createNew('cos');
    handler.appendMessage(id1, { role: 'user', content: 'a' });
    // Set last_message_at explicitly so sort order is deterministic
    const meta1 = { ...store.loadMeta(id1), last_message_at: 1000 };
    store.saveMeta(id1, meta1);

    await Bun.sleep(2);
    const id2 = handler.createNew('cos');
    handler.appendMessage(id2, { role: 'user', content: 'b' });
    const meta2 = { ...store.loadMeta(id2), last_message_at: 2000 };
    store.saveMeta(id2, meta2);

    const sessions = handler.listSessions();
    expect(sessions).toHaveLength(2);
    // id2 has higher last_message_at, should come first
    expect(sessions[0].id).toBe(id2);
  });

  it('excludes closed sessions', () => {
    const id = handler.createNew('cos');
    handler.appendMessage(id, { role: 'user', content: 'hi' });
    const meta = { ...store.loadMeta(id), closed: true };
    store.saveMeta(id, meta);
    expect(handler.listSessions()).toHaveLength(0);
  });
});

// ── getDisplayHistory ─────────────────────────────────────────────────────────

describe('SessionHandler.getDisplayHistory', () => {
  it('returns only user/assistant messages with text', () => {
    const id = handler.createNew('cos');
    handler.appendMessage(id, { role: 'user', content: 'hello' });
    handler.appendMessage(id, { role: 'tool', content: 'result' });
    handler.appendMessage(id, { role: 'assistant', content: 'hi there' });
    const r = handler.getDisplayHistory(id);
    expect(r.messages).toHaveLength(2);
    expect(r.messages[0].role).toBe('user');
    expect(r.messages[1].role).toBe('assistant');
  });
});

// ── getParentSummary ──────────────────────────────────────────────────────────

describe('SessionHandler.getParentSummary', () => {
  it('returns null for session with no parent', () => {
    const id = handler.createNew('cos');
    handler.appendMessage(id, { role: 'user', content: 'hi' });
    expect(handler.getParentSummary(id)).toBeNull();
  });

  it('returns summary if parent has one', () => {
    const old = handler.createNew('cos');
    handler.appendMessage(old, { role: 'user', content: 'old message' });
    store.writeSummary(old, 'The old session was about planning.');
    const newId = handler.rotate(old);

    const summary = handler.getParentSummary(newId);
    expect(summary).not.toBeNull();
    expect(summary!.content).toBe('The old session was about planning.');
  });

  it('falls back to transcript when no summary', async () => {
    const old = handler.createNew('cos');
    handler.appendMessage(old, { role: 'user', content: 'fallback message' });
    await Bun.sleep(2);
    const newId = handler.rotate(old);

    const summary = handler.getParentSummary(newId);
    expect(summary).not.toBeNull();
    expect(summary!.content).toContain('fallback message');
  });
});

// ── checkExpiredSessions ──────────────────────────────────────────────────────

describe('SessionHandler.checkExpiredSessions', () => {
  it('marks stale sessions as closed', () => {
    const id = handler.createNew('cos');
    handler.appendMessage(id, { role: 'user', content: 'old' });
    // Set last_message_at to 6h ago
    const meta = { ...store.loadMeta(id), last_message_at: Math.floor(Date.now() / 1000) - 6 * 3600 };
    store.saveMeta(id, meta);

    handler.checkExpiredSessions();

    const updatedMeta = store.loadMeta(id);
    expect(updatedMeta.closed).toBe(true);
  });

  it('skips sessions that already have a summary', () => {
    const id = handler.createNew('cos');
    handler.appendMessage(id, { role: 'user', content: 'hi' });
    store.writeSummary(id, 'already summarized');
    const meta = { ...store.loadMeta(id), last_message_at: Math.floor(Date.now() / 1000) - 6 * 3600 };
    store.saveMeta(id, meta);

    handler.checkExpiredSessions();

    const updatedMeta = store.loadMeta(id);
    expect(updatedMeta.closed).toBeUndefined();
  });
});

// ── buildTranscript (exported) ────────────────────────────────────────────────

describe('buildTranscript', () => {
  it('formats user and assistant messages', () => {
    const history = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ];
    const t = buildTranscript(history);
    expect(t).toContain('USER: hello');
    expect(t).toContain('ASSISTANT: world');
  });

  it('handles array content with text blocks', () => {
    const history = [
      { role: 'user', content: [{ type: 'text', text: 'array message' }] },
    ];
    const t = buildTranscript(history);
    expect(t).toContain('USER: array message');
  });

  it('includes tool calls and results', () => {
    const history = [
      { role: 'assistant', content: [{ type: 'tool_use', name: 'bash', input: { cmd: 'ls' } }] },
      { role: 'tool', content: [{ type: 'tool_result', content: 'file.txt' }] },
    ];
    const t = buildTranscript(history);
    expect(t).toContain('TOOL CALL [bash]');
  });

  it('returns empty string for empty history', () => {
    expect(buildTranscript([])).toBe('');
  });
});
