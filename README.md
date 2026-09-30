# school-reminder-bot

**One short WhatsApp every evening with every school task that's still due.** No apps to check, no messages missed.

```
@Partner 🎒 School · Mon 28

Anu
🟠 Tmrw: Bring colour palette

Ravi
• Wed: Homework pg 12
```

## What it does

- **Reads** the kid's school Gmail, Google Classroom and attached Drive files, plus a teacher's WhatsApp chat, including photos and PDFs.
- **Extracts** the tasks with a local AI model on the Mac. Nothing goes to the cloud.
- **Sends** one message a day at 8 pm (`RUN_TIMES`) with every task still due. Each task repeats daily until its due date.

**$0 to run.** Fully automatic, read-only, private. About 7 seconds per run.

## Setup (10 minutes, once)

Needs: a Mac with Node 22+, Google Chrome, [LM Studio](https://lmstudio.ai) (models: Gemma 4 26B-A4B QAT; Qwen3.5-9B as the fallback when memory is short), and Xcode command line tools.

1. `npm install`, then `cp .env.example .env` and fill in names, chats and group.
2. In Google Cloud, enable the Gmail, Classroom and Drive APIs. Publish the consent screen, create a **Desktop** OAuth client, and put its ID and secret in `.env`.
3. `npm run login:google` and choose the **kid's school account** (read-only, never expires).
4. `npm run login:whatsapp` and scan the QR code.
5. `npm run schedule`. It sends daily at `RUN_TIMES` (`20:00`). If the Mac was asleep or a send failed, it keeps retrying until sent, up to the next day's 8 pm.

**Run now:** double-click `run-now.command`.

## If something goes wrong

The bot WhatsApps you the reason. Details are in `data/bot.log`.

| Problem | Fix |
|---|---|
| Google access revoked | `npm run login:google` |
| WhatsApp unlinked | `npm run login:whatsapp` |
| Stop the schedule | `bash schedule.sh uninstall` |

## Safeguards

- Google access is read-only.
- Secrets are kept only in `.env`, and no passwords are stored.
- One-time codes (OTPs) are never forwarded.
- Tasks that are duplicates, past due, or low confidence are dropped, and every drop is logged.
- A message counts as sent only when WhatsApp confirms it.
- The AI model is unloaded after each run.

Code: `bot.js` (run), `sources.js` (Google, WhatsApp), `lib.js` (rules, model), `login.js`, `schedule.sh`. Tests: `npm test`.
