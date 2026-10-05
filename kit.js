// kit.js: the shared part of the local LLM bots, one file. Every bot keeps its own copy (the same in each; tests in
// kit.test.js). Sections: config · log · notify · store · llm (lease protocol) · google · whatsapp · runBot ·
// scheduler (`node kit.js schedule | unschedule | tick`).
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const ROOT = import.meta.dirname; // the bot's folder
export const DATA = path.join(ROOT, 'data');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// ── config: .env = personal values (names, IDs, tokens); config.json = everything public, validated ──────────
export const KIT_DEFAULTS = {
  model: 'qwen3.8-27b-mlx', // LM Studio model key; the load profile is fixed (PROFILE)
  timezone: 'Asia/Kolkata',
  runTimes: [], // the scheduler runs the bot once per run time ("HH:MM" in timezone)
  takeoverIdleMinutes: 5, // another app's model idle this long may be unloaded to make room
  chromePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
};
export class ConfigError extends Error {}
const kind = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
export const expandHome = (p) => p.replace(/^~(?=\/|$)/, os.homedir());

/** config.json merged over the defaults, or a ConfigError listing every problem ("_comment" keys are skipped). */
export function readConfigJson(root = ROOT, defaults = {}) {
  const base = { ...KIT_DEFAULTS, ...defaults };
  const file = path.join(root, 'config.json');
  let json = {};
  try { if (fs.existsSync(file)) json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new ConfigError(`config.json: ${e.message}`); }
  const problems = [];
  for (const [k, v] of Object.entries(json)) {
    if (k.startsWith('_')) continue;
    if (!(k in base)) problems.push(`unknown key "${k}"`);
    else if (base[k] !== null && kind(v) !== kind(base[k])) problems.push(`"${k}" must be ${kind(base[k])}, not ${kind(v)}`);
  }
  const cfg = { ...base, ...Object.fromEntries(Object.entries(json).filter(([k]) => !k.startsWith('_'))) };
  if (!cfg.runTimes.every((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t))) problems.push('"runTimes" must be "HH:MM" times');
  try { new Intl.DateTimeFormat('en', { timeZone: cfg.timezone }); } catch { problems.push(`"timezone" "${cfg.timezone}" is not a time zone`); }
  for (const [k, v] of Object.entries(cfg)) if (typeof v === 'number' && !(v >= 0)) problems.push(`"${k}" must be a number >= 0`);
  if (problems.length) throw new ConfigError(`config.json: ${problems.join('; ')}`);
  return cfg;
}

/** .env + config.json. `env`: required .env keys, `optionalEnv`: others the bot reads. Adds env, unusedEnv, data. */
export function loadConfig({ defaults = {}, env = [], optionalEnv = [] } = {}, root = ROOT) {
  const envFile = path.join(root, '.env');
  const known = new Set([...env, ...optionalEnv]);
  let unusedEnv = [];
  if (fs.existsSync(envFile)) {
    process.loadEnvFile(envFile);
    unusedEnv = [...fs.readFileSync(envFile, 'utf8').matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=/gm)].map((m) => m[1]).filter((k) => !known.has(k));
  }
  const cfg = readConfigJson(root, defaults);
  const missing = env.filter((k) => !process.env[k]?.trim());
  if (missing.length) throw new ConfigError(`missing in .env: ${missing.join(', ')} (see .env.example)`);
  const data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  return { ...cfg, data, unusedEnv, env: Object.fromEntries([...known].map((k) => [k, process.env[k]?.trim() ?? ''])) };
}

const zoneParts = (d, timeZone) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
  timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).formatToParts(d).map((p) => [p.type, p.value]));

/** The latest run time already passed, 'YYYY-MM-DD HH:MM' in `timezone` (yesterday's last before today's first). */
export function currentSlot(runTimes, timezone, now = new Date()) {
  if (!runTimes.length) return null;
  const p = zoneParts(now, timezone);
  const times = [...runTimes].sort();
  const passed = times.filter((t) => t <= `${p.hour}:${p.minute}`);
  if (passed.length) return `${p.year}-${p.month}-${p.day} ${passed.at(-1)}`;
  const y = zoneParts(new Date(now - 864e5), timezone);
  return `${y.year}-${y.month}-${y.day} ${times.at(-1)}`;
}

