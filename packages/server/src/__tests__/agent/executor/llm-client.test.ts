import { describe, it, expect } from 'bun:test';
import { newLlmResult } from '../../../agent/executor/llm-client.js';

describe('newLlmResult', () => {
  it('returns a zeroed result object', () => {
    const r = newLlmResult();
    expect(r.fullText).toBe('');
    expect(r.fullReasoning).toBe('');
    expect(r.parsedToolUses).toEqual([]);
    expect(r.stopReason).toBe('');
    expect(r.usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });

  it('each call returns a fresh independent object', () => {
    const a = newLlmResult();
    const b = newLlmResult();
    a.fullText = 'modified';
    expect(b.fullText).toBe('');
  });
});
