import { describe, it, expect } from 'bun:test';
import { newToolsResult, invokeTools } from '../../../agent/executor/tools-client.js';
import { prepareMessages } from '../../../agent/executor/executor.js';
import { Confirmations } from '../../../agent/executor/confirmations.js';
import { fakeToolInvoker } from '../../fakes.js';

// ── invokeTools ───────────────────────────────────────────────────────────────

describe('invokeTools — sequential dispatch', () => {
  it('invokes each tool and appends result message', async () => {
    const toolUses = [
      { id: 'id1', name: 'bash', input: { cmd: 'echo hi' } },
      { id: 'id2', name: 'bash', input: { cmd: 'echo there' } },
    ];
    const invoker = fakeToolInvoker(() => ({ output: 'ok' }));
    const result = newToolsResult();
    const events: any[] = [];
    for await (const e of invokeTools(toolUses, () => false, result, 'agent', invoker, new Confirmations())) {
      events.push(e);
    }
    expect(result.messages).toHaveLength(2);
    expect(result.cancelled).toBe(false);
    expect(events.filter((e) => e.type === 'tool_result')).toHaveLength(2);
  });

  it('cancels mid-dispatch when isCancelled returns true', async () => {
    const toolUses = [
      { id: 'id1', name: 'bash', input: {} },
      { id: 'id2', name: 'bash', input: {} },
    ];
    let calls = 0;
    const invoker = fakeToolInvoker(() => { calls++; return { ok: true }; });
    const result = newToolsResult();
    const events: any[] = [];
    // Cancel after first tool
    let first = true;
    for await (const e of invokeTools(toolUses, () => { if (first) { first = false; return false; } return true; }, result, 'agent', invoker, new Confirmations())) {
      events.push(e);
    }
    // The second tool was cancelled
    expect(result.cancelled).toBe(true);
    expect(events.some((e) => e.type === 'tool_cancelled')).toBe(true);
  });

  it('handles tool invocation error gracefully', async () => {
    const toolUses = [{ id: 'id1', name: 'bad_tool', input: {} }];
    const invoker = fakeToolInvoker(() => { throw new Error('boom'); });
    const result = newToolsResult();
    const events: any[] = [];
    for await (const e of invokeTools(toolUses, () => false, result, 'agent', invoker, new Confirmations())) {
      events.push(e);
    }
    expect(result.messages[0]).toBeDefined();
    const content = JSON.parse(result.messages[0].content);
    expect(content.error).toContain('boom');
  });
});

describe('newToolsResult', () => {
  it('returns empty messages and cancelled=false', () => {
    const r = newToolsResult();
    expect(r.messages).toEqual([]);
    expect(r.cancelled).toBe(false);
  });
});

describe('prepareMessages', () => {
  it('removes leading tool messages', () => {
    const messages = [
      { role: 'tool', content: 'result1' },
      { role: 'tool', content: 'result2' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' },
    ];
    prepareMessages(messages);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe('user');
  });

  it('leaves non-tool leading messages unchanged', () => {
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'tool', content: 'result' },
    ];
    prepareMessages(messages);
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe('user');
  });

  it('handles empty array', () => {
    const messages: Record<string, any>[] = [];
    prepareMessages(messages);
    expect(messages).toEqual([]);
  });

  it('handles all-tool array', () => {
    const messages = [
      { role: 'tool', content: 'a' },
      { role: 'tool', content: 'b' },
    ];
    prepareMessages(messages);
    expect(messages).toEqual([]);
  });
});
