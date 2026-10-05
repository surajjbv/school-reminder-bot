// Everything outside the Mac: the kid's school Google account (read-only Gmail, Classroom, attached Drive files),
// WhatsApp (the teacher's messages in, the digest out), and text out of attachments (OCR, Sheets, HTML).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { DATA, expandHome, googleApi, log, openWhatsApp, ROOT } from './kit.js';
import { istDate } from './rules.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── text out of attachments ────────────────────────────────────────────────
const OCR_BIN = path.join(DATA, 'ocr');

/** OCR an image, or text from a PDF (OCR for scanned pages). Builds the macOS helper on first use. */
export function fileText(file) {
  if (!fs.existsSync(OCR_BIN)) { fs.mkdirSync(DATA, { recursive: true }); execFileSync('swiftc', ['-O', path.join(ROOT, 'ocr.swift'), '-o', OCR_BIN]); }
  return execFileSync(OCR_BIN, [file], { encoding: 'utf8', timeout: 120000 }).trim();
}

// Latest date in a tab name, as YYMMDD (0 if none). Handles "15/09/26 - 18/09/26" and the compact
// day-month-year runs schools use: "210926" = 21/09/26, "7926" = 7/9/26, "10826" = 10/8/26.
function tabDate(name) {
  const dates = [];
  const add = (d, m, y) => { if (d >= 1 && d <= 31 && m >= 1 && m <= 12) dates.push((y % 100) * 1e4 + m * 100 + d); };
  for (const [, d, m, y] of name.matchAll(/(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/g)) add(+d, +m, +y);
  if (!dates.length) {
    for (const run of name.match(/\d{4,6}/g) || []) {
      const y = +run.slice(-2);
      const dm = run.slice(0, -2);
      const [d2, m2] = [+dm.slice(0, 2), +dm.slice(2)]; // prefer a 2-digit day ("10826" = 10 Aug, not 1 Aug)
      if (dm.length >= 3 && d2 <= 31 && m2 >= 1 && m2 <= 12) add(d2, m2, y); else add(+dm.slice(0, 1), +dm.slice(1), y);
    }
  }
  return dates.length ? Math.max(...dates) : 0;
}

/** The 3 most recent tabs of a workbook as CSV (newest dates in tab names; if none are dated, the first 3), skipping empty rows. */
export function sheetText(buf) {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  const dated = wb.SheetNames.filter(tabDate).sort((a, b) => tabDate(b) - tabDate(a));
  const tabs = dated.length ? dated : wb.SheetNames;
  return tabs.slice(0, 3).map((name) => {
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name], { blankrows: false, dateNF: 'yyyy-mm-dd' });
    return `## Tab: ${name}\n${csv.split('\n').filter((l) => l.replace(/,/g, '').trim()).join('\n')}`;
  }).join('\n\n');
}

export const htmlToText = (html) => html
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
  .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

/** Google Docs/Sheets/Drive file links found in text. */
export function driveLinks(text) {
  const out = new Map();
  const re = /https:\/\/(?:docs|drive)\.google\.com\/(?:(document|spreadsheets|presentation)\/d\/|file\/d\/|open\?id=|uc\?(?:export=\w+&)?id=)([\w-]{20,})/g;
  for (const m of text.matchAll(re)) {
    if (!out.has(m[2])) out.set(m[2], { id: m[2], kind: { document: 'doc', spreadsheets: 'sheet', presentation: 'slides' }[m[1]] || 'file' });
  }
  return [...out.values()];
}

// ── Google ─────────────────────────────────────────────────────────────────
const unb64 = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const schoolQuery = () => process.env.SCHOOL_GMAIL_QUERY?.trim() || '-from:accounts.google.com';
const api = googleApi(); // one read-only token for Gmail, Classroom and Drive
const google = (url, { binary = false } = {}) => api(url, { binary });

