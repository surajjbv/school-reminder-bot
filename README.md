# school-reminder-bot

Local, headless, $0 bot for a Mac. Once a day it reads your kids' school emails, Google Classroom posts and teacher WhatsApp messages, has a **local** model pull out the to-dos, and sends one short WhatsApp digest to a family group:

```
@Partner School - Mon 28 Sep
- Anu: Bring colour palette - Tue 29 Sep (TOMORROW)
- Ravi: Homework pg 12 - Wed 30 Sep
```

It starts, does the work, and exits. The browsers are closed, the model is unloaded, and nothing stays running between runs.

**Why Node:** whatsapp-web.js is Node-only, so a single runtime is the leanest option. Node 22+ also has SQLite and `.env` loading built in, which leaves only 4 npm packages.

## Sources

| Kid | Source | How |
|---|---|---|
| `EMAIL_KID_NAME` | School emails arriving in your Gmail (`SCHOOL_GMAIL_QUERY`) | Gmail API, read-only, on **your** account |
| `EMAIL_KID_NAME` | Classroom posts + linked Docs/Sheets (all tabs)/PDFs | Headless Chrome on a profile signed in as the kid's school account |
| `CHAT_KID_NAME` | WhatsApp chat `TEACHER_CHAT_NAME`, text + images | whatsapp-web.js; images and PDFs are read with macOS Vision OCR |

The digest goes to the WhatsApp group `GROUP_NAME` and @mentions the member `MENTION_NAME`. All names live in `.env`.

Linked Sheets and Docs are re-checked for 30 days, so if a teacher edits the weekly homework sheet, the new rows are picked up.

## 10-minute setup

**0. Prerequisites:** Node 22.13+, Google Chrome, [LM Studio](https://lmstudio.ai) with the `lms` CLI, and the Xcode command line tools (`xcode-select --install`, needed to build the OCR helper).

```bash
npm install          # also compiles bin/extract (OCR/PDF helper)
cp .env.example .env   # then fill in names, school account, chat and group names
```

**1. Model (LM Studio).** Download the model named in `MODEL` in LM Studio, for example `lmstudio-community/Qwen3.8-27B-MLX-4bit`. The bot loads it at the start of each run and unloads it at the end. If you switch to a model that is **not** Qwen, set `LLM_PROMPT_MODE=chat`.

**2. Google (your Gmail, read-only), about 4 min.**
1. Go to https://console.cloud.google.com, create a project (e.g. "school-reminder-bot"), then go to **APIs & Services**, then **Enable APIs**, and enable **Gmail API**.
2. **OAuth consent screen**: choose External, give it any app name, and use your email. Under **Audience**, click **Publish app** so it is *In production*. This matters: apps left in "Testing" lose access after 7 days. Google does not need to review it for your own use.
3. **Credentials**, then **Create credentials**, then **OAuth client ID**, then **Desktop app**. Copy the client ID and secret into `.env`.
4. Run `npm run login:google` and sign in with your Gmail. Google will warn that the app is unverified; click **Advanced**, then **Go to school-reminder-bot**. The token is saved into `.env`.

**3. The kid's school account, about 1 min.**
```bash
npm run login:school
```
A normal Chrome window opens with `SCHOOL_ACCOUNT_EMAIL` pre-filled. Sign in, let Chrome save the password, then quit that window with **Cmd+Q**.

**4. WhatsApp, about 1 min.**
```bash
npm run login:whatsapp
```
On your phone, go to WhatsApp **Settings**, then **Linked devices**, then **Link a device**, and scan the QR code shown in the terminal.

**5. Try it, then schedule it.**
```bash
npm run dry-run          # prints the message, sends nothing, touches no real state
npm run install:launchd  # schedule it
```

Keep the Mac logged in to your user account (System Settings, Users & Groups, automatic login). WhatsApp and the Keychain need a user session.

## Scheduling

- `RUN_TIMES` in `.env`, IST, comma separated. Default `10:00`.
- launchd runs `bin/tick.sh` every 5 minutes. It is a few lines of shell and only starts Node when a run is due.
- **Missed run** (Mac off or asleep at 10:00): the run happens once the Mac has been awake for 10 minutes, with that day's digest.
- **At most once per slot per day.** Missed *days* are never backfilled. A failing slot is retried at most 3 times.

## When something needs you

- **School login expired** (many schools sign student accounts out every few days): you get a WhatsApp message in your own "Message yourself" chat. Run `npm run login:school` (about 30 seconds, and Chrome fills in the saved password). Emails and WhatsApp reminders keep working in the meantime. Emails with attachments are held and processed after you log in again.
- **WhatsApp unlinked** (phone offline for about 14 days, or removed under Linked devices): you get a macOS notification. Run `npm run login:whatsapp`.
- **Logs:** `data/bot.log` has errors, dropped tasks with reasons, and every sent message (`SENT` lines). Raw run output is in `data/run.out`.

## Rules the code enforces

- The model returns strict JSON. If it is invalid, the bot retries once; if it is still invalid, it logs and skips that item.
- Due dates must not be in the past and must be within 60 days. Near-identical tasks for the same kid and date are merged.
- A task with no clear date is sent once, with "date unclear, check source".
- Reminders go out daily from the day a task is read until its due date (marked TODAY on that day), then stop. If there are no tasks, nothing is sent.
- WhatsApp: one message per run, with a short random "typing" delay. No bulk sends.

## Tests

```bash
npm test            # sample email, sheet (3 tabs), image (OCR); model stubbed
LIVE=1 npm test     # same, against the real LM Studio model (~1 min)
```

## Security

- Secrets live only in `.env` (gitignored, mode 600). `.env.example` has the keys without values.
- Gmail scope is `gmail.readonly`. The school account is only ever read, through a browser profile in `data/` (gitignored).
- Passwords are never stored by the bot. The school account password is kept by Chrome in the macOS Keychain, only if you choose to save it.
- Names, emails and chat names live only in `.env`; the repo contains none.
- Logs never include tokens or message bodies other than the digest that was sent.

## Uninstall

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.school-reminder-bot.plist
rm ~/Library/LaunchAgents/com.school-reminder-bot.plist
```
