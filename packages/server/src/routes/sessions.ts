import { Hono } from 'hono';
import type { AgentFleet } from '../agentfleet/agent-fleet.js';

export function sessionRoutes(fleet: AgentFleet) {
  const app = new Hono();

  // GET /api/sessions — list all sessions
  app.get('/sessions', (c) => {
    return c.json({ sessions: fleet.listAllSessions() });
  });

  // GET /api/sessions/:agentName — list sessions for one agent
  app.get('/sessions/:agentName', (c) => {
    const { agentName } = c.req.param();
    return c.json({ sessions: fleet.listSessions(agentName) });
  });

  // POST /api/sessions — create session
  app.post('/sessions', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const agentName = body.agent;
    if (!agentName) return c.json({ error: 'agent is required' }, 400);
    const sessionId = fleet.createSession(agentName);
    return c.json({ session_id: sessionId });
  });

  // DELETE /api/sessions/:agentName/:sessionId
  app.delete('/sessions/:agentName/:sessionId', (c) => {
    const { agentName, sessionId } = c.req.param();
    fleet.deleteSession(agentName, sessionId);
    return c.json({ deleted: sessionId });
  });

  // POST /api/sessions/prune
  app.post('/sessions/prune', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const agentName = body.agent;
    if (agentName) {
      fleet.pruneSessions(agentName);
    } else {
      for (const agent of fleet.allAgents()) {
        fleet.pruneSessions(agent.getName());
      }
    }
    return c.json({ status: 'ok' });
  });

  return app;
}
