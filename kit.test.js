// kit.js tests (the same file in every bot). The lease protocol runs with real processes against a fake `lms`,
// written to a temp folder below, so this file needs nothing else.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

const KIT = path.join(import.meta.dirname, 'kit.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-test-'));
const STATE = path.join(tmp, 'lms.json');
const LEASES = path.join(tmp, 'leases');
const FAKE_LMS = path.join(tmp, 'fake-lms.mjs');
const WORKER = path.join(tmp, 'worker.mjs');

/** Stand-in for LM Studio's `lms` CLI; state (models, loads, unloads, fit) in $FAKE_LMS_STATE. */
function fakeLms(fs) {
  const file = process.env.FAKE_LMS_STATE;
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  const a = process.argv.slice(2);
  const opt = (k) => a[a.indexOf(k) + 1];
  if (a[0] === 'server') console.log(a[1] === 'status' ? '{"running":true,"port":1234}' : 'started');
  else if (a[0] === 'ps') console.log(JSON.stringify(s.models));
  else if (a[0] === 'load' && a.includes('--estimate-only')) console.log(s.fit === false ? 'This model will fail to load' : 'This model may be loaded');
  else if (a[0] === 'load') {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); // loading takes a while
    if (s.models.some((m) => m.identifier === opt('--identifier'))) { console.error('identifier in use'); process.exit(1); }
    s.models.push({ type: 'llm', modelKey: a[1], identifier: opt('--identifier'), contextLength: Number(opt('--context-length')), status: 'idle', lastUsedTime: Date.now() });
    s.loads++;
  } else if (a[0] === 'unload') {
    if (!s.models.some((m) => m.identifier === a[1])) { console.error(`not loaded: ${a[1]}`); process.exit(1); }
    s.models = s.models.filter((m) => m.identifier !== a[1]);
    s.unloads++;
  }
  fs.writeFileSync(`${file}.${process.pid}`, JSON.stringify(s));
  fs.renameSync(`${file}.${process.pid}`, file);
}

/** A bot process: node worker.mjs <name> <startDelayMs> <holdMs|forever> [waitMs]; prints "acquired" or "busy". */
async function workerMain() {
  const [name, delay, hold, waitMs = '600000'] = process.argv.slice(2);
  const { llm, ModelBusy } = await import(process.env.KIT_URL);
  llm.setup({ bot: name, model: 'qwen3.8-27b-mlx', pollMs: 50, waitMs: Number(waitMs), log: { info() {}, warn() {} } });
  await new Promise((r) => setTimeout(r, Number(delay)));
  try { await llm.acquire(); console.log('acquired'); } catch (e) { console.log(e instanceof ModelBusy ? 'busy' : `error ${e.message}`); process.exit(75); }
  if (hold === 'forever') setInterval(() => {}, 1000);
  else setTimeout(() => process.exit(0), Number(hold)); // release() runs on exit
}
fs.writeFileSync(FAKE_LMS, `#!/usr/bin/env node\nimport fs from 'node:fs';\n(${fakeLms})(fs);\n`, { mode: 0o755 });
fs.writeFileSync(WORKER, `(${workerMain})();\n`);
Object.assign(process.env, { LMS_BIN: FAKE_LMS, FAKE_LMS_STATE: STATE, LLM_LEASE_DIR: LEASES, KIT_URL: `file://${KIT}` });
const kit = await import('./kit.js');
const { llm, currentSlot, readConfigJson, slotAge, ConfigError, openStore, lockWhatsApp } = kit;
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const lmsState = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));
const leaseFiles = () => (fs.existsSync(LEASES) ? fs.readdirSync(LEASES).filter((f) => f !== 'lock') : []);
const OURS = { type: 'llm', modelKey: 'qwen3.8-27b-mlx', identifier: 'qwen3.8-27b-mlx', contextLength: 42496, status: 'idle', lastUsedTime: Date.now() };
const OTHER = (idleMin) => ({ type: 'llm', modelKey: 'gemma', identifier: 'gemma', contextLength: 4096, status: 'idle', lastUsedTime: Date.now() - idleMin * 60000 });
beforeEach(() => {
  fs.rmSync(LEASES, { recursive: true, force: true });
  fs.writeFileSync(STATE, JSON.stringify({ models: [], loads: 0, unloads: 0 }));
});

