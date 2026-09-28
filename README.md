# school-reminder-bot

Local, headless, $0 bot for a Mac. It reads a kid's school Gmail, Google Classroom and attached Drive files (official Google APIs, read-only) plus a teacher's WhatsApp messages, has a **local** model (LM Studio) pull out the to-dos, and sends one short WhatsApp reminder to a family group:

```
@Partner School - Mon 28 Sep
- Anu: Bring colour palette - Tue 29 Sep (TOMORROW)
- Ravi: Homework pg 12 - Wed 30 Sep
```

Each run starts, does the work, and exits: WhatsApp's browser is closed, and the model is unloaded unless you already had it loaded. A run with nothing new takes about 7 s; each new item adds about 1–7 s of model time.

## Files

| File | What |
|---|---|
| `bot.js` | one run: read → extract → send |
| `sources.js` | Google APIs (Gmail, Classroom, Drive) and WhatsApp |
| `lib.js` | config, logging, storage, task rules, text extraction, local model |
| `login.js` | one-time logins (`google`, `whatsapp`) |
| `ocr.swift` | macOS Vision OCR / PDF text helper, compiled on first use |
| `run-now.command` | double-click to run now (sends) |
| `schedule.sh` | daily schedule via launchd |
| `test.js` | tests (task rules, sample email, sheet, image, model step) |

Names, chat names and keys live in `.env` (gitignored). State, logs and the WhatsApp login live in `data/` (gitignored).

## Setup (about 10 minutes)

