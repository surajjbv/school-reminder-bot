import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = path.join(ROOT, 'data');
fs.mkdirSync(DATA, { recursive: true });

const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const e = process.env;
export const config = {
  googleClientId: e.GOOGLE_CLIENT_ID,
  googleClientSecret: e.GOOGLE_CLIENT_SECRET,
  googleRefreshToken: e.GOOGLE_REFRESH_TOKEN,

  // Kid whose school sends email / Google Classroom posts
  emailKid: e.EMAIL_KID_NAME,
  schoolAccount: e.SCHOOL_ACCOUNT_EMAIL,
  schoolQuery: e.SCHOOL_GMAIL_QUERY || `to:${e.SCHOOL_ACCOUNT_EMAIL}`,

  // Kid whose teacher messages you on WhatsApp
  chatKid: e.CHAT_KID_NAME,
  teacherChat: e.TEACHER_CHAT_NAME,

  groupName: e.GROUP_NAME,
  mentionName: e.MENTION_NAME,

  model: e.MODEL,
  promptMode: e.LLM_PROMPT_MODE || 'chatml-nothink',
  llmContext: Number(e.LLM_CONTEXT || 16384),
  minConfidence: Number(e.MIN_CONFIDENCE || 0.5),
  runTimes: (e.RUN_TIMES || '10:00').split(',').map((s) => s.trim()).filter(Boolean),
  lookbackDays: Number(e.FIRST_RUN_LOOKBACK_DAYS || 7),
  chromePath: e.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  lmsUrl: 'http://127.0.0.1:1234',
};

/** Fail early with a clear message when a required .env value is missing. */
export function requireConfig(...keys) {
  const missing = keys.filter((k) => !config[k]);
  if (missing.length) throw new Error(`Missing in .env: ${missing.join(', ')} (see .env.example)`);
}
