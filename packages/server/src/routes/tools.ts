import { Hono } from 'hono';
import type { AgentFleet } from '../agentfleet/agent-fleet.js';

export function toolsRoutes(fleet: AgentFleet) {
  const app = new Hono();

  // GET /api/tools — list all tool names + disabled set
  app.get('/tools', (c) => {
    return c.json(fleet.getAllToolsInfo());
  });

  // PUT /api/tools/disabled — update disabled list
  app.put('/tools/disabled', async (c) => {
    const body = await c.req.json<{ disabled?: string[] }>();
    const names = body.disabled ?? [];
    fleet.setDisabledTools(names);
    return c.json({ disabled: names });
  });

  return app;
}