/** Seconds since `slot` started (its wall-clock time in `timezone`). */
export function slotAge(slot, timezone, now = new Date()) {
  const asUtc = Date.parse(`${slot.replace(' ', 'T')}:00Z`);
  const p = zoneParts(new Date(asUtc), timezone);
  const offset = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`) - asUtc;
  return Math.round((now - (asUtc - offset)) / 1000);
}

// ── log: console + data/bot.log (data/test.log under node --test), 2 MB rotation, secrets masked ──────────
const SECRET_KEY = /TOKEN|SECRET|PASSWORD|MOBILE|PHONE|_KEY$/i;
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (c, s) => (tty ? `\x1b[${c}m${s}\x1b[0m` : s);
const STYLE = { DEBUG: '2', INFO: '36', WARN: '33', ERROR: '1;31', DONE: '1;32' };
let logFile = null;
let secrets = [];
let step = 'startup';

export function openLog(dataDir = DATA) {
  logFile = path.join(dataDir, process.env.NODE_TEST_CONTEXT ? 'test.log' : 'bot.log');
  try { if (fs.statSync(logFile).size > 2e6) fs.renameSync(logFile, `${logFile}.1`); } catch { /* no log yet */ }
  secrets = Object.entries(process.env).filter(([k, v]) => SECRET_KEY.test(k) && v?.length >= 4).map(([, v]) => v);
}
const mask = (s) => secrets.reduce((out, v) => out.split(v).join('***'), String(s));
function write(level, msg) {
  msg = mask(msg);
  if (logFile) fs.appendFileSync(logFile, `${new Date().toISOString()} ${level} ${msg}\n`);
  if (level === 'DEBUG' && !process.env.DEBUG) return;
  console.log(`${paint('2', new Date().toLocaleTimeString('en-GB', { hour12: false }))} ${paint(STYLE[level], level.padEnd(5))} ${msg}`);
}
export const log = {
  debug: (m) => write('DEBUG', m),
  info: (m) => write('INFO', m),
  warn: (m) => write('WARN', m),
  error: (m) => write('ERROR', m),
  done: (m) => write('DONE', m),
  /** A named stage of the run; a failure message says which one it was in. */
  step: (m) => { step = m; if (logFile) fs.appendFileSync(logFile, `${new Date().toISOString()} STEP  ${mask(m)}\n`); console.log(`\n${paint('1;35', '▸')} ${paint('1', mask(m))}`); },
  get currentStep() { return step; },
  /** A block of output (e.g. the message being sent), console only. */
  box: (title, body) => console.log(`\n${paint('1;32', `── ${title} ──`)}\n${mask(body)}\n${paint('1;32', '─'.repeat(title.length + 6))}`),
};

/** macOS notification; best effort, synchronous so it works just before exit. */
export function notify(title, message) {
  const clip = (s, n) => String(s).replace(/\s+/g, ' ').slice(0, n);
  try { execFileSync('osascript', ['-e', `display notification ${JSON.stringify(clip(message, 200))} with title ${JSON.stringify(clip(title, 80))}`], { stdio: 'ignore', timeout: 5000 }); } catch { /* no GUI */ }
}

// ── store: data/bot.db (node:sqlite) with kv + processed; bots add tables with `schema` ─────────────────────
/** `importJson(state, store)` runs once if data/state.json (the old format) exists; the file is then deleted. */
export function openStore(dataDir = DATA, { schema = '', importJson = null } = {}) {
  const db = new DatabaseSync(path.join(dataDir, 'bot.db'));
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS processed (source_id TEXT PRIMARY KEY, at TEXT);
    ${schema}`);
  const store = {
    db,
    /** Stored value (JSON-decoded; plain strings from older versions come back as they are). */
    get(key) {
      const v = db.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value;
      try { return v === undefined ? undefined : JSON.parse(v); } catch { return v; }
    },
    set: (key, value) => db.prepare('INSERT INTO kv VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value)),
    isProcessed: (id) => !!db.prepare('SELECT 1 FROM processed WHERE source_id = ?').get(id),
    markProcessed: (id) => db.prepare('INSERT OR IGNORE INTO processed VALUES (?, ?)').run(id, new Date().toISOString()),
    close() { if (db.isOpen) db.close(); },
  };
  const old = path.join(dataDir, 'state.json');
  if (importJson && fs.existsSync(old)) {
    db.exec('BEGIN');
    importJson(JSON.parse(fs.readFileSync(old, 'utf8')), store);
    db.exec('COMMIT');
    fs.rmSync(old);
  }
  return store;
}

// ── llm: one local model shared by independent bots through leases, and ask() ───────────────────────────────
// Lease protocol (the same in book-distiller-bot's llm.py). State in ~/.local/state/llm-lease/: `lock/` (atomic mkdir,
// stale after 120 s), `<bot>.<pid>` leases (dead pid = dead lease), `owned` (a bot, not a person, loaded the model).
// acquire: lock → drop dead leases → write ours → our model loaded with context >= 16384? use it. Else unload other
// models idle >= takeoverIdleMinutes, wait (15 s polls, 10 min) for busy ones, check the guardrail (--estimate-only),
// load PROFILE, write `owned`. Can't: remove our lease, exit 75. release (exit, SIGINT, SIGTERM, or early): lock →
// remove ours → drop dead → none left and `owned`? unload, delete `owned`. A person's model is never unloaded.
// TTL 600 s unloads it if every holder crashed. The server is started if off, never stopped.
/** Every bot loads exactly this, so any bot can reuse the model another one loaded. */
export const PROFILE = { identifier: 'qwen3.8-27b-mlx', context: 16384, parallel: 2, ttl: 600 };
const LMS = process.env.LMS_BIN || path.join(os.homedir(), '.lmstudio/bin/lms');
const LEASES = process.env.LLM_LEASE_DIR || path.join(os.homedir(), '.local/state/llm-lease');
const LOCK = path.join(LEASES, 'lock');
const OWNED = path.join(LEASES, 'owned');
// Qwen3.8 thinks by default. In the chat API an empty think block as the start of the reply switches that off
// (LM Studio's reasoning flags don't, and a JSON schema alone puts the answer into reasoning_content).
const NO_THINK = '<think>\n\n</think>\n\n';

/** The model can't be had now (busy, or too little free memory): runBot exits 75, retried quietly. */
export class ModelBusy extends Error {}
/** The model answered, but not with JSON matching the schema (bots usually skip that item). */
export class BadReply extends Error {}

let llmOpts = { bot: 'bot', model: PROFILE.identifier, takeoverIdleMinutes: 5, pollMs: 15000, waitMs: 600000, log: console };
let lease = null;
let pending = null;
const usage = { loadMs: 0, calls: 0, ms: 0 };

const lms = (...a) => execFileSync(LMS, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000 });
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const leaseFiles = () => fs.readdirSync(LEASES).filter((f) => /\.\d+$/.test(f));
const dropDead = () => leaseFiles().forEach((f) => alive(Number(f.split('.').pop())) || fs.rmSync(path.join(LEASES, f), { force: true }));

/** Runs fn holding the lock dir (atomic mkdir; one left by a crash is stale after 120 s). */
function locked(fn) {
  fs.mkdirSync(LEASES, { recursive: true });
  for (;;) {
    try { fs.mkdirSync(LOCK); break; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    try { if (Date.now() - fs.statSync(LOCK).mtimeMs > 120000) fs.rmdirSync(LOCK); } catch { /* just released */ }
    sleepSync(100);
  }
  try { return fn(); } finally { fs.rmSync(LOCK, { recursive: true, force: true }); }
}

/** One attempt: our identifier if the model is (now) loaded, else { busy } or { refused }. */
function tryAcquire() {
  return locked(() => {
    dropDead();
    fs.writeFileSync(lease, `${new Date().toISOString()}\n`);
    const ps = JSON.parse(lms('ps', '--json'));
    const ours = ps.find((m) => [m.modelKey, m.path, m.indexedModelIdentifier].includes(llmOpts.model) && m.contextLength >= PROFILE.context);
    if (ours) return ours.identifier;
    if (fs.existsSync(OWNED)) fs.rmSync(OWNED); // our load is gone (TTL), so the marker is stale
    const busy = [];
    for (const m of ps.filter((x) => x.type !== 'embedding')) {
      const idle = m.status === 'idle' && m.lastUsedTime ? (Date.now() - m.lastUsedTime) / 60000 : 0;
      if (idle < llmOpts.takeoverIdleMinutes) { busy.push(m.identifier); continue; }
      llmOpts.log.info(`unloading ${m.identifier}: idle for ${Math.floor(idle)} min`);
      lms('unload', m.identifier);
    }
    if (busy.length) return { busy };
    const profile = ['--context-length', String(PROFILE.context), '--parallel', String(PROFILE.parallel)];
    if (/will fail/i.test(lms('load', llmOpts.model, '--estimate-only', ...profile, '-y'))) return { refused: `LM Studio's memory guardrail would refuse ${llmOpts.model} now` };
    llmOpts.log.info(`loading ${llmOpts.model}…`);
    const t = Date.now();
    try {
      lms('load', llmOpts.model, '--identifier', PROFILE.identifier, ...profile, '--ttl', String(PROFILE.ttl), '-y');
    } catch (e) {
      return { refused: `LM Studio could not load ${llmOpts.model}: ${String(e.stderr || e.message).trim().split('\n').at(-1)}` };
    }
    usage.loadMs += Date.now() - t;
    fs.writeFileSync(OWNED, `${path.basename(lease)} ${new Date().toISOString()}\n`);
    return PROFILE.identifier;
  });
}

async function acquireNow() {
  if (!JSON.parse(lms('server', 'status', '--json')).running) lms('server', 'start'); // never stopped: others use it
  lease = path.join(LEASES, `${llmOpts.bot}.${process.pid}`);
  // Ctrl-C and kill end the process without an 'exit' event unless someone handles them (runBot does).
  for (const sig of ['SIGINT', 'SIGTERM']) if (!process.listenerCount(sig)) process.on(sig, () => process.exit(130));
  for (const end = Date.now() + llmOpts.waitMs; ;) {
    const r = tryAcquire();
    if (typeof r === 'string') return r;
    if (r.refused || Date.now() > end) {
      release();
      throw new ModelBusy(r.refused ?? `LM Studio stayed busy with ${r.busy.join(', ')} for ${llmOpts.waitMs / 60000} min`);
    }
    llmOpts.log.info(`waiting for ${r.busy.join(', ')} to finish in LM Studio…`);
    await sleep(llmOpts.pollMs);
  }
}

/** Takes a lease and makes sure the model is loaded; returns the identifier to call. Cheap when already held. */
function acquire() {
  pending ??= acquireNow().catch((e) => { pending = null; throw e; });
  return pending;
}

/** Drops our lease; the last bot out unloads the model if a bot loaded it. Safe to call any time, and again. */
function release() {
  if (!lease) return;
  const mine = lease;
  lease = null;
  pending = null;
  try {
    locked(() => {
      fs.rmSync(mine, { force: true });
      dropDead();
      if (leaseFiles().length || !fs.existsSync(OWNED)) return;
      try { lms('unload', PROFILE.identifier); llmOpts.log.info('model unloaded'); } catch { /* already gone (TTL) */ }
      fs.rmSync(OWNED, { force: true });
    });
  } catch (e) { llmOpts.log.warn(`model release failed: ${e.message}`); }
}
process.on('exit', release);

/** Problems with `v` against a JSON schema (the subset ask() schemas use), or null. */
function check(schema, v, at = 'reply') {
  const types = [schema.type ?? []].flat();
  const type = v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) && types.includes('integer') ? 'integer' : typeof v;
  if (types.length && !types.includes(type)) return `${at} should be ${types.join(' or ')}`;
  if (schema.enum && !schema.enum.includes(v)) return `${at} should be one of ${schema.enum.join(', ')}`;
  if (type === 'string' && schema.pattern && !new RegExp(schema.pattern).test(v)) return `${at} should match ${schema.pattern}`;
  if (type === 'array') {
    if (v.length > (schema.maxItems ?? Infinity) || v.length < (schema.minItems ?? 0)) return `${at} has ${v.length} items`;
    for (const [i, x] of v.entries()) { const e = schema.items && check(schema.items, x, `${at}[${i}]`); if (e) return e; }
  }
  if (type === 'object') {
    for (const k of schema.required ?? []) if (!(k in v)) return `${at}.${k} is missing`;
    for (const [k, x] of Object.entries(v)) {
      const s = schema.properties?.[k];
      if (!s) { if (schema.additionalProperties === false) return `${at}.${k} is not allowed`; continue; }
      const e = check(s, x, `${at}.${k}`);
      if (e) return e;
    }
  }
  return null;
}

/**
 * One answer from the model, deterministic: temperature 0, thinking off, reply capped at maxTokens. With `schema`:
 * an object matching it (validated; BadReply if the reply is unusable); without: the reply text. Fixed instructions
 * go in `system` (cached across calls), the changing input in `user`; `images` are PNG/JPEG Buffers.
 */
async function ask({ system, user, schema, images = [], maxTokens = 1000, name = 'answer' }) {
  const content = images.length
    ? [{ type: 'text', text: user }, ...images.map((b) => ({ type: 'image_url', image_url: { url: `data:image/${b[0] === 0xff ? 'jpeg' : 'png'};base64,${b.toString('base64')}` } }))]
    : user;
  const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content }, { role: 'assistant', content: NO_THINK }];
  const post = async () => {
    const model = await acquire();
    const t = Date.now();
    return fetch(`${process.env.LMSTUDIO_URL || 'http://127.0.0.1:1234'}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(300000),
      body: JSON.stringify({
        model, temperature: 0, max_tokens: maxTokens, messages,
        ...(schema && { response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } } }),
      }),
    }).finally(() => { usage.calls++; usage.ms += Date.now() - t; });
  };
  let res = await post();
  if (!res.ok) {
    const text = await res.text();
    // An app outside the protocol may unload the copy we were reusing: take the model again, once.
    if (!/no models loaded|model .*not (found|loaded)/i.test(text)) throw new Error(`LM Studio ${res.status}: ${text.slice(0, 200)}`);
    llmOpts.log.warn('the model was unloaded under us; taking it again');
    pending = null;
    res = await post();
    if (!res.ok) throw new Error(`LM Studio ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const choice = (await res.json()).choices?.[0];
  const reply = choice?.message?.content ?? '';
  if (!schema) return reply.trim();
  let obj;
  try { obj = JSON.parse(reply); } catch {
    throw new BadReply(`model reply is not JSON${choice?.finish_reason === 'length' ? ` (cut off at ${maxTokens} tokens)` : ''}`);
  }
  const problem = check(schema, obj);
  if (problem) throw new BadReply(`model ${problem}`);
  return obj;
}

/** Short model name for messages: 'qwen3.8-27b-mlx' -> 'Qwen 3.8 27B'. */
function label(key = llmOpts.model) {
  const m = String(key).split('/').at(-1).match(/^([a-z]+)-?(\d+(?:\.\d+)?)-(\d+b)\b/i);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]} ${m[3].toUpperCase()}` : key;
}

export const llm = { setup: (o) => { llmOpts = { ...llmOpts, ...o }; }, acquire, release, ask, check, label, usage: () => ({ ...usage }) };

// ── google: one-time OAuth login (refresh token into .env) and an authorised fetch ───────────────────────────
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

/** Browser sign-in with `scopes` (short names, e.g. 'gmail.readonly'); saves GOOGLE_REFRESH_TOKEN into .env. */
export function googleLogin(scopes, who = 'the Google account the bot should use') {
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
        const file = path.join(ROOT, '.env');
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

// ── whatsapp: WhatsApp Web in headless Chrome. One linked login (dir/wa-auth) may be shared by several bots;
//    only one Chrome may use it at a time, so opening takes dir/wa.lock and waits ──────────────────────────────
export class WhatsAppLoggedOut extends Error {}

async function lockWhatsApp(dir) {
  const lockDir = path.join(dir, 'wa.lock');
  const chromeBusy = () => { // Chrome's own profile lock: a 'host-pid' symlink while that Chrome runs
    try { return alive(Number(fs.readlinkSync(path.join(dir, 'wa-auth/session/SingletonLock')).split('-').pop())); } catch { return false; }
  };
  for (const end = Date.now() + 45 * 60000; ; await sleep(20000)) {
    try { if (Date.now() - fs.statSync(lockDir).mtimeMs > 30 * 60000) fs.rmdirSync(lockDir); } catch { /* no lock */ } // left by a crash
    if (!chromeBusy()) try { fs.mkdirSync(lockDir); break; } catch { /* another bot has WhatsApp open */ }
    if (Date.now() > end) throw new Error('WhatsApp stayed busy (another bot) for 45 min');
    log.info('another bot is using WhatsApp, waiting…');
  }
  const unlock = () => fs.rmSync(lockDir, { recursive: true, force: true });
  process.on('exit', unlock);
  return unlock;
}

/** Opens WhatsApp. With `login`, shows the QR to link this Mac; otherwise a QR means it was unlinked. */
export async function openWhatsApp({ dir = DATA, chromePath, login = false }) {
  const [{ default: wweb }, { default: qrcode }] = await Promise.all([import('whatsapp-web.js'), import('qrcode-terminal')]);
  fs.mkdirSync(dir, { recursive: true });
  const unlock = await lockWhatsApp(dir);
  const client = new wweb.Client({
    authStrategy: new wweb.LocalAuth({ dataPath: path.join(dir, 'wa-auth') }),
    webVersionCache: { type: 'local', path: path.join(dir, 'wa-cache') },
    puppeteer: { headless: true, executablePath: chromePath, args: ['--no-first-run'] },
  });
  const close = async () => { await client.destroy().catch(() => {}); unlock(); };
  try {
    await new Promise((ok, fail) => {
      // The first connection after hours offline syncs history first; that can take minutes.
      const timer = setTimeout(() => fail(new Error('WhatsApp not ready in 10 min (phone offline?)')), 600000);
      const stop = (err) => { clearTimeout(timer); fail(err); };
      let pct = -1;
      client.on('loading_screen', (p) => { if (p - pct >= 25 || p === 100) log.info(`WhatsApp syncing ${p}%`); pct = p; });
      client.on('qr', (qr) => {
        if (!login) return stop(new WhatsAppLoggedOut('WhatsApp is unlinked: run `npm run login`'));
        console.log('\nWhatsApp > Settings > Linked devices > Link a device, then scan:\n');
        qrcode.generate(qr, { small: true });
      });
      client.on('auth_failure', (m) => stop(new WhatsAppLoggedOut(`WhatsApp auth failed: ${m}`)));
      client.on('disconnected', (reason) => log.warn(`WhatsApp disconnected: ${reason}`));
      client.on('ready', () => { clearTimeout(timer); ok(); });
      client.initialize().catch(stop);
    });
  } catch (err) {
    await close();
    throw err;
  }
  return {
    client,
    close,
    /** Chat id of the one group with this name (case-insensitive). */
    async findGroup(name) {
      const want = name.trim().toLowerCase();
      const groups = (await client.getChats()).filter((c) => c.isGroup && c.name?.trim().toLowerCase() === want);
      if (groups.length !== 1) throw new Error(`WhatsApp: expected 1 group named "${name}", found ${groups.length}`);
      return groups[0].id._serialized;
    },
    /** Sends and waits until WhatsApp's server has it (sendMessage only queues it in the browser). */
    async send(to, text, options = {}) {
      const msg = await client.sendMessage(to, text, { linkPreview: false, ...options });
      if (!msg?.id) throw new Error('WhatsApp did not create the message');
      let ack = msg.ack;
      for (const end = Date.now() + 60000; ack < 1 && ack !== -1 && Date.now() < end; await sleep(500)) {
        ack = (await client.getMessageById(msg.id._serialized))?.ack ?? ack;
      }
      if (ack < 1) throw new Error(`WhatsApp message not sent (${ack === -1 ? 'error' : 'still pending after 60 s'})`);
      log.info(`WhatsApp message ${msg.id.id} is on WhatsApp's server`);
      return msg;
    },
  };
}