/** Read-only scopes: the kid's mail, Classroom courses/posts/assignments/materials, and attached Drive files. */
export const SCOPES = ['gmail.readonly', 'classroom.courses.readonly', 'classroom.announcements.readonly', 'classroom.coursework.me.readonly',
  'classroom.courseworkmaterials.readonly', 'drive.readonly'];

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
// A reply's quoted original ("On <date> ... wrote:" and ">" lines) is dropped: the original is read on its own.
const stripQuoted = (t) => t.split(/^On .{5,200}?wrote:\s*$/ms)[0].split('\n').filter((l) => !l.startsWith('>')).join('\n').trim();

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const READABLE = /\.(pdf|png|jpe?g|heic|webp)$/i;

/** School mails after `afterMs`, oldest first, with text of PDF/image attachments. */
export async function fetchSchoolMails(afterMs) {
  // Skipped: Classroom notification emails (posts come from the Classroom API) and mail sent from this account.
  const q = encodeURIComponent(`${schoolQuery()} -from:classroom.google.com -in:sent after:${Math.floor(afterMs / 1000)}`);
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
    let text = stripQuoted(plain ? unb64(plain.body.data).toString() : html ? htmlToText(unb64(html.body.data).toString()) : '');
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

// ── WhatsApp ───────────────────────────────────────────────────────────────

/** Opens WhatsApp (`login`: link this Mac with a QR) and adds the school bot's lookups. Chat ids are cached in the store. */
export async function schoolWhatsApp({ cfg, env, store, login = false }) {
  const wa = await openWhatsApp({ dir: path.resolve(ROOT, expandHome(cfg.whatsappDir)), chromePath: cfg.chromePath, login });
  const { client } = wa;
  let contacts;
  // Chat IDs are looked up by saved name once (scanning contacts is slow), then cached.
  async function chatId(key, pred, label) {
    const cached = store?.get(key);
    if (cached) return cached;
    contacts ??= await client.getContacts();
    let found = [...new Map(contacts.filter(pred).map((c) => [c.id._serialized, c])).values()]; // de-duplicate
    if (found.length > 1) found = found.filter((c) => c.id.server !== 'lid');
    if (found.length !== 1) throw new Error(`WhatsApp: expected 1 contact "${label}", found ${found.length}`);
    store?.set(key, found[0].id._serialized);
    return found[0].id._serialized;
  }

  return {
    close: wa.close,
    /** Chat id of the digest's group (checks the name is unique). */
    async groupId() {
      let id = store.get('wa_group');
      if (!id) { id = await wa.findGroup(env.GROUP_NAME); store.set('wa_group', id); }
      return id;
    },

    /** The teacher's messages after `sinceSec`, with image/PDF text added via OCR. */
    async readTeacherMessages(sinceSec) {
      const id = await chatId('wa_teacher', (c) => !c.isGroup && c.name === env.TEACHER_CHAT_NAME, env.TEACHER_CHAT_NAME);
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
      let lid = store.get('wa_mention_lid');
      if (!lid) {
        const suffix = env.MENTION_NUMBER_ENDS_WITH;
        const phoneId = await chatId('wa_mention_phone',
          (c) => !c.isGroup && c.isMyContact && c.name === env.MENTION_NAME && (!suffix || c.id.user.endsWith(suffix)), env.MENTION_NAME);
        lid = (await client.getContactLidAndPhone([phoneId]))[0]?.lid || phoneId;
        store.set('wa_mention_lid', lid);
      }
      return { id: lid, token: '@' + lid.split('@')[0] };
    },

    async sendToGroup(text, mentionId) {
      const id = await this.groupId();
      await sleep(1000 + Math.random() * 2000); // small human-like pause
      await wa.send(id, text, { mentions: [mentionId], linkPreview: undefined }); // WhatsApp's default preview, as before
    },

    sendToSelf: (text) => wa.send(client.info.wid._serialized, text, { linkPreview: undefined }),
  };
}
