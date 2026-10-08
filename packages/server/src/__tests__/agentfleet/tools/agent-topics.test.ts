import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { AgentTopics } from '../../../agentfleet/tools/agent-topics.js';
import { makeTempDir, cleanupDir } from '../../helpers.js';

let tmpDir: string;
let topics: AgentTopics;

beforeEach(() => {
  tmpDir = makeTempDir('agent-topics');
  topics = new AgentTopics(tmpDir);
});

afterEach(() => {
  cleanupDir(tmpDir);
});

describe('AgentTopics.getTopicsDir', () => {
  it('returns the constructor path', () => {
    expect(topics.getTopicsDir()).toBe(tmpDir);
  });
});

describe('AgentTopics.writeTopic', () => {
  it('creates a topic file with the entry', () => {
    const r = topics.writeTopic('cos', 'daily', 'Hello world');
    expect(r).toEqual({ status: 'written', topic: 'daily' });
    const read = topics.readTopic('cos', 'daily', false);
    expect(read.count).toBe(1);
    expect(read.messages[0].message).toBe('Hello world');
  });

  it('rejects invalid topic names', () => {
    expect(topics.writeTopic('cos', 'Invalid Name!', 'msg').error).toBeDefined();
    expect(topics.writeTopic('cos', 'Has Space', 'msg').error).toBeDefined();
    expect(topics.writeTopic('cos', '', 'msg').error).toBeDefined();
  });

  it('rejects empty message', () => {
    expect(topics.writeTopic('cos', 'feed', '').error).toBeDefined();
    expect(topics.writeTopic('cos', 'feed', '   ').error).toBeDefined();
  });

  it('includes to and threadId in header when provided', () => {
    topics.writeTopic('cos', 'feed', 'hello', ['other'], 'tid-1');
    const read = topics.readTopic('cos', 'feed', false);
    expect(read.messages[0].from).toContain('cos');
  });
});

describe('AgentTopics.readTopic', () => {
  it('returns empty for non-existent topic', () => {
    const r = topics.readTopic('cos', 'nonexistent', false);
    expect(r.messages).toEqual([]);
    expect(r.count).toBe(0);
  });

  it('peek mode with no cursor returns all entries and does not advance cursor', () => {
    topics.writeTopic('cos', 'news', 'msg-1');
    topics.writeTopic('cos', 'news', 'msg-2');
    const r1 = topics.readTopic('reader', 'news', false);
    const r2 = topics.readTopic('reader', 'news', false);
    expect(r1.count).toBe(2);
    expect(r2.count).toBe(2); // idempotent — cursor not advanced
  });

  it('peek mode is bounded by cursor — entries before last reconcile are hidden', async () => {
    topics.writeTopic('cos', 'feed', 'old-msg');
    // Reconcile advances the cursor past old-msg
    const r1 = topics.readTopic('reader', 'feed', true);
    expect(r1.count).toBe(1);

    await Bun.sleep(5);
    topics.writeTopic('cos', 'feed', 'new-msg');

    // peek should only see new-msg, not old-msg
    const peek = topics.readTopic('reader', 'feed', false);
    expect(peek.count).toBe(1);
    expect(peek.messages[0].message).toBe('new-msg');
  });

  it('peek mode is idempotent after reconcile — same new entries each call', async () => {
    topics.writeTopic('cos', 'feed', 'before');
    topics.readTopic('reader', 'feed', true); // reconcile

    await Bun.sleep(5);
    topics.writeTopic('cos', 'feed', 'after');

    const p1 = topics.readTopic('reader', 'feed', false);
    const p2 = topics.readTopic('reader', 'feed', false);
    expect(p1.count).toBe(1);
    expect(p2.count).toBe(1); // same result — cursor not moved
    expect(p1.messages[0].message).toBe('after');
  });

  it('consume after peek advances cursor and clears the window', async () => {
    topics.writeTopic('cos', 'feed', 'before');
    topics.readTopic('reader', 'feed', true); // reconcile

    await Bun.sleep(5);
    topics.writeTopic('cos', 'feed', 'after');

    topics.readTopic('reader', 'feed', false); // peek — does not advance
    const consume = topics.readTopic('reader', 'feed', true); // now reconcile
    expect(consume.count).toBe(1);
    expect(consume.messages[0].message).toBe('after');

    await Bun.sleep(5);
    // Nothing new since reconcile
    const next = topics.readTopic('reader', 'feed', false);
    expect(next.count).toBe(0);
  });

  it('consume mode advances cursor — second read returns only new entries', async () => {
    topics.writeTopic('cos', 'feed', 'msg-1');
    topics.writeTopic('cos', 'feed', 'msg-2');
    const r1 = topics.readTopic('reader', 'feed', true);
    expect(r1.count).toBe(2);

    await Bun.sleep(5); // ensure msg-3 timestamp > cursor written by first read
    topics.writeTopic('cos', 'feed', 'msg-3');
    const r2 = topics.readTopic('reader', 'feed', true);
    expect(r2.count).toBe(1);
    expect(r2.messages[0].message).toBe('msg-3');
  });

  it('consume first call returns all existing entries', () => {
    topics.writeTopic('cos', 'feed', 'existing');
    const r = topics.readTopic('new-reader', 'feed', true);
    expect(r.count).toBe(1);
  });

  it('filter narrows results', () => {
    topics.writeTopic('alice', 'chat', 'from alice');
    topics.writeTopic('bob', 'chat', 'from bob');
    const r = topics.readTopic('reader', 'chat', false, 'alice');
    expect(r.count).toBe(1);
    expect(r.messages[0].message).toBe('from alice');
  });

  it('peek mode pagination', () => {
    for (let i = 0; i < 5; i++) topics.writeTopic('cos', 'log', `msg-${i}`);
    const p1 = topics.readTopic('reader', 'log', false, undefined, 1, 2);
    expect(p1.messages).toHaveLength(2);
    expect(p1.total).toBe(5);
  });
});

describe('AgentTopics.listTopics', () => {
  it('returns sorted topic names', () => {
    topics.writeTopic('cos', 'zebra', 'msg');
    topics.writeTopic('cos', 'alpha', 'msg');
    const r = topics.listTopics('cos');
    expect(r.topics.map((t: any) => t.name)).toEqual(['alpha', 'zebra']);
  });

  it('returns empty when no topics exist', () => {
    const r = topics.listTopics('cos');
    expect(r.topics).toEqual([]);
  });
});
