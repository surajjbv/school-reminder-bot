#!/bin/bash
# bash schedule.sh install    install the launchd agent (checks every 5 min)
# bash schedule.sh uninstall  remove it
# bash schedule.sh            (called by launchd) send once per RUN_TIMES slot, at least 10 min after
#                             boot/wake. A slot that fails or is missed (Mac asleep) is retried until
#                             it is sent or the next slot starts (for one daily time: until tomorrow's).
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
secs() { sysctl -n "$1" | sed -E 's/.*sec = ([0-9]+).*/\1/'; }
boot=$(secs kern.boottime); wake=$(secs kern.waketime)
(( $(date +%s) - (wake > boot ? wake : boot) < 600 )) && exit 0

# The latest send time already passed, e.g. "2026-09-29 20:00" (same rule as the bot, from RUN_TIMES).
slot=$(node --disable-warning=ExperimentalWarning -e "import('./lib.js').then((m) => console.log(m.currentSlot()))") || exit 1
key="data/state/${slot//[ :]/_}"
[ -e "$key.done" ] && exit 0
tries=$(cat "$key.tries" 2>/dev/null || echo 0)
# After 3 failed attempts (5 min apart), retry every 30 min.
[ "$tries" -ge 3 ] && [ -n "$(find "$key.tries" -mmin -30 2>/dev/null)" ] && exit 0
find data/state -maxdepth 1 -name lock -mmin +30 -exec rmdir {} \; 2>/dev/null  # left by a crash or power loss
mkdir data/state/lock 2>/dev/null || exit 0
trap 'rmdir data/state/lock; "$HOME/.lmstudio/bin/lms" unload school-reminder-bot >/dev/null 2>&1' EXIT
echo $(( tries + 1 )) > "$key.tries"

node --disable-warning=ExperimentalWarning bot.js --slot "$slot" >> data/run.out 2>&1 && touch "$key.done"
find data/state -name '20*' -mtime +7 -delete 2>/dev/null
