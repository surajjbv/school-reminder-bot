import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './config.js';

const file = path.join(DATA, 'bot.log');
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const STYLE = { INFO: '36', WARN: '33', ERROR: '1;31', SENT: '1;32' };

// Callers must never pass secrets; tokens are only ever held in memory.
function write(level, msg) {
  fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${msg}\n`);
  const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
  console.log(`${paint('2', time)} ${paint(STYLE[level], level.padEnd(5))} ${msg}`);
}

export const log = {
  info: (m) => write('INFO', m),
  warn: (m) => write('WARN', m),
  error: (m) => write('ERROR', m),
  sent: (m) => write('SENT', m),
  /** A visible step header in the terminal, e.g. "[2/5] Reading teacher's WhatsApp". */
  step: (n, total, m) => {
    fs.appendFileSync(file, `${new Date().toISOString()} STEP  [${n}/${total}] ${m}\n`);
    console.log(`\n${paint('1;35', `[${n}/${total}]`)} ${paint('1', m)}`);
  },
  /** Highlighted block (the digest) for the terminal only. */
  box: (title, body) => console.log(`\n${paint('1;32', `── ${title} ──`)}\n${body}\n${paint('1;32', '─'.repeat(title.length + 6))}`),
};
