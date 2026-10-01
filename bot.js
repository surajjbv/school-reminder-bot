// One run: read new school items -> extract tasks with the local model -> send today's reminder -> exit.
// Usage: node bot.js [--slot HH:MM]
import { execFileSync } from 'node:child_process';
import {
  addDays, buildDigest, config, currentSlot, ensureModel, extractTasks, isProcessed, istDate, istTime,
  kvGet, kvSet, log, markProcessed, openDb, releaseModel, requireConfig, markSent, saveTasks, tasksToSend, validateTasks,
} from './lib.js';
import { classroomPosts, driveModified, driveText, fetchSchoolMails, openWhatsApp, WhatsAppLoggedOut } from './sources.js';

const args = process.argv.slice(2);
const slot = args.includes('--slot') ? args[args.indexOf('--slot') + 1] : currentSlot(); // schedule.sh passes the slot, run-now 'manual-...'
const period = /^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(slot) ? slot : currentSlot(); // the send time this run belongs to, e.g. '2026-09-29 20:00'
const WATCH_DAYS = 14; // re-check attached Sheets/Docs this long for edits
const MAX_NESTED = 5;
const RETRY_WINDOW = 3 * 864e5;

/** New school emails and Classroom posts (with attached Drive files), plus edits to recently seen Sheets/Docs. */
async function collectSchool(db, today) {
  const since = (key, days) => Number(kvGet(db, key) || Date.now() - days * 864e5);
  const mailSince = since('gmail_last_ms', config.emailLookbackDays);
  const postSince = since('classroom_last_ms', config.emailLookbackDays);
  // Look 3 days behind the markers so items whose extraction failed are retried (processed ones are skipped).
  const [mails, posts] = await Promise.all([fetchSchoolMails(mailSince - RETRY_WINDOW), classroomPosts(postSince - RETRY_WINDOW)]);
  const newMails = mails.filter((m) => !isProcessed(db, `gmail:${m.id}`));
  const newPosts = posts.filter((p) => !isProcessed(db, `cls:${p.id}:${p.ms}`));
  log.info(`gmail: ${newMails.length} new school mail(s); classroom: ${newPosts.length} new post(s)`);

  // Each Drive file is read once per run; Docs often link to the real homework Sheet, so follow a few.
  const cache = new Map();
  const read = (id) => {
    if (!cache.has(id)) cache.set(id, driveText(id).catch((err) => { log.warn(`could not read Drive file ${id}: ${err.message}`); return null; }));
    return cache.get(id);
  };
  const remember = db.prepare('INSERT OR REPLACE INTO watched (id, modified, first_seen) VALUES (?, ?, COALESCE((SELECT first_seen FROM watched WHERE id = ?), ?))');
  async function withFiles(text, ids) {
    const queue = [...new Set(ids)];
    for (const id of queue) {
      const f = await read(id);
      if (!f) continue;
      text += `\n\n[Attached: ${f.name}]\n${f.text}`;
      remember.run(id, f.modified, id, today);
      for (const l of f.links) if (l.kind !== 'file' && !queue.includes(l.id) && queue.length < ids.length + MAX_NESTED) queue.push(l.id);
    }
    return text;
  }

  const items = await Promise.all([
    ...newMails.map(async (m) => ({
      sourceId: `gmail:${m.id}`, kid: config.emailKid, kind: 'school email', date: m.date, markIds: [`gmail:${m.id}`],
      text: await withFiles(`Subject: ${m.subject}\nFrom: ${m.from}\n\n${m.text}`, m.links.map((l) => l.id)),
    })),
    ...newPosts.map(async (p) => ({
      sourceId: `cls:${p.id}`, kid: config.emailKid, kind: p.kind, date: p.date, markIds: [`cls:${p.id}:${p.ms}`],
      text: await withFiles(p.text, p.driveIds),
    })),
  ]);

  // Sheets/Docs get edited in place (e.g. the weekly homework Sheet): re-read recent ones only if they changed.
  // An edit counts as handled only once extracted, so a failed extraction is retried next run.
  for (const w of db.prepare('SELECT * FROM watched WHERE first_seen >= ?').all(addDays(today, -WATCH_DAYS))) {
    if (cache.has(w.id)) continue;
    const modified = await driveModified(w.id).catch(() => w.modified);
    const editId = `drive:${w.id}:${modified}`;
    if (modified === w.modified || isProcessed(db, editId)) continue;
    const f = await read(w.id);
    if (f) items.push({ sourceId: editId, kid: config.emailKid, kind: 'edited school document', date: today, text: `[${f.name}]\n${f.text}`, markIds: [editId] });
  }

  const newest = (list, fallback) => Math.max(fallback, ...list.map((x) => x.ms));
  return {
    items,
    commit: () => { kvSet(db, 'gmail_last_ms', newest(mails, mailSince)); kvSet(db, 'classroom_last_ms', newest(posts, postSince)); },
  };
}

async function collectTeacherChat(db, wa) {
  const since = Number(kvGet(db, 'wa_last_ts') || Math.floor(Date.now() / 1000) - config.whatsappLookbackDays * 86400);
  // Look behind the marker too, so a day whose extraction failed is retried (processed messages are skipped).
  const msgs = (await wa.readTeacherMessages(since - RETRY_WINDOW / 1000)).filter((m) => !isProcessed(db, `wa:${m.id}`));
  log.info(`whatsapp: ${msgs.length} new message(s) from ${config.teacherChat}`);
  // One model call per day of messages, so captions and follow-ups keep their context.
  const byDay = Map.groupBy(msgs, (m) => istDate(m.ts * 1000));
  const items = [...byDay].map(([day, ms]) => ({
    sourceId: `wa:${ms[0].id}`, kid: config.chatKid, kind: 'teacher WhatsApp messages', date: day,
    text: ms.map((m) => `[${istTime(m.ts * 1000)}] ${m.text}`).join('\n\n'),
    markIds: ms.map((m) => `wa:${m.id}`),
  }));
  const newest = Math.max(since, ...msgs.map((m) => m.ts));
  return { items, commit: () => kvSet(db, 'wa_last_ts', newest) };
}

