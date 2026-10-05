// Task rules, sample email / sheet / image, and the model step.
// The model is stubbed; LIVE=1 npm test uses the real LM Studio model (through the kit's lease).
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';
import { BadReply, currentSlot, llm } from './kit.js';
import { buildDigest, extractTasks, isDuplicate, markSent, saveTasks, SCHEMA, tasksToSend, validateTasks } from './rules.js';
import { driveLinks, fileText, sheetText } from './sources.js';

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
const openDb = () => { const db = new DatabaseSync(':memory:'); db.exec(SCHEMA); return db; };

// Stub of kit ask() with canned replies: an object, or a string standing for an unusable reply (LIVE=1: the real model).
let replies = [];
const ask = LIVE ? llm.ask : async () => {
  const r = replies.shift();
  if (typeof r === 'string') throw new BadReply('model reply is not JSON');
  return r;
};
after(() => llm.release());

// ── task rules ──
test('validation: past, too far, unclear, low confidence, long lines', () => {
  const { ok, dropped } = validateTasks([
    { action_line: 'Bring colour palette.', due_date: '2026-09-29', confidence: 0.9 },
    { action_line: 'Old thing', due_date: '2026-09-20', confidence: 0.9 },
    { action_line: 'Far thing', due_date: '2026-12-31', confidence: 0.9 },
    { action_line: 'Send fee receipt', due_date: null, confidence: 0.8 },
    { action_line: 'Maybe something', due_date: '2026-09-30', confidence: 0.2 },
    { action_line: 'one two three four five six seven eight nine ten eleven twelve thirteen', due_date: '2026-09-30', confidence: 1, date_source: '30/09' },
    { action_line: 'Report to check-in counter with QR code and school ID card 30 mins before slot', due_date: null, confidence: 1 },
  ], { kid: 'Anu', sourceId: 'gmail:1', today });
  assert.deepEqual(ok.map((t) => t.action_line), ['Bring colour palette', 'Send fee receipt', 'one two three four five six seven eight nine ten eleven twelve', 'Report to check-in counter with QR code and school ID card']);
  assert.equal(ok[1].date_unclear, 1);
  assert.equal(ok[0].kid, 'Anu');
  assert.equal(validateTasks([{ action_line: 'Bring apron', due_date: null }], { kid: 'Anu', sourceId: 'x', today }).ok.length, 1); // no confidence given
  assert.equal(dropped.length, 3);
  assert.equal(validateTasks([{ action_line: 'Submit registration with OTP 5931', due_date: '2026-09-29', confidence: 1 }], { kid: 'Anu', sourceId: 'x', today }).ok.length, 0);
});

test('a date the message does not state is dropped (task kept as undetermined)', () => {
  const sourceText = 'The time slot allotted for you is 2:15 PM. Report 30 mins prior. Homework due 29/09/26. Wheat flour 17/08.';
  const { ok } = validateTasks([
    { action_line: 'Report 30 mins before 2:15 PM slot', due_date: '2026-10-05', date_source: null, confidence: 1 },
    { action_line: 'Report early', due_date: '2026-10-05', date_source: '5th October', confidence: 1 },
    { action_line: 'Report at check-in', due_date: '2026-09-28', date_source: '30 mins prior', confidence: 1 },
    { action_line: 'Bring wheat flour', due_date: '2026-10-17', date_source: '17/08', confidence: 1 },
    { action_line: 'Submit homework', due_date: '2026-09-29', date_source: 'due 29/09/26', confidence: 1 },
  ], { kid: 'Anu', sourceId: 'x', today, sourceText });
  // 17/08 is past -> dropped; invented/unquoted dates -> undetermined; real quote -> kept
  assert.deepEqual(ok.map((t) => t.due_date), [null, null, null, '2026-09-29']);
});

