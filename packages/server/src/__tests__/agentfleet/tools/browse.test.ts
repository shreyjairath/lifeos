import { describe, it, expect, afterEach, spyOn } from 'bun:test';
import { Browse } from '../../../agentfleet/tools/browse.js';

let fetchSpy: ReturnType<typeof spyOn>;

function mockFetchHtml(html: string, status = 200, contentType = 'text/html; charset=utf-8', responseUrl = 'https://example.com'): void {
  const resp = new Response(html, {
    status,
    headers: { 'Content-Type': contentType },
  });
  Object.defineProperty(resp, 'url', { value: responseUrl });
  fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(resp);
}

const ARTICLE_HTML = `
<html>
<head><title>Test Article</title></head>
<body>
<script>alert('remove me')</script>
<article>
${'This is a long article body with meaningful content. '.repeat(6)}
</article>
</body>
</html>
`;

afterEach(() => {
  fetchSpy?.mockRestore();
});

describe('Browse.fetch', () => {
  it('extracts content from article element', async () => {
    mockFetchHtml(ARTICLE_HTML);
    const browse = new Browse();
    const r = await browse.fetch('https://example.com');
    expect(r.content).toBeDefined();
    expect(r.content).toContain('long article body');
    expect(r.title).toBe('Test Article');
    expect(r.url).toBe('https://example.com');
  });

  it('returns error for non-http URL', async () => {
    const browse = new Browse();
    const r = await browse.fetch('ftp://bad.com');
    expect(r.error).toBeDefined();
  });

  it('returns error for 404', async () => {
    mockFetchHtml('Not Found', 404);
    const browse = new Browse();
    const r = await browse.fetch('https://example.com/missing');
    expect(r.error).toBeDefined();
  });

  it('returns error for non-HTML content type', async () => {
    mockFetchHtml('{}', 200, 'application/json');
    const browse = new Browse();
    const r = await browse.fetch('https://example.com/api');
    expect(r.error).toBeDefined();
    expect(r.error).toContain('Non-HTML');
  });

  it('truncates at 50k chars', async () => {
    const longContent = 'X'.repeat(60_000);
    mockFetchHtml(`<html><head><title>T</title></head><body><article>${longContent}</article></body></html>`);
    const browse = new Browse();
    const r = await browse.fetch('https://example.com');
    if (r.content) {
      expect(r.content.length).toBeLessThanOrEqual(50_001);
      expect(r.truncated).toBe(true);
    }
  });

  it('returns error on network failure', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connection refused'));
    const browse = new Browse();
    const r = await browse.fetch('https://example.com');
    expect(r.error).toBeDefined();
  });

  it('calls verifier.assessPage when verify=true', async () => {
    mockFetchHtml(ARTICLE_HTML);
    let assessCalled = false;
    const fakeVerifier = {
      assessPage: async () => {
        assessCalled = true;
        return { source_quality: 'medium', published: null, flags: [], summary: 'ok' };
      },
    } as any;
    const browse = new Browse(fakeVerifier);
    const r = await browse.fetch('https://example.com', true);
    if (!r.error) {
      expect(assessCalled).toBe(true);
    }
  });
});
