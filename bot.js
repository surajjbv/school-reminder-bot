// One run: read new school items -> extract tasks with the local model -> send today's reminder -> exit.
// Usage: node bot.js [--slot HH:MM]
import { execFileSync } from 'node:child_process';
import {
  addDays, buildDigest, classroomPostUrl, config, driveLinks, ensureModel, extractTasks, isProcessed, istDate, istTime,
  kvGet, kvSet, log, markProcessed, openDb, releaseModel, requireConfig, markSent, saveTasks, tasksToSend, validateTasks,
} from './lib.js';
import { fetchSchoolMails, LoginExpired, openClassroom, openWhatsApp, WhatsAppLoggedOut } from './sources.js';

const args = process.argv.slice(2);
const slot = args.includes('--slot') ? args[args.indexOf('--slot') + 1] : istTime();
const WATCH_DAYS = 14; // re-check linked Sheets/Docs this long for edits
const MAX_NESTED = 5; // Docs often link to the real homework Sheet; follow a few

const loginAlert = () => ({
  key: 'school-login',
  text: `School reminder bot: ${config.emailKid}'s school login expired. On the Mac run: npm run login:school (about 30 sec). Classroom attachments wait until then.`,
});

async function collectSchoolMail(db, today, alerts) {
  const lastMs = Number(kvGet(db, 'gmail_last_ms') || Date.now() - config.emailLookbackDays * 864e5);
  const mails = (await fetchSchoolMails(lastMs - 60000)).filter((m) => !isProcessed(db, `gmail:${m.id}`));
  log.info(`gmail: ${mails.length} new school mail(s)`);

  const watched = db.prepare('SELECT * FROM docs WHERE first_seen >= ?').all(addDays(today, -WATCH_DAYS));
  const needsBrowser = watched.length || mails.some((m) => classroomPostUrl(m.raw) || driveLinks(m.raw).length);
  const items = [];
  let heldFromMs = null; // mails whose attachments couldn't be read wait for the next run
  let browser = null;

  try {
    if (needsBrowser) {
      browser = await openClassroom();
      await browser.checkLogin();
    }
    const fetched = new Set();
    for (const m of mails) {
      const post = classroomPostUrl(m.raw);
      let links = driveLinks(m.raw);
      let text = `Subject: ${m.subject}\nFrom: ${m.from}\n\n${m.text}`;
      if (post) links = [...links, ...(await browser.postLinks(post))];
      const queue = links.filter((l) => !fetched.has(l.id));
      for (const link of queue) {
        if (fetched.has(link.id)) continue;
        fetched.add(link.id);
        const r = await browser.fileText(link);
        if (!r) continue;
        text += `\n\n[Attached ${link.kind}]\n${r.text}`;
        if (link.kind === 'doc' || link.kind === 'sheet') {
          db.prepare('INSERT OR REPLACE INTO docs VALUES (?, ?, ?, ?)').run(link.id, link.kind, r.hash, today);
        }
        for (const n of r.links) if (!fetched.has(n.id) && n.kind !== 'file' && queue.length < links.length + MAX_NESTED) queue.push(n);
      }
      items.push({ sourceId: `gmail:${m.id}`, kid: config.emailKid, kind: 'school email / Classroom post', date: m.date, text, markIds: [`gmail:${m.id}`] });
    }
    // Sheets/Docs get edited in place (e.g. weekly homework): re-read recent ones for changes.
    for (const d of watched) {
      if (fetched.has(d.id)) continue;
      const r = await browser.fileText(d);
      if (!r || r.hash === d.hash) continue;
      db.prepare('UPDATE docs SET hash = ? WHERE id = ?').run(r.hash, d.id);
      items.push({ sourceId: `doc:${d.id}:${r.hash.slice(0, 8)}`, kid: config.emailKid, kind: `updated school ${d.kind}`, date: today, text: r.text, markIds: [] });
    }
  } catch (err) {
    if (!(err instanceof LoginExpired)) throw err;
    alerts.push(loginAlert());
    // Keep mails without attachments; hold back the rest until the login is renewed.
    const done = new Set(items.map((i) => i.sourceId));
    for (const m of mails) {
      if (done.has(`gmail:${m.id}`)) continue;
      if (classroomPostUrl(m.raw) || driveLinks(m.raw).length) { heldFromMs ??= m.ms; continue; }
      items.push({ sourceId: `gmail:${m.id}`, kid: config.emailKid, kind: 'school email', date: m.date, text: `Subject: ${m.subject}\n\n${m.text}`, markIds: [`gmail:${m.id}`] });
    }
  } finally {
    await browser?.close();
  }

  const newest = mails.length ? mails.at(-1).ms : lastMs;
  const watermark = heldFromMs ? Math.min(heldFromMs - 1, newest) : newest;
  return { items, commit: () => kvSet(db, 'gmail_last_ms', Math.max(watermark, lastMs)) };
}

