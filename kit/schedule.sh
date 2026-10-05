#!/bin/bash
# The bot's launchd scheduler.    npm run schedule    install (launchd calls this every 5 min)
#                                 npm run unschedule  remove
# Each call (from launchd): runs the bot once per slot, the latest of config.json "runTimes" already passed (in
# "timezone"), at least 10 min after boot or wake. A slot older than 10 h is skipped. On failure or exit 75 it is
# retried every 5 min up to 3 times, then every 30 min, until the next slot.
set -u
cd "$(dirname "$0")/.." || exit 1
NAME=$(node -p 'require("./package.json").name') || exit 1
LABEL="com.$NAME"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

case "${1:-}" in
install)
  mkdir -p data "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<XML
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$PWD/kit/schedule.sh</string></array>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$(dirname "$(command -v node)"):/usr/bin:/bin:/usr/sbin</string></dict>
  <key>StandardOutPath</key><string>$PWD/data/launchd.log</string>
  <key>StandardErrorPath</key><string>$PWD/data/launchd.log</string>
</dict></plist>
XML
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null
  launchctl bootstrap "gui/$(id -u)" "$PLIST" && echo "Scheduled (runTimes in config.json). Log: data/bot.log. Remove: npm run unschedule"
  exit ;;
uninstall)
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null; rm -f "$PLIST"; echo "Unscheduled."
  exit ;;
esac

secs() { sysctl -n "$1" 2>/dev/null | sed -E 's/.*sec = ([0-9]+).*/\1/'; }
boot=$(secs kern.boottime); wake=$(secs kern.waketime); wake=${wake:-0}
(( $(date +%s) - (wake > boot ? wake : boot) < 600 )) && exit 0   # let the Mac settle after boot/wake

# "<slot>|<age in s>", e.g. "2026-10-05 20:00|300"
# Only runTimes and timezone matter here; the bot validates all of config.json when it starts.
info=$(node --input-type=module -e '
  import fs from "node:fs";
  import { KIT_DEFAULTS, currentSlot, slotAge } from "./kit/config.js";
  const c = { ...KIT_DEFAULTS, ...JSON.parse(fs.readFileSync("config.json", "utf8")) };
  const s = currentSlot(c.runTimes, c.timezone);
  console.log(s ? `${s}|${slotAge(s, c.timezone)}` : "");') || exit 1
[ -n "$info" ] || exit 0                                           # no runTimes
slot=${info%|*}; age=${info#*|}
(( age > 36000 )) && exit 0                                        # too stale; wait for the next slot

mkdir -p data
st=data/schedule.state                                             # "<slot>|<tries>|<sent 0/1>"
s=; tries=0; ok=0
{ IFS='|' read -r s tries ok < "$st"; } 2>/dev/null
[ "$s" = "$slot" ] || { tries=0; ok=0; }
[ "$ok" = 1 ] && exit 0
(( tries >= 3 )) && [ -n "$(find "$st" -mmin -30 2>/dev/null)" ] && exit 0
pid=$(cat data/run.lock 2>/dev/null) && kill -0 "$pid" 2>/dev/null && exit 0   # a run is still going

echo "$slot|$((tries + 1))|0" > "$st"
BOT_SLOT="$slot" npm start --silent >> data/run.out 2>&1
code=$?
[ $code = 0 ] && echo "$slot|$((tries + 1))|1" > "$st"
echo "$(date '+%F %T') slot $slot try $((tries + 1)): exit $code" >> data/run.out