test('dedupes near-identical tasks', () => {
  const a = { kid: 'Anu', action_line: 'Bring colour palette', due_date: '2026-09-29' };
  assert.ok(isDuplicate({ ...a, action_line: 'Bring the colour palette to school' }, [a]));
  assert.ok(!isDuplicate({ ...a, kid: 'Ravi' }, [a]));
  assert.ok(!isDuplicate({ ...a, due_date: '2026-09-30' }, [a]));
  assert.ok(!isDuplicate({ ...a, action_line: 'Finish Maths homework pg 12' }, [a]));
  assert.ok(isDuplicate({ ...a, action_line: 'Bring colour palette by 29/09/26' }, [a])); // dates/filler ignored
  const c = { ...a, action_line: "Write Cursive 'c' and 'a' in four line notebook" };
  assert.ok(isDuplicate({ ...a, action_line: "Complete Cursive 'c' and 'a' in notebook by 29/09/26" }, [c]));
});

test('digest: kid once, then one short-dated line per task', () => {
  assert.equal(buildDigest([
    { kid: 'Ravi', action_line: 'Homework pg 12', due_date: '2026-09-30' },
    { kid: 'Anu', action_line: 'Bring *colour* palette', due_date: '2026-09-29' },
    { kid: 'Anu', action_line: 'Wear yellow dress', due_date: '2026-09-28' },
    { kid: 'Ravi', action_line: 'Pay trip fee', due_date: null, posted: '2026-09-13' },
    { kid: 'Anu', action_line: "Register Anu for the Art Festival with Anu's ID", due_date: '2026-09-30' },
    { kid: 'Ravi', action_line: 'Send shoebox', due_date: '2026-10-12' },
  ], today, '@Partner'), [
    '@Partner 🎒 School · Mon 28',
    '',
    '*Anu*',
    '🔴 Today: Wear yellow dress',
    '',
    '🟠 Tmrw: Bring colour palette',
    '',
    '• Wed: Register for the Art Festival with ID',
    '',
    '*Ravi*',
    '• Wed: Homework pg 12',
    '',
    '• 12 Oct: Send shoebox',
    '',
    '❓ Pay trip fee (posted 13 Sep)',
  ].join('\n'));
  assert.equal(buildDigest([], today, '@Partner'), null);
  const one = [{ kid: 'Anu', action_line: 'Bring apron', due_date: '2026-10-01' }];
  assert.match(buildDigest(one, today, '@P', false, 'Gemma 4 26B'), /• Thu: Bring apron\n\n🤖 Gemma 4 26B$/);
  assert.ok(!buildDigest(one, today, '@P').includes('🤖'));
});

test('model: short name for the message', () => {
  assert.equal(llm.label('qwen3.8-27b-mlx'), 'Qwen 3.8 27B');
  assert.equal(llm.label('gemma-4-26b-a4b-it-qat-mlx'), 'Gemma 4 26B');
  assert.equal(llm.label('qwen3.5-9b-mlx'), 'Qwen 3.5 9B');
  assert.equal(llm.label('lmstudio-community/Qwen3.6-35B-A3B-MLX-4bit'), 'Qwen 3.6 35B');
  assert.equal(llm.label('mistral-small'), 'mistral-small'); // unknown pattern: as is
});

test('send time: the latest runTimes slot passed, else yesterday\'s last one', () => {
  const slot = (times, iso) => currentSlot(times, 'Asia/Kolkata', new Date(iso));
  assert.equal(slot(['20:00'], '2026-09-30T14:29:00Z'), '2026-09-29 20:00'); // 19:59 IST: still yesterday's slot
  assert.equal(slot(['20:00'], '2026-09-30T14:30:00Z'), '2026-09-30 20:00'); // 20:00 IST
  assert.equal(slot(['20:00'], '2026-09-30T19:00:00Z'), '2026-09-30 20:00'); // 00:30 IST next day
  assert.equal(slot(['08:00', '20:00'], '2026-09-30T04:00:00Z'), '2026-09-30 08:00');
  assert.equal(slot(['08:00', '20:00'], '2026-09-30T02:00:00Z'), '2026-09-29 20:00');
});

test('first message of the day: full list; later: only new; daily until due, then stops', () => {
  const db = openDb();
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
  assert.match(buildDigest(morning, today, '@P', true), /^@P 🆕 New school tasks · Mon 28\n\n\*Anu\*\n/);
});

