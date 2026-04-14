import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import { google } from 'googleapis';
import * as cheerio from 'cheerio';
import { marked } from 'marked';
import { PDFParse } from 'pdf-parse';
import { MONOREPO_ROOT } from '../../root.js';

/** Returns true if the string contains HTML tags (agent passed proper HTML). */
function looksLikeHtml(s: string): boolean {
  return /<[a-z][\s\S]*>/i.test(s);
}

/** Convert markdown to a basic HTML email body. Passes through existing HTML unchanged. */
function markdownToEmailHtml(md: string): string {
  if (looksLikeHtml(md)) return md;
  const body = marked.parse(md, { async: false }) as string;
  return `<div style="font-family:sans-serif;font-size:15px;line-height:1.6;color:#222;max-width:680px">${body}</div>`;
}

const USER_DATA = resolve(MONOREPO_ROOT, '.user-data');
export const GMAIL_CREDENTIALS_PATH = resolve(USER_DATA, 'system/gmail-credentials.json');

const MAX_BODY_LEN = 10_000;

const DATE_FMT = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit',
});

export interface EmailThreadMeta {
  threadId: string;
  subject: string;
  from: string;
  date: string;
  messageCount: number;
}

export interface RawThreadMessage {
  id: string;
  internalDate: number;
  rfcMessageId: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  body: string;
  /** Raw Gmail message payload — used post-routing to download attachments into agent workspace */
  payload: any;
  /** All text extracted from every part (plain + HTML) — used for @mention routing scans */
  mentionText: string;
  labelIds: string[];
}

export interface RawThread {
  threadId: string;
  messages: RawThreadMessage[]; // oldest first
}

export interface ThreadMessage {
  messageId: string;
  from: string;
  date: string;
  body: string;
  attachments?: EmailAttachment[];
}

export interface EmailAttachment {
  filename: string;
  mimeType: string;
  attachmentId: string;
  size: number;
}

export interface NormalizedMessage {
  message_id: string;
  rfc_message_id: string;
  thread_id?: string;
  from: string;
  to: string;
  cc: string;
  date: string;
  body: string;
  sent_by?: string; // agent name if sent by an agent via the shared mailbox
  attachments?: EmailAttachment[];
}

