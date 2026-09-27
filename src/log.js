import fs from 'node:fs';
import path from 'node:path';
import { DATA } from './config.js';

const file = path.join(DATA, 'bot.log');

// Callers must never pass secrets; tokens are only ever held in memory.
function write(level, msg) {
  const line = `${new Date().toISOString()} ${level} ${msg}`;
  console.log(line);
  fs.appendFileSync(file, line + '\n');
}

export const log = {
  info: (m) => write('INFO', m),
  warn: (m) => write('WARN', m),
  error: (m) => write('ERROR', m),
  sent: (m) => write('SENT', m),
};
