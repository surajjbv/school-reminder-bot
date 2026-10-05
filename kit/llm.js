// The one local model (LM Studio), shared by independent bots through leases (spec: botkit/PROTOCOL.md),
// and ask(): one JSON-schema answer, validated.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Every bot loads exactly this, so any bot can reuse the model another one loaded. */
export const PROFILE = { identifier: 'qwen3.8-27b-mlx', context: 16384, parallel: 2, ttl: 600 };
const LMS = process.env.LMS_BIN || path.join(os.homedir(), '.lmstudio/bin/lms');
const API = process.env.LMSTUDIO_URL || 'http://127.0.0.1:1234';
const DIR = process.env.LLM_LEASE_DIR || path.join(os.homedir(), '.local/state/llm-lease');
const LOCK = path.join(DIR, 'lock');
const OWNED = path.join(DIR, 'owned');
// Qwen3.8 thinks by default. In the chat API, an empty think block as the start of the reply switches that off
// (LM Studio's reasoning flags don't, and a JSON schema alone puts the answer into reasoning_content).
const NO_THINK = '<think>\n\n</think>\n\n';

/** The model could not be had for now (busy, or too little free memory): runBot exits 75, retried quietly. */
export class ModelBusy extends Error {}
/** The model answered, but not with JSON matching the schema (bots usually skip that item). */
export class BadReply extends Error {}

let opts = { bot: 'bot', model: PROFILE.identifier, takeoverIdleMinutes: 5, pollMs: 15000, waitMs: 600000, log: console };
let lease = null;
let pending = null;
const stats = { loadMs: 0, calls: 0, ms: 0 };
export const usage = () => ({ ...stats });

export function setup(o) { opts = { ...opts, ...o }; }

const lms = (...a) => execFileSync(LMS, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000 });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const leases = () => fs.readdirSync(DIR).filter((f) => /\.\d+$/.test(f));
const dropDead = () => leases().forEach((f) => alive(Number(f.split('.').pop())) || fs.rmSync(path.join(DIR, f), { force: true }));

/** Runs fn holding the lock dir (atomic mkdir; one left by a crash is stale after 120 s). */
function locked(fn) {
  fs.mkdirSync(DIR, { recursive: true });
  for (;;) {
    try { fs.mkdirSync(LOCK); break; } catch (e) { if (e.code !== 'EEXIST') throw e; }
    try { if (Date.now() - fs.statSync(LOCK).mtimeMs > 120000) fs.rmdirSync(LOCK); } catch { /* just released */ }
    sleepSync(100);
  }
  try { return fn(); } finally { fs.rmSync(LOCK, { recursive: true, force: true }); }
}

/** One attempt: our identifier if the model is (now) loaded, else { busy } or { refused }. Holds the lock. */
function tryAcquire() {
  return locked(() => {
    dropDead();
    fs.writeFileSync(lease, `${new Date().toISOString()}\n`);
    const ps = JSON.parse(lms('ps', '--json'));
    const isOurs = (m) => [m.modelKey, m.path, m.indexedModelIdentifier].includes(opts.model) && m.contextLength >= PROFILE.context;
    const ours = ps.find(isOurs);
    if (ours) return ours.identifier;
    if (fs.existsSync(OWNED)) fs.rmSync(OWNED); // our load is gone (TTL), so the marker is stale
    const busy = [];
    for (const m of ps.filter((x) => x.type !== 'embedding')) {
      const idle = m.status === 'idle' && m.lastUsedTime ? (Date.now() - m.lastUsedTime) / 60000 : 0;
      if (idle < opts.takeoverIdleMinutes) { busy.push(m.identifier); continue; }
      opts.log.info(`unloading ${m.identifier}: idle for ${Math.floor(idle)} min`);
      lms('unload', m.identifier);
    }
    if (busy.length) return { busy };
    const profile = ['--context-length', String(PROFILE.context), '--parallel', String(PROFILE.parallel)];
    const estimate = lms('load', opts.model, '--estimate-only', ...profile, '-y');
    if (/will fail/i.test(estimate)) return { refused: `LM Studio's memory guardrail would refuse ${opts.model} now` };
    opts.log.info(`loading ${opts.model}…`);
    const t = Date.now();
    try {
      lms('load', opts.model, '--identifier', PROFILE.identifier, ...profile, '--ttl', String(PROFILE.ttl), '-y');
    } catch (e) {
      return { refused: `LM Studio could not load ${opts.model}: ${String(e.stderr || e.message).trim().split('\n').at(-1)}` };
    }
    stats.loadMs += Date.now() - t;
    fs.writeFileSync(OWNED, `${path.basename(lease)} ${new Date().toISOString()}\n`);
    return PROFILE.identifier;
  });
}

