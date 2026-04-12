import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { LlmClient, newLlmResult } from '../../../agent/executor/llm-client.js';

let fetchSpy: ReturnType<typeof spyOn>;

function makeSseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

function sseChunk(data: Record<string, any>): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function mockFetch(chunks: string[], ok = true, status = 200): void {
  const stream = makeSseStream(chunks);
  const response = new Response(stream, {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  });
  // Override ok based on status
  if (!ok) Object.defineProperty(response, 'ok', { value: false });
  fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(response);
}

afterEach(() => {
  fetchSpy?.mockRestore();
});

describe('LlmClient.stream', () => {
  it('yields llm_request as first event', async () => {
    mockFetch([`data: [DONE]\n\n`]);
    const client = new LlmClient('test-key');
    const result = newLlmResult();
    const events: any[] = [];
    for await (const e of client.stream('test-model', 'sys', [], [], null, result)) {
      events.push(e);
    }
    expect(events[0].type).toBe('llm_request');
    expect(events[0].model).toBe('test-model');
  });

  it('yields llm_text events from delta content', async () => {
    mockFetch([
      sseChunk({ choices: [{ delta: { content: 'Hello' }, finish_reason: null }] }),
      sseChunk({ choices: [{ delta: { content: ' World' }, finish_reason: 'stop' }] }),
      `data: [DONE]\n\n`,
    ]);
    const client = new LlmClient('test-key');
    const result = newLlmResult();
    const textEvents: any[] = [];
    for await (const e of client.stream('model', 'sys', [], [], null, result)) {
      if (e.type === 'llm_text') textEvents.push(e);
    }
    expect(textEvents).toHaveLength(2);
    expect(textEvents[0].text).toBe('Hello');
    expect(textEvents[1].text).toBe(' World');
    expect(result.fullText).toBe('Hello World');
  });

  it('accumulates tool calls and yields llm_tool_call', async () => {
    mockFetch([
      sseChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'tc1', function: { name: 'bash', arguments: '{"cmd":' } }] }, finish_reason: null }] }),
      sseChunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] }, finish_reason: 'tool_calls' }] }),
      `data: [DONE]\n\n`,
    ]);
    const client = new LlmClient('test-key');
    const result = newLlmResult();
    const toolEvents: any[] = [];
    for await (const e of client.stream('model', 'sys', [], [], null, result)) {
      if (e.type === 'llm_tool_call') toolEvents.push(e);
    }
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0].name).toBe('bash');
    expect(toolEvents[0].input).toEqual({ cmd: 'ls' });
    expect(result.stopReason).toBe('tool_use');
  });

  it('yields llm_reasoning from reasoning_content', async () => {
    mockFetch([
      sseChunk({ choices: [{ delta: { reasoning_content: 'thinking...' }, finish_reason: null }] }),
      `data: [DONE]\n\n`,
    ]);
    const client = new LlmClient('test-key');
    const result = newLlmResult();
    const reasonEvents: any[] = [];
    for await (const e of client.stream('model', 'sys', [], [], null, result)) {
      if (e.type === 'llm_reasoning') reasonEvents.push(e);
    }
    expect(reasonEvents).toHaveLength(1);
    expect(reasonEvents[0].text).toBe('thinking...');
  });

  it('throws on non-2xx response', async () => {
    const response = new Response('Unauthorized', { status: 401 });
    spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const client = new LlmClient('bad-key');
    const result = newLlmResult();
    await expect(async () => {
      for await (const _ of client.stream('model', 'sys', [], [], null, result)) {}
    }).toThrow('401');
  });

  it('yields llm_response as last event', async () => {
    mockFetch([
      sseChunk({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }),
      `data: [DONE]\n\n`,
    ]);
    const client = new LlmClient('test-key');
    const result = newLlmResult();
    const events: any[] = [];
    for await (const e of client.stream('model', 'sys', [], [], null, result)) {
      events.push(e);
    }
    const last = events[events.length - 1];
    expect(last.type).toBe('llm_response');
    expect(last.stopReason).toBe('end_turn');
  });

  it('accumulates usage from chunk', async () => {
    mockFetch([
      sseChunk({ usage: { prompt_tokens: 10, completion_tokens: 5 }, choices: [] }),
      `data: [DONE]\n\n`,
    ]);
    const client = new LlmClient('test-key');
    const result = newLlmResult();
    for await (const _ of client.stream('model', 'sys', [], [], null, result)) {}
    expect(result.usage.input_tokens).toBe(10);
    expect(result.usage.output_tokens).toBe(5);
  });
});

describe('LlmClient.streamBlocking', () => {
  it('returns full text', async () => {
    mockFetch([
      sseChunk({ choices: [{ delta: { content: 'Result: ' }, finish_reason: null }] }),
      sseChunk({ choices: [{ delta: { content: '42' }, finish_reason: 'stop' }] }),
      `data: [DONE]\n\n`,
    ]);
    const client = new LlmClient('test-key');
    const text = await client.streamBlocking('model', 'sys', [{ role: 'user', content: 'compute' }]);
    expect(text).toBe('Result: 42');
  });
});
