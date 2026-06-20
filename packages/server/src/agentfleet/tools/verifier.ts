import { LlmClient, newLlmResult } from '../../agent/executor/llm-client.js';

const HIGH_QUALITY_DOMAINS = [
  '.gov', '.edu', '.mil',
  'uscis.gov', 'irs.gov', 'ssa.gov', 'cdc.gov', 'nih.gov',
  'reuters.com', 'apnews.com', 'bbc.com', 'nytimes.com', 'wsj.com',
  'nature.com', 'pubmed.ncbi.nlm.nih.gov', 'scholar.google.com',
];

const LOW_QUALITY_SIGNALS = [
  'quora.com', 'reddit.com', 'yahoo.com/answers',
];

const SYSTEM_PROMPT = `You are a source credibility analyst. Given a web page's URL, title, and content, assess its reliability.

Return a JSON object with exactly these fields:
- source_quality: "high", "medium", or "low"
- published: ISO date string (YYYY-MM-DD) if detectable, otherwise null
- flags: array of short strings noting concerns (e.g. "no author", "undated", "promotional tone", "AI-generated content", "outdated", "opinion not fact")
- summary: one sentence assessing reliability

Return only valid JSON, no markdown.`;

export interface VerificationResult {
  source_quality: 'high' | 'medium' | 'low';
  published: string | null;
  flags: string[];
  summary: string;
}

export class Verifier {
  private readonly llm: LlmClient;
  private readonly model: string;

  constructor(llm: LlmClient, model: string) {
    this.llm = llm;
    this.model = model;
  }

  /** Quick domain-only quality signal — no LLM call. Used by web_search. */
  domainQuality(url: string): 'high' | 'medium' | 'low' {
    try {
      const hostname = new URL(url).hostname.toLowerCase();
      if (HIGH_QUALITY_DOMAINS.some((d) => hostname.endsWith(d) || hostname === d.replace(/^\./, ''))) return 'high';
      if (LOW_QUALITY_SIGNALS.some((d) => hostname.includes(d))) return 'low';
      return 'medium';
    } catch {
      return 'medium';
    }
  }

  /** Extract a publish date hint from a snippet string. */
  extractDate(snippet: string): string | null {
    const m = snippet.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2},? \d{4}\b|\b\d{4}-\d{2}-\d{2}\b/i);
    return m ? m[0] ?? null : null;
  }

  /** Concise LLM summary of page content. Returns 3-5 sentences covering the key facts. */
  async summarizePage(url: string, title: string, content: string): Promise<string> {
    const excerpt = content.slice(0, 12_000);
    const userMessage = `URL: ${url}\nTitle: ${title}\n\nContent:\n${excerpt}`;
    const systemPrompt = 'Summarize the key information from this web page in 3-5 concise sentences. Focus on facts, data, and actionable details. No preamble.';
    try {
      const result = newLlmResult();
      for await (const _ of this.llm.stream(
        this.model,
        systemPrompt,
        [{ role: 'user', content: userMessage }],
        [],
        null,
        result,
        512,
      )) { /* drain */ }
      return result.fullText.trim();
    } catch {
      return content.slice(0, 2_000);
    }
  }

  /** Full LLM-based assessment of page content. Used by browse_page / browse_page_js. */
  async assessPage(url: string, title: string, content: string): Promise<VerificationResult> {
    const excerpt = content.slice(0, 6000); // keep prompt lean
    const userMessage = `URL: ${url}\nTitle: ${title}\n\nContent excerpt:\n${excerpt}`;

    try {
      const result = newLlmResult();
      for await (const _ of this.llm.stream(
        this.model,
        SYSTEM_PROMPT,
        [{ role: 'user', content: userMessage }],
        [],
        null,
        result,
        512,
      )) { /* drain */ }

      const parsed = JSON.parse(result.fullText.trim()) as VerificationResult;
      return parsed;
    } catch {
      return {
        source_quality: 'medium',
        published: null,
        flags: ['verification failed'],
        summary: 'Could not assess source reliability.',
      };
    }
  }
}
