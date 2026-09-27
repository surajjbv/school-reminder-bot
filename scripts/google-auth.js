// One-time: authorize read-only Gmail access and save the refresh token into .env.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { config, ROOT } from '../src/config.js';

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const { googleClientId: clientId, googleClientSecret: clientSecret } = config;
if (!clientId || !clientSecret) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first (see README step 2).');
  process.exit(1);
}

const state = crypto.randomBytes(16).toString('hex');
const server = http.createServer();
server.listen(0, '127.0.0.1', () => {
  const redirect = `http://127.0.0.1:${server.address().port}`;
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: SCOPE,
    access_type: 'offline', prompt: 'consent', state,
  });
  console.log('Opening your browser to sign in with YOUR Gmail (the one receiving the school mail)...');
  execFile('open', [url]);

  server.on('request', async (req, res) => {
    const q = new URL(req.url, redirect).searchParams;
    if (!q.get('code') || q.get('state') !== state) { res.end('Waiting...'); return; }
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams({ code: q.get('code'), client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: 'authorization_code' }),
    });
    const tok = await r.json();
    if (!tok.refresh_token) {
      res.end('Failed: no refresh token. See terminal.');
      console.error('Google did not return a refresh token:', tok.error || 'unknown error');
      process.exit(1);
    }
    const envPath = path.join(ROOT, '.env');
    let env = fs.readFileSync(envPath, 'utf8');
    env = /^GOOGLE_REFRESH_TOKEN=.*$/m.test(env)
      ? env.replace(/^GOOGLE_REFRESH_TOKEN=.*$/m, `GOOGLE_REFRESH_TOKEN=${tok.refresh_token}`)
      : env + `\nGOOGLE_REFRESH_TOKEN=${tok.refresh_token}\n`;
    fs.writeFileSync(envPath, env, { mode: 0o600 });
    res.end('Done. You can close this tab.');
    console.log('Saved refresh token to .env (read-only Gmail access).');
    server.close();
    process.exit(0);
  });
});
