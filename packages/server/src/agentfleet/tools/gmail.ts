import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { google } from 'googleapis';
import { MONOREPO_ROOT } from '../../root.js';

const USER_DATA = resolve(MONOREPO_ROOT, '.user-data');
export const GMAIL_CREDENTIALS_PATH = resolve(USER_DATA, 'system/gmail-credentials.json');

const MAX_BODY_LEN = 10_000;

export interface EmailMessage {
  messageId: string;
  threadId: string;
  from: string;
  subject: string;
  body: string;
}

interface GmailCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export class GmailClient {
  private readonly credentialsPath: string;
  private lastHistoryId: string | null = null;

  constructor(credentialsPath: string = GMAIL_CREDENTIALS_PATH) {
    this.credentialsPath = credentialsPath;
  }

  isConfigured(): boolean {
    return existsSync(this.credentialsPath);
  }

  private buildAuth() {
    const creds: GmailCredentials = JSON.parse(readFileSync(this.credentialsPath, 'utf-8'));
    const auth = new google.auth.OAuth2(creds.clientId, creds.clientSecret);
    auth.setCredentials({ refresh_token: creds.refreshToken });
    return auth;
  }

  private gmail() {
    return google.gmail({ version: 'v1', auth: this.buildAuth() });
  }

  async send(to: string, subject: string, body: string, threadId?: string): Promise<void> {
    const raw = Buffer.from(
      `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`,
    ).toString('base64url');

    const params: any = { userId: 'me', requestBody: { raw } };
    if (threadId) params.requestBody.threadId = threadId;

    await this.gmail().users.messages.send(params);
  }

  async fetchNewMessages(historyId: string): Promise<EmailMessage[]> {
    const gm = this.gmail();

    if (!this.lastHistoryId) {
      // First call — just store the historyId, no messages to return
      this.lastHistoryId = historyId;
      return [];
    }

    const histRes = await gm.users.history.list({
      userId: 'me',
      startHistoryId: this.lastHistoryId,
      historyTypes: ['messageAdded'],
      labelId: 'INBOX',
    });

    this.lastHistoryId = historyId;

    const history = histRes.data.history ?? [];
    const messageIds = new Set<string>();
    for (const h of history) {
      for (const m of h.messagesAdded ?? []) {
        if (m.message?.id) messageIds.add(m.message.id);
      }
    }

    const results: EmailMessage[] = [];
    for (const id of messageIds) {
      const msg = await gm.users.messages.get({ userId: 'me', id, format: 'full' });
      const parsed = parseMessage(msg.data);
      if (parsed) results.push(parsed);
    }
    return results;
  }

  async watch(topicName: string): Promise<void> {
    await this.gmail().users.watch({
      userId: 'me',
      requestBody: { topicName, labelIds: ['INBOX'] },
    });
    console.log('[GmailClient] watch registered for topic:', topicName);
  }
}

function parseMessage(msg: any): EmailMessage | null {
  const headers: Record<string, string> = {};
  for (const h of msg.payload?.headers ?? []) {
    headers[h.name.toLowerCase()] = h.value;
  }

  const from = headers['from'] ?? '';
  const subject = headers['subject'] ?? '(no subject)';

  // Skip sent mail (has no From or is from ourselves)
  if (!from) return null;

  const body = extractBody(msg.payload);

  return {
    messageId: msg.id,
    threadId: msg.threadId,
    from,
    subject,
    body: body.slice(0, MAX_BODY_LEN),
  };
}

function extractBody(payload: any): string {
  if (!payload) return '';

  // Direct body
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8').trim();
  }

  // Multipart — prefer text/plain
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf-8').trim();
      }
    }
    // Fallback to first part with data
    for (const part of payload.parts) {
      const text = extractBody(part);
      if (text) return text;
    }
  }

  return '';
}