test('edited document: a changed date updates the task instead of adding a copy', () => {
  const db = openDb();
  const t = (action_line, due_date, source_id) => ({ kid: 'Anu', action_line, due_date, date_unclear: 0, confidence: 1, source_id });
  // Classroom post with the weekly Sheet (D) and another file (E) attached.
  saveTasks(db, [t('Bring logsheets for review', '2026-10-04', 'cls:1'), t('Write Cursive d and g', '2026-10-05', 'cls:1'),
    t('Bring dandiya sticks', '2026-10-09', 'cls:1')], today, { docs: ['D', 'E'] });
  // The teacher corrects two dates in D; the edited Sheet is re-read.
  saveTasks(db, [t('Kindly bring your logsheets for review', '2026-10-05', 'drive:D:2'), t('Write Cursive d and g', '2026-10-06', 'drive:D:2')],
    today, { docs: ['D'], editedDoc: 'D' });
  const rows = () => db.prepare('SELECT action_line, due_date FROM tasks ORDER BY due_date').all().map((x) => `${x.due_date} ${x.action_line}`);
  assert.deepEqual(rows(), ['2026-10-05 Bring logsheets for review', '2026-10-06 Write Cursive d and g', '2026-10-09 Bring dandiya sticks']);
  // Next week's tab is added while this week's tasks are still upcoming: both weeks are kept.
  saveTasks(db, [t('Bring logsheets for review', '2026-10-05', 'drive:D:3'), t('Bring logsheets for review', '2026-10-12', 'drive:D:3')],
    today, { docs: ['D'], editedDoc: 'D' });
  assert.deepEqual(rows().filter((r) => /logsheets/.test(r)), ['2026-10-05 Bring logsheets for review', '2026-10-12 Bring logsheets for review']);
});

// ── sources ──
test('email: finds Drive links', () => {
  assert.deepEqual(driveLinks(EMAIL), [{ id: '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', kind: 'sheet' }]);
});

test('sheet: only the 3 most recent tabs (by date in the tab name)', () => {
  const wb = XLSX.utils.book_new();
  for (const name of ['Instructions', '10826-14826', '210926- 250926', '7926-11926', '150926- 180926']) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Week', name]]), name);
  }
  const text = sheetText(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  assert.deepEqual([...text.matchAll(/## Tab: (.+)/g)].map((m) => m[1]), ['210926- 250926', '150926- 180926', '7926-11926']);
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
const run = (kid, kind, date, text) => extractTasks({ sourceId: 't', kid, kind, date, text }, date, ask);

test('model: email -> task', async () => {
  replies = [{"tasks":[{"action_line":"Send child dressed in yellow with yellow object","due_date":"2026-09-29","confidence":0.95}]}];
  const { ok } = validateTasks(await run('Anu', 'school email', today, EMAIL), { kid: 'Anu', sourceId: 't', today });
  assert.ok(ok.some((t) => /yellow/i.test(t.action_line) && t.due_date === '2026-09-29'), JSON.stringify(ok));
});

test('model: sheet -> tasks from several tabs', async () => {
  replies = [{"tasks":[{"action_line":"Write letters A to E twice","due_date":"2026-09-29","confidence":0.9},{"action_line":"Bring empty shoebox for craft","due_date":"2026-09-30","confidence":0.9}]}];
  const { ok } = validateTasks(await run('Anu', 'school spreadsheet', today, sheetText(sampleSheet())), { kid: 'Anu', sourceId: 't', today });
  assert.ok(ok.some((t) => /shoebox/i.test(t.action_line) && t.due_date === '2026-09-30'), JSON.stringify(ok));
  assert.ok(ok.some((t) => /letters/i.test(t.action_line) && t.due_date === '2026-09-29'), JSON.stringify(ok));
});

test('model: image (OCR) -> task, retries once on an unusable reply', async () => {
  replies = ['Here you go: tasks are...', {"tasks":[{"action_line":"Bring colour palette and old newspaper","due_date":"2026-09-29","confidence":0.9}]}];
  const raw = await run('Ravi', 'teacher WhatsApp messages', '2026-09-27', `[Image text]\n${fileText(IMAGE)}`);
  assert.ok(raw.some((t) => /palette/i.test(t.action_line) && t.due_date === '2026-09-29'), JSON.stringify(raw));
});

test('model: gives up after two unusable replies', { skip: LIVE }, async () => {
  replies = ['nope', 'still nope'];
  assert.equal(await run('Anu', 'email', today, 'hi'), null);
});
