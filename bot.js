// school-reminder-bot: reads new school email, Classroom posts and the teacher's WhatsApp messages, extracts the
// tasks with the local model, and sends one reminder of everything still due to a WhatsApp group at 20:00.
//   npm start · npm run login [-- google|whatsapp] (both by default) · npm start -- --slot "YYYY-MM-DD HH:MM"
import { currentSlot, googleLogin, llm, ModelBusy, runBot } from './kit.js';
import { addDays, buildDigest, extractTasks, istDate, istTime, markSent, saveTasks, SCHEMA, tasksToSend, validateTasks } from './rules.js';
import { classroomPosts, driveModified, driveText, fetchSchoolMails, schoolWhatsApp, SCOPES } from './sources.js';

const WATCH_DAYS = 14; // re-check attached Sheets/Docs this long for edits
const MAX_NESTED = 5;
const RETRY_WINDOW = 3 * 864e5;

/** New school emails and Classroom posts (with attached Drive files), plus edits to recently seen Sheets/Docs. */
async function collectSchool({ cfg, env, store, log }, today) {
  const { db } = store;
  const since = (key, days) => Number(store.get(key) || Date.now() - days * 864e5);
  const mailSince = since('gmail_last_ms', cfg.emailLookbackDays);
  const postSince = since('classroom_last_ms', cfg.emailLookbackDays);
  // Look 3 days behind the markers so items whose extraction failed are retried (processed ones are skipped).
  const [mails, posts] = await Promise.all([fetchSchoolMails(mailSince - RETRY_WINDOW), classroomPosts(postSince - RETRY_WINDOW)]);
  const newMails = mails.filter((m) => !store.isProcessed(`gmail:${m.id}`));
  const newPosts = posts.filter((p) => !store.isProcessed(`cls:${p.id}:${p.ms}`));
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
    const docs = []; // files actually read, kept with the tasks so later edits can correct their dates
    for (const id of queue) {
      const f = await read(id);
      if (!f) continue;
      docs.push(id);
      text += `\n\n[Attached: ${f.name}]\n${f.text}`;
      remember.run(id, f.modified, id, today);
      for (const l of f.links) if (l.kind !== 'file' && !queue.includes(l.id) && queue.length < ids.length + MAX_NESTED) queue.push(l.id);
    }
    return { text, docs };
  }

  const kid = env.EMAIL_KID_NAME;
  const items = await Promise.all([
    ...newMails.map(async (m) => ({
      sourceId: `gmail:${m.id}`, kid, kind: 'school email', date: m.date, markIds: [`gmail:${m.id}`],
      ...await withFiles(`Subject: ${m.subject}\nFrom: ${m.from}\n\n${m.text}`, m.links.map((l) => l.id)),
    })),
    ...newPosts.map(async (p) => ({
      sourceId: `cls:${p.id}`, kid, kind: p.kind, date: p.date, markIds: [`cls:${p.id}:${p.ms}`],
      ...await withFiles(p.text, p.driveIds),
    })),
  ]);

  // Sheets/Docs get edited in place (e.g. the weekly homework Sheet): re-read recent ones only if they changed.
  // An edit counts as handled only once extracted, so a failed extraction is retried next run.
  for (const w of db.prepare('SELECT * FROM watched WHERE first_seen >= ?').all(addDays(today, -WATCH_DAYS))) {
    if (cache.has(w.id)) continue;
    const modified = await driveModified(w.id).catch(() => w.modified);
    const editId = `drive:${w.id}:${modified}`;
    if (modified === w.modified || store.isProcessed(editId)) continue;
    const f = await read(w.id);
    if (f) items.push({ sourceId: editId, kid, kind: 'edited school document', date: today, text: `[${f.name}]\n${f.text}`, markIds: [editId], docs: [w.id], editedDoc: w.id });
  }

  const newest = (list, fallback) => Math.max(fallback, ...list.map((x) => x.ms));
  return {
    items,
    commit: () => { store.set('gmail_last_ms', newest(mails, mailSince)); store.set('classroom_last_ms', newest(posts, postSince)); },
  };
}

async function collectTeacherChat({ cfg, env, store, log }, wa) {
  const since = Number(store.get('wa_last_ts') || Math.floor(Date.now() / 1000) - cfg.whatsappLookbackDays * 86400);
  // Look behind the marker too, so a day whose extraction failed is retried (processed messages are skipped).
  const msgs = (await wa.readTeacherMessages(since - RETRY_WINDOW / 1000)).filter((m) => !store.isProcessed(`wa:${m.id}`));
  log.info(`whatsapp: ${msgs.length} new message(s) from ${env.TEACHER_CHAT_NAME}`);
  // One model call per day of messages, so captions and follow-ups keep their context.
  const byDay = Map.groupBy(msgs, (m) => istDate(m.ts * 1000));
  const items = [...byDay].map(([day, ms]) => ({
    sourceId: `wa:${ms[0].id}`, kid: env.CHAT_KID_NAME, kind: 'teacher WhatsApp messages', date: day,
    text: ms.map((m) => `[${istTime(m.ts * 1000)}] ${m.text}`).join('\n\n'),
    markIds: ms.map((m) => `wa:${m.id}`),
  }));
  const newest = Math.max(since, ...msgs.map((m) => m.ts));
  return { items, commit: () => store.set('wa_last_ts', newest) };
}