/** Starts a worker process; resolves its first line ("acquired"/"busy") and keeps the child for killing. */
function worker(name, delay, hold, waitMs) {
  const child = spawn(process.execPath, [WORKER, name, String(delay), String(hold), ...(waitMs ? [String(waitMs)] : [])], { env: process.env });
  let out = '';
  const said = new Promise((ok) => child.stdout.on('data', (d) => { out += d; if (out.includes('\n')) ok(out.trim()); }));
  const exited = new Promise((ok) => child.on('exit', (code) => ok(code)));
  return { child, said, exited };
}

test('lease: overlapping bots and a killed one load the model once and unload it once', async () => {
  const a = worker('a', 0, 1500);
  const b = worker('b', 300, 2500);
  const k = worker('k', 600, 'forever');
  assert.equal(await k.said, 'acquired');
  k.child.kill('SIGKILL'); // crashes holding a lease: no release, its lease stays behind
  await new Promise((r) => setTimeout(r, 600));
  const c = worker('c', 0, 1500);
  for (const w of [a, b, c]) assert.equal(await w.said, 'acquired');
  assert.equal(lmsState().models.length, 1);
  assert.deepEqual(await Promise.all([a.exited, b.exited, c.exited]), [0, 0, 0]);
  const s = lmsState();
  assert.equal(s.loads, 1);
  assert.equal(s.unloads, 1);
  assert.deepEqual(s.models, []);
  assert.deepEqual(leaseFiles(), []); // the dead lease was dropped, owned removed
});

test('lease: a model a person loaded is reused and left loaded', async () => {
  fs.writeFileSync(STATE, JSON.stringify({ models: [OURS], loads: 0, unloads: 0 }));
  const w = worker('a', 0, 100);
  assert.equal(await w.said, 'acquired');
  assert.equal(await w.exited, 0);
  const s = lmsState();
  assert.equal(s.loads + s.unloads, 0);
  assert.equal(s.models.length, 1);
});

test('lease: a busy other model is waited for, then exit 75 with the lease removed', async () => {
  fs.writeFileSync(STATE, JSON.stringify({ models: [OTHER(1)], loads: 0, unloads: 0 }));
  const w = worker('a', 0, 100, 300);
  assert.equal(await w.said, 'busy');
  assert.equal(await w.exited, 75);
  assert.deepEqual(lmsState().models.map((m) => m.identifier), ['gemma']);
  assert.deepEqual(leaseFiles(), []);
});

test('lease: an idle other model is unloaded to make room', async () => {
  fs.writeFileSync(STATE, JSON.stringify({ models: [OTHER(6), { ...OURS, contextLength: 4096, identifier: 'small', lastUsedTime: Date.now() - 9 * 60000 }], loads: 0, unloads: 0 }));
  const w = worker('a', 0, 100);
  assert.equal(await w.said, 'acquired');
  assert.equal(await w.exited, 0);
  const s = lmsState();
  assert.equal(s.loads, 1);
  assert.equal(s.unloads, 3); // gemma, the too-small copy, then ours at release
});

test('lease: guardrail refusal means exit 75 and nothing loaded', async () => {
  fs.writeFileSync(STATE, JSON.stringify({ models: [], loads: 0, unloads: 0, fit: false }));
  const w = worker('a', 0, 100);
  assert.equal(await w.said, 'busy');
  assert.equal(await w.exited, 75);
  assert.equal(lmsState().loads, 0);
  assert.deepEqual(leaseFiles(), []);
});

