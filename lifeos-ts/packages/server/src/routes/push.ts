import { Hono } from 'hono';
import type { WebPushService } from '../agentfleet/web-push-service.js';

export function pushRoutes(webPush: WebPushService) {
  const app = new Hono();

  // GET /api/push/vapid-public-key
  app.get('/push/vapid-public-key', (c) => {
    return c.json({ publicKey: webPush.getPublicKey() });
  });

  // POST /api/push/subscribe
  app.post('/push/subscribe', async (c) => {
    const sub = await c.req.json<Record<string, any>>();
    await webPush.addSubscription(sub);
    return c.json({ ok: true });
  });

  // POST /api/push/unsubscribe
  app.post('/push/unsubscribe', async (c) => {
    const body = await c.req.json<{ endpoint: string }>();
    await webPush.removeSubscription(body.endpoint);
    return c.json({ ok: true });
  });

  return app;
}
