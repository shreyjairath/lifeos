import { Hono } from 'hono';
import type { AgentFleet } from '../agentfleet/agent-fleet.js';
import type { GmailClient } from '../agentfleet/tools/gmail.js';

export function gmailWebhookRoutes(
  fleet: AgentFleet,
  gmail: GmailClient,
  webhookSecret: string,
  pubsubTopic: string,
) {
  const app = new Hono();

  // POST /api/webhook/gmail — receives Pub/Sub push notifications from Gmail
  app.post('/webhook/gmail', async (c) => {
    if (c.req.header('x-webhook-secret') !== webhookSecret) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    let historyId: string | undefined;
    try {
      const body = await c.req.json();
      const data = JSON.parse(Buffer.from(body.message?.data ?? '', 'base64').toString('utf-8'));
      historyId = data.historyId?.toString();
    } catch {
      return c.json({ error: 'Invalid payload' }, 400);
    }

    if (!historyId) return c.json({ ok: true });

    try {
      const emails = await gmail.fetchNewMessages(historyId);
      for (const email of emails) {
        fleet.trigger('new_email', {
          from: email.from,
          subject: email.subject,
          body: email.body,
          messageId: email.messageId,
          threadId: email.threadId,
        });
        console.log(`[gmail] new email from ${email.from}: ${email.subject}`);
      }
    } catch (err: any) {
      console.error('[gmail] webhook processing error:', err?.message);
    }

    return c.json({ ok: true });
  });

  // POST /api/webhook/gmail/watch — re-register Gmail push notifications
  app.post('/webhook/gmail/watch', async (c) => {
    try {
      await gmail.watch(pubsubTopic);
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ error: err?.message ?? 'watch failed' }, 500);
    }
  });

  return app;
}
