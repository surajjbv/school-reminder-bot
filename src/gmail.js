import { config } from './config.js';
import { istDate } from './dates.js';
import { htmlToText } from './extract.js';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

async function accessToken() {
  const { googleClientId, googleClientSecret, googleRefreshToken } = config;
  if (!googleRefreshToken) throw new Error('GOOGLE_REFRESH_TOKEN missing: run `npm run login:google`');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: googleClientId, client_secret: googleClientSecret,
      refresh_token: googleRefreshToken, grant_type: 'refresh_token',
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`Google token refresh failed: ${body.error}`); // never log the body itself
  return body.access_token;
}

const b64 = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

function bodyText(payload) {
  const parts = [];
  const walk = (p) => {
    if (p.body?.data && /^text\/(plain|html)/.test(p.mimeType)) parts.push({ type: p.mimeType, text: b64(p.body.data) });
    (p.parts || []).forEach(walk);
  };
  walk(payload);
  const plain = parts.find((p) => p.type === 'text/plain');
  const html = parts.find((p) => p.type === 'text/html');
  // Keep raw HTML too: it carries Drive/Classroom links the plain part may drop.
  return { text: plain ? plain.text : html ? htmlToText(html.text) : '', raw: parts.map((p) => p.text).join('\n') };
}

/** The kid's school mails received after `afterMs`, oldest first. */
export async function fetchSchoolMails(afterMs) {
  const token = await accessToken();
  const get = async (url) => {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Gmail ${res.status} for ${url.split('?')[0]}`);
    return res.json();
  };
  const q = `${config.schoolQuery} after:${Math.floor(afterMs / 1000)}`;
  const ids = [];
  let pageToken = '';
  do {
    const r = await get(`${API}/messages?maxResults=100&q=${encodeURIComponent(q)}${pageToken ? `&pageToken=${pageToken}` : ''}`);
    ids.push(...(r.messages || []).map((m) => m.id));
    pageToken = r.nextPageToken;
  } while (pageToken);

  const mails = [];
  for (const id of ids) {
    const m = await get(`${API}/messages/${id}?format=full`);
    const header = (n) => m.payload.headers.find((h) => h.name.toLowerCase() === n)?.value || '';
    const { text, raw } = bodyText(m.payload);
    const ms = Number(m.internalDate);
    mails.push({ id, ms, date: istDate(ms), subject: header('subject'), from: header('from'), text, raw });
  }
  return mails.sort((a, b) => a.ms - b.ms);
}

/** Classroom post URL hidden in the "See details" AccountChooser link. */
export function classroomPostUrl(raw) {
  for (const m of raw.matchAll(/continue=(https:\/\/classroom\.google\.com\/c\/[^&"\s>]+)/g)) {
    const url = decodeURIComponent(m[1]).split('?')[0];
    if (/\/p\//.test(url)) return url;
  }
  return null;
}
