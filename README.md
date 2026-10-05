# school-reminder-bot

**One short WhatsApp every evening with every school task that's still due.** No apps to check, no messages missed.

```
@Partner 🎒 School · Mon 28

Anu
🟠 Tmrw: Bring colour palette

Ravi
• Wed: Homework pg 12

🤖 Qwen 3.8 27B
```

## What it does

- **Reads** the kid's school Gmail, Google Classroom and attached Drive files, plus a teacher's WhatsApp chat, including photos and PDFs.
- **Extracts** the tasks with a local AI model on the Mac. Nothing goes to the cloud.
- **Sends** one message a day at 8 pm (`runTimes` in `config.json`) with every task still due. Each task repeats daily until its due date.

**$0 to run.** Fully automatic, read-only, private. About 7 seconds per run.

## Setup (10 minutes, once)

Needs: a Mac with Node 24+, Google Chrome, [LM Studio](https://lmstudio.ai) with Qwen3.8 27B (`lmstudio-community/Qwen3.8-27B-MLX-4bit`; one model, no fallback), and Xcode command line tools.

1. `npm install`, then `cp .env.example .env` and fill in names, chats and group. Settings (run time, lookbacks) are in `config.json`.
2. In Google Cloud, enable the Gmail, Classroom and Drive APIs. Publish the consent screen, create a **Desktop** OAuth client, and put its ID and secret in `.env`.
3. `npm run login`: choose the **kid's school account** in the browser (read-only, never expires), then scan the WhatsApp QR code. (`npm run login -- google` or `-- whatsapp` for just one.)
4. `npm run dry` reads everything and prints the message it would send; nothing is sent or saved.
5. `npm run schedule`. It sends daily at `runTimes` (`20:00`). If the Mac was asleep, it sends 10 min after it wakes (up to 10 h late); a failed send is retried every 5 min three times, then every 30 min.

**Run now:** double-click `run-now.command`.

## If something goes wrong

The bot WhatsApps you the reason. Details are in `data/bot.log`.

| Problem | Fix |
|---|---|
| Google access revoked | `npm run login -- google` |
| WhatsApp unlinked | `npm run login -- whatsapp` |
| Model busy or not enough memory | Nothing to do: the run exits and is retried (LM Studio's guardrail stays on) |
| Stop the schedule | `npm run unschedule` |

## Safeguards

- Google access is read-only.
- Secrets are kept only in `.env`, and no passwords are stored.
- One-time codes (OTPs) are never forwarded.
- Tasks that are duplicates, past due, or low confidence are dropped, and every drop is logged.
- A message counts as sent only when WhatsApp confirms it.
- The AI model is shared with the other bots (lease protocol in `kit/llm.js`) and unloaded when the last one is done.

Code: `bot.js` (collect → decide → act), `sources/` (Google, WhatsApp, text and OCR), `rules.js` (task rules, digest, model step), `prompts/`; shared code in `kit/` (from botkit). Tests: `npm test` (`LIVE=1 npm test` uses the real model).
