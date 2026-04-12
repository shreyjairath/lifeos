import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { SessionStore } from '../../../agent/session/session-store.js';
import { makeTempDir, cleanupDir } from '../../helpers.js';

let tmpDir: string;
let store: SessionStore;

beforeEach(() => {
  tmpDir = makeTempDir('session-store');
  store = new SessionStore(tmpDir, 'test_agent');
});

afterEach(() => {
  cleanupDir(tmpDir);
});

describe('SessionStore meta', () => {
  it('saveMeta and loadMeta round-trip', () => {
    const meta = { id: 'sess-1', title: 'Hello', created_at: 1000 };
    store.saveMeta('sess-1', meta);
    expect(store.loadMeta('sess-1')).toEqual(meta);
  });

  it('loadMeta returns empty object for missing session', () => {
    expect(store.loadMeta('nonexistent')).toEqual({});
  });

  it('loadMeta returns empty object for corrupt JSON', () => {
    const dir = store.sessionDir('bad-sess');
    const { mkdirSync } = require('fs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'meta.json'), 'not valid json');
    expect(store.loadMeta('bad-sess')).toEqual({});
  });
});

describe('SessionStore messages', () => {
  it('saveMessages and loadMessages round-trip', () => {
    const msgs = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }];
    store.saveMessages('sess-1', msgs);
    expect(store.loadMessages('sess-1')).toEqual(msgs);
  });

  it('loadMessages returns empty array for missing session', () => {
    expect(store.loadMessages('nonexistent')).toEqual([]);
  });
});

describe('SessionStore summary', () => {
  it('writeSummary and readSummary round-trip', () => {
    store.saveMeta('sess-1', { id: 'sess-1' });
    store.writeSummary('sess-1', 'This was a great session.');
    expect(store.readSummary('sess-1')).toBe('This was a great session.');
  });

  it('readSummary returns empty string for missing session', () => {
    expect(store.readSummary('nonexistent')).toBe('');
  });
});

describe('SessionStore listSessionDirs', () => {
  it('returns sorted directory names', () => {
    store.saveMeta('session-c', {});
    store.saveMeta('session-a', {});
    store.saveMeta('session-b', {});
    const dirs = store.listSessionDirs();
    expect(dirs).toEqual(['session-a', 'session-b', 'session-c']);
  });

  it('returns empty array for non-existent root', () => {
    const emptyStore = new SessionStore(tmpDir, 'no_such_agent');
    expect(emptyStore.listSessionDirs()).toEqual([]);
  });
});

describe('SessionStore deleteSession', () => {
  it('removes the session directory', () => {
    store.saveMeta('sess-1', { id: 'sess-1' });
    store.deleteSession('sess-1');
    expect(store.loadMeta('sess-1')).toEqual({});
  });

  it('is safe for non-existent session', () => {
    expect(() => store.deleteSession('nonexistent')).not.toThrow();
  });
});

describe('SessionStore sessionDir', () => {
  it('returns correct path', () => {
    const dir = store.sessionDir('my-sess');
    expect(dir).toContain('test_agent');
    expect(dir).toContain('my-sess');
  });
});
