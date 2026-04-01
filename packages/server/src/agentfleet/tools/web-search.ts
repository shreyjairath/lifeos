const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const LINK_RE = /class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gds;
const SNIPPET_RE = /class="result__snippet"[^>]*>(.*?)<\/[a-z]+>/gds;
const STRIP_HTML_RE = /<[^>]+>/g;

export class WebSearch {
  async search(query: string, maxResults = 5): Promise<Record<string, any>> {
    try {
      const encoded = encodeURIComponent(query);
      const response = await fetch(`https://html.duckduckgo.com/html/?q=${encoded}`, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        return { error: `HTTP ${response.status}`, results: [] };
      }

      const html = await response.text();

      const links: [string, string][] = [];
      const snippets: string[] = [];

      // Reset regex state
      let m: RegExpExecArray | null;
      const linkRe = new RegExp(LINK_RE.source, 'gds');
      while ((m = linkRe.exec(html)) !== null) {
        links.push([m[1]!, stripHtml(m[2]!)]);
      }

      const snippetRe = new RegExp(SNIPPET_RE.source, 'gds');
      while ((m = snippetRe.exec(html)) !== null) {
        snippets.push(stripHtml(m[1]!));
      }

      const results = links.slice(0, maxResults).map(([url, title], i) => ({
        title,
        url,
        snippet: snippets[i] ?? '',
      }));

      return { query, results };
    } catch (err: any) {
      return { error: err?.message ?? 'unknown', results: [] };
    }
  }
}

function stripHtml(html: string): string {
  return html.replace(STRIP_HTML_RE, '').trim();
}
