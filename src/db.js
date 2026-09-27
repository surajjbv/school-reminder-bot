import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA } from './config.js';

export function openDb(file = path.join(DATA, 'bot.db')) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS processed (source_id TEXT PRIMARY KEY, at TEXT);
    CREATE TABLE IF NOT EXISTS docs (           -- linked Docs/Sheets, re-checked for edits
      id TEXT PRIMARY KEY, kind TEXT, hash TEXT, first_seen TEXT);
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY, kid TEXT, action_line TEXT, due_date TEXT,
      date_unclear INTEGER DEFAULT 0, unclear_sent INTEGER DEFAULT 0, confidence REAL, source_id TEXT, first_seen TEXT);
    CREATE TABLE IF NOT EXISTS sent (
      id INTEGER PRIMARY KEY, day TEXT, slot TEXT, text TEXT, at TEXT);
  `);
  return db;
}

export const kvGet = (db, key) => db.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value;
export const kvSet = (db, key, value) =>
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));

export const isProcessed = (db, id) => !!db.prepare('SELECT 1 FROM processed WHERE source_id = ?').get(id);
export const markProcessed = (db, id) =>
  db.prepare('INSERT OR IGNORE INTO processed (source_id, at) VALUES (?, ?)').run(id, new Date().toISOString());
