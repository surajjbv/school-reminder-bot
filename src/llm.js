import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { pretty } from './dates.js';
import { log } from './log.js';
import { parseModelJson } from './tasks.js';

const LMS = path.join(os.homedir(), '.lmstudio/bin/lms');
const ID = 'school-reminder-bot';
const MAX_INPUT_CHARS = 30000;
let startedServer = false;

const lms = (...args) => execFileSync(LMS, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// MODEL in .env may be a path ("publisher/Repo") or an lms key; `lms load` wants the key.
function resolveModelKey(model) {
  const models = JSON.parse(lms('ls', '--json'));
  const m = models.find((x) => [x.modelKey, x.path, x.indexedModelIdentifier].includes(model));
  if (!m) throw new Error(`Model "${model}" not found in LM Studio (lms ls)`);
  return m.modelKey;
}

export function loadModel() {
  if (!JSON.parse(lms('server', 'status', '--json')).running) {
    lms('server', 'start');
    startedServer = true;
  }
  const key = resolveModelKey(config.model);
  lms('load', key, '--identifier', ID, '--context-length', String(config.llmContext), '-y');
  log.info(`model loaded: ${key}`);
}

export function unloadModel() {
  try { lms('unload', '--all'); } catch { /* already unloaded */ }
  if (startedServer) try { lms('server', 'stop'); } catch { /* ignore */ }
}

const SYSTEM = `You extract action items for a parent from school messages (emails, class announcements, spreadsheets, teacher WhatsApp messages, OCR text of notices).
Return ONLY JSON: {"tasks":[{"kid":"<given kid>","action_line":"...","due_date":"YYYY-MM-DD or null","confidence":0.0-1.0}]}
Rules:
- action_line: imperative, max 12 words, concrete (e.g. "Bring colour palette", "Finish Maths homework pg 12", "Register for Navarathri performance").
- Only things the parent/child must DO or BRING, or dated events to attend. Ignore circulars with no action, recaps of past events, promotions, greetings.
- Resolve relative dates ("tomorrow", "Monday", "29/09") against the message date. Dates are Indian format (DD/MM). Timezone IST.
- For deadlines ("fill form by 18th") use that deadline as due_date.
- If a task clearly exists but its date is unknown, set due_date to null.
- One task per distinct action. No tasks -> {"tasks":[]}.`;

function userPrompt({ kid, kind, date, today, text }) {
  return `Kid: ${kid}
Source: ${kind}
Message date: ${date} (${pretty(date)})
Today: ${today} (${pretty(today)})
---
${text.slice(0, MAX_INPUT_CHARS)}`;
}

async function post(endpoint, body) {
  const res = await fetch(config.lmsUrl + endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  if (!res.ok) throw new Error(`LM Studio ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function complete(messages) {
  if (config.promptMode === 'chatml-nothink') {
    // Qwen chat template with an empty think block: skips hidden reasoning.
    const prompt = messages.map((m) => `<|im_start|>${m.role}\n${m.content}<|im_end|>\n`).join('')
      + '<|im_start|>assistant\n<think>\n\n</think>\n\n';
    const r = await post('/v1/completions', { model: ID, prompt, temperature: 0, max_tokens: 1500, stop: ['<|im_end|>'] });
    return r.choices[0].text;
  }
  const r = await post('/v1/chat/completions', { model: ID, messages, temperature: 0, max_tokens: 4000 });
  return r.choices[0].message.content;
}

/** Returns raw model tasks for one source item, or null if the reply was unusable twice. */
export async function extractTasks(item, today) {
  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: userPrompt({ ...item, today }) }];
  let reply = await complete(messages);
  try {
    return parseModelJson(reply);
  } catch (e) {
    log.warn(`bad JSON for ${item.sourceId} (${e.message}), retrying`);
    messages.push({ role: 'assistant', content: reply }, { role: 'user', content: 'That was not valid JSON. Reply with ONLY the JSON object.' });
    reply = await complete(messages);
    try {
      return parseModelJson(reply);
    } catch (e2) {
      log.error(`skipping ${item.sourceId}: invalid JSON after retry (${e2.message})`);
      return null;
    }
  }
}
