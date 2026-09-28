#!/bin/bash
# bash schedule.sh install    install the launchd agent (checks every 5 min)
# bash schedule.sh uninstall  remove it
# bash schedule.sh            (called by launchd) run once per RUN_TIMES slot per day, at least
#                             10 min after boot/wake; missed days are never backfilled.
set -u
cd "$(dirname "$0")"
LABEL=com.school-reminder-bot
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

case "${1:-}" in
install)
  mkdir -p data "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$PWD/schedule.sh</string></array>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$(dirname "$(command -v node)"):/usr/bin:/bin:/usr/sbin</string></dict>
  <key>StandardOutPath</key><string>$PWD/data/launchd.log</string>
  <key>StandardErrorPath</key><string>$PWD/data/launchd.log</string>
</dict></plist>
EOF
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null
  launchctl bootstrap "gui/$(id -u)" "$PLIST" && echo "Scheduled (RUN_TIMES in .env). Remove with: bash schedule.sh uninstall"
  exit ;;
uninstall)
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null; rm -f "$PLIST"; echo "Unscheduled."
  exit ;;
esac

mkdir -p data/state
RUN_TIMES=$(grep -E '^RUN_TIMES=' .env 2>/dev/null | cut -d= -f2 | tr -d ' "')
today=$(TZ=Asia/Kolkata date +%F)
now=$(TZ=Asia/Kolkata date +%H%M)

secs() { sysctl -n "$1" | sed -E 's/.*sec = ([0-9]+).*/\1/'; }
boot=$(secs kern.boottime); wake=$(secs kern.waketime)
(( $(date +%s) - (wake > boot ? wake : boot) < 600 )) && exit 0

slot=""
for t in $(echo "${RUN_TIMES:-10:00}" | tr ',' '\n' | sort); do
  [ "${t/:/}" -le "$now" ] && slot=$t   # latest slot already passed today
done
[ -z "$slot" ] && exit 0

key="data/state/${today}_${slot/:/}"
[ -e "$key.done" ] && exit 0
tries=$(cat "$key.tries" 2>/dev/null || echo 0)
[ "$tries" -ge 3 ] && exit 0            # give up on this slot after 3 failed attempts
mkdir data/state/lock 2>/dev/null || exit 0
trap 'rmdir data/state/lock; "$HOME/.lmstudio/bin/lms" unload school-reminder-bot >/dev/null 2>&1' EXIT
echo $(( tries + 1 )) > "$key.tries"

node --disable-warning=ExperimentalWarning bot.js --slot "$slot" >> data/run.out 2>&1 && touch "$key.done"
find data/state -name '20*' -mtime +7 -delete 2>/dev/null