test('ask: thinking-off prefill, JSON schema, temperature 0, images; validates the reply', async () => {
  fs.writeFileSync(STATE, JSON.stringify({ models: [OURS], loads: 0, unloads: 0 }));
  let body;
  let reply = '{"text":"QGMPs"}';
  let gone = 0; // answer "No models loaded" this many times
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; }).on('end', () => {
      body = JSON.parse(raw);
      if (gone-- > 0) { res.statusCode = 400; return res.end('{"error":{"message":"No models loaded. Please load a model"}}'); }
      res.end(JSON.stringify({ choices: [{ message: { content: reply }, finish_reason: 'stop' }] }));
    });
  }).listen(0);
  await new Promise((r) => server.on('listening', r));
  process.env.LMSTUDIO_URL = `http://127.0.0.1:${server.address().port}`;
  const { ask, release } = llm; // LMSTUDIO_URL is read per call
  try {
    const schema = { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', pattern: '^[A-Za-z0-9]{5}$' } } };
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    assert.deepEqual(await ask({ system: 'Read it.', user: 'Captcha:', schema, images: [png], maxTokens: 20 }), { text: 'QGMPs' });
    assert.equal(body.temperature, 0);
    assert.equal(body.max_tokens, 20);
    assert.equal(body.model, 'qwen3.8-27b-mlx');
    assert.equal(body.response_format.type, 'json_schema');
    assert.deepEqual(body.messages.map((m) => m.role), ['system', 'user', 'assistant']);
    assert.equal(body.messages[2].content, '<think>\n\n</think>\n\n');
    assert.match(body.messages[1].content[1].image_url.url, /^data:image\/png;base64,/);
    reply = '{"text":"too long"}';
    await assert.rejects(ask({ system: 's', user: 'u', schema }), (e) => e.constructor.name === 'BadReply' && /should match/.test(e.message));
    reply = '{"text":"AbCd1"}';
    gone = 1; // someone outside the protocol unloaded the model: taken again, then answered
    assert.deepEqual(await ask({ system: 's', user: 'u', schema }), { text: 'AbCd1' });
    reply = ' QGMPs\n'; // no schema: the reply text, no response_format, no system message
    assert.equal(await ask({ user: 'Read it.', images: [png], maxTokens: 20 }), 'QGMPs');
    assert.ok(!('response_format' in body));
    assert.deepEqual(body.messages.map((m) => m.role), ['user', 'assistant']);
    reply = '{"text":';
    await assert.rejects(ask({ system: 's', user: 'u', schema }), (e) => e.constructor.name === 'BadReply' && /not JSON/.test(e.message));
  } finally {
    release();
    server.close();
  }
});

test('check: the schema subset ask() validates', () => {
  const s = { type: 'object', required: ['tasks'], properties: { tasks: { type: 'array', maxItems: 2, items: { type: 'object', required: ['d'], properties: { d: { type: ['string', 'null'] }, n: { type: 'integer' }, k: { enum: ['a', 'b'] } } } } } };
  assert.equal(llm.check(s, { tasks: [{ d: null }, { d: 'x', n: 2, k: 'a' }] }), null);
  assert.match(llm.check(s, {}), /tasks is missing/);
  assert.match(llm.check(s, { tasks: [{ d: 1 }] }), /tasks\[0\]\.d should be string or null/);
  assert.match(llm.check(s, { tasks: [{ d: null, n: 1.5 }] }), /should be integer/);
  assert.match(llm.check(s, { tasks: [{ d: null, k: 'z' }] }), /one of a, b/);
  assert.match(llm.check(s, { tasks: [{ d: null }, { d: null }, { d: null }] }), /3 items/);
  assert.equal(llm.label('qwen3.8-27b-mlx'), 'Qwen 3.8 27B');
});

test('config: defaults, validation of config.json', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'cfg-'));
  assert.equal(readConfigJson(dir, { maxInbox: 60 }).maxInbox, 60);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ _comment: 'x', maxInbox: 10, runTimes: ['07:00'] }));
  const c = readConfigJson(dir, { maxInbox: 60 });
  assert.equal(c.maxInbox, 10);
  assert.equal(c.model, 'qwen3.8-27b-mlx');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ maxInbx: 10, maxInbox: '10', runTimes: ['7:00'], timezone: 'Mars/Base' }));
  assert.throws(() => readConfigJson(dir, { maxInbox: 60 }), (e) => e instanceof ConfigError
    && /unknown key "maxInbx"/.test(e.message) && /"maxInbox" must be number, not string/.test(e.message) && /HH:MM/.test(e.message) && /time zone/.test(e.message));
});

test('config: slots in the bot time zone', () => {
  const at = (iso) => new Date(iso);
  const tz = 'Asia/Kolkata';
  assert.equal(currentSlot(['10:00', '20:00'], tz, at('2026-10-05T05:00:00Z')), '2026-10-05 10:00'); // 10:30 IST
  assert.equal(currentSlot(['20:00', '10:00'], tz, at('2026-10-05T03:00:00Z')), '2026-10-04 20:00'); // 08:30 IST
  assert.equal(currentSlot(['20:00'], tz, at('2026-10-05T18:40:00Z')), '2026-10-05 20:00'); // 00:10 IST on the 6th
  assert.equal(currentSlot([], tz), null);
  assert.equal(slotAge('2026-10-05 10:00', tz, at('2026-10-05T05:00:00Z')), 1800);
});

