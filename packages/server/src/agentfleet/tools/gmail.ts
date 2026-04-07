import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import { google } from 'googleapis';
import * as cheerio from 'cheerio';
import { MONOREPO_ROOT } from '../../root.js';

const USER_DATA = resolve(MONOREPO_ROOT, '.user-data');
export const GMAIL_CREDENTIALS_PATH = resolve(USER_DATA, 'system/gmail-credentials.json');

const MAX_BODY_LEN = 10_000;

export interface RawThreadMessage {
  id: string;
  internalDate: number;
  rfcMessageId: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  body: string;
  /** All text extracted from every part (plain + HTML) — used for @mention routing scans */
  mentionText: string;
  labelIds: string[];
}

export interface RawThread {
  threadId: string;
  messages: RawThreadMessage[]; // oldest first
}

export interface ThreadMessage {
  from: string;
  date: string;
  body: string;
}

export interface EmailMessage {
  messageId: string;
  /** RFC 2822 Message-ID header — pass as in_reply_to when replying to keep thread intact */
  rfcMessageId: string;
  threadId: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  body: string;
  /** Prior messages in the thread, oldest first. Empty for new threads. */
  thread: ThreadMessage[];
}

interface GmailCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export class GmailClient {
  private readonly credentialsPath: string;
  private cachedEmail: string | null = null; // null = not yet fetched, '' = fetch failed

  constructor(credentialsPath: string = GMAIL_CREDENTIALS_PATH) {
    this.credentialsPath = credentialsPath;
  }

