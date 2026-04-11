import * as cheerio from 'cheerio';
import { chromium, type Browser } from 'playwright';
import type { Verifier } from './verifier.js';

const MAX_CHARS = 50_000;
const REMOVE_TAGS = ['script', 'style', 'nav', 'header', 'footer', 'aside', 'iframe', 'noscript'];

export class BrowseJs {
  private browser: Browser | null = null;

  constructor(private readonly verifier?: Verifier) {}

  private async getBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) return this.browser;
    this.browser = await chromium.launch({
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    return this.browser;
  }

  async fetch(url: string, verify = false): Promise<Record<string, any>> {
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return { error: 'Only http/https URLs are supported.', url };
    }

    let browser: Browser;
    try {
      browser = await this.getBrowser();
    } catch (err: any) {
      return { error: `Failed to launch browser: ${err?.message ?? 'Unknown error'}`, url };
    }

    const page = await browser.newPage();
    try {
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
      });

      const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });

      if (!response) return { error: 'No response received', url };
      if (response.status() >= 400) return { error: `HTTP ${response.status()}`, url };

      const finalUrl = page.url();
      const html = await page.content();
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
        return { error: 'Could not extract readable content.', url: finalUrl, title };
      }

      const wordCount = text.split(/\s+/).length;
      const truncated = text.length > MAX_CHARS;
      if (truncated) text = text.slice(0, MAX_CHARS);

      const result: Record<string, any> = { url: finalUrl, title, content: text, truncated, word_count: wordCount };

      if (verify && this.verifier) {
        result.verification = await this.verifier.assessPage(finalUrl, title, text);
      }

      return result;
    } catch (err: any) {
      // Reset browser on crash
      this.browser = null;
      if (err?.name === 'TimeoutError' || err?.message?.includes('Timeout')) {
        return { error: 'Page timed out after 30s (JS rendering).', url };
      }
      return { error: err?.message ?? 'Unknown error', url };
    } finally {
      await page.close();
    }
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}
