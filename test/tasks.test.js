import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../src/db.js';
import { buildDigest, isDuplicate, parseModelJson, saveTasks, tasksForToday, validateTasks } from '../src/tasks.js';

const today = '2026-09-28'; // Monday
const ctx = { kid: 'Anu', sourceId: 'gmail:1', today };

test('parses JSON wrapped in chatter or code fences', () => {
  const tasks = parseModelJson('Sure!\n```json\n{"tasks":[{"action_line":"Bring colour palette"}]}\n```');
  assert.equal(tasks[0].action_line, 'Bring colour palette');
  assert.throws(() => parseModelJson('no json here'));
  assert.throws(() => parseModelJson('{"items":[]}'));
});

test('validation: past, too far, unclear, low confidence, long lines', () => {
  const { ok, dropped } = validateTasks([
    { action_line: 'Bring colour palette.', due_date: '2026-09-29', confidence: 0.9 },
    { action_line: 'Old thing', due_date: '2026-09-20', confidence: 0.9 },
    { action_line: 'Far thing', due_date: '2026-12-31', confidence: 0.9 },
    { action_line: 'Send fee receipt', due_date: null, confidence: 0.8 },
    { action_line: 'Maybe something', due_date: '2026-09-30', confidence: 0.2 },
    { action_line: 'one two three four five six seven eight nine ten eleven twelve thirteen', due_date: '2026-09-30', confidence: 1 },
  ], ctx);
  assert.deepEqual(ok.map((t) => t.action_line), ['Bring colour palette', 'Send fee receipt', 'one two three four five six seven eight nine ten eleven twelve']);
  assert.equal(ok[1].date_unclear, 1);
  assert.equal(ok[0].kid, 'Anu');
  assert.equal(dropped.length, 3);
});

test('dedupes near-identical tasks', () => {
  const a = { kid: 'Anu', action_line: 'Bring colour palette', due_date: '2026-09-29' };
  assert.ok(isDuplicate({ ...a, action_line: 'Bring the colour palette to school' }, [a]));
  assert.ok(!isDuplicate({ ...a, kid: 'Ravi' }, [a]));
  assert.ok(!isDuplicate({ ...a, due_date: '2026-09-30' }, [a]));
  assert.ok(!isDuplicate({ ...a, action_line: 'Finish Maths homework pg 12' }, [a]));
});

test('digest matches the agreed format, sorted by due date', () => {
  const text = buildDigest([
    { kid: 'Ravi', action_line: 'Homework pg 12', due_date: '2026-09-30' },
    { kid: 'Anu', action_line: 'Bring colour palette', due_date: '2026-09-29' },
    { kid: 'Anu', action_line: 'Wear yellow dress', due_date: '2026-09-28' },
    { kid: 'Ravi', action_line: 'Pay trip fee', due_date: null },
  ], today, '@Partner');
  assert.equal(text, [
    '@Partner School - Mon 28 Sep',
    '- Anu: Wear yellow dress - Mon 28 Sep (TODAY)',
    '- Anu: Bring colour palette - Tue 29 Sep (TOMORROW)',
    '- Ravi: Homework pg 12 - Wed 30 Sep',
    '- Ravi: Pay trip fee - date unclear, check source',
  ].join('\n'));
  assert.equal(buildDigest([], today, '@Partner'), null);
});

test('reminds daily until due date, then stops; unclear only until sent', () => {
  const db = openDb(':memory:');
  saveTasks(db, [
    { kid: 'Anu', action_line: 'Bring colour palette', due_date: '2026-09-29', date_unclear: 0, confidence: 1, source_id: 'x' },
    { kid: 'Anu', action_line: 'Bring colour palette', due_date: '2026-09-29', date_unclear: 0, confidence: 1, source_id: 'y' },
    { kid: 'Ravi', action_line: 'Pay trip fee', due_date: null, date_unclear: 1, confidence: 1, source_id: 'z' },
  ], today);
  assert.equal(tasksForToday(db, today).length, 2); // duplicate dropped
  db.prepare('UPDATE tasks SET unclear_sent = 1 WHERE date_unclear = 1').run();
  assert.equal(tasksForToday(db, '2026-09-29').length, 1); // due day itself
  assert.equal(tasksForToday(db, '2026-09-30').length, 0); // after due date
});
