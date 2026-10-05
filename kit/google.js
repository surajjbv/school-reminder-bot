// Google APIs: a one-time OAuth login on this Mac (the refresh token is saved into .env) and an authorised
// fetch that refreshes the access token itself. Needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const env = (k) => process.env[k]?.trim();

/** fetch for Google APIs: JSON back (a Buffer with `binary`), clear errors, the token never logged. */
export function googleApi() {
  let token;
  return async (url, { binary = false, ...init } = {}) => {
    if (!token) {
      if (!env('GOOGLE_REFRESH_TOKEN')) throw new Error('GOOGLE_REFRESH_TOKEN missing in .env: run `npm run login`');
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        body: new URLSearchParams({ client_id: env('GOOGLE_CLIENT_ID'), client_secret: env('GOOGLE_CLIENT_SECRET'), refresh_token: env('GOOGLE_REFRESH_TOKEN'), grant_type: 'refresh_token' }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(`Google access was revoked or expired (${body.error}): run \`npm run login\``);
      token = body.access_token;
    }
    const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
    if (!res.ok) throw new Error(`Google ${res.status} for ${url.split('?')[0]}: ${(await res.text()).slice(0, 150)}`);
    return binary ? Buffer.from(await res.arrayBuffer()) : res.json();
  };
}

/** Browser sign-in with `scopes` (short names, e.g. 'gmail.readonly'); saves GOOGLE_REFRESH_TOKEN into <root>/.env. */
export function googleLogin(root, scopes, who = 'the Google account the bot should use') {
  if (!env('GOOGLE_CLIENT_ID') || !env('GOOGLE_CLIENT_SECRET')) throw new Error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first');
  const state = crypto.randomBytes(16).toString('hex');
  return new Promise((done, fail) => {
    const server = http.createServer().listen(0, '127.0.0.1', () => {
      const redirect = `http://127.0.0.1:${server.address().port}`;
      const client = { client_id: env('GOOGLE_CLIENT_ID'), client_secret: env('GOOGLE_CLIENT_SECRET'), redirect_uri: redirect };
      const url = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams({
        client_id: client.client_id, redirect_uri: redirect, response_type: 'code', access_type: 'offline', prompt: 'select_account consent', state,
        scope: scopes.map((s) => `https://www.googleapis.com/auth/${s}`).join(' '),
      })}`;
      execFile('open', [url]);
      console.log(`If no browser opened, visit:\n${url}\n\nIn the browser, sign in with ${who}...`);
      server.on('request', async (req, res) => {
        const q = new URL(req.url, redirect).searchParams;
        if (!q.get('code') || q.get('state') !== state) return res.end('Waiting...');
        const tok = await (await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST', body: new URLSearchParams({ ...client, code: q.get('code'), grant_type: 'authorization_code' }),
        })).json();
        server.close();
        if (!tok.refresh_token) { res.end('Failed, see terminal.'); return fail(new Error(`No refresh token: ${tok.error || 'unknown'}`)); }
        const file = path.join(root, '.env');
        const text = fs.readFileSync(file, 'utf8');
        const line = `GOOGLE_REFRESH_TOKEN=${tok.refresh_token}`;
        fs.writeFileSync(file, /^GOOGLE_REFRESH_TOKEN=.*$/m.test(text) ? text.replace(/^GOOGLE_REFRESH_TOKEN=.*$/m, line) : `${text}\n${line}\n`, { mode: 0o600 });
        res.end('Done. You can close this tab.');
        console.log('Saved the refresh token to .env.');
        done();
      });
    });
  });
}
