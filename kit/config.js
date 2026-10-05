// Config: personal values from .env (names, IDs, tokens), everything public from config.json.
// Defaults live in code; config.json is validated against them on load, so a typo fails fast.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const KIT_DEFAULTS = {
  model: 'qwen3.8-27b-mlx', // LM Studio model key; the load profile is fixed in llm.js
  timezone: 'Asia/Kolkata',
  runTimes: [], // schedule.sh runs the bot once per run time ("HH:MM" in timezone)
  dryRun: false, // true: every run is a dry run (nothing sent, changed or saved)
  takeoverIdleMinutes: 5, // another app's model idle this long may be unloaded to make room
  chromePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
};

export class ConfigError extends Error {}
const kind = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
export const expandHome = (p) => p.replace(/^~(?=\/|$)/, os.homedir());

/** config.json merged over the defaults, or a ConfigError listing every problem. */
export function readConfigJson(root, defaults = {}) {
  const base = { ...KIT_DEFAULTS, ...defaults };
  const file = path.join(root, 'config.json');
  let json = {};
  try { if (fs.existsSync(file)) json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new ConfigError(`config.json: ${e.message}`); }
  const problems = [];
  for (const [k, v] of Object.entries(json)) {
    if (k.startsWith('_')) continue; // "_comment" keys
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

/**
 * Loads .env (personal) and config.json (public). `env`: required .env keys, `optionalEnv`: the rest the bot reads.
 * Returns the config plus `env` (just those keys), `dry` (--dry or dryRun), `root` and `data` (created).
 */
export function loadConfig(root, { defaults = {}, env = [], optionalEnv = [] } = {}) {
  const envFile = path.join(root, '.env');
  const known = new Set([...env, ...optionalEnv]);
  let unused = [];
  if (fs.existsSync(envFile)) {
    process.loadEnvFile(envFile);
    unused = [...fs.readFileSync(envFile, 'utf8').matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*=/gm)].map((m) => m[1]).filter((k) => !known.has(k));
  }
  const cfg = readConfigJson(root, defaults);
  const missing = env.filter((k) => !process.env[k]?.trim());
  if (missing.length) throw new ConfigError(`missing in .env: ${missing.join(', ')} (see .env.example)`);
  const data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  return {
    ...cfg, root, data, unusedEnv: unused,
    env: Object.fromEntries([...known].map((k) => [k, process.env[k]?.trim() ?? ''])),
    dry: process.argv.includes('--dry') || cfg.dryRun,
  };
}

const parts = (d, timeZone) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
  timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).formatToParts(d).map((p) => [p.type, p.value]));

/** The latest run time already passed, 'YYYY-MM-DD HH:MM' in `timezone` (yesterday's last before today's first). */
export function currentSlot(runTimes, timezone, now = new Date()) {
  if (!runTimes.length) return null;
  const p = parts(now, timezone);
  const times = [...runTimes].sort();
  const passed = times.filter((t) => t <= `${p.hour}:${p.minute}`);
  if (passed.length) return `${p.year}-${p.month}-${p.day} ${passed.at(-1)}`;
  const y = parts(new Date(now - 864e5), timezone);
  return `${y.year}-${y.month}-${y.day} ${times.at(-1)}`;
}

/** Seconds since `slot` started (its wall-clock time in `timezone`). */
export function slotAge(slot, timezone, now = new Date()) {
  const asUtc = Date.parse(`${slot.replace(' ', 'T')}:00Z`);
  const p = parts(new Date(asUtc), timezone); // the zone's offset at that moment
  const offset = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:00Z`) - asUtc;
  return Math.round((now - (asUtc - offset)) / 1000);
}
