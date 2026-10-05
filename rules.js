// Decisions and text, no I/O: the model's task extraction (prompt, schema), the code-side rules (grounded dates,
// dedupe, what to send) and the digest.
import { BadReply, log } from './kit.js';

const MIN_CONFIDENCE = 0.5;
const MAX_AHEAD_DAYS = 60;

/** The bot's tables in data/bot.db (kv and processed come from kit.js). */
export const SCHEMA = `
  CREATE TABLE IF NOT EXISTS watched (id TEXT PRIMARY KEY, modified TEXT, first_seen TEXT); -- attached Sheets/Docs re-checked for edits
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY, kid TEXT, action_line TEXT, due_date TEXT,
    date_unclear INTEGER DEFAULT 0, last_sent TEXT, confidence REAL, source_id TEXT, first_seen TEXT, posted TEXT,
    docs TEXT); -- Drive files the task was read from (',id1,id2,')
  CREATE TABLE IF NOT EXISTS sent (id INTEGER PRIMARY KEY, day TEXT, slot TEXT, text TEXT, at TEXT);`;

// ── dates (IST calendar days, 'YYYY-MM-DD') ───────────────────────────────
const TZ = 'Asia/Kolkata';
export const istDate = (d = new Date()) => new Date(d).toLocaleDateString('en-CA', { timeZone: TZ });
export const istTime = (d = new Date()) => new Date(d).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
export function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function pretty(ymd) { // 'Tue 29 Sep'
  const d = new Date(ymd + 'T00:00:00Z');
  return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}
const isValidYmd = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;

// ── task rules ────────────────────────────────────────────────────────────
// Max 12 words; if cut, don't end on a dangling number or small word ("...ID card 30").
function shorten(line) {
  const w = line.split(' ');
  if (w.length <= 12) return line;
  const cut = w.slice(0, 12);
  while (cut.length > 1 && /^(\d+|and|or|to|for|with|by|of|the|a|an|in|on|at|before|after|from)$/i.test(cut.at(-1))) cut.pop();
  return cut.join(' ');
}

// A due date is kept only if the model quotes the words that state it, and they really are in the message.
const norm = (s) => String(s).toLowerCase().replace(/[*_]/g, '').replace(/\s+/g, ' ').trim(); // ignore email bold/italic marks
// Must look like a date or day: 29/09, 2026-10-01, 2nd October, Oct 2, Friday, tomorrow, next week.
const DATE_WORDS = /\d{1,4}[/.-]\d{1,2}|\b\d{1,2}(st|nd|rd|th)?\s*(of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b(mon|tues?|wed(nes)?|thu(rs)?|fri|sat(ur)?|sun)(day)?\b|\b(today|tonight|tomorrow|next week)\b/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const ymd = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * The due date, taken from the words the model quoted. A quote with an explicit day and month
 * (29/09, 2026-10-01, 2nd October, Oct 2) decides the date itself; a relative quote
 * ("tomorrow", "Friday") keeps the model's resolved date. No usable quote in the message -> null.
 */
function groundedDate(quote, source, modelDate, today) {
  if (!quote || !DATE_WORDS.test(quote) || !norm(source).includes(norm(quote))) return null;
  const q = quote.toLowerCase();
  const year = Number(today.slice(0, 4));
  const pick = (m, d) => { // the year closest to today
    const dates = [year - 1, year, year + 1].map((y) => ymd(y, m, d)).filter(isValidYmd);
    return dates.sort((a, b) => Math.abs(daysBetween(today, a)) - Math.abs(daysBetween(today, b)))[0] ?? null;
  };
  const iso = q.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) { const v = ymd(iso[1], iso[2], iso[3]); return isValidYmd(v) ? v : null; }
  const dm = q.match(/\b(\d{1,2})[/.-](\d{1,2})\b/);
  if (dm) return pick(+dm[2], +dm[1]);
  const named = q.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:of\s+)?([a-z]{3})/) || q.match(/\b([a-z]{3})[a-z]*\.?\s+(\d{1,2})\b/);
  if (named) {
    const [day, mon] = /\d/.test(named[1]) ? [named[1], named[2]] : [named[2], named[1]];
    if (MONTHS.includes(mon)) return pick(MONTHS.indexOf(mon) + 1, +day);
  }
  return isValidYmd(modelDate) ? modelDate : null;
}

