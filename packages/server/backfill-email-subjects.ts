/**
 * One-off script: backfill missing `subject` fields in all email-threads.json files.
 * Run with: bun packages/server/backfill-email-subjects.ts
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { google } from 'googleapis';
import { MONOREPO_ROOT } from './src/root.js';

const USER_DATA = resolve(MONOREPO_ROOT, '.user-data');

// Map from client id → credentials path
const CLIENTS: Record<string, string> = {
  shrey:    resolve(USER_DATA, 'clients/shrey/system/gmail-credentials.json'),
  akanksha: resolve(USER_DATA, 'clients/akanksha/system/gmail-credentials.json'),
  tita:     resolve(USER_DATA, 'clients/tita/system/gmail-credentials.json'),
};

// All email-threads.json paths and their owning client
const THREAD_FILES: Array<{ client: string; path: string }> = [
  { client: 'akanksha', path: resolve(USER_DATA, 'clients/akanksha/agents/cos/email-threads.json') },
  { client: 'shrey',    path: resolve(USER_DATA, 'clients/shrey/agents/advisor/email-threads.json') },
  { client: 'shrey',    path: resolve(USER_DATA, 'clients/shrey/agents/chicago_childcare/email-threads.json') },
  { client: 'shrey',    path: resolve(USER_DATA, 'clients/shrey/agents/chicago_realestate/email-threads.json') },
  { client: 'shrey',    path: resolve(USER_DATA, 'clients/shrey/agents/cos/email-threads.json') },
  { client: 'shrey',    path: resolve(USER_DATA, 'clients/shrey/agents/dating_coach/email-threads.json') },
  { client: 'shrey',    path: resolve(USER_DATA, 'clients/shrey/agents/relocation/email-threads.json') },
  { client: 'shrey',    path: resolve(USER_DATA, 'clients/shrey/agents/therapist/email-threads.json') },
  { client: 'tita',     path: resolve(USER_DATA, 'clients/tita/agents/cos/email-threads.json') },
];

function buildGmail(credPath: string) {
  const creds = JSON.parse(readFileSync(credPath, 'utf-8'));
  const auth = new google.auth.OAuth2(creds.clientId, creds.clientSecret);
  auth.setCredentials({ refresh_token: creds.refreshToken });
  return google.gmail({ version: 'v1', auth });
}

function stripRe(subject: string): string {
  return subject.replace(/^(Re:\s*)+/i, '').trim();
}

async function getThreadSubject(gmail: ReturnType<typeof buildGmail>, threadId: string): Promise<string | null> {
  try {
    const res = await gmail.users.threads.get({
      userId: 'me',
      id: threadId,
      format: 'metadata',
      metadataHeaders: ['Subject'],
    });
    const msgs: any[] = res.data.messages ?? [];
    for (const msg of msgs) {
      for (const h of msg.payload?.headers ?? []) {
        if ((h.name as string).toLowerCase() === 'subject' && h.value) {
          return stripRe(h.value as string);
        }
      }
    }
    return null;
  } catch (err: any) {
    console.warn(`  [warn] could not fetch thread ${threadId}: ${err?.message}`);
    return null;
  }
}

// Cache gmail clients per client id
const gmailClients = new Map<string, ReturnType<typeof buildGmail>>();
function getGmail(clientId: string) {
  if (!gmailClients.has(clientId)) {
    const credPath = CLIENTS[clientId];
    if (!credPath || !existsSync(credPath)) {
      throw new Error(`No credentials found for client: ${clientId}`);
    }
    gmailClients.set(clientId, buildGmail(credPath));
  }
  return gmailClients.get(clientId)!;
}

for (const { client, path } of THREAD_FILES) {
  if (!existsSync(path)) continue;

  const store: Record<string, any> = JSON.parse(readFileSync(path, 'utf-8'));
  const missingSubjects = Object.entries(store).filter(([, v]) => !v.subject);

  if (missingSubjects.length === 0) {
    console.log(`[${client}] ${path.split('/').slice(-3).join('/')} — all subjects present, skipping`);
    continue;
  }

  console.log(`[${client}] ${path.split('/').slice(-3).join('/')} — backfilling ${missingSubjects.length} thread(s)`);
  const gmail = getGmail(client);
  let changed = false;

  for (const [threadId] of missingSubjects) {
    const subject = await getThreadSubject(gmail, threadId);
    if (subject) {
      store[threadId] = { ...store[threadId], subject };
      console.log(`  ${threadId} → "${subject}"`);
      changed = true;
    } else {
      console.log(`  ${threadId} → (no subject found)`);
    }
  }

  if (changed) {
    writeFileSync(path, JSON.stringify(store, null, 2), 'utf-8');
    console.log(`  saved.`);
  }
}

console.log('done.');
