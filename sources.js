// The three outside systems: Gmail (your account, read-only), Google Classroom/Drive
// (headless Chrome signed in as the school account), and WhatsApp Web.
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import wweb from 'whatsapp-web.js';
import { config, DATA, driveLinks, fileText, htmlToText, kvGet, kvSet, istDate, log, sha1, sheetText } from './lib.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unb64 = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// ── Gmail ─────────────────────────────────────────────────────────────────
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const READABLE = /\.(pdf|png|jpe?g|heic|webp)$/i;

async function gmailGet() {
  if (!config.googleRefreshToken) throw new Error('GOOGLE_REFRESH_TOKEN missing: run `npm run login:google`');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({ client_id: config.googleClientId, client_secret: config.googleClientSecret, refresh_token: config.googleRefreshToken, grant_type: 'refresh_token' }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Google token refresh failed: ${body.error}`); // never log the token
  return async (url) => {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${body.access_token}` } });
    if (!r.ok) throw new Error(`Gmail ${r.status} for ${url.split('?')[0]}`);
    return r.json();
  };
}

/** School mails received after `afterMs`, oldest first, with text of PDF/image attachments. */
export async function fetchSchoolMails(afterMs) {
  const get = await gmailGet();
  const q = encodeURIComponent(`${config.schoolQuery} after:${Math.floor(afterMs / 1000)}`);
  const ids = [];
  let page = '';
  do {
    const r = await get(`${GMAIL}/messages?maxResults=100&q=${q}${page ? `&pageToken=${page}` : ''}`);
    ids.push(...(r.messages || []).map((m) => m.id));
    page = r.nextPageToken;
  } while (page);

  const mails = await Promise.all(ids.map(async (id) => {
    const m = await get(`${GMAIL}/messages/${id}?format=full`);
    const parts = [];
    const walk = (p) => { parts.push(p); (p.parts || []).forEach(walk); };
    walk(m.payload);
    const body = (type) => parts.find((p) => p.mimeType === type && p.body?.data);
    const plain = body('text/plain');
    const html = body('text/html');
    let text = plain ? unb64(plain.body.data).toString() : html ? htmlToText(unb64(html.body.data).toString()) : '';
    // Keep the raw bodies: they carry Drive/Classroom links the plain text may drop.
    const raw = [plain, html].filter(Boolean).map((p) => unb64(p.body.data).toString()).join('\n');
    for (const a of parts.filter((p) => p.filename && p.body?.attachmentId && READABLE.test(p.filename) && p.body.size <= 15e6)) {
      const file = path.join(DATA, `att-${id}-${a.filename.replace(/[^\w.-]/g, '_')}`);
      try {
        fs.writeFileSync(file, unb64((await get(`${GMAIL}/messages/${id}/attachments/${a.body.attachmentId}`)).data));
        text += `\n\n[Attached ${a.filename}]\n${fileText(file).slice(0, 15000)}`;
      } catch (err) {
        log.warn(`could not read attachment ${a.filename}: ${err.message}`);
      } finally {
        fs.rmSync(file, { force: true });
      }
    }
    const header = (n) => m.payload.headers.find((h) => h.name.toLowerCase() === n)?.value || '';
    const ms = Number(m.internalDate);
    return { id, ms, date: istDate(ms), subject: header('subject'), from: header('from'), text, raw };
  }));
  return mails.sort((a, b) => a.ms - b.ms);
}

// ── Google Classroom / Drive (as the school account) ──────────────────────
export const PROFILE = path.join(DATA, 'school-chrome');
const DOWNLOADS = path.join(DATA, 'downloads');
export class LoginExpired extends Error {}

const exportUrl = ({ id, kind }) => ({
  doc: `https://docs.google.com/document/d/${id}/export?format=html`,
  sheet: `https://docs.google.com/spreadsheets/d/${id}/export?format=xlsx`,
  slides: `https://docs.google.com/presentation/d/${id}/export?format=pdf`,
  file: `https://drive.google.com/uc?export=download&id=${id}`,
}[kind]);

