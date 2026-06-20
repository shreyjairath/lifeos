import { Hono } from 'hono';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { resolve } from 'path';

function makeId(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function idToIso(id: string): string {
  const m = id.match(/^(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/);
  if (!m) return id;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
}

function entryTitle(content: string, id: string): string {
  const first = content.split('\n').find(l => l.trim());
  if (!first) return idToIso(id).slice(0, 10);
  if (first.startsWith('# ')) return first.slice(2).trim();
  return first.length > 60 ? first.slice(0, 57) + '...' : first;
}

function entryPreview(content: string): string {
  const lines = content.split('\n').filter(l => l.trim() && !l.startsWith('#'));
  const text = lines.join(' ').trim();
  return text.length > 120 ? text.slice(0, 117) + '...' : text;
}

export function journalRoutes(dataDir: string) {
  const dir = resolve(dataDir, 'journal');
  mkdirSync(dir, { recursive: true });

  const app = new Hono();

  // GET /api/journal — list entries, most recent first
  app.get('/journal', (c) => {
    const files = readdirSync(dir)
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse();

    return c.json(files.map(f => {
      const id = f.slice(0, -3);
      const content = readFileSync(resolve(dir, f), 'utf-8');
      return { id, title: entryTitle(content, id), date: idToIso(id), preview: entryPreview(content) };
    }));
  });

  // POST /api/journal — create entry
  app.post('/journal', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const content = (body.content as string | undefined) ?? '';
    const id = makeId();
    writeFileSync(resolve(dir, `${id}.md`), content, 'utf-8');
    return c.json({ id, title: entryTitle(content, id), date: idToIso(id) }, 201);
  });

  // GET /api/journal/:id — read full entry
  app.get('/journal/:id', (c) => {
    const { id } = c.req.param();
    if (!/^[\w-]+$/.test(id)) return c.json({ error: 'Invalid id' }, 400);
    const file = resolve(dir, `${id}.md`);
    if (!existsSync(file)) return c.json({ error: 'Not found' }, 404);
    const content = readFileSync(file, 'utf-8');
    return c.json({ id, title: entryTitle(content, id), date: idToIso(id), content });
  });

  // PUT /api/journal/:id — update entry
  app.put('/journal/:id', async (c) => {
    const { id } = c.req.param();
    if (!/^[\w-]+$/.test(id)) return c.json({ error: 'Invalid id' }, 400);
    const file = resolve(dir, `${id}.md`);
    if (!existsSync(file)) return c.json({ error: 'Not found' }, 404);
    const body = await c.req.json().catch(() => ({}));
    const content = (body.content as string | undefined) ?? '';
    writeFileSync(file, content, 'utf-8');
    return c.json({ id, title: entryTitle(content, id), date: idToIso(id) });
  });

  // DELETE /api/journal/:id
  app.delete('/journal/:id', (c) => {
    const { id } = c.req.param();
    if (!/^[\w-]+$/.test(id)) return c.json({ error: 'Invalid id' }, 400);
    const file = resolve(dir, `${id}.md`);
    if (!existsSync(file)) return c.json({ error: 'Not found' }, 404);
    unlinkSync(file);
    return c.json({ deleted: id });
  });

  return app;
}