  private async getAccountEmail(): Promise<string | null> {
    if (this.cachedEmail !== null) return this.cachedEmail || null;
    try {
      const profile = await this.withTimeout(this.gmail().users.getProfile({ userId: 'me' }));
      this.cachedEmail = profile.data.emailAddress ?? '';
      console.log('[GmailClient] Sending as:', this.cachedEmail);
      return this.cachedEmail || null;
    } catch (err: any) {
      console.warn('[GmailClient] Could not fetch account email:', err?.message);
      this.cachedEmail = '';
      return null;
    }
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

  async send(
    to: string,
    subject: string,
    body?: string,
    threadId?: string,
    html?: string,
    inReplyTo?: string,
    fromName?: string,
    cc?: string,
    attachments?: { filename: string; mimeType: string; data: Buffer }[],
  ): Promise<void> {
    const accountEmail = fromName ? await this.getAccountEmail() : null;
    const fromHeader = fromName && accountEmail
      ? `From: ${fromName} <${accountEmail}>\r\n`
      : '';

    const encodedSubject = /[^\x00-\x7F]/.test(subject)
      ? `=?UTF-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`
      : subject;

    const rfcId = inReplyTo
      ? (inReplyTo.startsWith('<') ? inReplyTo : `<${inReplyTo}>`)
      : null;

    // Build full References chain for proper threading in recipient mailboxes.
    // References = parent's References + parent's Message-ID (RFC 2822).
    let references = rfcId;
    if (rfcId && threadId) {
      try {
        const threadRes = await this.withTimeout(
          this.gmail().users.threads.get({ userId: 'me', id: threadId, format: 'metadata', metadataHeaders: ['References', 'Message-ID'] }),
        );
        for (const msg of (threadRes.data.messages ?? []) as any[]) {
          const hdrs: Record<string, string> = {};
          for (const h of (msg.payload?.headers ?? []) as any[]) hdrs[(h.name as string).toLowerCase()] = h.value as string;
          if (hdrs['message-id'] === rfcId) {
            references = hdrs['references'] ? `${hdrs['references']} ${rfcId}` : rfcId;
            break;
          }
        }
      } catch { /* fall back to just inReplyTo */ }
    }

    const replyHeaders = rfcId
      ? `In-Reply-To: ${rfcId}\r\nReferences: ${references}\r\n`
      : '';
    const ccHeader = cc ? `CC: ${cc}\r\n` : '';

    let mime: string;
    if (attachments && attachments.length > 0) {
      const boundary = randomUUID().replace(/-/g, '');
      const bodyPart = html
        ? `--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}`
        : `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${normalizeTextBody(body ?? '')}`;
      const attachmentParts = attachments.map((a) =>
        `--${boundary}\r\nContent-Type: ${a.mimeType}\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="${a.filename}"\r\n\r\n${a.data.toString('base64')}`,
      );
      mime = `${fromHeader}To: ${to}\r\n${ccHeader}Subject: ${encodedSubject}\r\n${replyHeaders}MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n${bodyPart}\r\n${attachmentParts.join('\r\n')}\r\n--${boundary}--`;
    } else if (html) {
      mime = `${fromHeader}To: ${to}\r\n${ccHeader}Subject: ${encodedSubject}\r\n${replyHeaders}Content-Type: text/html; charset=utf-8\r\n\r\n${html}`;
    } else {
      mime = `${fromHeader}To: ${to}\r\n${ccHeader}Subject: ${encodedSubject}\r\n${replyHeaders}Content-Type: text/plain; charset=utf-8\r\n\r\n${normalizeTextBody(body ?? '')}`;
    }

    const raw = Buffer.from(mime).toString('base64url');
    const params: any = { userId: 'me', requestBody: { raw } };
    if (threadId) params.requestBody.threadId = threadId;

    const gm = this.gmail();
    const res = await this.withTimeout(gm.users.messages.send(params));
    // Add INBOX label so agent-sent threads are visible in the mailbox inbox
    if (res.data.id) {
      await this.withTimeout(gm.users.messages.modify({
        userId: 'me',
        id: res.data.id,
        requestBody: { addLabelIds: ['INBOX'] },
      })).catch(() => { /* best-effort */ });
    }
  }

  async markAsRead(messageIds: string[]): Promise<void> {
    const gm = this.gmail();
    await Promise.all(
      messageIds.map((id) =>
        this.withTimeout(
          gm.users.messages.modify({
            userId: 'me',
            id,
            requestBody: { removeLabelIds: ['UNREAD'] },
          }),
        ),
      ),
    );
  }

  async sendFile(to: string, subject: string, filePath: string, threadId?: string, inReplyTo?: string, fromName?: string, cc?: string): Promise<void> {
    const html = readFileSync(filePath, 'utf-8');
    await this.send(to, subject, undefined, threadId, html, inReplyTo, fromName, cc);
  }

  /** Returns the most recent sent message in the thread sent after `afterMs`, or null if none. */
  async getLatestSentMessage(threadId: string, afterMs: number): Promise<{ id: string; body: string } | null> {
    try {
      const threadRes = await this.withTimeout(this.gmail().users.threads.get({ userId: 'me', id: threadId, format: 'full' }));
      const msgs: any[] = threadRes.data.messages ?? [];
      // Find sent messages that arrived after the check started (internalDate is ms-since-epoch as string)
      const sent = msgs.filter((m: any) =>
        (m.labelIds ?? []).includes('SENT') && Number(m.internalDate ?? 0) >= afterMs,
      );
      if (!sent.length) return null;
      const last = sent[sent.length - 1];
      const body = parseThreadMessage(last)?.body ?? '';
      return { id: last.id as string, body };
    } catch {
      return null;
    }
  }

  async markAsUnreadInInbox(messageId: string): Promise<void> {
    await this.withTimeout(
      this.gmail().users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: { addLabelIds: ['INBOX', 'UNREAD'] },
      }),
    );
  }

  async fetchRecent(query: string = 'in:inbox', maxResults: number = 10): Promise<EmailMessage[]> {
    const gm = this.gmail();
    const listRes = await this.withTimeout(gm.users.messages.list({
      userId: 'me',
      q: query,
      maxResults,
    }));

    const messages = listRes.data.messages ?? [];
    console.log(`[Gmail] fetchRecent: ${messages.length} message(s) matched query "${query}"`);
    const results: EmailMessage[] = [];
    for (const m of messages) {
      if (!m.id) continue;
      try {
        const threadRes = await this.withTimeout(gm.users.threads.get({ userId: 'me', id: m.threadId!, format: 'full' }));
        const threadMsgs: any[] = threadRes.data.messages ?? [];
        const currentIdx = threadMsgs.findIndex((t: any) => t.id === m.id);
        const current = currentIdx >= 0 ? threadMsgs[currentIdx] : threadMsgs[threadMsgs.length - 1];
        const prior = threadMsgs.slice(0, currentIdx >= 0 ? currentIdx : threadMsgs.length - 1);
        const thread: ThreadMessage[] = prior.map((t: any) => parseThreadMessage(t)).filter(Boolean) as ThreadMessage[];
        const parsed = parseMessage(current, thread);
        if (parsed) results.push(parsed);
      } catch (err: any) {
        console.warn(`[Gmail] failed to fetch thread for message ${m.id}:`, err?.message);
      }
    }
    return results;
  }

  async fetchThread(threadId: string): Promise<EmailMessage | null> {
    const gm = this.gmail();
    try {
      const threadRes = await this.withTimeout(gm.users.threads.get({ userId: 'me', id: threadId, format: 'full' }));
      const threadMsgs: any[] = threadRes.data.messages ?? [];
      if (!threadMsgs.length) return null;
      const current = threadMsgs[threadMsgs.length - 1];
      const prior = threadMsgs.slice(0, threadMsgs.length - 1);
      const thread: ThreadMessage[] = prior.map((t: any) => parseThreadMessage(t)).filter(Boolean) as ThreadMessage[];
      return parseMessage(current, thread);
    } catch (err: any) {
      console.warn(`[Gmail] fetchThread failed for ${threadId}:`, err?.message);
      return null;
    }
  }

  /** Fetch all threads with recent inbox activity, returning raw message data for per-agent cursor comparison. */
  async fetchInboxThreads(query: string = 'in:inbox newer_than:3d'): Promise<RawThread[]> {
    const gm = this.gmail();
    const listRes = await this.withTimeout(gm.users.messages.list({ userId: 'me', q: query, maxResults: 20 }));
    const messages = listRes.data.messages ?? [];
    console.log(`[Gmail] fetchInboxThreads: ${messages.length} message(s) matched query "${query}"`);

    // Deduplicate by threadId — one fetch per thread
    const seenThreads = new Set<string>();
    const results: RawThread[] = [];
    for (const m of messages) {
      if (!m.threadId || seenThreads.has(m.threadId)) continue;
      seenThreads.add(m.threadId);
      try {
        const threadRes = await this.withTimeout(gm.users.threads.get({ userId: 'me', id: m.threadId, format: 'full' }));
        const threadMsgs: any[] = threadRes.data.messages ?? [];
        const rawMessages: RawThreadMessage[] = threadMsgs.map((msg: any) => {
          const headers: Record<string, string> = {};
          for (const h of msg.payload?.headers ?? []) {
            headers[(h.name as string).toLowerCase()] = decodeHeader(h.value as string);
          }
          return {
            id: msg.id as string,
            internalDate: Number(msg.internalDate ?? 0),
            rfcMessageId: headers['message-id'] ?? '',
            from: headers['from'] ?? '',
            to: headers['to'] ?? '',
            cc: headers['cc'] ?? '',
            subject: headers['subject'] ?? '(no subject)',
            body: extractBody(msg.payload, msg.payload?.mimeType),
            mentionText: extractAllText(msg.payload),
            labelIds: (msg.labelIds ?? []) as string[],
          };
        }).filter((msg) => msg.from);
        if (rawMessages.length > 0) {
          results.push({ threadId: m.threadId, messages: rawMessages });
        }
      } catch (err: any) {
        console.warn(`[Gmail] failed to fetch thread ${m.threadId}:`, err?.message);
      }
    }
    return results;
  }
}

