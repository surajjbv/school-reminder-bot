// State in data/bot.db (node:sqlite): kv and processed tables; bots add their own with `schema`.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * `importJson(state, store)`: run once if data/state.json (the old format) exists; the file is then deleted.
 */
export function openStore(dataDir, { schema = '', importJson = null } = {}) {
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
