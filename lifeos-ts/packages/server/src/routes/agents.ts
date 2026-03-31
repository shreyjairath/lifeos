import { Hono } from 'hono';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
import type { AgentFleet } from '../agentfleet/agent-fleet.js';
import { getRecentRuns } from '../agent/agent-run-logs.js';
import { ScheduledTasks } from '../agentfleet/tools/scheduled-tasks.js';

const CHANNELS_DIR = resolve(process.cwd(), '.user-data', 'inter-agent-channels');
const TASKS_FILE = resolve(process.cwd(), '.user-data', 'tasks.json');

export function agentRoutes(fleet: AgentFleet) {
  const app = new Hono();

  // GET /api/agents — list all agents
  app.get('/agents', (c) => {
    const agents = fleet.allAgents().map((a) => fleet.agentInfo(a.getName()));
    return c.json(agents);
  });

  // GET /api/agents/:name/definition
  app.get('/agents/:name/definition', (c) => {
    const { name } = c.req.param();
    return c.json(fleet.agentDefinitionText(name));
  });

  // GET /api/agents/:name/runs
  app.get('/agents/:name/runs', (c) => {
    const { name } = c.req.param();
    const limit = Math.min(Number(c.req.query('limit') ?? '20'), 100);
    return c.json(getRecentRuns(name, limit));
  });

  // GET /api/agents/tasks — all tasks
  app.get('/agents/tasks', (c) => {
    const tasks = new ScheduledTasks(TASKS_FILE);
    return c.json(tasks.list(null));
  });

  // GET /api/agents/:name/tasks
  app.get('/agents/:name/tasks', (c) => {
    const tasks = new ScheduledTasks(TASKS_FILE);
    return c.json(tasks.list(null));
  });

  // POST /api/agents/trigger/:eventType
  app.post('/agents/trigger/:eventType', async (c) => {
    const { eventType } = c.req.param();
    const extra = await c.req.json().catch(() => ({}));
    fleet.trigger(eventType, extra);
    return c.json({ triggered: eventType });
  });

  // GET /api/agents/channels — list inter-agent channels
  app.get('/agents/channels', (c) => {
    if (!existsSync(CHANNELS_DIR)) return c.json([]);
    try {
      const files = readdirSync(CHANNELS_DIR)
        .filter((f) => f.endsWith('.md'))
        .sort();
      const channels = files.map((f) => {
        const pair = f.replace('.md', '');
        const agents = pair.split('-', 2);
        return { pair, agents };
      });
      return c.json(channels);
    } catch {
      return c.json([]);
    }
  });

  // GET /api/agents/channels/:pair
  app.get('/agents/channels/:pair', (c) => {
    const { pair } = c.req.param();
    const file = resolve(CHANNELS_DIR, `${pair}.md`);
    if (!existsSync(file)) return c.json({ error: 'Not found' }, 404);
    try {
      return c.json({ pair, content: readFileSync(file, 'utf-8') });
    } catch {
      return c.json({ error: 'Failed to read channel' }, 500);
    }
  });

  return app;
}