/** Decode RFC 2047 encoded-words in email headers (e.g. =?UTF-8?B?...?= or =?UTF-8?Q?...?=) */
function decodeHeader(str: string): string {
  return str.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, encoding, text) => {
    try {
      const cs = (charset as string).toLowerCase().replace(/-/g, '');
      const enc = (encoding as string).toLowerCase();
      const buf = enc === 'b'
        ? Buffer.from(text as string, 'base64')
        : Buffer.from((text as string).replace(/_/g, ' '), 'binary');
      return buf.toString(cs === 'utf8' ? 'utf8' : 'latin1');
    } catch {
      return _;
    }
  });
}

function parseMessage(msg: any, thread: ThreadMessage[] = []): EmailMessage | null {
  const headers: Record<string, string> = {};
  for (const h of msg.payload?.headers ?? []) {
    headers[h.name.toLowerCase()] = decodeHeader(h.value as string);
  }

  const from = headers['from'] ?? '';
  const to = headers['to'] ?? '';
  const cc = headers['cc'] ?? '';
  const subject = headers['subject'] ?? '(no subject)';
  const rfcMessageId = headers['message-id'] ?? '';

  if (!from) return null;

  const body = extractBody(msg.payload);

  return {
    messageId: msg.id,
    rfcMessageId,
    threadId: msg.threadId,
    from,
    to,
    cc,
    subject,
    body: body.slice(0, MAX_BODY_LEN),
    thread,
  };
}

