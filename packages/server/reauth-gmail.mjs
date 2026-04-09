#!/usr/bin/env node
// Run: node scripts/reauth-gmail.mjs
// Opens a browser for OAuth, then writes the new refresh token to gmail-credentials.json

import { createServer } from 'http';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CREDS_PATH = resolve(__dirname, '../../.user-data/system/gmail-credentials.json');

const creds = JSON.parse(readFileSync(CREDS_PATH, 'utf-8'));
const REDIRECT_URI = 'http://localhost:4242/oauth2callback';

const oauth2Client = new google.auth.OAuth2(creds.clientId, creds.clientSecret, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/gmail.modify'],
});

console.log('\nOpening browser for Gmail authorization...');
console.log('If it does not open, visit:\n', authUrl, '\n');

const { exec } = await import('child_process');
exec(`open "${authUrl}"`);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:4242');
  if (url.pathname !== '/oauth2callback') {
    res.writeHead(204).end();
    return;
  }

  const code = url.searchParams.get('code');
  if (!code) {
    res.end('No code received.');
    server.close();
    process.exit(1);
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    if (!tokens.refresh_token) {
      res.end('Error: no refresh_token in response — try revoking access at myaccount.google.com/permissions and re-running.');
      console.error('✗ Google did not return a refresh_token.');
      server.close();
      process.exit(1);
    }
    const updated = { ...creds, refreshToken: tokens.refresh_token };
    writeFileSync(CREDS_PATH, JSON.stringify(updated, null, 2));
    res.end('<h2>Done! Refresh token saved. You can close this tab.</h2>');
    console.log('✓ New refresh token saved to gmail-credentials.json');
    server.close();
    process.exit(0);
  } catch (err) {
    res.end(`Error: ${err.message}`);
    console.error(err);
    server.close();
    process.exit(1);
  }
});

server.listen(4242, () => console.log('Waiting for OAuth callback on http://localhost:4242 ...'));
