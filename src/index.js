// One run: fetch new school items -> extract tasks with the local model -> send today's digest -> exit.
// Usage: node src/index.js [--dry-run] [--slot HH:MM]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config, DATA, requireConfig } from './config.js';
import { addDays, istDate, istTime } from './dates.js';
import { isProcessed, kvGet, kvSet, markProcessed, openDb } from './db.js';
import { driveLinks } from './extract.js';
import { classroomPostUrl, fetchSchoolMails } from './gmail.js';
import { extractTasks, loadModel, unloadModel } from './llm.js';
import { log } from './log.js';
import { LoginExpired, openClassroom } from './classroom.js';
import { buildDigest, saveTasks, tasksForToday, validateTasks } from './tasks.js';
import { mentionToken, openWhatsApp, WhatsAppLoggedOut } from './whatsapp.js';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const slot = args.includes('--slot') ? args[args.indexOf('--slot') + 1] : istTime();
const WATCH_DAYS = 30;
const MAX_NESTED = 5;

function openState() {
  if (!dryRun) return openDb();
  // Dry run works on a throwaway copy so real state is untouched.
  const live = openDb();
  const copy = path.join(DATA, 'dry-run.db');
  fs.rmSync(copy, { force: true });
  live.exec(`VACUUM INTO '${copy}'`);
  live.close();
  return openDb(copy);
}

const notifyMac = (msg) => {
  try { execFileSync('osascript', ['-e', `display notification ${JSON.stringify(msg)} with title "School bot"`]); } catch { /* headless */ }
};

const loginAlert = () => ({
  key: 'school-login',
  text: `School reminder bot: ${config.emailKid}'s school login expired. On the Mac run: npm run login:school (about 30 sec). Classroom attachments wait until then.`,
});

async function collectSchoolMail(db, today, alerts) {
  const lastMs = Number(kvGet(db, 'gmail_last_ms') || Date.now() - config.lookbackDays * 864e5);
  const mails = (await fetchSchoolMails(lastMs - 60000)).filter((m) => !isProcessed(db, `gmail:${m.id}`));
  log.info(`gmail: ${mails.length} new school mail(s)`);

  const watched = db.prepare('SELECT * FROM docs WHERE first_seen >= ?').all(addDays(today, -WATCH_DAYS));
  const needsBrowser = mails.some((m) => classroomPostUrl(m.raw) || driveLinks(m.raw).length) || watched.length;
  const items = [];
  let heldFromMs = null; // mails left for next run because attachments could not be read

  let browser = null;
  try {
    if (needsBrowser) { browser = await openClassroom(); await browser.checkLogin(); }
  } catch (e) {
    if (!(e instanceof LoginExpired)) throw e;
    alerts.push(loginAlert());
    await browser?.close();
    browser = null;
  }

  try {
    const fetched = new Set();
    for (const m of mails) {
      const post = classroomPostUrl(m.raw);
      let links = driveLinks(m.raw);
      if ((post || links.length) && !browser) { heldFromMs ??= m.ms; continue; }
      let text = `Subject: ${m.subject}\nFrom: ${m.from}\n\n${m.text}`;
      if (post) links = [...links, ...(await browser.postLinks(post))];
      const queue = links.filter((l) => !fetched.has(l.id));
      for (let i = 0; i < queue.length; i++) {
        const link = queue[i];
        if (fetched.has(link.id)) continue;
        fetched.add(link.id);
        const r = await browser.fileText(link);
        if (!r) continue;
        text += `\n\n[Attached ${link.kind}]\n${r.text}`;
        if (link.kind === 'doc' || link.kind === 'sheet') {
          db.prepare('INSERT OR REPLACE INTO docs (id, kind, hash, first_seen) VALUES (?, ?, ?, ?)').run(link.id, link.kind, r.hash, today);
        }
        // Docs often link to the actual homework Sheet; follow a few of those.
        for (const n of r.links) if (!fetched.has(n.id) && n.kind !== 'file' && queue.length < links.length + MAX_NESTED) queue.push(n);
      }
      items.push({ sourceId: `gmail:${m.id}`, kid: config.emailKid, kind: 'school email / Classroom post', date: m.date, text, markIds: [`gmail:${m.id}`] });
    }

    // Sheets/Docs get edited in place (e.g. weekly homework): re-read recent ones for changes.
    if (browser) {
      for (const d of watched) {
        if (fetched.has(d.id)) continue;
        const r = await browser.fileText(d);
        if (!r || r.hash === d.hash) continue;
        db.prepare('UPDATE docs SET hash = ? WHERE id = ?').run(r.hash, d.id);
        items.push({ sourceId: `doc:${d.id}:${r.hash.slice(0, 8)}`, kid: config.emailKid, kind: `updated school ${d.kind} (previously shared)`, date: today, text: r.text, markIds: [] });
      }
    }
  } catch (e) {
    if (!(e instanceof LoginExpired)) throw e;
    alerts.push(loginAlert());
    heldFromMs ??= Date.now();
  } finally {
    await browser?.close();
  }

  const newest = mails.length ? mails.at(-1).ms : lastMs;
  const watermark = heldFromMs ? Math.min(heldFromMs - 1, newest) : newest;
  return { items, commit: () => kvSet(db, 'gmail_last_ms', Math.max(watermark, lastMs)) };
}

