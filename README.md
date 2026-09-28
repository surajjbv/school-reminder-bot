# school-reminder-bot

Local, headless, $0 bot for a Mac. Once a day it reads your kids' school emails, Google Classroom posts and a teacher's WhatsApp messages, has a **local** model (LM Studio) pull out the to-dos, and sends one short WhatsApp reminder to a family group:

```
@Partner School - Mon 28 Sep
- Anu: Bring colour palette - Tue 29 Sep (TOMORROW)
- Ravi: Homework pg 12 - Wed 30 Sep
```

It starts, does the work, and exits: browsers closed, model unloaded (unless you already had it loaded).

## Files

| File | What |
|---|---|
| `bot.js` | one run: read → extract → send |
| `sources.js` | Gmail, Google Classroom/Drive, WhatsApp |
| `lib.js` | config, logging, storage, task rules, text extraction, local model |
| `login.js` | one-time logins (`google`, `school`, `whatsapp`) |
| `ocr.swift` | macOS Vision OCR / PDF text helper, compiled on first use |
| `run-now.command` | double-click to run now |
| `schedule.sh` | daily schedule via launchd |
| `test.js` | tests (sample email, 3-tab sheet, image) |

All names, emails and chat names live in `.env` (gitignored). State, logs and logins live in `data/` (gitignored).

## Setup (about 10 minutes)

Prerequisites: Node 22.13+, Google Chrome, [LM Studio](https://lmstudio.ai) with the `lms` CLI and the model in `MODEL` downloaded (default `Qwen3.5-9B-MLX-4bit`), Xcode command line tools (`xcode-select --install`).

```bash
npm install
cp .env.example .env      # fill in names, school account, chat and group names
```

1. **Google (your Gmail, read-only).** At https://console.cloud.google.com, create a project and enable the **Gmail API**. On the **OAuth consent screen**, choose External, fill in the app name and your email, then under **Audience** click **Publish app** (apps left in "Testing" lose access after 7 days). Under **Credentials**, create an **OAuth client ID** of type **Desktop app**, and put its ID and secret in `.env`. Then run `npm run login:google` and allow access (on the "unverified app" warning, click **Advanced** and continue).
2. **School account.** Run `npm run login:school`. A Chrome window opens; sign in, let Chrome save the password, then quit it with **Cmd+Q**.
3. **WhatsApp.** Run `npm run login:whatsapp`, then scan the QR code with WhatsApp (**Settings**, **Linked devices**, **Link a device**).
4. **Run it.** Run `npm start`, or double-click `run-now.command`.
5. **Schedule it.** Run `npm run schedule`. It runs daily at `RUN_TIMES` (IST). If the Mac was off or asleep, it runs 10 minutes after the Mac wakes. It runs at most once per time slot per day and never catches up on missed days. Remove it with `bash schedule.sh uninstall`. Keep the Mac logged in (automatic login), since WhatsApp and the Keychain need a user session.

## How it behaves

- **Model:** if `MODEL` is already loaded in LM Studio, the bot uses it and leaves it loaded. Otherwise it loads it for the run and unloads it afterwards, also on errors, Ctrl-C and kill signals. After a hard crash, the launcher, the scheduler, or the next run cleans up. To unload by hand, run `lms unload school-reminder-bot`.
- **Reading:** images and PDFs (WhatsApp, email attachments, Drive) are read with macOS Vision OCR. Linked Google Sheets and Docs are re-checked for edits for 14 days, so if a teacher edits the weekly homework sheet, the new tasks are picked up.
- **Rules:**
  - The model must return valid JSON; the bot retries once, then skips that item.
  - Due dates must not be in the past and must be within 60 days.
  - Near-identical tasks are merged.
  - A task whose date is unclear is sent once, with "date unclear, check source".
  - Reminders go out daily until the due date.
  - If there are no tasks, nothing is sent.
- **Alerts:** if the school login expires, you get a WhatsApp message in your own "Message yourself" chat; run `npm run login:school`. If WhatsApp gets unlinked, you get a macOS notification; run `npm run login:whatsapp`.
- **Logs:** `data/bot.log` has every step, failures as `run FAILED during [step]: reason` with the stack trace, and every sent message (`SENT` lines, with WhatsApp's message id).
- **Security:**
  - Secrets live only in `.env`.
  - Gmail access is `gmail.readonly`.
  - The school account is only read.
  - Passwords are never stored by the bot.

## Tests

```bash
npm test            # model stubbed
LIVE=1 npm test     # against the real LM Studio model
```
