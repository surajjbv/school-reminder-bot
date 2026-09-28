# school-reminder-bot

Local, headless, $0 bot for a Mac. It reads a kid's school Gmail, Google Classroom and attached Drive files (official Google APIs, read-only) and a teacher's WhatsApp messages, has a **local** model (LM Studio) pull out the to-dos, and sends one short WhatsApp reminder to a family group:

```
@Partner School - Mon 28 Sep
- Anu: Bring colour palette - Tue 29 Sep (TOMORROW)
- Ravi: Homework pg 12 - Wed 30 Sep
```

It starts, does the work, and exits: WhatsApp's browser closed, model unloaded (unless you already had it loaded).

## Files

| File | What |
|---|---|
| `bot.js` | one run: read → extract → send |
| `sources.js` | Google APIs (Gmail, Classroom, Drive), WhatsApp |
| `lib.js` | config, logging, storage, task rules, text extraction, local model |
| `login.js` | one-time logins (`google`, `whatsapp`) |
| `ocr.swift` | macOS Vision OCR / PDF text helper, compiled on first use |
| `run-now.command` | double-click to run now (sends) |
| `schedule.sh` | daily schedule via launchd |
| `test.js` | tests (sample email, 3-tab sheet, image) |

All names, emails and chat names live in `.env` (gitignored). State, logs and logins live in `data/` (gitignored).

## Setup (about 10 minutes)

Prerequisites: Node 22.13+, Google Chrome, [LM Studio](https://lmstudio.ai) with the `lms` CLI and the model in `MODEL` downloaded (default `Qwen3.5-9B-MLX-4bit`), Xcode command line tools (`xcode-select --install`).

```bash
npm install
cp .env.example .env      # fill in names, school account, chat and group names
```

1. **Google (read-only).** At https://console.cloud.google.com, create a project and enable the **Gmail API**, **Google Classroom API** and **Google Drive API**. On the **OAuth consent screen**, choose External, fill in the app name and your email, then under **Audience** click **Publish app** (apps left in "Testing" lose access after 7 days). Under **Credentials**, create an **OAuth client ID** of type **Desktop app**, and put its ID and secret in `.env`. Then run `npm run login:google`, choose the **kid's school account**, and allow read-only access (on the "unverified app" warning, click **Advanced** and continue). The access doesn't expire, so there's no recurring login.
2. **WhatsApp.** Run `npm run login:whatsapp`, then scan the QR code with WhatsApp (**Settings**, **Linked devices**, **Link a device**).
3. **Run it.** Run `npm start`, or double-click `run-now.command`.
4. **Schedule it.** Run `npm run schedule`. It runs daily at `RUN_TIMES` (IST). If the Mac was off or asleep, it runs 10 minutes after the Mac wakes. It runs at most once per time slot per day and never catches up on missed days. Remove it with `bash schedule.sh uninstall`. Keep the Mac logged in (automatic login), since WhatsApp needs a user session.

## How it behaves

- **Model:** if `MODEL` is already loaded in LM Studio, the bot uses it and leaves it loaded. Otherwise it loads it for the run and unloads it afterwards, also on errors, Ctrl-C and kill signals. After a hard crash, the launcher, the scheduler, or the next run cleans up. To unload by hand, run `lms unload school-reminder-bot`.
- **Reading:** new Gmail messages (with PDF/image attachments), new Classroom announcements, assignments (with due dates) and materials, and their attached Drive files: Docs, Sheets (the 3 newest tabs), Slides, PDFs, images. Images and PDFs are read with macOS Vision OCR. Attached Sheets and Docs are re-checked for edits for 14 days (only re-read if Google says they changed). Items whose extraction fails are retried on the next runs, up to 3 times.
- **What gets sent:** the first message of the day lists everything still due. Any later run that day (for example at 8 pm, with `RUN_TIMES=10:00,20:00`) sends only tasks that were never sent before, or nothing if there's nothing new.
- **Rules:**
  - The model must return valid JSON; the bot retries once, then skips that item.
  - Due dates must not be in the past and must be within 60 days.
  - Near-identical tasks are merged.
  - A task whose date is unclear is sent once, with "date unclear, check source".
  - Reminders go out daily until the due date.
- **Alerts:** if a run fails (for example, Google access was revoked: run `npm run login:google`), you get a WhatsApp message in your own "Message yourself" chat with the step and the reason. If WhatsApp itself is the problem, you get a macOS notification; run `npm run login:whatsapp`.
- **Logs:** `data/bot.log` has every step, failures as `run FAILED during [step]: reason` with the stack trace, and every sent message (`SENT` lines, with WhatsApp's message id).
- **Security:**
  - Secrets live only in `.env`.
  - Google access is read-only (Gmail, Classroom, Drive).
  - Passwords are never stored by the bot.

## Tests

```bash
npm test            # model stubbed
LIVE=1 npm test     # against the real LM Studio model
```