export async function openClassroom() {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: config.chromePath,
    userDataDir: PROFILE,
    ignoreDefaultArgs: ['--password-store=basic', '--use-mock-keychain'], // real Keychain: reads the login window's cookies
  });
  const page = await browser.newPage();
  fs.rmSync(DOWNLOADS, { recursive: true, force: true });
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  await (await page.createCDPSession()).send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS });
  const expired = () => { if (page.url().includes('accounts.google.com')) throw new LoginExpired('school account login expired'); };

  return {
    close: () => browser.close(),

    async checkLogin() {
      await page.goto('https://classroom.google.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
      if (!page.url().startsWith('https://classroom.google.com')) throw new LoginExpired('school account login expired');
    },

    /** Drive/Docs links attached to a Classroom post. */
    async postLinks(url) {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
      expired();
      return driveLinks((await page.$$eval('a[href]', (as) => as.map((a) => a.href))).join('\n'));
    },

    /** Download one Drive item; returns its text (and, for Docs, the links inside it). */
    async fileText(link) {
      const before = new Set(fs.readdirSync(DOWNLOADS));
      try { await page.goto(exportUrl(link), { timeout: 60000 }); } catch { /* a download aborts navigation */ }
      expired();
      let file = null;
      for (const end = Date.now() + 45000; !file && Date.now() < end; await sleep(300)) {
        const f = fs.readdirSync(DOWNLOADS).find((n) => !before.has(n) && !n.endsWith('.crdownload'));
        if (f) file = path.join(DOWNLOADS, f);
      }
      if (!file) { log.warn(`no download for ${link.kind} ${link.id} (no access or unsupported)`); return null; }
      const buf = fs.readFileSync(file);
      let text = '';
      let links = [];
      if (link.kind === 'doc') { const html = buf.toString(); text = htmlToText(html); links = driveLinks(decodeURIComponent(html)); }
      else if (link.kind === 'sheet' || file.endsWith('.xlsx')) text = sheetText(buf);
      else if (/\.(pdf|png|jpe?g|heic|gif|webp)$/i.test(file)) text = fileText(file);
      fs.rmSync(file);
      if (!text) { log.warn(`skipping unsupported file ${path.basename(file)}`); return null; }
      text = text.slice(0, 20000);
      return { text, links, hash: sha1(text) };
    },
  };
}

// ── WhatsApp ──────────────────────────────────────────────────────────────
export class WhatsAppLoggedOut extends Error {}

/** Start WhatsApp Web. With onQr (login) shows the QR; otherwise a QR means the device was unlinked. */
export function openWhatsApp(db, { onQr } = {}) {
  const client = new wweb.Client({
    authStrategy: new wweb.LocalAuth({ dataPath: path.join(DATA, 'wa-auth') }),
    webVersionCache: { type: 'local', path: path.join(DATA, 'wa-cache') },
    puppeteer: { headless: true, executablePath: config.chromePath, args: ['--no-first-run'] },
  });
  return new Promise((resolve, reject) => {
    // The first connection after hours offline syncs history first; that can take minutes.
    const timer = setTimeout(() => {
      reject(new Error('WhatsApp did not become ready in 10 min (phone offline? check data/bot.log sync progress)'));
      client.destroy().catch(() => {});
    }, 600000);
    let lastPct = -1;
    client.on('loading_screen', (pct) => { if (pct - lastPct >= 25 || pct === 100) log.info(`WhatsApp syncing ${pct}%`); lastPct = pct; });
    client.on('authenticated', () => log.info('WhatsApp session accepted, loading chats...'));
    client.on('qr', (qr) => {
      if (onQr) return onQr(qr);
      clearTimeout(timer);
      reject(new WhatsAppLoggedOut('WhatsApp is unlinked: run `npm run login:whatsapp`')); // before destroy, which errors too
      client.destroy().catch(() => {});
    });
    client.on('auth_failure', (m) => { clearTimeout(timer); reject(new WhatsAppLoggedOut(`WhatsApp auth failed: ${m}`)); });
    client.on('disconnected', (reason) => log.warn(`WhatsApp disconnected: ${reason}`));
    client.on('ready', () => { clearTimeout(timer); resolve(whatsapp(client, db)); });
    client.initialize().catch(reject);
  });
}

