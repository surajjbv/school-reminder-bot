# school-reminder-bot

One short WhatsApp every evening (20:00 IST) with every school task that's still due. It reads the kid's school
Gmail, Google Classroom (with attached Drive files) and a teacher's WhatsApp chat, including photos and PDFs, and a
local model (Qwen3.8 27B in LM Studio) extracts the tasks. Read-only, private; nothing goes to the cloud.

```
@Partner 🎒 School · Mon 28

*Anu*
🟠 Tmrw: Bring colour palette

*Ravi*
• Wed: Homework pg 12

🤖 Qwen 3.8 27B
```

## How it works

1. **Collect**: new school mail and Classroom posts since the last run (with Docs, Sheets, PDFs and images as text,
   OCR via macOS Vision), edited Sheets/Docs seen in the last 14 days, and the teacher's WhatsApp messages.
2. **Decide**: the model extracts tasks (one call per item; a day of chat messages is one item). Code-side rules
   keep a due date only if the message's own words state it, drop past, too-far, low-confidence and OTP tasks, and
   merge duplicates; an edited Sheet updates a task's date instead of adding a copy.
3. **Act**: one message per send time: the first of the day lists everything still due (each task repeats daily
   until its date), later ones only new tasks. A message counts as sent only when WhatsApp's server confirms it.

The model loads while WhatsApp starts, is shared with the other bots, and is released after extraction. If it
can't be had (busy, or too little memory for LM Studio's guardrail), the run is retried. pgrs-status-bot shares
this bot's WhatsApp login (`data/wa-auth`); the two take turns.

## Setup (macOS, Node 24+, Google Chrome, LM Studio with Qwen3.8 27B, Xcode command line tools)

```
npm install
cp .env.example .env    # names, chats, group; a Google Desktop OAuth client (Gmail, Classroom, Drive APIs on)
npm run login           # Google: the kid's school account (read-only), then scan the WhatsApp QR
npm start               # run now
npm run schedule        # send at runTimes from now on (npm run unschedule to stop)
```
Settings: `config.json` (`runTimes`, `timezone`, `emailLookbackDays`, `whatsappLookbackDays`, `model`).
Personal values: `.env` only (gitignored). Run now: double-click `run-now.command`.

## Files

```
bot.js            the run: collect → decide → act
sources.js        Gmail, Classroom, Drive, WhatsApp, text from attachments (OCR, Sheets, HTML)
rules.js          task prompt and schema, date/dedupe rules, what to send, the message (pure, tested)
test.js           tests for rules.js and sources' text helpers     kit.test.js   tests for kit.js
kit.js            shared kit: config, log, store, model sharing, Google login, WhatsApp, run, scheduler
ocr.swift         the macOS Vision OCR helper (built into data/ocr on first use)
test-notice.png   sample notice for the OCR test
config.json       public settings              .env.example  personal values template
pii-check.sh      personal-data gate before a commit: bash pii-check.sh && git commit ...
run-now.command   double-click = npm start     package.json  npm start · test · login · schedule · unschedule
data/             (gitignored) bot.db state · bot.log log · run.out scheduler · wa-auth WhatsApp login · ocr
```

## When something goes wrong

A failure shows a macOS notification and WhatsApps you the reason (once per send time). Details: `data/bot.log`
(each step, `FAILED during …` with the error) and `data/run.out` (each scheduled try). Google access revoked:
`npm run login -- google`. WhatsApp unlinked: `npm run login -- whatsapp`. `LIVE=1 npm test` also runs the model.

## License

MIT
