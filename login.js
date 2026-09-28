// One-time logins:  node login.js google | school | whatsapp
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import qrcode from 'qrcode-terminal';
import { config, requireConfig, ROOT } from './lib.js';
import { openClassroom, openWhatsApp, PROFILE } from './sources.js';

const what = process.argv[2];

if (what === 'google') {
  // Read-only Gmail access for the account whose mail the bot reads; the refresh token is saved into .env.
  requireConfig('googleClientId', 'googleClientSecret');
  const state = crypto.randomBytes(16).toString('hex');
  const server = http.createServer().listen(0, '127.0.0.1', () => {
    const redirect = `http://127.0.0.1:${server.address().port}`;
    const client = { client_id: config.googleClientId, client_secret: config.googleClientSecret, redirect_uri: redirect };
    execFile('open', ['https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
      client_id: client.client_id, redirect_uri: redirect, response_type: 'code', access_type: 'offline', prompt: 'consent', state,
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
    })]);
    console.log('In the browser, sign in with the Gmail account the bot should read (e.g. the kid\'s school account)...');
    server.on('request', async (req, res) => {
      const q = new URL(req.url, redirect).searchParams;
      if (!q.get('code') || q.get('state') !== state) return res.end('Waiting...');
      const tok = await (await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', body: new URLSearchParams({ ...client, code: q.get('code'), grant_type: 'authorization_code' }),
      })).json();
      if (!tok.refresh_token) { res.end('Failed, see terminal.'); console.error('No refresh token:', tok.error || 'unknown'); process.exit(1); }
      const envPath = path.join(ROOT, '.env');
      const env = fs.readFileSync(envPath, 'utf8');
      const line = `GOOGLE_REFRESH_TOKEN=${tok.refresh_token}`;
      fs.writeFileSync(envPath, /^GOOGLE_REFRESH_TOKEN=.*$/m.test(env) ? env.replace(/^GOOGLE_REFRESH_TOKEN=.*$/m, line) : `${env}\n${line}\n`, { mode: 0o600 });
      res.end('Done. You can close this tab.');
      console.log('Saved the refresh token to .env.');
      process.exit(0);
    });
  });
} else if (what === 'school') {
  // A normal (not automated) Chrome window on the bot's profile; sign in by hand, then Cmd+Q.
  requireConfig('schoolAccount');
  console.log(`Sign in as ${config.schoolAccount}, let Chrome save the password, then QUIT that window with Cmd+Q.`);
  const url = `https://accounts.google.com/AccountChooser?Email=${encodeURIComponent(config.schoolAccount)}&continue=https://classroom.google.com/`;
  spawn(config.chromePath, [`--user-data-dir=${PROFILE}`, '--no-first-run', '--no-default-browser-check', url], { stdio: 'ignore' })
    .on('exit', async () => {
      const s = await openClassroom();
      try { await s.checkLogin(); console.log(`OK: ${config.schoolAccount} is signed in.`); }
      catch (err) { console.error(`Not signed in (${err.message}). Run \`npm run login:school\` again.`); process.exitCode = 1; }
      finally { await s.close(); }
    });
} else if (what === 'whatsapp') {
  // Link the bot as a device: WhatsApp > Settings > Linked devices > Link a device.
  console.log('Starting WhatsApp Web...');
  const wa = await openWhatsApp(null, { onQr: (qr) => { console.log('\nScan with WhatsApp > Linked devices > Link a device:\n'); qrcode.generate(qr, { small: true }); } });
  console.log('Linked. The session is saved.');
  await wa.close();
  process.exit(0);
} else {
  console.error('Usage: node login.js google | school | whatsapp');
  process.exit(1);
}