Prerequisites:
- Node 22.13+
- Google Chrome (used by WhatsApp Web)
- [LM Studio](https://lmstudio.ai) with the `lms` CLI, and the model in `MODEL` downloaded (default `Qwen3.5-9B-MLX-4bit`)
- Xcode command line tools (`xcode-select --install`)

```bash
npm install
cp .env.example .env      # fill in kid names, teacher chat, group and mention names
```

1. **Google (read-only).** At https://console.cloud.google.com:
   1. Create a project and enable the **Gmail API**, **Google Classroom API** and **Google Drive API**.
   2. On the **OAuth consent screen**, choose External, fill in the app name and your email, then under **Audience** click **Publish app**. Apps left in "Testing" lose access after 7 days.
   3. Under **Credentials**, create an **OAuth client ID** of type **Desktop app**, and put its ID and secret in `.env`.
   4. Run `npm run login:google`, choose the **kid's school account**, and allow read-only access. On the "unverified app" warning, click **Advanced** and continue.

   The access doesn't expire, so there's no recurring login.
2. **WhatsApp.** Run `npm run login:whatsapp`, then scan the QR code with WhatsApp (**Settings**, **Linked devices**, **Link a device**).
3. **Run it.** Run `npm start`, or double-click `run-now.command`.
4. **Schedule it.** Run `npm run schedule`, and keep the Mac logged in (automatic login), since WhatsApp needs a user session. To remove it: `bash schedule.sh uninstall`.

## Settings (`.env`)

| Key | What |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | from the Google Cloud Desktop client |
| `GOOGLE_REFRESH_TOKEN` | filled in by `npm run login:google` |
| `EMAIL_KID_NAME` | kid whose school uses Gmail / Classroom |
| `SCHOOL_GMAIL_QUERY` | Gmail search in the kid's inbox (default: everything except Google account notices) |
| `CHAT_KID_NAME`, `TEACHER_CHAT_NAME` | kid whose teacher messages you, and that chat's name as saved in WhatsApp |
| `GROUP_NAME`, `MENTION_NAME` | WhatsApp group to post in, and the member to @mention |
| `MENTION_NUMBER_ENDS_WITH` | only if several contacts share that name: last digits of the right number |
| `MODEL` | LM Studio model (default `lmstudio-community/Qwen3.5-9B-MLX-4bit`) |
| `EMAIL_LOOKBACK_DAYS`, `WHATSAPP_LOOKBACK_DAYS` | how far back the **first** run reads (default 14) |
| `RUN_TIMES` | daily run times, IST, comma separated (e.g. `10:00,20:00`) |
| `CHROME_PATH` | only if Chrome isn't in `/Applications` |

## How it works

**1. Reading.** Everything new since the last run. Each run also looks 3 days behind that point, so items that failed get retried; already-processed items are skipped.
- **Gmail:** the kid's emails, including text read from PDF and image attachments. Classroom notification emails are skipped, because those posts come straight from Classroom.
- **Classroom:** announcements, assignments (with their due dates) and materials in the kid's active courses.
- **Drive:** files attached to emails or posts:
  - Docs, plus up to 5 Docs/Sheets they link to
  - Sheets: the 3 newest tabs, by the dates in the tab names
  - Slides, PDFs and images, read with macOS Vision OCR
- **Watched files:** attached Sheets and Docs are re-checked for 14 days. They're re-read only if Google reports a change, which catches edits to a weekly homework sheet.
- **WhatsApp:** the teacher's messages, including text read from photos and PDFs.

**2. Extracting.** One model call per email or post (together with its attachments), and one per day of teacher messages, so a photo and a "for tomorrow" message are understood together.
- **Settings:**
  - temperature 0, so the same input always gives the same result
  - replies capped at 1,000 tokens
  - a prompt that skips the model's hidden reasoning, about 10x faster
- **The model is told to:**
  - return only structured data (JSON)
  - write each action starting with a verb, in 12 words or fewer, with no dates in it
  - work out relative and DD/MM dates from the message date
  - return at most 10 tasks and never invent any
- **The model is told to ignore:**
  - promotions and greetings
  - recaps of past events
  - class-activity lines like "Completed pg 10"
  - "view the attachment" notes
  - OTP, password and verification-code emails
  - tasks already past due
- **If a reply is unusable,** it's retried once with a correction. If it still fails, the item is retried on the next runs, up to 3 times, and the result is logged.

**3. Checking.** The bot drops tasks that are:
- low confidence (under 0.5)
- past due
- more than 60 days away
- mentioning OTPs or passwords
- duplicates of existing tasks (same kid and date, with nearly the same wording, ignoring numbers and filler words)

Every dropped task is logged with the reason.

**4. Sending.**
- **The first message of the day** lists everything still due, repeated daily until the due date and marked TODAY / TOMORROW. A task with an unclear date is sent once, as "date unclear, check source".
- **Later runs that day** send only tasks never sent before, or nothing.
- **The @mention** uses the member's WhatsApp privacy ID, so it shows as a real tag.
- **A send counts only once WhatsApp's server confirms it.** Otherwise the run fails and is retried.

**Model.** If `MODEL` is already loaded in LM Studio, the bot uses it and leaves it loaded. Otherwise it loads it only when there's something new, and unloads it afterwards. That includes errors, Ctrl-C and kill signals. After a hard crash, the launcher, the scheduler or the next run cleans up. To unload by hand: `lms unload school-reminder-bot`.

**Schedule.** launchd checks every 5 minutes, and a run happens for the latest time slot in `RUN_TIMES` that has passed. If the Mac was asleep or off, it runs once it has been awake for 10 minutes. It runs at most once per slot per day, never catches up on missed days, and gives up on a slot after 3 failed tries.

## When something goes wrong

- **Alerts:** a failed run sends a WhatsApp to your own "Message yourself" chat with the step and the reason. If WhatsApp itself is the problem, you get a macOS notification instead.
- **Google access revoked** (for example, the kid's password was changed): run `npm run login:google`.
- **WhatsApp unlinked** (phone offline for about 14 days, or removed under Linked devices): run `npm run login:whatsapp`.
- **Logs:** `data/bot.log` records every step and every dropped task with its reason. Failures appear as `run FAILED during [step]: reason` with the stack trace, and each sent message as a `SENT` line with WhatsApp's confirmation.

## Security

- Secrets live only in `.env`.
- Google access is read-only (Gmail, Classroom, Drive). No passwords are stored or typed by the bot.
- OTP and password codes are never passed on to the group.

## Tests

```bash
npm test            # model stubbed
LIVE=1 npm test     # against the real LM Studio model
```
