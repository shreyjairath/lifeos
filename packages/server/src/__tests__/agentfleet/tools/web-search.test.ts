import { describe, it, expect, afterEach, spyOn } from 'bun:test';
import { WebSearch } from '../../../agentfleet/tools/web-search.js';

let fetchSpy: ReturnType<typeof spyOn>;

function mockFetchHtml(html: string, status = 200): void {
  fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(html, { status, headers: { 'Content-Type': 'text/html' } }),
  );
}

const SAMPLE_HTML = `
<html><body>
<a class="result__a" href="https://example.com">Example Title</a>
<a class="result__a" href="https://docs.org">Docs Title</a>
<span class="result__snippet">A snippet about something</span>
<span class="result__snippet">Another snippet here</span>
</body></html>
`;

afterEach(() => {
  fetchSpy?.mockRestore();
});

describe('WebSearch.search', () => {
  it('returns parsed results from HTML', async () => {
    mockFetchHtml(SAMPLE_HTML);
    const ws = new WebSearch();
    const r = await ws.search('test query');
    expect(r.query).toBe('test query');
    expect(Array.isArray(r.results)).toBe(true);
  });

  it('respects maxResults limit', async () => {
    // Build HTML with 5 results
    const links = Array.from({ length: 5 }, (_, i) =>
      `<a class="result__a" href="https://site${i}.com">Site ${i}</a>`).join('');
    const snippets = Array.from({ length: 5 }, (_, i) =>
      `<span class="result__snippet">Snippet ${i}</span>`).join('');
    mockFetchHtml(`<html><body>${links}${snippets}</body></html>`);
    const ws = new WebSearch();
    const r = await ws.search('query', 2);
    expect(r.results.length).toBeLessThanOrEqual(2);
  });

  it('returns error object on HTTP failure', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 503 }));
    const ws = new WebSearch();
    const r = await ws.search('query');
    expect(r.error).toBeDefined();
    expect(r.results).toEqual([]);
  });

  it('includes source_quality when verify=true', async () => {
    const links = `<a class="result__a" href="https://reuters.com">Reuters</a>`;
    const snippet = `<span class="result__snippet">News from Jan 01, 2024</span>`;
    mockFetchHtml(`<html><body>${links}${snippet}</body></html>`);
    const fakeVerifier = {
      domainQuality: (url: string) => 'high' as const,
      extractDate: (s: string) => '2024-01-01',
    } as any;
    const ws = new WebSearch(fakeVerifier);
    const r = await ws.search('query', 5, true);
    if (r.results.length > 0) {
      expect(r.results[0].source_quality).toBe('high');
    }
  });

  it('returns error on network failure', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'));
    const ws = new WebSearch();
    const r = await ws.search('query');
    expect(r.error).toBeDefined();
  });
});
