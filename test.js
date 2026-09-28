// Task rules, sample email / sheet / image, and the model step.
// The model is stubbed; LIVE=1 npm test uses the real LM Studio model.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';
import {
  buildDigest, classroomPostUrl, driveLinks, ensureModel, extractTasks, fileText, isDuplicate,
  markSent, openDb, parseModelJson, releaseModel, saveTasks, sheetText, tasksToSend, validateTasks,
} from './lib.js';

const LIVE = process.env.LIVE === '1';
const today = '2026-09-28'; // a Monday
const IMAGE = fileURLToPath(new URL('./test-notice.png', import.meta.url));
const EMAIL = `Grade 1 A · New announcement
Dear Parents,
Tomorrow is Colour Day. Kindly send your ward dressed in yellow with a yellow object for show and tell.
Please also complete the worksheet in the attached homework sheet:
https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit?usp=sharing
See details
<https://accounts.google.com/AccountChooser?continue=https://classroom.google.com/c/MTExMTEx/p/MjIyMjIy?email%3Dstudent@school.example&Email=student@school.example>`;

function sampleSheet() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Date', 'Subject', 'Homework'], ['29/09/2026', 'English', 'Write letters A to E, 2 times'], ['', '', '']]), 'Homework');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Date', 'Item to bring'], ['30/09/2026', 'Empty shoebox for craft']]), 'Items to bring');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Event', 'Date'], ['Sports Day', '10/10/2026']]), 'Events');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// Stub LM Studio with canned replies (LIVE=1 uses the real model).
let replies = [];
const realFetch = globalThis.fetch;
before(async () => {
  if (LIVE) return ensureModel();
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ text: replies.shift() }] }) });
});
after(() => { if (LIVE) releaseModel(); else globalThis.fetch = realFetch; });

// ── task rules ──
test('parses JSON wrapped in chatter or code fences', () => {
  assert.equal(parseModelJson('Sure!\n```json\n{"tasks":[{"action_line":"Bring colour palette"}]}\n```')[0].action_line, 'Bring colour palette');
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
  ], { kid: 'Anu', sourceId: 'gmail:1', today });
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

test('digest format, sorted by due date', () => {
  assert.equal(buildDigest([
    { kid: 'Ravi', action_line: 'Homework pg 12', due_date: '2026-09-30' },
    { kid: 'Anu', action_line: 'Bring colour palette', due_date: '2026-09-29' },
    { kid: 'Anu', action_line: 'Wear yellow dress', due_date: '2026-09-28' },
    { kid: 'Ravi', action_line: 'Pay trip fee', due_date: null },
  ], today, '@Partner'), [
    '@Partner School - Mon 28 Sep',
    '- Anu: Wear yellow dress - Mon 28 Sep (TODAY)',
    '- Anu: Bring colour palette - Tue 29 Sep (TOMORROW)',
    '- Ravi: Homework pg 12 - Wed 30 Sep',
    '- Ravi: Pay trip fee - date unclear, check source',
  ].join('\n'));
  assert.equal(buildDigest([], today, '@Partner'), null);
});

test('first message of the day: full list; later: only new; daily until due, then stops', () => {
  const db = openDb(':memory:');
  const t = { kid: 'Anu', action_line: 'Bring colour palette', due_date: '2026-09-29', date_unclear: 0, confidence: 1, source_id: 'x' };
  saveTasks(db, [t, { ...t, source_id: 'y' }, { kid: 'Ravi', action_line: 'Pay trip fee', due_date: null, date_unclear: 1, confidence: 1, source_id: 'z' }], today);
  const morning = tasksToSend(db, today, false);
  assert.equal(morning.length, 2); // duplicate dropped
  markSent(db, morning, today);
  assert.equal(tasksToSend(db, today, true).length, 0); // evening: nothing new
  saveTasks(db, [{ ...t, action_line: 'Bring old newspaper', source_id: 'n' }], today);
  assert.deepEqual(tasksToSend(db, today, true).map((x) => x.action_line), ['Bring old newspaper']); // evening: only the new one
  assert.equal(tasksToSend(db, '2026-09-29', false).length, 2); // next morning: both still due, unclear one not repeated
  assert.equal(tasksToSend(db, '2026-09-30', false).length, 0); // after the due date
  assert.match(buildDigest(morning, today, '@P', true), /^@P New school tasks - Mon 28 Sep/);
});

