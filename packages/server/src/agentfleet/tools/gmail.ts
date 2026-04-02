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

  private withTimeout<T>(promise: Promise<T>, ms = 15_000): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`Gmail API timed out after ${ms}ms`)), ms),
      ),
    ]);
  }

  async send(to: string, subject: string, body?: string, threadId?: string, html?: string): Promise<void> {
    let mime: string;
    if (html) {
      mime = `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}`;
    } else {
      mime = `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body ?? ''}`;
    }

    const raw = Buffer.from(mime).toString('base64url');
    const params: any = { userId: 'me', requestBody: { raw } };
    if (threadId) params.requestBody.threadId = threadId;

    await this.withTimeout(this.gmail().users.messages.send(params));
  }

  async fetchRecent(query: string = 'in:inbox', maxResults: number = 10): Promise<EmailMessage[]> {
    const gm = this.gmail();
    const listRes = await this.withTimeout(gm.users.messages.list({
      userId: 'me',
      q: query,
      maxResults,
    }));

    const messages = listRes.data.messages ?? [];
    const results: EmailMessage[] = [];
    for (const m of messages) {
      if (!m.id) continue;
      const msg = await this.withTimeout(gm.users.messages.get({ userId: 'me', id: m.id, format: 'full' }));
      const parsed = parseMessage(msg.data);
      if (parsed) results.push(parsed);
    }
    return results;
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