function parseThreadMessage(msg: any): ThreadMessage | null {
  const headers: Record<string, string> = {};
  for (const h of msg.payload?.headers ?? []) {
    headers[h.name.toLowerCase()] = decodeHeader(h.value as string);
  }
  const from = headers['from'] ?? '';
  const date = headers['date'] ?? '';
  if (!from) return null;
  const body = extractBody(msg.payload);
  return { from, date, body };
}

/**
 * Normalize a plain-text email body so soft-wrapped lines (single \n)
 * are joined into continuous paragraphs. Double newlines (paragraph breaks)
 * and list items are preserved.
 */
function normalizeTextBody(text: string): string {
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const paragraphs = text.split(/\n{2,}/);
  return paragraphs
    .map((para) => {
      const lines = para.split('\n');
      // Preserve list items, code-indented lines, or single-line paragraphs
      if (lines.length <= 1 || lines.some((l) => /^(\s{2,}|[-*•]|\d+[.)]\s)/.test(l))) {
        return para;
      }
      return lines.map((l) => l.trim()).filter(Boolean).join(' ');
    })
    .join('\n\n');
}

function htmlToText(html: string): string {
  const $ = cheerio.load(html);
  $('style, script, head').remove();

  // Replace <br> early so cell text is properly separated
  $('br').replaceWith(' ');

  // Headings → markdown
  $('h1, h2, h3, h4, h5, h6').each((_, el) => {
    const level = el.tagName.replace('h', '');
    const prefix = '#'.repeat(Number(level));
    $(el).replaceWith(`\n${prefix} ${$(el).text().trim()}\n`);
  });

  // Tables → pipe-delimited markdown
  $('table').each((_, table) => {
    const rows: string[][] = [];
    $(table).find('tr').each((_, tr) => {
      const cells: string[] = [];
      $(tr).find('td, th').each((_, cell) => {
        cells.push($(cell).text().replace(/\s+/g, ' ').trim());
      });
      if (cells.length) rows.push(cells);
    });
    if (rows.length) {
      const colCount = Math.max(...rows.map((r) => r.length));
      const header = rows[0]!;
      const separator = Array(colCount).fill('---');
      const body = rows.slice(1);
      const toRow = (cells: string[]) =>
        '| ' + cells.concat(Array(colCount - cells.length).fill('')).join(' | ') + ' |';
      const md = [toRow(header), toRow(separator), ...body.map(toRow)].join('\n');
      $(table).replaceWith(`\n${md}\n`);
    } else {
      $(table).remove();
    }
  });

  // List items → markdown bullets
  $('li').each((_, el) => {
    $(el).replaceWith(`\n- ${$(el).text().trim()}`);
  });

  // Block elements → newlines
  $('p, div, blockquote').each((_, el) => {
    $(el).append('\n');
  });

  return $.text().replace(/\n{3,}/g, '\n\n').trim();
}

/** Collect text from every part of a message payload (plain + HTML) for @mention scanning */
function extractAllText(payload: any): string {
  const parts: string[] = [];
  const collect = (p: any) => {
    if (!p) return;
    if (p.body?.data) {
      const raw = Buffer.from(p.body.data, 'base64').toString('utf-8').trim();
      parts.push(p.mimeType === 'text/html' ? htmlToText(raw) : raw);
    }
    for (const child of p.parts ?? []) collect(child);
  };
  collect(payload);
  return parts.join('\n');
}

function extractBody(payload: any, mimeType?: string): string {
  if (!payload) return '';

  // Direct body
  if (payload.body?.data) {
    const raw = Buffer.from(payload.body.data, 'base64').toString('utf-8').trim();
    return mimeType === 'text/html' ? htmlToText(raw) : raw;
  }

  // Multipart — prefer text/plain
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf-8').trim();
      }
    }
    // Fallback: use first part with data, converting HTML if needed
    for (const part of payload.parts) {
      const text = extractBody(part, part.mimeType);
      if (text) return text;
    }
  }

  return '';
}
