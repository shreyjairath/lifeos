import type { Verifier } from './verifier.js';

const BRAVE_API = 'https://api.search.brave.com/res/v1/web/search';

export class WebSearch {
  constructor(private readonly apiKey: string, private readonly verifier?: Verifier) {}

  async search(query: string, maxResults = 5, verify = false): Promise<Record<string, any>> {
    if (!this.apiKey) {
      return { error: 'BRAVE_SEARCH_API_KEY is not configured', results: [] };
    }
    try {
      const url = new URL(BRAVE_API);
      url.searchParams.set('q', query);
      url.searchParams.set('count', String(maxResults));
      const response = await fetch(url.toString(), {
        headers: {
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip',
          'X-Subscription-Token': this.apiKey,
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        return { error: `HTTP ${response.status}`, results: [] };
      }

      const data = await response.json() as any;
      const results = ((data.web?.results ?? []) as any[]).slice(0, maxResults).map((r: any) => {
        const result: Record<string, any> = {
          title: r.title ?? '',
          url: r.url ?? '',
          snippet: r.description ?? '',
        };
        if (verify && this.verifier) {
          result.source_quality = this.verifier.domainQuality(r.url ?? '');
          result.published = this.verifier.extractDate(r.description ?? '') ?? null;
        }
        return result;
      });

      return { query, results };
    } catch (err: any) {
      return { error: err?.message ?? 'unknown', results: [] };
    }
  }
}
