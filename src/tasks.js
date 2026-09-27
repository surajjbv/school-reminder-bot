import { addDays, daysBetween, isValidYmd, pretty } from './dates.js';

const MAX_AHEAD_DAYS = 60;
const STOP = new Set(['the', 'a', 'an', 'to', 'for', 'and', 'of', 'on', 'in', 'your', 'child', 'school', 'please', 'kindly']);

// Pull the first {...} block out of a model reply and parse it.
export function parseModelJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no JSON object');
  const obj = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(obj.tasks)) throw new Error('missing tasks array');
  return obj.tasks;
}

/**
 * Turn raw model tasks into clean rows, or drop them with a reason.
 * Kid and source_id come from the source, not the model.
 */
export function validateTasks(raw, { kid, sourceId, today, minConfidence = 0.5 }) {
  const ok = [];
  const dropped = [];
  for (const t of raw) {
    const line = String(t?.action_line || '').replace(/\s+/g, ' ').trim().replace(/[.!]+$/, '');
    const conf = Number(t?.confidence ?? 0);
    if (!line) { dropped.push({ t, why: 'empty action_line' }); continue; }
    if (conf < minConfidence) { dropped.push({ t, why: `low confidence ${conf}` }); continue; }
    const words = line.split(' ');
    const action_line = words.length > 12 ? words.slice(0, 12).join(' ') : line;

    let due_date = t?.due_date;
    let date_unclear = 0;
    if (!isValidYmd(due_date)) {
      due_date = null;
      date_unclear = 1;
    } else if (due_date < today) {
      dropped.push({ t, why: `due date ${due_date} is past` }); continue;
    } else if (daysBetween(today, due_date) > MAX_AHEAD_DAYS) {
      dropped.push({ t, why: `due date ${due_date} over ${MAX_AHEAD_DAYS} days away` }); continue;
    }
    ok.push({ kid, action_line, due_date, date_unclear, confidence: conf, source_id: sourceId });
  }
  return { ok, dropped };
}

const tokens = (s) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w)));

export function similar(a, b) {
  const A = tokens(a);
  const B = tokens(b);
  if (!A.size || !B.size) return a.toLowerCase() === b.toLowerCase();
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter) >= 0.6;
}

// Same kid, same (or both unclear) date, near-identical wording.
export const isDuplicate = (task, existing) =>
  existing.some((e) => e.kid === task.kid && (e.due_date ?? null) === (task.due_date ?? null) && similar(e.action_line, task.action_line));

export function saveTasks(db, tasks, today) {
  const existing = db.prepare('SELECT kid, action_line, due_date FROM tasks').all();
  const insert = db.prepare(
    'INSERT INTO tasks (kid, action_line, due_date, date_unclear, confidence, source_id, first_seen) VALUES (?, ?, ?, ?, ?, ?, ?)');
  let added = 0;
  for (const t of tasks) {
    if (isDuplicate(t, existing)) continue;
    insert.run(t.kid, t.action_line, t.due_date, t.date_unclear, t.confidence, t.source_id, today);
    existing.push(t);
    added++;
  }
  return added;
}

// Tasks to remind about today: due today or later; unclear-date tasks until sent once.
export function tasksForToday(db, today) {
  const dated = db.prepare('SELECT * FROM tasks WHERE date_unclear = 0 AND due_date >= ? AND first_seen <= ?').all(today, today);
  const unclear = db.prepare('SELECT * FROM tasks WHERE date_unclear = 1 AND unclear_sent = 0').all();
  return [...dated, ...unclear];
}

export function buildDigest(tasks, today, mentionToken) {
  if (!tasks.length) return null;
  const tomorrow = addDays(today, 1);
  const sorted = [...tasks].sort((a, b) =>
    (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999') || a.kid.localeCompare(b.kid));
  const lines = sorted.map((t) => {
    if (!t.due_date) return `- ${t.kid}: ${t.action_line} - date unclear, check source`;
    const tag = t.due_date === today ? ' (TODAY)' : t.due_date === tomorrow ? ' (TOMORROW)' : '';
    return `- ${t.kid}: ${t.action_line} - ${pretty(t.due_date)}${tag}`;
  });
  return [`${mentionToken} School - ${pretty(today)}`, ...lines].join('\n');
}