/** Clean model tasks, or drop them with a reason. Kid and source come from the source, not the model. */
export function validateTasks(raw, { kid, sourceId, today, sourceText = '', posted = null }) {
  const ok = [];
  const dropped = [];
  for (const t of raw) {
    const line = String(t?.action_line || '').replace(/\s+/g, ' ').trim().replace(/[.!]+$/, '');
    const conf = Number(t?.confidence ?? 1); // some models (e.g. Gemma) omit it when certain
    if (!line) { dropped.push({ t, why: 'empty action_line' }); continue; }
    if (conf < MIN_CONFIDENCE) { dropped.push({ t, why: `low confidence ${conf}` }); continue; }
    if (/\b(otp|one[- ]time|password|verification code)\b/i.test(line)) { dropped.push({ t, why: 'mentions a login/OTP code' }); continue; }
    let due = sourceText ? groundedDate(t?.date_source, sourceText, t?.due_date, today) : (isValidYmd(t?.due_date) ? t.due_date : null);
    if (isValidYmd(t?.due_date) && due !== t.due_date) log.info(`date for "${line}": model said ${t.due_date}, message says ${due ?? 'nothing'} (quote: ${JSON.stringify(t?.date_source ?? null)})`);
    if (due && due < today) { dropped.push({ t, why: `due date ${due} is past` }); continue; }
    if (due && daysBetween(today, due) > MAX_AHEAD_DAYS) { dropped.push({ t, why: `due date ${due} over ${MAX_AHEAD_DAYS} days away` }); continue; }
    ok.push({ kid, action_line: shorten(line), due_date: due, date_unclear: due ? 0 : 1, confidence: conf, source_id: sourceId, posted });
  }
  return { ok, dropped };
}

const STOP = new Set(['the', 'an', 'to', 'for', 'and', 'of', 'on', 'in', 'by', 'before', 'with', 'your', 'child', 'school', 'please', 'kindly']);
// Words that matter for comparing tasks: no numbers/dates, no filler.
const words = (s) => new Set(s.toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w)));
function similar(a, b) {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return a.toLowerCase() === b.toLowerCase();
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  // Mostly the same words, or the shorter wording is (almost) contained in the longer one.
  return inter / (A.size + B.size - inter) >= 0.6 || inter / Math.min(A.size, B.size) >= 0.8;
}
// Same kid, same (or both unclear) date, near-identical wording.
export const isDuplicate = (t, existing) =>
  existing.some((x) => x.kid === t.kid && (x.due_date ?? null) === (t.due_date ?? null) && similar(x.action_line, t.action_line));

/**
 * Store new tasks, skipping duplicates. `docs`: Drive files the tasks were read from. `editedDoc`: the
 * tasks come from re-reading that file after an edit; an upcoming task read from it earlier whose date
 * the file no longer gives is the same task with a corrected date, so its date is updated, not copied.
 */