// ── sources ──
test('email: finds the Classroom post and Drive links', () => {
  assert.equal(classroomPostUrl(EMAIL), 'https://classroom.google.com/c/MTExMTEx/p/MjIyMjIy');
  assert.deepEqual(driveLinks(EMAIL), [{ id: '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', kind: 'sheet' }]);
});

test('sheet: only the 3 most recent tabs (by date in the tab name)', () => {
  const wb = XLSX.utils.book_new();
  for (const name of ['080926- 110926', '210926- 250926', '010926- 050926', '150926- 180926']) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Week', name]]), name);
  }
  const text = sheetText(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  assert.deepEqual([...text.matchAll(/## Tab: (.+)/g)].map((m) => m[1]), ['210926- 250926', '150926- 180926', '080926- 110926']);
});

test('sheet: undated tabs, first 3, skips blank rows', () => {
  const text = sheetText(sampleSheet());
  for (const s of ['## Tab: Homework', '## Tab: Items to bring', '## Tab: Events', 'Empty shoebox', 'Sports Day']) assert.ok(text.includes(s), s);
  assert.ok(!/^,+$/m.test(text));
});

test('image: macOS Vision OCR reads the notice', () => {
  const text = fileText(IMAGE);
  assert.match(text, /colour palette/i);
  assert.match(text, /29\/09/);
});

// ── model step ──
const run = (kid, kind, date, text) => extractTasks({ sourceId: 't', kid, kind, date, text }, date);

test('model: email -> task', async () => {
  replies = ['{"tasks":[{"action_line":"Send child dressed in yellow with yellow object","due_date":"2026-09-29","confidence":0.95}]}'];
  const { ok } = validateTasks(await run('Anu', 'school email', today, EMAIL), { kid: 'Anu', sourceId: 't', today });
  assert.ok(ok.some((t) => /yellow/i.test(t.action_line) && t.due_date === '2026-09-29'), JSON.stringify(ok));
});

test('model: sheet -> tasks from several tabs', async () => {
  replies = ['{"tasks":[{"action_line":"Write letters A to E twice","due_date":"2026-09-29","confidence":0.9},{"action_line":"Bring empty shoebox for craft","due_date":"2026-09-30","confidence":0.9}]}'];
  const { ok } = validateTasks(await run('Anu', 'school spreadsheet', today, sheetText(sampleSheet())), { kid: 'Anu', sourceId: 't', today });
  assert.ok(ok.some((t) => /shoebox/i.test(t.action_line) && t.due_date === '2026-09-30'), JSON.stringify(ok));
  assert.ok(ok.some((t) => /letters/i.test(t.action_line) && t.due_date === '2026-09-29'), JSON.stringify(ok));
});

test('model: image (OCR) -> task, retries once on bad JSON', async () => {
  replies = ['Here you go: tasks are...', '{"tasks":[{"action_line":"Bring colour palette and old newspaper","due_date":"2026-09-29","confidence":0.9}]}'];
  const raw = await run('Ravi', 'teacher WhatsApp messages', '2026-09-27', `[Image text]\n${fileText(IMAGE)}`);
  assert.ok(raw.some((t) => /palette/i.test(t.action_line) && t.due_date === '2026-09-29'), JSON.stringify(raw));
});

test('model: gives up after two invalid replies', { skip: LIVE }, async () => {
  replies = ['nope', 'still nope'];
  assert.equal(await run('Anu', 'email', today, 'hi'), null);
});
