import { describe, it, expect, afterEach, spyOn } from 'bun:test';
import { WebSearch } from '../../../agentfleet/tools/web-search.js';

let fetchSpy: ReturnType<typeof spyOn>;

function mockBraveResponse(results: { title: string; url: string; description: string }[], status = 200): void {
  fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ web: { results } }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

const SAMPLE_RESULTS = [
  { title: 'Example Title', url: 'https://example.com', description: 'A snippet about something' },
  { title: 'Docs Title', url: 'https://docs.org', description: 'Another snippet here' },
];

afterEach(() => {
  fetchSpy?.mockRestore();
});

describe('WebSearch.search', () => {
  it('returns error when api key is missing', async () => {
    const ws = new WebSearch('');
    const r = await ws.search('test query');
    expect(r.error).toBeDefined();
    expect(r.results).toEqual([]);
  });

  it('returns parsed results from Brave API', async () => {
    mockBraveResponse(SAMPLE_RESULTS);
    const ws = new WebSearch('test-key');
    const r = await ws.search('test query');
    expect(r.query).toBe('test query');
    expect(Array.isArray(r.results)).toBe(true);
    expect(r.results.length).toBe(2);
    expect(r.results[0].title).toBe('Example Title');
    expect(r.results[0].url).toBe('https://example.com');
    expect(r.results[0].snippet).toBe('A snippet about something');
  });

  it('respects maxResults limit', async () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      title: `Site ${i}`, url: `https://site${i}.com`, description: `Snippet ${i}`,
    }));
    mockBraveResponse(many);
    const ws = new WebSearch('test-key');
    const r = await ws.search('query', 2);
    expect(r.results.length).toBeLessThanOrEqual(2);
  });

  it('returns error object on HTTP failure', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 429 }));
    const ws = new WebSearch('test-key');
    const r = await ws.search('query');
    expect(r.error).toBeDefined();
    expect(r.results).toEqual([]);
  });

  it('includes source_quality when verify=true', async () => {
    mockBraveResponse([{ title: 'Reuters', url: 'https://reuters.com', description: 'News from Jan 01, 2024' }]);
    const fakeVerifier = {
      domainQuality: (_url: string) => 'high' as const,
      extractDate: (_s: string) => '2024-01-01',
    } as any;
    const ws = new WebSearch('test-key', fakeVerifier);
    const r = await ws.search('query', 5, true);
    expect(r.results.length).toBe(1);
    expect(r.results[0].source_quality).toBe('high');
    expect(r.results[0].published).toBe('2024-01-01');
  });

  it('returns error on network failure', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'));
    const ws = new WebSearch('test-key');
    const r = await ws.search('query');
    expect(r.error).toBeDefined();
  });

  it('handles missing web results gracefully', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const ws = new WebSearch('test-key');
    const r = await ws.search('query');
    expect(r.results).toEqual([]);
  });
});