function whatsapp(client, db) {
  let contacts;
  // Chat IDs are looked up by saved name once (scanning contacts is slow), then cached.
  async function chatId(key, pred, label) {
    const cached = db && kvGet(db, key);
    if (cached) return cached;
    contacts ??= await client.getContacts();
    let found = [...new Map(contacts.filter(pred).map((c) => [c.id._serialized, c])).values()]; // de-duplicate
    if (found.length > 1) found = found.filter((c) => c.id.server !== 'lid');
    if (found.length !== 1) throw new Error(`WhatsApp: expected 1 contact "${label}", found ${found.length}`);
    if (db) kvSet(db, key, found[0].id._serialized);
    return found[0].id._serialized;
  }
  const groupId = () => chatId('wa_group', (c) => c.isGroup && c.name === config.groupName, config.groupName);

  // sendMessage() returns once the message is queued in the browser, not sent. Closing the
  // browser then leaves it stuck as "pending", so wait until WhatsApp's server has it.
  const ACK = { 1: 'on WhatsApp server', 2: 'delivered', 3: 'read' };
  async function sendConfirmed(to, text, options) {
    const msg = await client.sendMessage(to, text, options);
    if (!msg?.id) throw new Error('WhatsApp did not create the message');
    let ack = msg.ack;
    for (const end = Date.now() + 60000; ack < 1 && Date.now() < end; await sleep(500)) {
      ack = (await client.getMessageById(msg.id._serialized))?.ack ?? ack;
      if (ack === -1) break;
    }
    if (ack < 1) throw new Error(`WhatsApp message ${msg.id.id} not sent (status ${ack === -1 ? 'error' : 'still pending after 60 s'})`);
    for (const end = Date.now() + 5000; ack < 2 && Date.now() < end; await sleep(500)) { // brief look for "delivered", for the log
      ack = (await client.getMessageById(msg.id._serialized))?.ack ?? ack;
    }
    log.info(`WhatsApp message ${msg.id.id}: ${ACK[ack] ?? ack}`);
  }

  return {
    close: () => client.destroy(),

    /** The teacher's messages after `sinceSec`, with image/PDF text added via OCR. */
    async readTeacherMessages(sinceSec) {
      const id = await chatId('wa_teacher', (c) => !c.isGroup && c.name === config.teacherChat, config.teacherChat);
      const chat = await client.getChatById(id);
      await sleep(1500); // let history sync after being offline
      const out = [];
      for (const m of (await chat.fetchMessages({ limit: 200 })).filter((x) => x.timestamp > sinceSec && !x.fromMe)) {
        let text = m.body || '';
        const isPdf = m.type === 'document' && /pdf/i.test(m._data?.mimetype || '');
        if (m.hasMedia && (m.type === 'image' || isPdf)) {
          const file = path.join(DATA, `wa-${m.id.id}.${isPdf ? 'pdf' : 'jpg'}`);
          try {
            fs.writeFileSync(file, Buffer.from((await m.downloadMedia()).data, 'base64'));
            text = `${text}\n[${isPdf ? 'PDF' : 'Image'} text]\n${fileText(file)}`.trim();
          } catch (err) {
            log.warn(`could not read media in WhatsApp message ${m.id.id}: ${err.message}`);
          } finally {
            fs.rmSync(file, { force: true });
          }
        }
        if (text.trim()) out.push({ id: m.id._serialized, ts: m.timestamp, text });
      }
      return out;
    },

    /**
     * Who to @mention. Groups now tag people by privacy ID (@lid), and a mention only shows
     * as "@Name" when the text and the tag both use that ID. Cached after the first lookup.
     */
    async mention() {
      let lid = kvGet(db, 'wa_mention_lid');
      if (!lid) {
        const suffix = config.mentionNumberEndsWith;
        const phoneId = await chatId('wa_mention_phone',
          (c) => !c.isGroup && c.isMyContact && c.name === config.mentionName && (!suffix || c.id.user.endsWith(suffix)), config.mentionName);
        lid = (await client.getContactLidAndPhone([phoneId]))[0]?.lid || phoneId;
        kvSet(db, 'wa_mention_lid', lid);
      }
      return { id: lid, token: '@' + lid.split('@')[0] };
    },

    async sendToGroup(text, mentionId) {
      const id = await groupId();
      await sleep(1000 + Math.random() * 2000); // small human-like pause
      await sendConfirmed(id, text, { mentions: [mentionId] });
    },

    sendToSelf: (text) => sendConfirmed(client.info.wid._serialized, text),
  };
}
