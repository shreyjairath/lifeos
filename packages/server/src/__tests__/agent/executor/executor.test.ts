import { describe, it, expect, afterEach, spyOn } from 'bun:test';
import { Executor, prepareMessages } from '../../../agent/executor/executor.js';
import { LlmClient, newLlmResult } from '../../../agent/executor/llm-client.js';
import { Confirmations } from '../../../agent/executor/confirmations.js';
import { fakeToolInvoker } from '../../fakes.js';

let fetchSpy: ReturnType<typeof spyOn>;

afterEach(() => {
  fetchSpy?.mockRestore();
});

function makeStream(content: string, stopReason = 'stop'): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode(
        `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: stopReason }] })}\n\n`
      ));
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
  return new Response(stream);
}

function makeToolStream(toolName: string, toolArgs: string): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(c) {
      // First chunk: tool call start
      c.enqueue(enc.encode(
        `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'tc1', function: { name: toolName, arguments: toolArgs } }] }, finish_reason: 'tool_calls' }] })}\n\n`
      ));
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
  return new Response(stream);
}

describe('Executor.runLoop', () => {
  it('yields events and returns on end_turn', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(makeStream('Hello'));
    const executor = new Executor(new LlmClient('key'), new Confirmations());
    const events: any[] = [];
    for await (const e of executor.runLoop([], 'sys', 'model', [], 'agent', null, fakeToolInvoker())) {
      events.push(e);
    }
    expect(events.some((e) => e.type === 'llm_text')).toBe(true);
    expect(events.some((e) => e.type === 'llm_response')).toBe(true);
    expect(events.some((e) => e.type === 'agent_append')).toBe(true);
  });

  it('dispatches tools and continues loop', async () => {
    // First response: tool_use, Second: end_turn
    let call = 0;
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(() => {
      call++;
      if (call === 1) return Promise.resolve(makeToolStream('bash', '{"cmd":"ls"}'));
      return Promise.resolve(makeStream('Done'));
    });
    const invoker = fakeToolInvoker(() => ({ output: 'file.txt' }));
    const executor = new Executor(new LlmClient('key'), new Confirmations());
    const events: any[] = [];
    for await (const e of executor.runLoop([], 'sys', 'model', [], 'agent', null, invoker)) {
      events.push(e);
    }
    expect(events.some((e) => e.type === 'tool_result')).toBe(true);
    expect(call).toBe(2);
  });

  it('stops when cancelled', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(makeStream('Never'));
    const executor = new Executor(new LlmClient('key'), new Confirmations());
    executor.cancel();
    const events: any[] = [];
    for await (const e of executor.runLoop([], 'sys', 'model', [], 'agent', null, fakeToolInvoker())) {
      events.push(e);
    }
    expect(events).toHaveLength(0); // cancelled before first turn
  });
});

describe('invokeTools — gated tool denial', () => {
  it('yields tool_confirm_request and tool_confirm_denied on denial', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      makeToolStream('run_python', '{"code":"x=1"}')
    );
    const confirmations = new Confirmations();
    // Auto-deny the confirmation
    const origRegister = confirmations.register.bind(confirmations);
    confirmations.register = () => {
      const r = origRegister();
      setTimeout(() => confirmations.resolve(r.requestId, false), 0);
      return r;
    };
    const executor = new Executor(new LlmClient('key'), confirmations);
    const events: any[] = [];
    // Second fetch won't be reached (tool denied → end of tool block → end_turn)
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(() => {
      return Promise.resolve(
        call === 0
          ? (call++, makeToolStream('run_python', '{"code":"x=1"}'))
          : makeStream('Done')
      );
    });
    let call = 0;
    for await (const e of executor.runLoop([], 'sys', 'model', [], 'agent', null, fakeToolInvoker())) {
      events.push(e);
    }
    expect(events.some((e) => e.type === 'tool_confirm_request')).toBe(true);
    expect(events.some((e) => e.type === 'tool_confirm_denied')).toBe(true);
  });
});

// ── prepareMessages ────────────────────────────────────────────────────────────

describe('prepareMessages', () => {
  it('removes leading tool messages', () => {
    const msgs = [
      { role: 'tool', content: 'result' },
      { role: 'user', content: 'hi' },
    ];
    prepareMessages(msgs);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('user');
  });

  it('handles empty array', () => {
    const msgs: any[] = [];
    prepareMessages(msgs);
    expect(msgs).toEqual([]);
  });

  it('does not remove non-leading tool messages', () => {
    const msgs = [
      { role: 'user', content: 'hi' },
      { role: 'tool', content: 'result' },
    ];
    prepareMessages(msgs);
    expect(msgs).toHaveLength(2);
  });
});