async function main() {
  requireConfig('emailKid', 'chatKid', 'teacherChat', 'groupName', 'mentionName');
  const today = istDate();
  const db = openDb();
  log.info(`run start ${today} slot ${slot} (send time ${period})`);
  let wa;
  let modelUsed = 'No model (nothing new)'; // shown at the end of the message

  // WhatsApp takes ~15 s to start: warm it up while Gmail/Classroom are read.
  const waStarting = openWhatsApp(db).then((w) => (wa = w), (err) => err);
  try {
    log.step(1, `Checking ${config.emailKid}'s school email and Classroom`);
    const school = await collectSchool(db, today);

    log.step(2, `Reading ${config.teacherChat} on WhatsApp`);
    const waResult = await waStarting;
    if (waResult instanceof Error) {
      if (waResult instanceof WhatsAppLoggedOut) {
        try { execFileSync('osascript', ['-e', 'display notification "Run: npm run login:whatsapp" with title "School bot: WhatsApp unlinked"']); } catch { /* no GUI */ }
      }
      throw waResult;
    }
    const chat = await collectTeacherChat(db, wa);
    const items = [...school.items, ...chat.items];

    log.step(3, items.length ? `Extracting tasks from ${items.length} new item(s) with the local model` : 'No new messages, model not needed');
    if (items.length) {
      modelUsed = await ensureModel();
      try {
        for (const [i, item] of items.entries()) {
          log.info(`item ${i + 1}/${items.length}: ${item.kind}, ${item.date}`);
          const raw = await extractTasks(item, today);
          if (raw) {
            const { ok, dropped } = validateTasks(raw, { kid: item.kid, sourceId: item.sourceId, today, sourceText: item.text, posted: item.date });
            dropped.forEach((d) => log.info(`dropped from ${item.sourceId}: "${d.t?.action_line}" (${d.why})`));
            log.info(`${item.sourceId}: ${ok.length} task(s), ${saveTasks(db, ok, today)} new`);
          } else {
            // Unreadable model reply: retry on the next runs; give up (logged) after 3 attempts.
            const tries = Number(kvGet(db, `tries:${item.sourceId}`) || 0) + 1;
            kvSet(db, `tries:${item.sourceId}`, tries);
            if (tries < 3) { log.warn(`${item.sourceId}: will retry next run (attempt ${tries}/3)`); continue; }
            log.error(`${item.sourceId}: gave up after 3 attempts`);
          }
          item.markIds.forEach((id) => markProcessed(db, id));
        }
      } finally {
        releaseModel();
      }
    }
    school.commit();
    chat.commit();

    log.step(4, "Building today's reminder");
    // sent.day holds the send time a message belongs to. Already messaged for it (e.g. by run-now)? Then only new tasks.
    const newOnly = !!db.prepare('SELECT 1 FROM sent WHERE day = ?').get(period);
    const tasks = tasksToSend(db, today, newOnly);
    log.info(`${tasks.length} task(s) to send (${newOnly ? `only new since the last message for ${period}` : 'full list'})`);
    if (tasks.length && !db.prepare('SELECT 1 FROM sent WHERE day = ? AND slot = ?').get(period, slot)) {
      const mention = await wa.mention();
      const text = buildDigest(tasks, today, mention.token, newOnly, modelUsed);
      log.step(5, `Sending to "${config.groupName}"`);
      log.box(`sending to "${config.groupName}"`, text.replace(mention.token, '@' + config.mentionName));
      await wa.sendToGroup(text, mention.id);
      db.prepare('INSERT INTO sent (day, slot, text, at) VALUES (?, ?, ?, ?)').run(period, slot, text, new Date().toISOString());
      markSent(db, tasks, today);
      log.sent(`${config.groupName}: ${text.replace(/\n/g, ' | ')}`);
    } else {
      log.step(5, 'Nothing to send');
      log.info(tasks.length ? `slot ${slot} already sent` : newOnly ? 'nothing new since the last message' : 'no tasks today, nothing sent');
    }
  } catch (err) {
    // Tell the user without them having to read logs: WhatsApp to self, else a macOS notification.
    // Scheduled runs retry every few minutes, so only the first failure per send time is messaged.
    const text = `School reminder bot FAILED during ${log.currentStep()}: ${err.message}. It keeps retrying until sent. Details: data/bot.log`;
    if (kvGet(db, 'alerted') !== period) {
      kvSet(db, 'alerted', period);
      try { await wa.sendToSelf(text); } catch {
        try { execFileSync('osascript', ['-e', `display notification ${JSON.stringify(err.message)} with title "School reminder bot failed"`]); } catch { /* no GUI */ }
      }
    }
    throw err;
  } finally {
    await (wa ?? (await waStarting))?.close?.();
    db.close();
  }
  log.info('run done');
}

// Log anything that would otherwise end the run silently; the exit handler then unloads the model.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { log.error(`run interrupted by ${sig}`); process.exit(130); });
process.on('unhandledRejection', (err) => { log.failed(err); process.exit(1); });
main().then(() => process.exit(0), (err) => { log.failed(err); process.exit(1); });