export interface EmailThreadFull {
  thread_id: string;
  subject: string;
  messages: NormalizedMessage[]; // sorted oldest-first by internalDate
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
  /** Attachments on this message, if any. Use fetch_email_attachment to download. */
  attachments?: EmailAttachment[];
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
    fromEmail?: string,
  ): Promise<{ threadId: string; messageId: string }> {
    const effectiveFromEmail = fromEmail ?? (fromName ? await this.getAccountEmail() : null);
    const fromHeader = fromName && effectiveFromEmail
      ? `From: ${fromName} <${effectiveFromEmail}>\r\n`
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

    // Normalize html: convert markdown → HTML if the agent passed markdown instead of HTML tags.
    const htmlBody = html ? markdownToEmailHtml(html) : undefined;
    // If body (plain text) looks like markdown, upgrade to HTML to avoid raw syntax in email.
    const bodyIsMarkdown = body && !looksLikeHtml(body) && /[*_#`\[\]]/.test(body);
    const effectiveHtml = htmlBody ?? (bodyIsMarkdown ? markdownToEmailHtml(body!) : undefined);
    const effectivePlain = effectiveHtml ? undefined : body;

    let mime: string;
    if (attachments && attachments.length > 0) {
      const boundary = randomUUID().replace(/-/g, '');
      const bodyPart = effectiveHtml
        ? `--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${effectiveHtml}`
        : `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${normalizeTextBody(effectivePlain ?? '')}`;
      const attachmentParts = attachments.map((a) =>
        `--${boundary}\r\nContent-Type: ${a.mimeType}\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="${a.filename}"\r\n\r\n${a.data.toString('base64')}`,
      );
      mime = `${fromHeader}To: ${to}\r\n${ccHeader}Subject: ${encodedSubject}\r\n${replyHeaders}MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n${bodyPart}\r\n${attachmentParts.join('\r\n')}\r\n--${boundary}--`;
    } else if (effectiveHtml) {
      mime = `${fromHeader}To: ${to}\r\n${ccHeader}Subject: ${encodedSubject}\r\n${replyHeaders}Content-Type: text/html; charset=utf-8\r\n\r\n${effectiveHtml}`;
    } else {
      mime = `${fromHeader}To: ${to}\r\n${ccHeader}Subject: ${encodedSubject}\r\n${replyHeaders}Content-Type: text/plain; charset=utf-8\r\n\r\n${normalizeTextBody(effectivePlain ?? '')}`;
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
    return { threadId: res.data.threadId ?? '', messageId: res.data.id ?? '' };
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

  async sendFile(to: string, subject: string, filePath: string, threadId?: string, inReplyTo?: string, fromName?: string, cc?: string, fromEmail?: string): Promise<{ threadId: string; messageId: string }> {
    const html = readFileSync(filePath, 'utf-8');
    return this.send(to, subject, undefined, threadId, html, inReplyTo, fromName, cc, undefined, fromEmail);
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

  /** Download a single attachment by ID and save it to {downloadDir}/_downloads/{filename}. Returns the saved path. */
  async fetchAttachment(messageId: string, attachmentId: string, filename: string, downloadDir: string): Promise<string> {
    const gm = this.gmail();
    const res = await this.withTimeout(
      gm.users.messages.attachments.get({ userId: 'me', messageId, id: attachmentId }),
    );
    const data = Buffer.from(res.data.data ?? '', 'base64url');
    const destDir = resolve(downloadDir, '_downloads');
    mkdirSync(destDir, { recursive: true });
    const dest = resolve(destDir, filename);
    writeFileSync(dest, data);
    console.log(`[Gmail] fetchAttachment: saved "${filename}" (${data.length} bytes) → ${dest}`);

    if (filename.toLowerCase().endsWith('.pdf')) {
      try {
        const parser = new PDFParse({ data });
        const parsed = await parser.getText();
        const txtFilename = filename.replace(/\.pdf$/i, '.txt');
        writeFileSync(resolve(destDir, txtFilename), parsed.text, 'utf-8');
        console.log(`[Gmail] fetchAttachment: extracted PDF text → "${txtFilename}" (${parsed.text.length} chars)`);
        return `_downloads/${txtFilename}`;
      } catch (err: any) {
        console.warn(`[Gmail] fetchAttachment: PDF extraction failed for "${filename}":`, err?.message);
      }
    }
    return `_downloads/${filename}`;
  }

  /** Download text/* attachments to {downloadDir}/_downloads/ and append filename references to the body. */
  async downloadTextAttachments(messageId: string, payload: any, body: string, downloadDir: string): Promise<string> {
    const attachments = extractTextAttachmentParts(payload);
    if (!attachments.length) return body;
    const gm = this.gmail();
    const destDir = resolve(downloadDir, '_downloads');
    mkdirSync(destDir, { recursive: true });
    const refs: string[] = [];
    for (const att of attachments) {
      try {
        const res = await this.withTimeout(
          gm.users.messages.attachments.get({ userId: 'me', messageId, id: att.attachmentId }),
        );
        const data = Buffer.from(res.data.data ?? '', 'base64url');
        const dest = resolve(destDir, att.filename);
        writeFileSync(dest, data);
        console.log(`[Gmail] saved attachment "${att.filename}" (${data.length} bytes) → ${dest}`);
        if (att.filename.toLowerCase().endsWith('.pdf')) {
          try {
            const parser = new PDFParse({ data });
            const parsed = await parser.getText();
            const txtFilename = att.filename.replace(/\.pdf$/i, '.txt');
            writeFileSync(resolve(destDir, txtFilename), parsed.text, 'utf-8');
            console.log(`[Gmail] extracted PDF text "${txtFilename}" (${parsed.text.length} chars)`);
            refs.push(`_downloads/${txtFilename}`);
          } catch (pdfErr: any) {
            console.warn(`[Gmail] PDF text extraction failed for "${att.filename}":`, pdfErr?.message);
            refs.push(`_downloads/${att.filename}`);
          }
        } else {
          refs.push(`_downloads/${att.filename}`);
        }
      } catch (err: any) {
        console.warn(`[Gmail] failed to download attachment "${att.filename}":`, err?.message);
      }
    }
    if (!refs.length) return body;
    return body + `\n\n[Attachments saved to workspace: ${refs.join(', ')}]`;
  }

  async fetchRecent(query: string = 'in:inbox', maxResults: number = 10, downloadDir?: string): Promise<EmailMessage[]> {
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
        if (parsed) {
          if (downloadDir) parsed.body = await this.downloadTextAttachments(current.id as string, current.payload, parsed.body, downloadDir);
          results.push(parsed);
        }
      } catch (err: any) {
        console.warn(`[Gmail] failed to fetch thread for message ${m.id}:`, err?.message);
      }
    }
    return results;
  }

  async fetchThread(threadId: string, downloadDir?: string): Promise<EmailMessage | null> {
    const gm = this.gmail();
    try {
      const threadRes = await this.withTimeout(gm.users.threads.get({ userId: 'me', id: threadId, format: 'full' }));
      const threadMsgs: any[] = threadRes.data.messages ?? [];
      if (!threadMsgs.length) return null;
      const current = threadMsgs[threadMsgs.length - 1];
      const prior = threadMsgs.slice(0, threadMsgs.length - 1);
      const thread: ThreadMessage[] = prior.map((t: any) => parseThreadMessage(t)).filter(Boolean) as ThreadMessage[];
      const result = parseMessage(current, thread);
      if (result && downloadDir) result.body = await this.downloadTextAttachments(current.id as string, current.payload, result.body, downloadDir);
      return result;
    } catch (err: any) {
      console.warn(`[Gmail] fetchThread failed for ${threadId}:`, err?.message);
      return null;
    }
  }

  /** Fetch a single message by ID with no body truncation — used by read_email_message. */
  async fetchMessage(messageId: string): Promise<NormalizedMessage | null> {
    const gm = this.gmail();
    try {
      const res = await this.withTimeout(gm.users.messages.get({ userId: 'me', id: messageId, format: 'full' }));
      const msg = res.data;
      const headers: Record<string, string> = {};
      for (const h of msg.payload?.headers ?? []) {
        headers[(h.name as string).toLowerCase()] = decodeHeader(h.value as string);
      }
      if (!headers['from']) return null;
      const body = extractBody(msg.payload as any, (msg.payload as any)?.mimeType);
      const attachments = extractAllAttachmentParts(msg.payload as any);
      return {
        message_id: msg.id ?? messageId,
        rfc_message_id: headers['message-id'] ?? '',
        thread_id: msg.threadId ?? '',
        from: headers['from'],
        to: headers['to'] ?? '',
        cc: headers['cc'] ?? '',
        date: headers['date'] ? DATE_FMT.format(new Date(headers['date'])) : 'unknown',
        body,
        ...(attachments.length > 0 ? { attachments } : {}),
      };
    } catch (err: any) {
      console.warn(`[Gmail] fetchMessage failed for ${messageId}:`, err?.message);
      return null;
    }
  }

  /** Fetch a full thread as a flat sorted list of normalized messages — used by read_email_thread. */
  async fetchThreadFull(threadId: string, downloadDir?: string): Promise<EmailThreadFull | null> {
    const gm = this.gmail();
    try {
      const threadRes = await this.withTimeout(gm.users.threads.get({ userId: 'me', id: threadId, format: 'full' }));
      const threadMsgs: any[] = threadRes.data.messages ?? [];
      if (!threadMsgs.length) return null;

      // Extract subject from first message headers
      const firstHeaders: Record<string, string> = {};
      for (const h of threadMsgs[0]?.payload?.headers ?? []) {
        firstHeaders[(h.name as string).toLowerCase()] = decodeHeader(h.value as string);
      }
      const subject = firstHeaders['subject'] ?? '(no subject)';

      const messages: { msg: NormalizedMessage; internalDate: number }[] = [];
      for (const msg of threadMsgs) {
        const headers: Record<string, string> = {};
        for (const h of msg.payload?.headers ?? []) {
          headers[(h.name as string).toLowerCase()] = decodeHeader(h.value as string);
        }
        if (!headers['from']) continue;
        const rawBody = extractBody(msg.payload, msg.payload?.mimeType);
        const wasTruncated = rawBody.length > MAX_BODY_LEN;
        let body = wasTruncated ? rawBody.slice(0, MAX_BODY_LEN) : rawBody;
        if (downloadDir) body = await this.downloadTextAttachments(msg.id as string, msg.payload, body, downloadDir);
        const messageId = msg.id as string;
        if (wasTruncated) body += `\n[...truncated at ${MAX_BODY_LEN} chars — call read_email_message with message_id "${messageId}" for full content]`;
        const attachments = extractAllAttachmentParts(msg.payload);
        messages.push({
          internalDate: Number(msg.internalDate ?? 0),
          msg: {
            message_id: messageId,
            rfc_message_id: headers['message-id'] ?? '',
            from: headers['from'],
            to: headers['to'] ?? '',
            cc: headers['cc'] ?? '',
            date: headers['date'] ? DATE_FMT.format(new Date(headers['date'])) : 'unknown',
            body,
            ...(attachments.length > 0 ? { attachments } : {}),
          },
        });
      }

      // Sort oldest-first by internalDate
      messages.sort((a, b) => a.internalDate - b.internalDate);
      const sorted = messages.map((m) => m.msg);

      return { thread_id: threadId, subject, messages: sorted };
    } catch (err: any) {
      console.warn(`[Gmail] fetchThreadFull failed for ${threadId}:`, err?.message);
      return null;
    }
  }

  /** Fetch thread metadata (no body) for a query — used by read_emails to return a lightweight thread list. */
  async fetchThreadsMeta(query: string, maxResults: number = 10): Promise<EmailThreadMeta[]> {
    const gm = this.gmail();
    const listRes = await this.withTimeout(gm.users.messages.list({ userId: 'me', q: query, maxResults }));
    const messages = listRes.data.messages ?? [];
    console.log(`[Gmail] fetchThreadsMeta: ${messages.length} message(s) matched query "${query}"`);

    const seenThreads = new Set<string>();
    const results: EmailThreadMeta[] = [];
    for (const m of messages) {
      if (!m.threadId || seenThreads.has(m.threadId)) continue;
      seenThreads.add(m.threadId);
      try {
        const threadRes = await this.withTimeout(
          gm.users.threads.get({ userId: 'me', id: m.threadId, format: 'metadata', metadataHeaders: ['From', 'Subject', 'Date'] }),
        );
        const threadMsgs: any[] = threadRes.data.messages ?? [];
        if (!threadMsgs.length) continue;
        const latest = threadMsgs[threadMsgs.length - 1];
        const headers: Record<string, string> = {};
        for (const h of latest.payload?.headers ?? []) {
          headers[(h.name as string).toLowerCase()] = decodeHeader(h.value as string);
        }
        results.push({
          threadId: m.threadId,
          subject: headers['subject'] ?? '(no subject)',
          from: headers['from'] ?? '',
          date: headers['date'] ? DATE_FMT.format(new Date(headers['date'])) : 'unknown',
          messageCount: threadMsgs.length,
        });
      } catch (err: any) {
        console.warn(`[Gmail] fetchThreadsMeta failed for thread ${m.threadId}:`, err?.message);
      }
    }
    return results;
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
        const rawMessages: RawThreadMessage[] = [];
        for (const msg of threadMsgs) {
          const headers: Record<string, string> = {};
          for (const h of msg.payload?.headers ?? []) {
            headers[(h.name as string).toLowerCase()] = decodeHeader(h.value as string);
          }
          if (!headers['from']) continue;
          rawMessages.push({
            id: msg.id as string,
            internalDate: Number(msg.internalDate ?? 0),
            rfcMessageId: headers['message-id'] ?? '',
            from: headers['from'],
            to: headers['to'] ?? '',
            cc: headers['cc'] ?? '',
            subject: headers['subject'] ?? '(no subject)',
            body: extractBody(msg.payload, msg.payload?.mimeType),
            payload: msg.payload,
            mentionText: extractAllText(msg.payload),
            labelIds: (msg.labelIds ?? []) as string[],
          });
        }
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
  const attachments = extractAllAttachmentParts(msg.payload);

  return {
    messageId: msg.id,
    rfcMessageId,
    threadId: msg.threadId,
    from,
    to,
    cc,
    subject,
    body: body.slice(0, MAX_BODY_LEN),
    ...(attachments.length > 0 ? { attachments } : {}),
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
  const attachments = extractAllAttachmentParts(msg.payload);
  return {
    messageId: msg.id as string,
    from,
    date,
    body,
    ...(attachments.length > 0 ? { attachments } : {}),
  };
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

/** Find all attachment parts in a message payload (any MIME type with an attachmentId). */
function extractAllAttachmentParts(payload: any): EmailAttachment[] {
  const result: EmailAttachment[] = [];
  const scan = (p: any) => {
    if (!p) return;
    if (p.body?.attachmentId && p.filename) {
      result.push({
        filename: p.filename as string,
        mimeType: (p.mimeType as string | undefined) ?? 'application/octet-stream',
        attachmentId: p.body.attachmentId as string,
        size: (p.body.size as number | undefined) ?? 0,
      });
    }
    for (const child of p.parts ?? []) scan(child);
  };
  scan(payload);
  return result;
}

/** Find text/* attachment parts (those with an attachmentId rather than inline data). */
function extractTextAttachmentParts(payload: any): { filename: string; attachmentId: string }[] {
  const result: { filename: string; attachmentId: string }[] = [];
  const scan = (p: any) => {
    if (!p) return;
    const mime = p.mimeType as string | undefined;
    if (p.body?.attachmentId && p.filename && (mime?.startsWith('text/') || mime === 'application/pdf')) {
      result.push({ filename: p.filename as string, attachmentId: p.body.attachmentId as string });
    }
    for (const child of p.parts ?? []) scan(child);
  };
  scan(payload);
  return result;
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
