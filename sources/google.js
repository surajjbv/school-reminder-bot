// The kid's school Google account, read-only: Gmail, Classroom and attached Drive files.
import fs from 'node:fs';
import path from 'node:path';
import { googleApi } from '../kit/google.js';
import { log } from '../kit/log.js';
import { istDate } from '../rules.js';
import { driveLinks, fileText, htmlToText, sheetText } from './text.js';

const DATA = path.join(import.meta.dirname, '..', 'data');
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
