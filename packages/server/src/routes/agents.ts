import { Hono } from 'hono';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { resolve, basename } from 'path';
import type { AgentFleet } from '../agentfleet/agent-fleet.js';
import { getRecentRuns } from '../agent/agent-run-logs.js';
import { ScheduledTasks } from '../agentfleet/tools/scheduled-tasks.js';
import { MONOREPO_ROOT } from '../root.js';

const TOPICS_DIR = resolve(MONOREPO_ROOT, '.user-data', 'topics');
const FEED_FILE = resolve(TOPICS_DIR, 'feed.md');
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

  // GET /api/agents/feed — inter-agent message feed (legacy, kept for compat)
  app.get('/agents/feed', (c) => {
    if (!existsSync(FEED_FILE)) return c.json([]);
    try {
      const raw = readFileSync(FEED_FILE, 'utf-8');
      const entries = raw
        .split('\n---\n')
        .filter((e) => e.trim())
        .map(parseFeedEntry)
        .filter(Boolean)
        .reverse();
      return c.json(entries);
    } catch {
      return c.json([]);
    }
  });

  // GET /api/agents/topics — list all topic names with metadata
  app.get('/agents/topics', (c) => {
    if (!existsSync(TOPICS_DIR)) return c.json([]);
    try {
      const files = readdirSync(TOPICS_DIR)
        .filter((f) => f.endsWith('.md') && !f.startsWith('.'));
      const topics = files.map((f) => {
        const name = basename(f, '.md');
        const file = resolve(TOPICS_DIR, f);
        try {
          const raw = readFileSync(file, 'utf-8');
          const entries = parseTopicEntries(raw);
          const last = entries[entries.length - 1];
          return { name, count: entries.length, lastActivity: last?.timestamp ?? null };
        } catch {
          return { name, count: 0, lastActivity: null };
        }
      });
      // Sort: feed first, then alphabetical
      topics.sort((a, b) => {
        if (a.name === 'feed') return -1;
        if (b.name === 'feed') return 1;
        return a.name.localeCompare(b.name);
      });
      return c.json(topics);
    } catch {
      return c.json([]);
    }
  });

  // GET /api/agents/topics/:name — entries for a topic
  app.get('/agents/topics/:name', (c) => {
    const { name } = c.req.param();
    if (!/^[a-z0-9_-]+$/.test(name)) return c.json({ error: 'Invalid topic name' }, 400);
    const file = resolve(TOPICS_DIR, `${name}.md`);
    if (!existsSync(file)) return c.json([]);
    try {
      const raw = readFileSync(file, 'utf-8');
      const entries = parseTopicEntries(raw).reverse(); // newest first
      return c.json(entries);
    } catch {
      return c.json([]);
    }
  });

  return app;
}

function parseFeedEntry(entry: string): Record<string, any> | null {
  return parseTopicEntry(entry);
}

// Parses both header formats:
//   ## TIMESTAMP | from: AGENT | to: @AGENTS | thread: ID
//   ## TIMESTAMP | AGENT
function parseTopicEntry(entry: string): Record<string, any> | null {
  const lines = entry.trim().split('\n');
  const headerLine = lines[0]?.trim() ?? '';
  const content = lines.slice(2).join('\n').replace(/\n?---\s*$/, '').trim();

  // Full format (inter-agent feed)
  const full = headerLine.match(
    /^##\s+(\S+)\s+\|\s+from:\s+(\S+)\s+\|\s+to:\s+(.+?)\s+\|\s+thread:\s+(\S+)/,
  );
  if (full) {
    const [, timestamp, from, toStr, threadId] = full as [string, string, string, string, string];
    const to = toStr === 'broadcast' ? [] : toStr.split(/\s+/).map((t) => t.replace(/^@/, ''));
    return { timestamp, from, to, threadId, content };
  }

  // Simple format (logs, system_feedback, etc.)
  const simple = headerLine.match(/^##\s+(\S+)\s+\|\s+(\S+)/);
  if (simple) {
    const [, timestamp, from] = simple as [string, string, string];
    return { timestamp, from, to: [], threadId: null, content };
  }

  return null;
}

function parseTopicEntries(raw: string): Record<string, any>[] {
  return raw
    .split('\n---\n')
    .filter((e) => e.trim())
    .map(parseTopicEntry)
    .filter(Boolean) as Record<string, any>[];
}
