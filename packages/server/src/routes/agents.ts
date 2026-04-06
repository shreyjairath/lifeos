import { Hono } from 'hono';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import type { AgentFleet } from '../agentfleet/agent-fleet.js';
import { getRecentRuns } from '../agent/agent-run-logs.js';
import { ScheduledTasks } from '../agentfleet/tools/scheduled-tasks.js';
import { MONOREPO_ROOT } from '../root.js';

const FEED_FILE = resolve(MONOREPO_ROOT, '.user-data', 'topics', 'feed.md');
const TASKS_FILE = resolve(MONOREPO_ROOT, '.user-data', 'tasks.json');

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
    if (eventType === 'check_email_trigger') {
      void fleet.triggerEmailCheck();
    } else {
      fleet.trigger(eventType, extra);
    }
    return c.json({ triggered: eventType });
  });

  // GET /api/agents/feed — inter-agent message feed
  app.get('/agents/feed', (c) => {
    if (!existsSync(FEED_FILE)) return c.json([]);
    try {
      const raw = readFileSync(FEED_FILE, 'utf-8');
      const entries = raw
        .split('\n---\n')
        .filter((e) => e.trim())
        .map(parseFeedEntry)
        .filter(Boolean)
        .reverse(); // newest first
      return c.json(entries);
    } catch {
      return c.json([]);
    }
  });

  return app;
}

function parseFeedEntry(entry: string): Record<string, any> | null {
  const lines = entry.trim().split('\n');
  const headerLine = lines[0]?.trim() ?? '';
  const m = headerLine.match(
    /^##\s+(\S+)\s+\|\s+from:\s+(\S+)\s+\|\s+to:\s+(.+?)\s+\|\s+thread:\s+(\S+)/,
  );
  if (!m) return null;
  const [, timestamp, from, toStr, threadId] = m as [string, string, string, string, string];
  const to = toStr === 'broadcast' ? [] : toStr.split(/\s+/).map((t) => t.replace(/^@/, ''));
  const content = lines.slice(2).join('\n').replace(/\n?---\s*$/, '').trim();
  return { timestamp, from, to, threadId, content };
}
