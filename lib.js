// Shared helpers: config, logging, dates, storage, task rules, text extraction, local model.
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as XLSX from 'xlsx';

// ── config ────────────────────────────────────────────────────────────────
export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const DATA = path.join(ROOT, 'data');
fs.mkdirSync(DATA, { recursive: true });
if (fs.existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));

const e = process.env;
export const config = {
  googleClientId: e.GOOGLE_CLIENT_ID,
  googleClientSecret: e.GOOGLE_CLIENT_SECRET,
  googleRefreshToken: e.GOOGLE_REFRESH_TOKEN,
  emailKid: e.EMAIL_KID_NAME,
  schoolQuery: e.SCHOOL_GMAIL_QUERY || '-from:accounts.google.com',
  chatKid: e.CHAT_KID_NAME,
  teacherChat: e.TEACHER_CHAT_NAME,
  groupName: e.GROUP_NAME,
  mentionName: e.MENTION_NAME,
  mentionNumberEndsWith: e.MENTION_NUMBER_ENDS_WITH,
  model: e.MODEL || 'lmstudio-community/gemma-4-26B-A4B-it-QAT-MLX-4bit',
  modelFallback: e.MODEL_FALLBACK ?? 'lmstudio-community/Qwen3.5-9B-MLX-4bit', // if LM Studio lacks memory for MODEL; empty = none
  // How far back the very first run reads; later runs read everything since the last run.
  emailLookbackDays: Number(e.EMAIL_LOOKBACK_DAYS || 14),
  whatsappLookbackDays: Number(e.WHATSAPP_LOOKBACK_DAYS || 14),
  // Send times (IST). Each one is retried until sent, up to the next send time (tomorrow's, for a single time).
  runTimes: (e.RUN_TIMES || '20:00').split(',').map((t) => t.trim().padStart(5, '0')).filter((t) => /^\d\d:\d\d$/.test(t)).sort(),
  chromePath:e.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
};
const MIN_CONFIDENCE = 0.5;
const MAX_AHEAD_DAYS = 60;

export function requireConfig(...keys) {
  const missing = keys.filter((k) => !config[k]);
  if (missing.length) throw new Error(`Missing in .env: ${missing.join(', ')} (see .env.example)`);
}

// ── logging (data/bot.log; tests use data/test.log) ───────────────────────
const LOG = path.join(DATA, process.env.NODE_TEST_CONTEXT ? 'test.log' : 'bot.log');
try { if (fs.statSync(LOG).size > 2e6) fs.renameSync(LOG, LOG + '.1'); } catch { /* no log yet */ }
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (c, s) => (tty ? `\x1b[${c}m${s}\x1b[0m` : s);
const STYLE = { INFO: '36', WARN: '33', ERROR: '1;31', SENT: '1;32' };
let step = 'startup';

// Callers must never pass secrets.
function write(level, msg) {
  fs.appendFileSync(LOG, `${new Date().toISOString()} ${level} ${msg}\n`);
  console.log(`${paint('2', new Date().toLocaleTimeString('en-GB', { hour12: false }))} ${paint(STYLE[level], level.padEnd(5))} ${msg}`);
}
export const log = {
  info: (m) => write('INFO', m),
  warn: (m) => write('WARN', m),
  error: (m) => write('ERROR', m),
  sent: (m) => write('SENT', m),
  step: (n, m) => {
    step = `[${n}/5] ${m}`;
    fs.appendFileSync(LOG, `${new Date().toISOString()} STEP  ${step}\n`);
    console.log(`\n${paint('1;35', `[${n}/5]`)} ${paint('1', m)}`);
  },
  failed: (err) => write('ERROR', `run FAILED during ${step}: ${err?.message}\n${err?.stack || ''}`),
  currentStep: () => step,
  box: (title, body) => console.log(`\n${paint('1;32', `── ${title} ──`)}\n${body}\n${paint('1;32', '─'.repeat(title.length + 6))}`),
};

