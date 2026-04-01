import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AgentFleet } from '../agentfleet/agent-fleet.js';
import type { Confirmations } from '../agent/executor/confirmations.js';

export function chatRoutes(fleet: AgentFleet, confirmations: Confirmations) {
  const app = new Hono();

  // POST /api/chat — SSE stream
  app.post('/chat', (c) => {
    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async (stream) => {
      let body: Record<string, any>;
      try {
        body = await c.req.json();
      } catch {
        await stream.writeSSE({ data: JSON.stringify({ type: 'error', text: 'Invalid JSON' }) });
        return;
      }
      const { session_id, message, agent, model } = body;
      try {
        for await (const frame of fleet.handleMessage(session_id, message, agent, model)) {
          await stream.writeSSE({ data: frame.data });
        }
      } catch (err: any) {
        await stream.writeSSE({ data: JSON.stringify({ type: 'error', text: err?.message ?? 'unknown' }) });
      }
    });
  });

  // GET /api/chat/:agentName/:sessionId — load history
  app.get('/chat/:agentName/:sessionId', (c) => {
    const { agentName, sessionId } = c.req.param();
    return c.json(fleet.getHistory(agentName, sessionId));
  });

  // DELETE /api/chat/:agentName/:sessionId — clear session
  app.delete('/chat/:agentName/:sessionId', (c) => {
    const { agentName, sessionId } = c.req.param();
    fleet.clearSession(agentName, sessionId);
    return c.json({ cleared: sessionId });
  });

  // POST /api/chat/:agentName/:sessionId/truncate
  app.post('/chat/:agentName/:sessionId/truncate', async (c) => {
    const { agentName, sessionId } = c.req.param();
    const body = await c.req.json().catch(() => ({}));
    const remaining = fleet.truncateSession(agentName, sessionId, body.index ?? 0);
    return c.json({ session_id: sessionId, remaining });
  });

  // POST /api/chat/:agentName/:sessionId/stop — cancel
  app.post('/chat/:agentName/:sessionId/stop', (c) => {
    const { agentName, sessionId } = c.req.param();
    fleet.cancel(agentName, sessionId);
    return c.json({ ok: true });
  });

  // POST /api/tool-confirm/:requestId — confirm/deny tool
  app.post('/tool-confirm/:requestId', async (c) => {
    const { requestId } = c.req.param();
    const body = await c.req.json().catch(() => ({}));
    const approved = body.approved === true;
    const resolved = confirmations.resolve(requestId, approved);
    return c.json({ ok: resolved });
  });

  return app;
}
