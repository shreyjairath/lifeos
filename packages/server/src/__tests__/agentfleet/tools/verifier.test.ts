import { describe, it, expect, afterEach, spyOn } from 'bun:test';
import { Verifier } from '../../../agentfleet/tools/verifier.js';
import { LlmClient, newLlmResult } from '../../../agent/executor/llm-client.js';

let fetchSpy: ReturnType<typeof spyOn>;

afterEach(() => {
  fetchSpy?.mockRestore();
});

function makeVerifier(): Verifier {
  return new Verifier(new LlmClient('test-key'), 'test-model');
}

function mockLlmResponse(text: string): void {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\n`));
      c.enqueue(encoder.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
  fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(stream));
}

// ── domainQuality ─────────────────────────────────────────────────────────────

describe('Verifier.domainQuality', () => {
  const v = makeVerifier();

  it('returns high for .gov domains', () => {
    expect(v.domainQuality('https://irs.gov/taxes')).toBe('high');
    expect(v.domainQuality('https://cdc.gov/covid')).toBe('high');
  });

  it('returns high for .edu domains', () => {
    expect(v.domainQuality('https://university.edu/paper')).toBe('high');
  });

  it('returns high for known quality news', () => {
    expect(v.domainQuality('https://reuters.com/article')).toBe('high');
    expect(v.domainQuality('https://apnews.com/story')).toBe('high');
  });

  it('returns low for low-quality domains', () => {
    expect(v.domainQuality('https://quora.com/question')).toBe('low');
    expect(v.domainQuality('https://reddit.com/r/test')).toBe('low');
  });

  it('returns medium for generic domains', () => {
    expect(v.domainQuality('https://some-random-blog.com')).toBe('medium');
  });

  it('returns medium for invalid URL', () => {
    expect(v.domainQuality('not-a-url')).toBe('medium');
  });
});

// ── extractDate ───────────────────────────────────────────────────────────────

describe('Verifier.extractDate', () => {
  const v = makeVerifier();

  it('extracts ISO date format', () => {
    expect(v.extractDate('Published on 2024-01-15.')).toBe('2024-01-15');
  });

  it('extracts month-name format', () => {
    expect(v.extractDate('Updated Jan 5, 2023')).toBe('Jan 5, 2023');
  });

  it('returns null for no date', () => {
    expect(v.extractDate('No date here at all.')).toBeNull();
  });
});

// ── assessPage ────────────────────────────────────────────────────────────────

describe('Verifier.assessPage', () => {
  it('calls LLM and parses JSON response', async () => {
    const mockResult = {
      source_quality: 'high',
      published: '2024-01-01',
      flags: [],
      summary: 'Reliable source.',
    };
    mockLlmResponse(JSON.stringify(mockResult));
    const v = makeVerifier();
    const r = await v.assessPage('https://reuters.com', 'Test', 'content here');
    expect(r.source_quality).toBe('high');
    expect(r.summary).toBe('Reliable source.');
  });

  it('returns fallback on LLM error', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    const v = makeVerifier();
    const r = await v.assessPage('https://x.com', 'Bad', 'content');
    expect(r.source_quality).toBe('medium');
    expect(r.flags).toContain('verification failed');
  });

  it('returns fallback when LLM returns invalid JSON', async () => {
    mockLlmResponse('this is not json');
    const v = makeVerifier();
    const r = await v.assessPage('https://x.com', 'T', 'content');
    expect(r.source_quality).toBe('medium');
    expect(r.flags).toContain('verification failed');
  });
});
