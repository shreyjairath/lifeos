import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { EventBus } from '../agentfleet/event-bus.js';

export function eventRoutes(eventBus: EventBus) {
  const app = new Hono();

  // GET /api/events — SSE event bus (live)
  app.get('/events', (c) => {
    return streamSSE(c, async (stream) => {
      const iterator = eventBus.subscribe();
      try {
        for await (const event of iterator) {
          try {
            await stream.writeSSE({ data: JSON.stringify(event) });
          } catch {
            break; // client disconnected
          }
        }
      } finally {
        await iterator.return?.();
      }
    });
  });

  // GET /api/events/history — snapshot of recent events
  app.get('/events/history', (c) => {
    return c.json(eventBus.getHistory());
  });

  return app;
}
