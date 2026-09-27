// Sample email, sheet and image through extraction and the model step.
// The model is stubbed by default; LIVE=1 uses the real LM Studio model.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import * as XLSX from 'xlsx';
import { driveLinks, fileText, sheetText } from '../src/extract.js';
import { classroomPostUrl } from '../src/gmail.js';
import { extractTasks, loadModel, unloadModel } from '../src/llm.js';
import { validateTasks } from '../src/tasks.js';

const LIVE = process.env.LIVE === '1';
const today = '2026-09-28';
const IMAGE = fileURLToPath(new URL('./fixtures/notice.png', import.meta.url));
const email = fs.readFileSync(new URL('./fixtures/classroom-email.txt', import.meta.url), 'utf8');

function sampleSheet() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Date', 'Subject', 'Homework'], ['29/09/2026', 'English', 'Write letters A to E, 2 times'], ['', '', ''],
  ]), 'Homework');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Date', 'Item to bring'], ['30/09/2026', 'Empty shoebox for craft'],
  ]), 'Items to bring');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Event', 'Date'], ['Sports Day', '10/10/2026']]), 'Events');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// Stub LM Studio: reply with canned JSON (first reply can be forced invalid).
let replies = [];
const realFetch = globalThis.fetch;
before(() => {
  if (LIVE) { loadModel(); return; }
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ text: replies.shift() }] }) });
});
after(() => { if (LIVE) unloadModel(); else globalThis.fetch = realFetch; });

test('email: finds Classroom post and Drive links', () => {
  assert.equal(classroomPostUrl(email), 'https://classroom.google.com/c/MTExMTExMTExMTEx/p/MjIyMjIyMjIyMjIy');
  assert.deepEqual(driveLinks(email), [{ id: '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', kind: 'sheet' }]);
});

test('sheet: reads all tabs, skips blank rows', () => {
  const text = sheetText(sampleSheet());
  for (const s of ['## Tab: Homework', '## Tab: Items to bring', '## Tab: Events', 'Empty shoebox', 'Sports Day']) assert.ok(text.includes(s), s);
  assert.ok(!/^,+$/m.test(text));
});

test('image: macOS Vision OCR reads the notice', () => {
  const text = fileText(IMAGE);
  assert.match(text, /colour palette/i);
  assert.match(text, /29\/09/);
});

test('model: email -> tasks', async () => {
  replies = ['{"tasks":[{"kid":"Anu","action_line":"Send child dressed in yellow with yellow object","due_date":"2026-09-29","confidence":0.95}]}'];
  const raw = await extractTasks({ sourceId: 'gmail:t', kid: 'Anu', kind: 'school email', date: today, text: email }, today);
  const { ok } = validateTasks(raw, { kid: 'Anu', sourceId: 'gmail:t', today });
  assert.ok(ok.some((t) => /yellow/i.test(t.action_line) && t.due_date === '2026-09-29'), JSON.stringify(ok));
});

test('model: sheet -> tasks from several tabs', async () => {
  replies = ['{"tasks":[{"action_line":"Write letters A to E twice","due_date":"2026-09-29","confidence":0.9},{"action_line":"Bring empty shoebox for craft","due_date":"2026-09-30","confidence":0.9}]}'];
  const raw = await extractTasks({ sourceId: 'doc:t', kid: 'Anu', kind: 'school spreadsheet', date: today, text: sheetText(sampleSheet()) }, today);
  const { ok } = validateTasks(raw, { kid: 'Anu', sourceId: 'doc:t', today });
  assert.ok(ok.some((t) => /shoebox/i.test(t.action_line) && t.due_date === '2026-09-30'), JSON.stringify(ok));
  assert.ok(ok.some((t) => /letters/i.test(t.action_line) && t.due_date === '2026-09-29'), JSON.stringify(ok));
});

test('model: image (OCR) -> tasks, retries once on bad JSON', async () => {
  replies = ['Here you go: tasks are...', '{"tasks":[{"action_line":"Bring colour palette and old newspaper","due_date":"2026-09-29","confidence":0.9}]}'];
  const text = fileText(IMAGE);
  const raw = await extractTasks({ sourceId: 'wa:t', kid: 'Ravi', kind: 'teacher WhatsApp messages', date: '2026-09-27', text: `[Image text]\n${text}` }, '2026-09-27');
  assert.ok(raw.some((t) => /palette/i.test(t.action_line) && t.due_date === '2026-09-29'), JSON.stringify(raw));
});

test('model: gives up after two invalid replies', { skip: LIVE }, async () => {
  replies = ['nope', 'still nope'];
  assert.equal(await extractTasks({ sourceId: 'x', kid: 'Anu', kind: 'email', date: today, text: 'hi' }, today), null);
});
