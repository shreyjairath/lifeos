import * as cheerio from 'cheerio';

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const MAX_CHARS = 50_000;
const REMOVE_TAGS = ['script', 'style', 'nav', 'header', 'footer', 'aside', 'iframe', 'noscript'];

export class Browse {
  async fetch(url: string): Promise<Record<string, any>> {
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return { error: 'Only http/https URLs are supported.', url };
    }
    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(15_000),
        redirect: 'follow',
      });

      if (response.status >= 400) {
        return { error: `HTTP ${response.status}`, url };
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('text/html')) {
        return { error: `Non-HTML content type: ${contentType}`, url };
      }

      const html = await response.text();
      const finalUrl = response.url;
      const $ = cheerio.load(html);

      const title = $('title').text().trim();
      for (const tag of REMOVE_TAGS) $(tag).remove();

      let text = '';
      for (const selector of ['article', 'main', '[role=main]', '.post-content', '.article-body', '.entry-content', '#content']) {
        const el = $(selector).first();
        if (el.length) {
          text = el.text().replace(/\s+/g, ' ').trim();
          if (text.length > 200) break;
        }
      }
      if (!text || text.length < 200) {
        text = $('body').text().replace(/\s+/g, ' ').trim();
      }

      if (!text || text.length < 200) {
        return { error: 'Could not extract readable content (page may be JS-rendered or paywalled).', url: finalUrl, title };
      }

      const wordCount = text.split(/\s+/).length;
      const truncated = text.length > MAX_CHARS;
      if (truncated) text = text.slice(0, MAX_CHARS);

      return { url: finalUrl, title, content: text, truncated, word_count: wordCount };
    } catch (err: any) {
      if (err?.name === 'TimeoutError') {
        return { error: 'Request timed out after 15s.', url };
      }
      return { error: err?.message ?? 'Unknown error', url };
    }
  }
}