async function collectTeacherChat(db, wa) {
  const since = Number(kvGet(db, 'wa_last_ts') || Math.floor(Date.now() / 1000) - config.whatsappLookbackDays * 86400);
  const msgs = (await wa.readTeacherMessages(since)).filter((m) => !isProcessed(db, `wa:${m.id}`));
  log.info(`whatsapp: ${msgs.length} new message(s) from ${config.teacherChat}`);
  // One model call per day of messages, so captions and follow-ups keep their context.
  const byDay = Map.groupBy(msgs, (m) => istDate(m.ts * 1000));
  const items = [...byDay].map(([day, ms]) => ({
    sourceId: `wa:${ms[0].id}`, kid: config.chatKid, kind: 'teacher WhatsApp messages', date: day,
    text: ms.map((m) => `[${istTime(m.ts * 1000)}] ${m.text}`).join('\n\n'),
    markIds: ms.map((m) => `wa:${m.id}`),
  }));
  const newest = msgs.length ? Math.max(...msgs.map((m) => m.ts)) : since;
  return { items, commit: () => kvSet(db, 'wa_last_ts', newest) };
}

async function main() {
  requireConfig('emailKid', 'schoolAccount', 'chatKid', 'teacherChat', 'groupName', 'mentionName');
  const today = istDate();
  const db = openDb();
  log.info(`run start ${today} slot ${slot}`);
  const alerts = [];
  let wa;

  // WhatsApp takes ~15 s to start: warm it up while Gmail/Classroom are read.
  const waStarting = openWhatsApp(db).then((w) => (wa = w), (err) => err);
  try {
    log.step(1, `Checking ${config.emailKid}'s school email and Classroom`);
    const school = await collectSchoolMail(db, today, alerts);

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
      await ensureModel();
      try {
        for (const [i, item] of items.entries()) {
          log.info(`item ${i + 1}/${items.length}: ${item.kind}, ${item.date}`);
          const raw = await extractTasks(item, today);
          if (raw) {
            const { ok, dropped } = validateTasks(raw, { kid: item.kid, sourceId: item.sourceId, today });
            dropped.forEach((d) => log.info(`dropped from ${item.sourceId}: "${d.t?.action_line}" (${d.why})`));
            log.info(`${item.sourceId}: ${ok.length} task(s), ${saveTasks(db, ok, today)} new`);
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
    const newOnly = !!db.prepare('SELECT 1 FROM sent WHERE day = ?').get(today); // already messaged today?
    const tasks = tasksToSend(db, today, newOnly);
    log.info(`${tasks.length} task(s) to send (${newOnly ? 'only new since the last message today' : 'first message today: full list'})`);
    if (tasks.length && !db.prepare('SELECT 1 FROM sent WHERE day = ? AND slot = ?').get(today, slot)) {
      const mention = await wa.mention();
      const text = buildDigest(tasks, today, mention.token, newOnly);
      log.step(5, `Sending to "${config.groupName}"`);
      log.box(`sending to "${config.groupName}"`, text.replace(mention.token, '@' + config.mentionName));
      await wa.sendToGroup(text, mention.id);
      db.prepare('INSERT INTO sent (day, slot, text, at) VALUES (?, ?, ?, ?)').run(today, slot, text, new Date().toISOString());
      markSent(db, tasks, today);
      log.sent(`${config.groupName}: ${text.replace(/\n/g, ' | ')}`);
    } else {
      log.step(5, 'Nothing to send');
      log.info(tasks.length ? `slot ${slot} already sent today` : newOnly ? 'nothing new since the last message' : 'no tasks today, nothing sent');
    }

    for (const a of alerts) {
      if (kvGet(db, `alert:${a.key}`) === today) continue; // at most one nag per day
      await wa.sendToSelf(a.text);
      kvSet(db, `alert:${a.key}`, today);
      log.warn(`alert sent to self: ${a.key}`);
    }
  } catch (err) {
    // Tell the user without them having to read logs: WhatsApp to self, else a macOS notification.
    const text = `School reminder bot FAILED during ${log.currentStep()}: ${err.message}. Details: data/bot.log`;
    try { await wa.sendToSelf(text); } catch {
      try { execFileSync('osascript', ['-e', `display notification ${JSON.stringify(err.message)} with title "School reminder bot failed"`]); } catch { /* no GUI */ }
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
