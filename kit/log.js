// Levelled log: console plus data/bot.log (data/test.log under `node --test`), rotated at 2 MB.
// Values of secret .env keys (tokens, passwords, phone numbers) are masked even if a caller passes one.
import fs from 'node:fs';
import path from 'node:path';

const SECRET_KEY = /TOKEN|SECRET|PASSWORD|MOBILE|PHONE|_KEY$/i;
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (c, s) => (tty ? `\x1b[${c}m${s}\x1b[0m` : s);
const STYLE = { DEBUG: '2', INFO: '36', WARN: '33', ERROR: '1;31', DONE: '1;32' };
let file = null;
let secrets = [];
let step = 'startup';

/** Starts writing to <dataDir>/bot.log; call after .env is loaded so its secrets can be masked. */
export function openLog(dataDir) {
  file = path.join(dataDir, process.env.NODE_TEST_CONTEXT ? 'test.log' : 'bot.log');
  try { if (fs.statSync(file).size > 2e6) fs.renameSync(file, `${file}.1`); } catch { /* no log yet */ }
  secrets = Object.entries(process.env).filter(([k, v]) => SECRET_KEY.test(k) && v?.length >= 4).map(([, v]) => v);
}

const mask = (s) => secrets.reduce((out, v) => out.split(v).join('***'), String(s));

function write(level, msg) {
  msg = mask(msg);
  if (file) fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${msg}\n`);
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
  step: (m) => { step = m; if (file) fs.appendFileSync(file, `${new Date().toISOString()} STEP  ${mask(m)}\n`); console.log(`\n${paint('1;35', '▸')} ${paint('1', mask(m))}`); },
  get currentStep() { return step; },
  /** A block of output (e.g. the message about to be sent), console only. */
  box: (title, body) => console.log(`\n${paint('1;32', `── ${title} ──`)}\n${mask(body)}\n${paint('1;32', '─'.repeat(title.length + 6))}`),
};
