import { Hono } from 'hono';
import { resolve, normalize } from 'path';
import { existsSync, readdirSync, statSync, readFileSync } from 'fs';
import type { AgentFleet } from '../agentfleet/agent-fleet.js';

// Simple MIME type lookup for common artifact types
function mimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    html: 'text/html',
    htm: 'text/html',
    css: 'text/css',
    js: 'application/javascript',
    json: 'application/json',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
  };
  return map[ext] ?? 'application/octet-stream';
}

function walkDir(dir: string, base: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    const rel = full.slice(base.length + 1);
    if (statSync(full).isDirectory()) {
      results.push(...walkDir(full, base));
    } else {
      results.push(rel);
    }
  }
  return results;
}

export function artifactsRoutes(fleet: AgentFleet) {
  const agentsDir = fleet.getAgentsDir();
  const app = new Hono();

  // GET /api/artifacts/:agentName — list artifact files
  app.get('/artifacts/:agentName', (c) => {
    const { agentName } = c.req.param();
    const artifactsDir = normalize(resolve(agentsDir, agentName, 'workspace', '_artifacts'));

    if (!existsSync(artifactsDir) || !statSync(artifactsDir).isDirectory()) {
      return c.json([]);
    }
    try {
      const files = walkDir(artifactsDir, artifactsDir).sort();
      return c.json(files);
    } catch {
      return c.json({ error: 'Failed to list artifacts' }, 500);
    }
  });

  // GET /api/artifacts/:agentName/* — serve artifact file
  app.get('/artifacts/:agentName/*', (c) => {
    const { agentName } = c.req.param();
    const url = new URL(c.req.url);
    const prefix = `/api/artifacts/${agentName}/`;
    if (!url.pathname.startsWith(prefix)) {
      return c.json({ error: 'Bad request' }, 400);
    }
    const relativePath = decodeURIComponent(url.pathname.slice(prefix.length));

    const artifactsDir = normalize(resolve(agentsDir, agentName, 'workspace', '_artifacts'));
    const file = normalize(resolve(artifactsDir, relativePath));

    // Path traversal guard
    if (!file.startsWith(artifactsDir)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      return c.json({ error: 'Not found' }, 404);
    }

    const content = readFileSync(file);
    return new Response(content, {
      headers: { 'Content-Type': mimeType(file) },
    });
  });

  return app;
}