// ── runBot: one run with config, log, store, a single-instance lock and the standard exit codes:
//    0 ok · 1 failed (macOS notification) · 75 temporary (model busy, low memory, already running), retried quietly
/** A failure that should just be retried later, without a notification (exit 75). */
export class Temporary extends Error {}

/** name · defaults/env/optionalEnv: see loadConfig · schema/importJson: see openStore · main({ cfg, env, store, log, args }). */
export async function runBot({ name, defaults, env: envKeys, optionalEnv, schema, importJson, main }) {
  const lockFile = path.join(DATA, 'run.lock');
  let store = null;
  let haveLock = false;
  const cleanup = () => {
    store?.close();
    release();
    if (haveLock) fs.rmSync(lockFile, { force: true });
    haveLock = false;
  };
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { log.error(`stopped by ${sig}`); process.exit(130); });
  process.on('unhandledRejection', (err) => { log.error(`unhandled: ${err?.stack ?? err}`); process.exit(1); });

  let code = 0;
  try {
    const cfg = loadConfig({ defaults, env: envKeys, optionalEnv });
    openLog(cfg.data);
    if (cfg.unusedEnv.length) log.warn(`.env keys not used by this bot: ${cfg.unusedEnv.join(', ')}`);
    try { fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' }); } catch {
      const pid = Number(fs.readFileSync(lockFile, 'utf8'));
      if (pid && pid !== process.pid && alive(pid)) throw new Temporary(`another run is in progress (pid ${pid})`);
      fs.writeFileSync(lockFile, String(process.pid)); // left by a crash
    }
    haveLock = true;
    llm.setup({ bot: name, model: cfg.model, takeoverIdleMinutes: cfg.takeoverIdleMinutes, log });
    store = openStore(cfg.data, { schema, importJson });
    log.info(`${name} run start`);
    await main({ cfg, env: cfg.env, store, log, args: process.argv.slice(2) });
    log.info('run done');
  } catch (err) {
    code = err instanceof Temporary || err instanceof ModelBusy ? 75 : 1;
    if (code === 75) log.warn(`${err.message}: will retry later`);
    else {
      log.error(`FAILED during "${log.currentStep}": ${err instanceof ConfigError ? err.message : err.stack}`);
      notify(`${name} failed`, err.message);
    }
  }
  const u = usage;
  if (u.calls || u.loadMs) log.info(`model: load ${(u.loadMs / 1000).toFixed(1)} s, ${u.calls} call(s) ${(u.ms / 1000).toFixed(1)} s`);
  cleanup();
  process.exit(code);
}