test('whatsapp lock: a dead owner\'s lock is taken and the Chrome it left behind is closed', async () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'wa-'));
  const profile = path.join(dir, 'wa-auth/session');
  fs.mkdirSync(profile, { recursive: true });
  fs.mkdirSync(path.join(dir, 'wa.lock'));
  fs.writeFileSync(path.join(dir, 'wa.lock/pid'), '999999'); // a bot killed with -9
  const chrome = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', profile]); // stand-in: profile on its command line
  const exited = new Promise((ok) => chrome.on('exit', ok));
  fs.symlinkSync(`host-${chrome.pid}`, path.join(profile, 'SingletonLock'));
  const unlock = await lockWhatsApp(dir);
  await exited;
  assert.equal(fs.readFileSync(path.join(dir, 'wa.lock/pid'), 'utf8'), String(process.pid));
  unlock();
  assert.ok(!fs.existsSync(path.join(dir, 'wa.lock')));
});

test('store: kv, processed, bot tables, old state.json imported once', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'store-'));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ last: 5 }));
  const importJson = (st, s) => s.set('last', st.last);
  let s = openStore(dir, { importJson, schema: 'CREATE TABLE IF NOT EXISTS t (x TEXT);' });
  assert.equal(s.get('last'), 5);
  assert.ok(!fs.existsSync(path.join(dir, 'state.json'))); // imported, then deleted
  s.markProcessed('m1');
  s.db.prepare('INSERT INTO t VALUES (?)').run('y');
  s.close();
  s = openStore(dir, { importJson, schema: 'CREATE TABLE IF NOT EXISTS t (x TEXT);' });
  assert.equal(s.isProcessed('m1'), true);
  assert.equal(s.isProcessed('m2'), false);
  assert.equal(s.db.prepare('SELECT count(*) n FROM t').get().n, 1);
  s.db.prepare("INSERT INTO kv VALUES ('raw', '120363@g.us')").run(); // plain strings from older bots
  assert.equal(s.get('raw'), '120363@g.us');
  s.set('obj', { a: [1] });
  assert.deepEqual(s.get('obj'), { a: [1] });
  s.close();
});

test('scheduler: one run per slot; failures retried, 3 tries then 30 min apart', (t) => {
  const settle = ['kern.boottime', 'kern.waketime'].map((k) => Number(execFileSync('sysctl', ['-n', k], { encoding: 'utf8' }).match(/sec = (\d+)/)?.[1] ?? 0));
  if (Date.now() / 1000 - Math.max(...settle) < 600) return t.skip('Mac booted or woke < 10 min ago');
  const bot = fs.mkdtempSync(path.join(tmp, 'bot-'));
  fs.copyFileSync(KIT, path.join(bot, 'kit.js'));
  fs.writeFileSync(path.join(bot, 'package.json'), JSON.stringify({ name: 'fake-bot', type: 'module' }));
  fs.writeFileSync(path.join(bot, 'bot.js'), "import fs from 'node:fs'; fs.appendFileSync('runs', process.env.BOT_SLOT + '\\n'); process.exit(Number(fs.readFileSync('code', 'utf8')));");
  const hm = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  fs.writeFileSync(path.join(bot, 'config.json'), JSON.stringify({ runTimes: [hm(new Date(Date.now() - 60000))], botOwnKey: 1 })); // a key only the bot knows
  const tick = () => execFileSync(process.execPath, ['kit.js', 'tick'], { cwd: bot });
  const runs = () => fs.readFileSync(path.join(bot, 'runs'), 'utf8').trim().split('\n').length;
  fs.writeFileSync(path.join(bot, 'code'), '75');
  tick(); tick(); tick();
  assert.equal(runs(), 3);
  tick(); // 3 tries: the next waits 30 min
  assert.equal(runs(), 3);
  execFileSync('touch', ['-t', '202001010000', path.join(bot, 'data/schedule.json')]); // pretend 30 min passed
  fs.writeFileSync(path.join(bot, 'code'), '0');
  tick();
  assert.equal(runs(), 4);
  tick(); // done for this slot
  assert.equal(runs(), 4);
  assert.match(fs.readFileSync(path.join(bot, 'runs'), 'utf8'), /^\d{4}-\d\d-\d\d \d\d:\d\d$/m);
});
