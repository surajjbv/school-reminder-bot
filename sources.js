// The outside systems: Google (the kid's school account, read-only: Gmail, Classroom, Drive)
// and WhatsApp Web.
import fs from 'node:fs';
import path from 'node:path';
import wweb from 'whatsapp-web.js';
import { config, DATA, driveLinks, fileText, htmlToText, istDate, kvGet, kvSet, log, sheetText } from './lib.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unb64 = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

// ── Google API (one read-only token for Gmail, Classroom and Drive) ────────
let accessToken;
async function google(url, { binary = false } = {}) {
  if (!accessToken) {
    if (!config.googleRefreshToken) throw new Error('GOOGLE_REFRESH_TOKEN missing: run `npm run login:google`');
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams({ client_id: config.googleClientId, client_secret: config.googleClientSecret, refresh_token: config.googleRefreshToken, grant_type: 'refresh_token' }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`Google access was revoked or expired (${body.error}): run \`npm run login:google\``); // never log the token
    accessToken = body.access_token;
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Google ${res.status} for ${url.split('?')[0]}: ${(await res.text()).slice(0, 150)}`);
  return binary ? Buffer.from(await res.arrayBuffer()) : res.json();
}

/** Text of a file: PDFs and images via OCR (macOS Vision). The temp file is always removed. */
function bufferText(buf, name) {
  const file = path.join(DATA, `tmp-${Date.now()}-${name.replace(/[^\w.-]/g, '_')}`);
  try { fs.writeFileSync(file, buf); return fileText(file); } finally { fs.rmSync(file, { force: true }); }
}

// ── Drive ─────────────────────────────────────────────────────────────────
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const EXPORT = {
  'application/vnd.google-apps.document': 'text/html',
  'application/vnd.google-apps.spreadsheet': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.google-apps.presentation': 'application/pdf',
};
const XLSX_TYPE = EXPORT['application/vnd.google-apps.spreadsheet'];

export const driveModified = async (id) => (await google(`${DRIVE}/${id}?fields=modifiedTime&supportsAllDrives=true`)).modifiedTime;

/** A Drive file as text (Docs, Sheets: 3 newest tabs, Slides, PDFs, images), plus Drive links inside Docs; null if unreadable. */
export async function driveText(id) {
  const f = await google(`${DRIVE}/${id}?fields=name,mimeType,modifiedTime,size&supportsAllDrives=true`);
  const type = f.mimeType;
  if (!EXPORT[type] && !/pdf|image\/|spreadsheetml/.test(type)) return null; // folders, videos, Word, ...
  if (Number(f.size) > 15e6) { log.warn(`skipping large Drive file "${f.name}"`); return null; }
  const buf = await google(EXPORT[type] ? `${DRIVE}/${id}/export?mimeType=${encodeURIComponent(EXPORT[type])}` : `${DRIVE}/${id}?alt=media&supportsAllDrives=true`, { binary: true });
  const format = EXPORT[type] ?? type;
  let text;
  let links = [];
  if (format === 'text/html') { const html = buf.toString(); text = htmlToText(html); links = driveLinks(decodeURIComponent(html)); }
  else if (format === XLSX_TYPE) text = sheetText(buf);
  else text = bufferText(buf, format === 'application/pdf' ? `${id}.pdf` : f.name);
  return { name: f.name, modified: f.modifiedTime, text: text.slice(0, 20000), links };
}

// ── Gmail ─────────────────────────────────────────────────────────────────
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const READABLE = /\.(pdf|png|jpe?g|heic|webp)$/i;

/** School mails after `afterMs`, oldest first, with text of PDF/image attachments. */
export async function fetchSchoolMails(afterMs) {
  // Classroom notification emails are skipped: Classroom posts come from the Classroom API.
  const q = encodeURIComponent(`${config.schoolQuery} -from:classroom.google.com after:${Math.floor(afterMs / 1000)}`);
  const ids = [];
  let page = '';
  do {
    const r = await google(`${GMAIL}/messages?maxResults=100&q=${q}${page ? `&pageToken=${page}` : ''}`);
    ids.push(...(r.messages || []).map((m) => m.id));
    page = r.nextPageToken;
  } while (page);

  const mails = await Promise.all(ids.map(async (id) => {
    const m = await google(`${GMAIL}/messages/${id}?format=full`);
    const parts = [];
    const walk = (p) => { parts.push(p); (p.parts || []).forEach(walk); };
    walk(m.payload);
    const body = (type) => parts.find((p) => p.mimeType === type && p.body?.data);
    const plain = body('text/plain');
    const html = body('text/html');
    let text = plain ? unb64(plain.body.data).toString() : html ? htmlToText(unb64(html.body.data).toString()) : '';
    const raw = [plain, html].filter(Boolean).map((p) => unb64(p.body.data).toString()).join('\n'); // keeps Drive links
    for (const a of parts.filter((p) => p.filename && p.body?.attachmentId && READABLE.test(p.filename) && p.body.size <= 15e6)) {
      try {
        const data = unb64((await google(`${GMAIL}/messages/${id}/attachments/${a.body.attachmentId}`)).data);
        text += `\n\n[Attached ${a.filename}]\n${bufferText(data, a.filename).slice(0, 15000)}`;
      } catch (err) {
        log.warn(`could not read attachment ${a.filename}: ${err.message}`);
      }
    }
    const header = (n) => m.payload.headers.find((h) => h.name.toLowerCase() === n)?.value || '';
    const ms = Number(m.internalDate);
    return { id, ms, date: istDate(ms), subject: header('subject'), from: header('from'), text, links: driveLinks(raw) };
  }));
  return mails.sort((a, b) => a.ms - b.ms);
}

// ── Classroom ─────────────────────────────────────────────────────────────
const CLASSROOM = 'https://classroom.googleapis.com/v1/courses';
const STREAMS = [['announcements', 'announcements', 'Classroom announcement'], ['courseWork', 'courseWork', 'Classroom assignment'],
  ['courseWorkMaterial', 'courseWorkMaterials', 'Classroom material']];

/** Announcements, assignments and materials updated after `afterMs` in the kid's active courses, oldest first. */
export async function classroomPosts(afterMs) {
  const { courses = [] } = await google(`${CLASSROOM}?studentId=me&courseStates=ACTIVE`);
  const lists = await Promise.all(courses.flatMap((c) => STREAMS.map(async ([key, path, kind]) => {
    const r = await google(`${CLASSROOM}/${c.id}/${path}?orderBy=updateTime%20desc&pageSize=30`);
    return (r[key] || []).filter((x) => x.state === 'PUBLISHED' && Date.parse(x.updateTime) > afterMs).map((x) => {
      const due = x.dueDate && istDate(Date.UTC(x.dueDate.year, x.dueDate.month - 1, x.dueDate.day, x.dueTime?.hours ?? 12, x.dueTime?.minutes ?? 0));
      const m = x.materials || [];
      const other = m.map(({ link, youtubeVideo: v, form }) =>
        (link && `Link: ${link.title || ''} ${link.url}`) || (v && `Video: ${v.title}`) || (form && `Form: ${form.title} ${form.formUrl}`)).filter(Boolean);
      return {
        id: x.id, ms: Date.parse(x.updateTime), date: istDate(x.updateTime), kind,
        text: [`Course: ${c.name}`, x.title, x.text || x.description, due && `Due: ${due}`, ...other].filter(Boolean).join('\n'),
        driveIds: m.map((y) => y.driveFile?.driveFile?.id).filter(Boolean),
      };
    });
  })));
  return lists.flat().sort((a, b) => a.ms - b.ms);
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