// ── dates (IST calendar days, 'YYYY-MM-DD') ───────────────────────────────
const TZ = 'Asia/Kolkata';
export const istDate = (d = new Date()) => new Date(d).toLocaleDateString('en-CA', { timeZone: TZ });
export const istTime = (d = new Date()) => new Date(d).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
export function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/** The send time now being worked on: the latest one already passed, e.g. '2026-09-29 20:00' until 20:00 on the 30th. */
export function currentSlot(now = new Date()) {
  const [today, time] = [istDate(now), istTime(now)];
  const passed = config.runTimes.filter((t) => t <= time);
  return passed.length ? `${today} ${passed.at(-1)}` : `${addDays(today, -1)} ${config.runTimes.at(-1)}`;
}
const daysBetween =(a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function pretty(ymd) { // 'Tue 29 Sep'
  const d = new Date(ymd + 'T00:00:00Z');
  return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}
const isValidYmd = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;

// ── storage ───────────────────────────────────────────────────────────────
export function openDb(file = path.join(DATA, 'bot.db')) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS processed (source_id TEXT PRIMARY KEY, at TEXT);
    DROP TABLE IF EXISTS docs;
    CREATE TABLE IF NOT EXISTS watched (id TEXT PRIMARY KEY, modified TEXT, first_seen TEXT); -- attached Sheets/Docs re-checked for edits
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY, kid TEXT, action_line TEXT, due_date TEXT,
      date_unclear INTEGER DEFAULT 0, last_sent TEXT, confidence REAL, source_id TEXT, first_seen TEXT, posted TEXT);
    CREATE TABLE IF NOT EXISTS sent (id INTEGER PRIMARY KEY, day TEXT, slot TEXT, text TEXT, at TEXT);
  `);
  try { db.exec('ALTER TABLE tasks ADD COLUMN posted TEXT'); } catch { /* already there */ } // databases from before 'posted'
  return db;
}
export const kvGet = (db, k) => db.prepare('SELECT value FROM kv WHERE key = ?').get(k)?.value;
export const kvSet = (db, k, v) => db.prepare('INSERT INTO kv VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));
export const isProcessed = (db, id) => !!db.prepare('SELECT 1 FROM processed WHERE source_id = ?').get(id);
export const markProcessed = (db, id) => db.prepare('INSERT OR IGNORE INTO processed VALUES (?, ?)').run(id, new Date().toISOString());

// ── task rules ────────────────────────────────────────────────────────────
export function parseModelJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no JSON object');
  const obj = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(obj.tasks)) throw new Error('missing tasks array');
  return obj.tasks;
}

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

export function saveTasks(db, tasks, today) {
  const existing = db.prepare('SELECT kid, action_line, due_date FROM tasks').all();
  const insert = db.prepare('INSERT INTO tasks (kid, action_line, due_date, date_unclear, confidence, source_id, first_seen, posted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  let added = 0;
  for (const t of tasks) {
    if (isDuplicate(t, existing)) continue;
    insert.run(t.kid, t.action_line, t.due_date, t.date_unclear, t.confidence, t.source_id, today, t.posted ?? null);
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
export function buildDigest(tasks, today, mention, newOnly = false) {
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
  return out.join('\n\n');
}

// ── text extraction ───────────────────────────────────────────────────────
const OCR_BIN = path.join(DATA, 'ocr');

/** OCR an image, or text from a PDF (OCR for scanned pages). Builds the macOS helper on first use. */
export function fileText(file) {
  if (!fs.existsSync(OCR_BIN)) execFileSync('swiftc', ['-O', path.join(ROOT, 'ocr.swift'), '-o', OCR_BIN]);
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

// ── local model (LM Studio) ───────────────────────────────────────────────
// Reuses the model if it's already loaded (and leaves it loaded); otherwise loads it,
// and unloads it on exit, including on errors and Ctrl-C. If LM Studio would refuse MODEL
// for lack of memory, MODEL_FALLBACK is used instead.
const LMS = path.join(os.homedir(), '.lmstudio/bin/lms');
const MODEL_ID = 'school-reminder-bot';
const CONTEXT = '16384';
const lms = async (...a) => (await promisify(execFile)(LMS, a, { encoding: 'utf8' })).stdout;
let model = null; // { id, key, owned, startedServer }

export async function ensureModel() {
  const startedServer = !JSON.parse(await lms('server', 'status', '--json')).running;
  if (startedServer) await lms('server', 'start');
  const loaded = JSON.parse(await lms('ps', '--json'));
  // Our own identifier means a copy left behind by a crashed run: use it, then unload it.
  const leftover = loaded.find((m) => m.identifier === MODEL_ID);
  if (leftover) {
    model = { id: MODEL_ID, key: leftover.modelKey, owned: true, startedServer };
    return log.info(`model already loaded, reusing it (${leftover.modelKey})`);
  }
  const names = [config.model, config.modelFallback].filter(Boolean);
  for (const name of names) {
    const matches = (m) => [m.modelKey, m.path, m.indexedModelIdentifier].includes(name);
    const running = loaded.find(matches);
    if (running) {
      model = { id: running.identifier, key: running.modelKey, owned: false, startedServer };
      return log.info(`model already loaded, reusing it (${running.identifier})`);
    }
    const key = JSON.parse(await lms('ls', '--json')).find(matches)?.modelKey;
    if (!key) throw new Error(`Model "${name}" is not downloaded in LM Studio`);
    // LM Studio's memory guardrails: ask first whether it would refuse this model right now.
    if (/will fail to load/i.test(await lms('load', key, '--estimate-only', '--context-length', CONTEXT))) {
      log.warn(`not enough free memory for ${key} (LM Studio guardrails)`);
      continue;
    }
    model = { id: MODEL_ID, key, owned: true, startedServer }; // set first so a crash mid-load still cleans up
    try {
      await lms('load', key, '--identifier', MODEL_ID, '--context-length', CONTEXT, '-y');
    } catch (err) {
      if (!/memory|resource|guardrail/i.test(err.message) || name === names.at(-1)) throw err;
      log.warn(`LM Studio could not load ${key} for lack of memory, trying the fallback`);
      continue;
    }
    return log.info(`model loaded: ${key}`);
  }
  throw new Error(`Not enough free memory to load ${names.join(' or ')}: close other apps or models`);
}

/** Unload the model only if this run loaded it. Synchronous so it also works in the exit handler. */
export function releaseModel() {
  if (!model) return;
  const { owned, startedServer } = model;
  model = null;
  const run = (...a) => execFileSync(LMS, a, { stdio: 'ignore' });
  if (owned) try { run('unload', MODEL_ID); log.info('model unloaded'); } catch (err) { log.warn(`model unload failed: ${err.message}`); }
  if (startedServer) try { run('server', 'stop'); } catch { /* already stopped */ }
}
process.on('exit', releaseModel);

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

// Deterministic extraction: temperature 0, thinking off, capped reply length.
const GEN = { temperature: 0, max_tokens: 1000 };
const post = async (path, body) => {
  const res = await fetch(`http://127.0.0.1:1234${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: model?.id ?? MODEL_ID, ...GEN, ...body }), signal: AbortSignal.timeout(5 * 60 * 1000),
  });
  if (!res.ok) throw new Error(`LM Studio ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
};

async function complete(messages) {
  if (/qwen/i.test(model?.key ?? config.model)) {
    // Qwen thinks by default; its own chat format ending in an empty <think> block switches that off (~10x faster).
    const prompt = messages.map((m) => `<|im_start|>${m.role}\n${m.content}<|im_end|>\n`).join('') + '<|im_start|>assistant\n<think>\n\n</think>\n\n';
    return (await post('/v1/completions', { prompt, stop: ['<|im_end|>'] })).choices[0].text;
  }
  // Others (e.g. Gemma 4): LM Studio applies the model's own template; Gemma's thinking is off unless enabled.
  return (await post('/v1/chat/completions', { messages })).choices[0].message.content;
}

/** Raw model tasks for one source item, or null if the reply was invalid twice. */
export async function extractTasks(item, today) {
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `Kid: ${item.kid}\nSource: ${item.kind}\nMessage date: ${item.date} (${pretty(item.date)})\nToday: ${today} (${pretty(today)})\n---\n${item.text.slice(0, 30000)}` },
  ];
  let reply = await complete(messages);
  try { return parseModelJson(reply); } catch (err) { log.warn(`bad JSON for ${item.sourceId} (${err.message}), retrying`); }
  messages.push({ role: 'assistant', content: reply }, { role: 'user', content: 'That was not valid JSON. Reply with ONLY the JSON object.' });
  reply = await complete(messages);
  try { return parseModelJson(reply); } catch (err) {
    log.error(`skipping ${item.sourceId}: invalid JSON after retry (${err.message})`);
    return null;
  }
}