export function saveTasks(db, tasks, today, { docs = [], editedDoc = null } = {}) {
  const existing = db.prepare('SELECT id, kid, action_line, due_date FROM tasks').all();
  const insert = db.prepare('INSERT INTO tasks (kid, action_line, due_date, date_unclear, confidence, source_id, first_seen, posted, docs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  // Earlier tasks from the edited file that none of the new tasks repeats with the same date.
  const stale = !editedDoc ? [] : db.prepare("SELECT * FROM tasks WHERE docs LIKE ? AND (due_date >= ? OR due_date IS NULL)")
    .all(`%,${editedDoc},%`, today).filter((x) => !isDuplicate(x, tasks));
  let added = 0;
  for (const t of tasks) {
    if (isDuplicate(t, existing)) continue;
    const old = stale.find((x) => x.kid === t.kid && similar(x.action_line, t.action_line));
    if (old) {
      stale.splice(stale.indexOf(old), 1);
      db.prepare('UPDATE tasks SET due_date = ?, date_unclear = ?, source_id = ? WHERE id = ?').run(t.due_date, t.date_unclear, t.source_id, old.id);
      existing.find((x) => x.id === old.id).due_date = t.due_date;
      log.info(`date changed in ${editedDoc}: "${old.action_line}" ${old.due_date ?? 'undetermined'} -> ${t.due_date ?? 'undetermined'}`);
      continue;
    }
    insert.run(t.kid, t.action_line, t.due_date, t.date_unclear, t.confidence, t.source_id, today, t.posted ?? null, docs.length ? `,${docs.join(',')},` : null);
    existing.push(t);
    added++;
  }
  return added;
}

/**
 * What to send. First message of the day: everything still due (reminded daily until the due
 * date; unclear-date tasks only once). Later the same day: only tasks never sent before.
 */
export function tasksToSend(db, today, newOnly) {
  const due = [
    ...db.prepare('SELECT * FROM tasks WHERE date_unclear = 0 AND due_date >= ? AND first_seen <= ?').all(today, today),
    ...db.prepare('SELECT * FROM tasks WHERE date_unclear = 1 AND last_sent IS NULL').all(),
  ];
  return newOnly ? due.filter((t) => !t.last_sent) : due;
}
export function markSent(db, tasks, today) {
  const update = db.prepare('UPDATE tasks SET last_sent = ? WHERE id = ?');
  for (const t of tasks) update.run(today, t.id);
}

/**
 * WhatsApp message, made for a narrow phone screen: each kid once in bold, then one line per task,
 * soonest first, with a short date up front ("Today", "Tmrw", "Fri", "12 Oct") so it isn't lost when
 * the line wraps. Day-and-month dates are avoided in the header, as WhatsApp underlines them as links.
 */
export function buildDigest(tasks, today, mention, newOnly = false, footer = null) {
  if (!tasks.length) return null;
  const short = (ymd) => pretty(ymd).slice(4); // '13 Sep'
  const line = (t) => {
    const days = t.due_date && daysBetween(today, t.due_date);
    const task = t.action_line // the kid's name is the heading: "Register Anu for ..." -> "Register for ..."
      .replace(new RegExp(`\\s*\\b${t.kid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}('s)?\\b`, 'gi'), '').replace(/[*_~`]/g, '').trim();
    if (!t.due_date) return `❓ ${task}${t.posted ? ` (posted ${short(t.posted)})` : ''}`;
    if (days === 0) return `🔴 Today: ${task}`;
    if (days === 1) return `🟠 Tmrw: ${task}`;
    return `• ${days < 7 ? pretty(t.due_date).slice(0, 3) : short(t.due_date)}: ${task}`;
  };
  const sorted = [...tasks].sort((a, b) => a.kid.localeCompare(b.kid) || (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999'));
  const out = [`${mention} ${newOnly ? '🆕 New school tasks' : '🎒 School'} · ${pretty(today).slice(0, -4)}`];
  // A blank line between tasks, so wrapped lines don't run together; the kid's name sits on its first task.
  for (const [kid, list] of Map.groupBy(sorted, (t) => t.kid)) out.push(...list.map((t, i) => (i ? '' : `*${kid}*\n`) + line(t)));
  if (footer) out.push(`🤖 ${footer}`); // which model this run used
  return out.join('\n\n');
}

// ── the model ─────────────────────────────────────────────────────────────
const SYSTEM = `You extract action items for a parent from school messages (emails, class announcements, spreadsheets, teacher WhatsApp messages, OCR text of notices).
Return ONLY JSON: {"tasks":[{"action_line":"...","due_date":"YYYY-MM-DD or null","date_source":"exact words from the message that state the date, or null","confidence":0.0-1.0}]}
Rules:
- action_line: starts with a verb, max 12 words, concrete, no dates in it (keep a specific time like "2:15 PM"). Use only what the message says; never invent tasks.
- Only things the parent/child must DO or BRING, or dated events to attend. Invitations to school events or competitions the child can join count (e.g. register/attend). Ignore circulars with no action, recaps of past events, greetings.
- "View/see/access/check the attachment, picture, folder, link or timetable" is NOT a task.
- Messages written TO the school (leave notes, "I will be late") or by other parents (e.g. "I have paid the fee") contain no tasks.
- Lines like "Completed pg 10", "Introduction of ...", "Reinforcement of ..." describe class work already done: they are NOT tasks. In weekly-update sheets, tasks are under "Practice work"/"Submission Dates" and "Requirements".
- Ignore OTP / verification-code / password emails completely, and never put any code or password in action_line.
- Resolve relative dates ("tomorrow", "Monday", "29/09") against the message date. Dates are Indian format (DD/MM). Timezone IST.
- Skip tasks whose due date is before Today (e.g. older weeks in a homework sheet).
- For deadlines ("fill form by 18th") use that deadline as due_date.
- Registration/sign-up for an event with no stated deadline: due_date is the event date. Merge "register" and "attend" for the same event into one task.
- NEVER guess a date. due_date only if the message itself states the date or day for that task; copy those exact words into date_source. Otherwise due_date and date_source are null.
- One task per distinct action, at most 10, most important first. No tasks -> {"tasks":[]}.`;
const TASKS = { type: 'object', additionalProperties: false, required: ['tasks'], properties: { tasks: { type: 'array', maxItems: 10, items: {
  type: 'object', additionalProperties: false, required: ['action_line', 'due_date', 'date_source', 'confidence'],
  properties: { action_line: { type: 'string' }, due_date: { type: ['string', 'null'] }, date_source: { type: ['string', 'null'] }, confidence: { type: 'number' } } } } } };

/** Raw model tasks for one source item, or null if the reply was unusable twice. `ask`: kit llm.ask (tests stub it). */
export async function extractTasks(item, today, ask) {
  const user = `Kid: ${item.kid}\nSource: ${item.kind}\nMessage date: ${item.date} (${pretty(item.date)})\nToday: ${today} (${pretty(today)})\n---\n${item.text.slice(0, 30000)}`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try { return (await ask({ system: SYSTEM, user, schema: TASKS, maxTokens: 1000, name: 'tasks' })).tasks; } catch (err) {
      if (!(err instanceof BadReply)) throw err;
      (attempt === 1 ? log.warn : log.error)(`${attempt === 1 ? 'unusable reply' : 'skipping'} for ${item.sourceId} (${err.message})${attempt === 1 ? ', retrying' : ''}`);
    }
  }
  return null;
}