runBot({
  name: 'school-reminder-bot',
  defaults: {
    runTimes: ['20:00'], // several: later ones send only tasks not yet sent that day
    emailLookbackDays: 14, // how far back the very first run reads; later runs read everything since the last run
    whatsappLookbackDays: 14,
    whatsappDir: 'data', // folder holding wa-auth/ (the linked WhatsApp login); can be shared with other bots
  },
  env: ['EMAIL_KID_NAME', 'CHAT_KID_NAME', 'TEACHER_CHAT_NAME', 'GROUP_NAME', 'MENTION_NAME'],
  optionalEnv: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'SCHOOL_GMAIL_QUERY', 'MENTION_NUMBER_ENDS_WITH'],
  schema: SCHEMA,
  async main(ctx) {
    const { cfg, env, store, log, args } = ctx;
    if (args.includes('--login')) {
      const what = args[args.indexOf('--login') + 1];
      if (what !== 'whatsapp') await googleLogin(SCOPES, "the kid's school Google account");
      if (what !== 'google') await (await schoolWhatsApp({ cfg, env, store, login: true })).close();
      return log.done('logged in');
    }
    const argSlot = args.includes('--slot') ? args[args.indexOf('--slot') + 1] : null;
    const slot = argSlot ?? process.env.BOT_SLOT ?? `manual-${new Date().toTimeString().slice(0, 8).replace(/:/g, '')}`;
    // The send time this run belongs to, e.g. '2026-09-29 20:00'.
    const period = /^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(slot) ? slot : currentSlot(cfg.runTimes, cfg.timezone);
    const today = istDate();
    const { db } = store;
    log.info(`run ${today} slot ${slot} (send time ${period})`);
    let wa;
    let modelUsed = 'No model (nothing new)'; // shown at the end of the message

    // WhatsApp takes ~15 s to start: warm it up while Gmail/Classroom are read.
    const waStarting = schoolWhatsApp({ cfg, env, store }).then((w) => (wa = w), (err) => err);
    try {
      // collect
      log.step(`[1/5] Checking ${env.EMAIL_KID_NAME}'s school email and Classroom`);
      const school = await collectSchool(ctx, today);
      // New items: load the model now, while WhatsApp is still starting.
      const warming = school.items.length ? llm.acquire().catch((err) => err) : null;
      log.step(`[2/5] Reading ${env.TEACHER_CHAT_NAME} on WhatsApp`);
      const waResult = await waStarting;
      if (waResult instanceof Error) throw waResult;
      const chat = await collectTeacherChat(ctx, wa);
      const items = [...school.items, ...chat.items];

      // decide
      log.step(items.length ? `[3/5] Extracting tasks from ${items.length} new item(s) with the local model` : '[3/5] No new messages, model not needed');
      if (items.length) {
        const model = await (warming ?? llm.acquire());
        if (model instanceof Error) throw model;
        modelUsed = llm.label(cfg.model);
        for (const [i, item] of items.entries()) {
          log.info(`item ${i + 1}/${items.length}: ${item.kind}, ${item.date}`);
          const raw = await extractTasks(item, today, llm.ask);
          if (raw) {
            const { ok, dropped } = validateTasks(raw, { kid: item.kid, sourceId: item.sourceId, today, sourceText: item.text, posted: item.date });
            dropped.forEach((d) => log.info(`dropped from ${item.sourceId}: "${d.t?.action_line}" (${d.why})`));
            log.info(`${item.sourceId}: ${ok.length} task(s), ${saveTasks(db, ok, today, item)} new`);
          } else {
            // Unusable model reply: retry on the next runs; give up (logged) after 3 attempts.
            const tries = Number(store.get(`tries:${item.sourceId}`) || 0) + 1;
            store.set(`tries:${item.sourceId}`, tries);
            if (tries < 3) { log.warn(`${item.sourceId}: will retry next run (attempt ${tries}/3)`); continue; }
            log.error(`${item.sourceId}: gave up after 3 attempts`);
          }
          item.markIds.forEach((id) => store.markProcessed(id));
        }
        llm.release();
      }
      school.commit();
      chat.commit();

      log.step("[4/5] Building today's reminder");
      // sent.day holds the send time a message belongs to. Already messaged for it (e.g. by a manual run)? Then only new tasks.
      const newOnly = !!db.prepare('SELECT 1 FROM sent WHERE day = ?').get(period);
      const tasks = tasksToSend(db, today, newOnly);
      log.info(`${tasks.length} task(s) to send (${newOnly ? `only new since the last message for ${period}` : 'full list'})`);
      if (tasks.length && !db.prepare('SELECT 1 FROM sent WHERE day = ? AND slot = ?').get(period, slot)) {
        // act
        const mention = await wa.mention();
        const text = buildDigest(tasks, today, mention.token, newOnly, modelUsed);
        log.step(`[5/5] Sending to "${env.GROUP_NAME}"`);
        log.box(`sending to "${env.GROUP_NAME}"`, text.replace(mention.token, '@' + env.MENTION_NAME));
        await wa.sendToGroup(text, mention.id);
        db.prepare('INSERT INTO sent (day, slot, text, at) VALUES (?, ?, ?, ?)').run(period, slot, text, new Date().toISOString());
        markSent(db, tasks, today);
        log.done(`${env.GROUP_NAME}: ${text.replace(/\n/g, ' | ')}`);
      } else {
        log.step('[5/5] Nothing to send');
        log.info(tasks.length ? `slot ${slot} already sent` : newOnly ? 'nothing new since the last message' : 'no tasks today, nothing sent');
      }
    } catch (err) {
      // Also tell the user on WhatsApp (to self). Scheduled runs retry, so only the first failure per send time.
      if (!(err instanceof ModelBusy) && store.get('alerted') !== period) {
        store.set('alerted', period);
        await wa?.sendToSelf(`School reminder bot FAILED during ${log.currentStep}: ${err.message}. It keeps retrying until sent. Details: data/bot.log`).catch(() => {});
      }
      throw err;
    } finally {
      await (wa ?? (await waStarting))?.close?.();
    }
  },
});