// ── scheduler: launchd calls `node kit.js tick` every 5 min. Each tick runs bot.js once per slot (the latest of
//    config.json runTimes already passed, in timezone), at least 10 min after boot or wake; skips a slot older
//    than 10 h; after a failure or exit 75 retries every 5 min up to 3 times, then every 30 min, until the next slot.
function tick(root = ROOT) {
  const secs = (k) => Number(execFileSync('sysctl', ['-n', k], { encoding: 'utf8' }).match(/sec = (\d+)/)?.[1] ?? 0);
  if (Date.now() / 1000 - Math.max(secs('kern.boottime'), secs('kern.waketime')) < 600) return; // let the Mac settle
  const c = { ...KIT_DEFAULTS, ...JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')) }; // the bot validates the rest
  const slot = currentSlot(c.runTimes, c.timezone);
  if (!slot || slotAge(slot, c.timezone) > 36000) return;
  const data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  const stateFile = path.join(data, 'schedule.json');
  let st = { slot, tries: 0, sent: false };
  try { const s = JSON.parse(fs.readFileSync(stateFile, 'utf8')); if (s.slot === slot) st = s; } catch { /* first tick */ }
  if (st.sent) return;
  if (st.tries >= 3 && Date.now() - fs.statSync(stateFile).mtimeMs < 30 * 60000) return;
  try { if (alive(Number(fs.readFileSync(path.join(data, 'run.lock'), 'utf8')))) return; } catch { /* not running */ }
  st.tries++;
  fs.writeFileSync(stateFile, JSON.stringify(st));
  const out = fs.openSync(path.join(data, 'run.out'), 'a');
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'bot.js'], { cwd: root, env: { ...process.env, BOT_SLOT: slot }, stdio: ['ignore', out, out] });
  st.sent = r.status === 0;
  fs.writeFileSync(stateFile, JSON.stringify(st));
  fs.appendFileSync(out, `${new Date().toISOString()} slot ${slot} try ${st.tries}: exit ${r.status}\n`);
}

