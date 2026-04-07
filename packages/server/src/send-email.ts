#!/usr/bin/env bun
/**
 * send-email.ts — standalone Gmail sender for Claude Code
 *
 * Usage:
 *   bun .claude/scripts/send-email.ts --to foo@example.com --subject "Hello" --body "Text"
 *   bun .claude/scripts/send-email.ts --to foo@example.com --subject "Hello" < body.txt
 *   bun .claude/scripts/send-email.ts --to foo@example.com --subject "Hello" --body-file /tmp/report.txt
 *   bun .claude/scripts/send-email.ts --to foo@example.com --subject "Hello" --html "<b>Hi</b>"
 *
 * Reads credentials from .user-data/system/gmail-credentials.json
 * (same file used by the lifeos server's GmailClient)
 */

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { google } from 'googleapis';
import { randomUUID } from 'crypto';

const MONOREPO_ROOT = resolve(import.meta.dir, '../../..');
const CREDENTIALS_PATH = resolve(MONOREPO_ROOT, '.user-data/system/gmail-credentials.json');

// --- Arg parsing ---
const args = process.argv.slice(2);
function getArg(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
}
function hasFlag(flag: string): boolean {
  return args.includes(flag);
}

const to = getArg('--to');
const subject = getArg('--subject');
const bodyArg = getArg('--body');
const bodyFile = getArg('--body-file');
const htmlArg = getArg('--html');

if (!to || !subject) {
  console.error('Usage: send-email.ts --to <email> --subject <subject> [--body <text> | --body-file <path> | --html <html> | stdin]');
  process.exit(1);
}

// Read body: --body > --body-file > --html > stdin
let body: string | undefined;
let html: string | undefined;

if (htmlArg) {
  html = htmlArg;
} else if (bodyArg) {
  body = bodyArg;
} else if (bodyFile) {
  body = readFileSync(bodyFile, 'utf-8');
} else {
  // Read from stdin
  body = readFileSync('/dev/stdin', 'utf-8');
}

// --- Gmail setup ---
if (!existsSync(CREDENTIALS_PATH)) {
  console.error(`Gmail credentials not found at ${CREDENTIALS_PATH}`);
  process.exit(1);
}

const creds = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf-8')) as {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

const auth = new google.auth.OAuth2(creds.clientId, creds.clientSecret);
auth.setCredentials({ refresh_token: creds.refreshToken });
const gmail = google.gmail({ version: 'v1', auth });

// Normalize soft-wrapped plain text: join single-newline lines into paragraphs
function normalizeTextBody(text: string): string {
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const paragraphs = text.split(/\n{2,}/);
  return paragraphs
    .map((para) => {
      const lines = para.split('\n');
      if (lines.length <= 1 || lines.some((l) => /^(\s{2,}|[-*•]|\d+[.)]\s)/.test(l))) {
        return para;
      }
      return lines.map((l) => l.trim()).filter(Boolean).join(' ');
    })
    .join('\n\n');
}

// --- Build MIME ---
const encodedSubject = /[^\x00-\x7F]/.test(subject)
  ? `=?UTF-8?B?${Buffer.from(subject, 'utf-8').toString('base64')}?=`
  : subject;

let mime: string;
if (html) {
  mime = `To: ${to}\r\nSubject: ${encodedSubject}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}`;
} else {
  mime = `To: ${to}\r\nSubject: ${encodedSubject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${normalizeTextBody(body ?? '')}`;
}

const raw = Buffer.from(mime).toString('base64url');

// --- Send ---
try {
  const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  // Add INBOX label so it's visible in inbox
  if (res.data.id) {
    await gmail.users.messages.modify({
      userId: 'me',
      id: res.data.id,
      requestBody: { addLabelIds: ['INBOX'] },
    }).catch(() => {});
  }
  console.log(`Sent: ${res.data.id}`);
} catch (err: any) {
  console.error('Failed to send:', err?.message ?? err);
  process.exit(1);
}