async function acquireNow() {
  if (!JSON.parse(lms('server', 'status', '--json')).running) lms('server', 'start'); // never stopped: others use it
  lease = path.join(DIR, `${opts.bot}.${process.pid}`);
  // Ctrl-C and kill end the process without an 'exit' event unless someone handles them (runBot does).
  for (const sig of ['SIGINT', 'SIGTERM']) if (!process.listenerCount(sig)) process.on(sig, () => process.exit(130));
  for (const end = Date.now() + opts.waitMs; ;) {
    const r = tryAcquire();
    if (typeof r === 'string') return r;
    if (r.refused || Date.now() > end) {
      release();
      throw new ModelBusy(r.refused ?? `LM Studio stayed busy with ${r.busy.join(', ')} for ${opts.waitMs / 60000} min`);
    }
    opts.log.info(`waiting for ${r.busy.join(', ')} to finish in LM Studio…`);
    await new Promise((ok) => setTimeout(ok, opts.pollMs));
  }
}

/** Takes a lease and makes sure the model is loaded; returns the identifier to call. Cheap when already held. */
export function acquire() {
  pending ??= acquireNow().catch((e) => { pending = null; throw e; });
  return pending;
}

/** Drops our lease; the last bot out unloads the model if a bot loaded it. Safe to call any time, and again. */
export function release() {
  if (!lease) return;
  const mine = lease;
  lease = null;
  pending = null;
  try {
    locked(() => {
      fs.rmSync(mine, { force: true });
      dropDead();
      if (leases().length || !fs.existsSync(OWNED)) return;
      try { lms('unload', PROFILE.identifier); opts.log.info('model unloaded'); } catch { /* already gone (TTL) */ }
      fs.rmSync(OWNED, { force: true });
    });
  } catch (e) { opts.log.warn(`model release failed: ${e.message}`); }
}
process.on('exit', release);

/** Problems with `v` against a JSON schema (the subset ask() schemas use), or null. */
export function check(schema, v, at = 'reply') {
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
 * One answer from the model as an object matching `schema` (validated), or throws (BadReply if the reply
 * itself is unusable). Deterministic: temperature 0,
 * thinking off, reply capped at maxTokens. Put fixed instructions in `system` (it is cached across calls) and the
 * changing input in `user`; `images` are PNG/JPEG Buffers.
 */
export async function ask({ system, user, schema, images = [], maxTokens = 1000, name = 'answer' }) {
  const content = images.length
    ? [{ type: 'text', text: user }, ...images.map((b) => ({ type: 'image_url', image_url: { url: `data:image/${b[0] === 0xff ? 'jpeg' : 'png'};base64,${b.toString('base64')}` } }))]
    : user;
  const post = async () => {
    const model = await acquire();
    const t = Date.now();
    return fetch(`${API}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(300000),
      body: JSON.stringify({
        model, temperature: 0, max_tokens: maxTokens,
        messages: [{ role: 'system', content: system }, { role: 'user', content }, { role: 'assistant', content: NO_THINK }],
        response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } },
      }),
    }).finally(() => { stats.calls++; stats.ms += Date.now() - t; });
  };
  let res = await post();
  if (!res.ok) {
    const text = await res.text();
    // An app outside the protocol may unload the copy we were reusing: take the model again, once.
    if (!/no models loaded|model .*not (found|loaded)/i.test(text)) throw new Error(`LM Studio ${res.status}: ${text.slice(0, 200)}`);
    opts.log.warn('the model was unloaded under us; taking it again');
    pending = null;
    res = await post();
    if (!res.ok) throw new Error(`LM Studio ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const choice = (await res.json()).choices?.[0];
  let obj;
  try { obj = JSON.parse(choice?.message?.content); } catch {
    throw new BadReply(`model reply is not JSON${choice?.finish_reason === 'length' ? ` (cut off at ${maxTokens} tokens)` : ''}`);
  }
  const problem = check(schema, obj);
  if (problem) throw new BadReply(`model ${problem}`);
  return obj;
}

/** Short model name for messages: 'qwen3.8-27b-mlx' -> 'Qwen 3.8 27B'. */
export function label(key = opts.model) {
  const m = String(key).split('/').at(-1).match(/^([a-z]+)-?(\d+(?:\.\d+)?)-(\d+b)\b/i);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2]} ${m[3].toUpperCase()}` : key;
}