function schedule(cmd, root = ROOT) {
  const name = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name;
  const label = `com.${name}`;
  const plist = path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`);
  const domain = `gui/${process.getuid()}`;
  try { execFileSync('launchctl', ['bootout', domain, plist], { stdio: 'ignore' }); } catch { /* not loaded */ }
  if (cmd === 'unschedule') { fs.rmSync(plist, { force: true }); return console.log('Unscheduled.'); }
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  const x = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${x(process.execPath)}</string><string>${x(path.join(root, 'kit.js'))}</string><string>tick</string></array>
  <key>WorkingDirectory</key><string>${x(root)}</string>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin</string></dict>
  <key>StandardOutPath</key><string>${x(path.join(root, 'data/launchd.log'))}</string>
  <key>StandardErrorPath</key><string>${x(path.join(root, 'data/launchd.log'))}</string>
</dict></plist>
`);
  execFileSync('launchctl', ['bootstrap', domain, plist]);
  console.log('Scheduled (runTimes in config.json). Log: data/bot.log. Remove: npm run unschedule');
}

if (import.meta.main) {
  const cmd = process.argv[2];
  if (cmd === 'tick') tick();
  else if (cmd === 'schedule' || cmd === 'unschedule') schedule(cmd);
  else { console.error('usage: node kit.js schedule | unschedule | tick'); process.exit(2); }
}
