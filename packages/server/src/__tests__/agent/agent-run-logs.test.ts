import { describe, it, expect } from 'bun:test';
import {
  createRunRecord,
  finishRunRecord,
  addTokens,
  addTurn,
  setInitialMessages,
} from '../../agent/agent-run-logs.js';

describe('createRunRecord', () => {
  it('returns a valid record with all fields set', () => {
    const r = createRunRecord('cos', 'chat', 'sys prompt', 'hello', 'model-x', 'sess-1');
    expect(r.agent).toBe('cos');
    expect(r.mode).toBe('chat');
    expect(r.systemPrompt).toBe('sys prompt');
    expect(r.userMessage).toBe('hello');
    expect(r.model).toBe('model-x');
    expect(r.sessionId).toBe('sess-1');
    expect(r.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.inputTokens).toBe(0);
    expect(r.outputTokens).toBe(0);
    expect(r.turns).toEqual([]);
    expect(r.result).toBe('');
    expect(r.startedAt).toBeGreaterThan(0);
    expect(r.endedAt).toBeUndefined();
  });

  it('sessionId is optional', () => {
    const r = createRunRecord('agent', 'heartbeat', 'sys', 'msg', 'model');
    expect(r.sessionId).toBeUndefined();
  });
});

describe('finishRunRecord', () => {
  it('sets endedAt, durationMs, and result', () => {
    const r = createRunRecord('a', 'chat', 'sys', 'msg', 'model');
    finishRunRecord(r, 'final answer');
    expect(r.endedAt).toBeGreaterThanOrEqual(r.startedAt);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(r.result).toBe('final answer');
  });
});

describe('addTokens', () => {
  it('accumulates input and output tokens across calls', () => {
    const r = createRunRecord('a', 'chat', 'sys', 'msg', 'model');
    addTokens(r, 100, 50);
    addTokens(r, 200, 75);
    expect(r.inputTokens).toBe(300);
    expect(r.outputTokens).toBe(125);
  });
});

describe('addTurn', () => {
  it('appends a turn with string content', () => {
    const r = createRunRecord('a', 'chat', 'sys', 'msg', 'model');
    addTurn(r, 'assistant', { role: 'assistant', content: 'Hello there' });
    expect(r.turns).toHaveLength(1);
    expect(r.turns[0]!.role).toBe('assistant');
    expect(r.turns[0]!.content).toBe('Hello there');
  });

  it('truncates long assistant text at 5000 chars', () => {
    const r = createRunRecord('a', 'chat', 'sys', 'msg', 'model');
    const longText = 'x'.repeat(6000);
    addTurn(r, 'assistant', { role: 'assistant', content: longText });
    expect(r.turns[0]!.content.length).toBeLessThan(6000);
    expect(r.turns[0]!.content).toContain('…');
  });

  it('truncates tool result content at 2000 chars', () => {
    const r = createRunRecord('a', 'chat', 'sys', 'msg', 'model');
    const longText = 'y'.repeat(3000);
    addTurn(r, 'tool', { role: 'tool', content: longText });
    expect(r.turns[0]!.content.length).toBeLessThan(3000);
  });

  it('extracts tool_calls with names', () => {
    const r = createRunRecord('a', 'chat', 'sys', 'msg', 'model');
    addTurn(r, 'assistant', {
      role: 'assistant',
      content: null,
      tool_calls: [
        { function: { name: 'web_search', arguments: '{"query":"test"}' } },
      ],
    });
    expect(r.turns[0]!.tool_calls).toHaveLength(1);
    expect(r.turns[0]!.tool_calls[0].name).toBe('web_search');
  });

  it('captures reasoning field', () => {
    const r = createRunRecord('a', 'chat', 'sys', 'msg', 'model');
    addTurn(r, 'assistant', { role: 'assistant', content: 'answer', reasoning: 'I thought about it' });
    expect(r.turns[0]!.reasoning).toBe('I thought about it');
  });
});

describe('setInitialMessages', () => {
  it('captures up to 50 messages', () => {
    const r = createRunRecord('a', 'chat', 'sys', 'msg', 'model');
    const messages = Array.from({ length: 60 }, (_, i) => ({
      role: 'user',
      content: `msg ${i}`,
    }));
    setInitialMessages(r, messages);
    expect(r.initialMessages).toHaveLength(50);
  });

  it('truncates long content in messages', () => {
    const r = createRunRecord('a', 'chat', 'sys', 'msg', 'model');
    setInitialMessages(r, [{ role: 'user', content: 'x'.repeat(6000) }]);
    expect(r.initialMessages![0]!.content.length).toBeLessThan(6000);
  });
});
