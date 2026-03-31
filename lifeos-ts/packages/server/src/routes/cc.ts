import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { LlmClient, newLlmResult } from '../agent/executor/llm-client.js';
import type { AppConfig } from '../config.js';

const SYSTEM = `You are Claude Code, a developer assistant embedded in the lifeos personal agent application.
You help the developer understand, debug, and extend the lifeos codebase.
The backend is Bun + Hono (TypeScript). The frontend is React/Next.js.
Be concise and precise. Prefer code examples over lengthy explanations.`;

/**
 * Claude Code sidecar chat — developer assistant scoped to the lifeos codebase.
 * Maintains in-memory session history; no file persistence.
 */
export function ccRoutes(config: AppConfig) {
  const llmClient = new LlmClient(config.apiKey);
  const sessions = new Map<string, Record<string, any>[]>();

  const app = new Hono();

  // POST /api/cc/chat — SSE stream
  app.post('/cc/chat', async (c) => {
    const body = await c.req.json<{ message: string; session_id?: string }>();
    const message = body.message ?? '';
    let sessionId = body.session_id;
    if (!sessionId?.trim()) {
      sessionId = 'cc-' + crypto.randomUUID().slice(0, 8);
    }
    const sid = sessionId;

    if (!sessions.has(sid)) sessions.set(sid, []);
    const history = sessions.get(sid)!;
    history.push({ role: 'user', content: message });

    const snapshot = [...history];

    return streamSSE(c, async (stream) => {
      const result = newLlmResult();
      try {
        for await (const event of llmClient.stream(config.model, SYSTEM, snapshot, [], null, result)) {
          if (event.type === 'llm_text') {
            await stream.writeSSE({
              data: JSON.stringify({ type: 'cc_block', block: { type: 'text', text: event.text } }),
            });
          }
        }
        if (result.fullText.trim()) {
          history.push({ role: 'assistant', content: result.fullText });
        }
      } catch (err: any) {
        await stream.writeSSE({
          data: JSON.stringify({ type: 'error', text: err?.message ?? 'LLM error' }),
        });
      }
      await stream.writeSSE({ data: JSON.stringify({ type: 'session_id', session_id: sid }) });
    });
  });

  // GET /api/cc/history?session_id=...
  app.get('/cc/history', (c) => {
    const sid = c.req.query('session_id') ?? '';
    const history = sessions.get(sid) ?? [];
    const messages = history.map((msg) => {
      const role = msg.role === 'assistant' ? 'cc' : msg.role;
      const text = typeof msg.content === 'string'
        ? msg.content
        : (Array.isArray(msg.content) && msg.content[0]?.text) ?? '';
      return { role, text };
    });
    return c.json({ messages });
  });

  return app;
}