async function collectTeacherChat(db, wa) {
  const since = Number(kvGet(db, 'wa_last_ts') || Math.floor(Date.now() / 1000) - config.lookbackDays * 86400);
  const msgs = (await wa.readTeacherMessages(since)).filter((m) => !isProcessed(db, `wa:${m.id}`));
  log.info(`whatsapp: ${msgs.length} new message(s) from ${config.teacherChat}`);
  // One model call per day of messages, so captions and follow-ups keep their context.
  const byDay = new Map();
  for (const m of msgs) {
    const day = istDate(m.ts * 1000);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(m);
  }
  const items = [...byDay].map(([day, ms]) => ({
    sourceId: `wa:${ms[0].id}`, kid: config.chatKid, kind: 'teacher WhatsApp messages', date: day,
    text: ms.map((m) => `[${istTime(m.ts * 1000)}] ${m.text}`).join('\n\n'),
    markIds: ms.map((m) => `wa:${m.id}`),
  }));
  const newest = msgs.length ? Math.max(...msgs.map((m) => m.ts)) : since;
  return { items, commit: () => kvSet(db, 'wa_last_ts', newest) };
}

async function main() {
  requireConfig('model', 'emailKid', 'schoolAccount', 'chatKid', 'teacherChat', 'groupName', 'mentionName');
  const today = istDate();
  const db = openState();
  log.info(`run start ${today} slot ${slot}${dryRun ? ' (dry run)' : ''}`);
  const alerts = [];

  log.step(1, 5, `Checking ${config.emailKid}'s school email and Classroom`);
  const school = await collectSchoolMail(db, today, alerts);

  log.step(2, 5, `Reading ${config.teacherChat} on WhatsApp`);
  let wa;
  try {
    wa = await openWhatsApp();
  } catch (e) {
    if (e instanceof WhatsAppLoggedOut) notifyMac('WhatsApp unlinked. Run: npm run login:whatsapp');
    throw e;
  }

  try {
    const chat = await collectTeacherChat(db, wa);
    const items = [...school.items, ...chat.items];

    log.step(3, 5, items.length ? `Extracting tasks from ${items.length} new item(s) with the local model` : 'No new messages, skipping the model');
    if (items.length) {
      log.info('loading model (takes ~10 s)...');
      loadModel();
      try {
        for (const [i, item] of items.entries()) {
          log.info(`item ${i + 1}/${items.length}: ${item.kind}, ${item.date}`);
          const raw = await extractTasks(item, today);
          if (raw) {
            const { ok, dropped } = validateTasks(raw, { kid: item.kid, sourceId: item.sourceId, today, minConfidence: config.minConfidence });
            dropped.forEach((d) => log.info(`dropped from ${item.sourceId}: "${d.t?.action_line}" (${d.why})`));
            const added = saveTasks(db, ok, today);
            log.info(`${item.sourceId}: ${ok.length} task(s), ${added} new`);
          }
          item.markIds.forEach((id) => markProcessed(db, id));
        }
      } finally {
        unloadModel();
      }
    }
    school.commit();
    chat.commit();

    log.step(4, 5, "Building today's reminder");
    const tasks = tasksForToday(db, today);
    log.info(`${tasks.length} task(s) to remind about`);
    const already = db.prepare('SELECT 1 FROM sent WHERE day = ? AND slot = ?').get(today, slot);
    if (tasks.length && (!already || dryRun)) {
      const mention = await wa.mentionId(db);
      const text = buildDigest(tasks, today, mentionToken(mention));
      const readable = text.replace(mentionToken(mention), '@' + config.mentionName);
      log.step(5, 5, dryRun ? 'Dry run: not sending' : `Sending to "${config.groupName}"`);
      log.box(dryRun ? `would send to "${config.groupName}"` : `sending to "${config.groupName}"`, readable);
      if (!dryRun) {
        await wa.sendToGroup(text, mention);
        db.prepare('INSERT INTO sent (day, slot, text, at) VALUES (?, ?, ?, ?)').run(today, slot, text, new Date().toISOString());
        db.prepare('UPDATE tasks SET unclear_sent = 1 WHERE date_unclear = 1').run();
        log.sent(`${config.groupName}: ${text.replace(/\n/g, ' | ')}`);
      }
    } else {
      log.step(5, 5, 'Nothing to send');
      log.info(tasks.length ? `slot ${slot} already sent today` : 'no tasks today, nothing sent');
    }

    for (const a of alerts) {
      if (kvGet(db, `alert:${a.key}`) === today) continue; // at most one nag per day
      if (dryRun) { console.log(`(would alert you) ${a.text}`); continue; }
      await wa.sendToSelf(a.text);
      kvSet(db, `alert:${a.key}`, today);
      log.warn(`alert sent to self: ${a.key}`);
    }
  } finally {
    await wa.close();
    db.close();
  }
  log.info('run done');
}

main().then(() => process.exit(0)).catch((e) => {
  log.error(e.stack || e.message);
  process.exit(1);
});
