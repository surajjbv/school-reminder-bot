#!/bin/bash
# launchd calls this every 5 min (cheap: no Node unless a run is due).
# Runs the bot once per RUN_TIMES slot per day, at least 10 min after boot/wake,
# and only for the latest slot already passed today: missed days are never backfilled.
set -u
cd "$(dirname "$0")/.."
mkdir -p data/state

RUN_TIMES=$(grep -E '^RUN_TIMES=' .env 2>/dev/null | cut -d= -f2 | tr -d ' "')
RUN_TIMES=${RUN_TIMES:-10:00}
today=$(TZ=Asia/Kolkata date +%F)
now=$(TZ=Asia/Kolkata date +%H%M)

secs() { sysctl -n "$1" | sed -E 's/.*sec = ([0-9]+).*/\1/'; }
boot=$(secs kern.boottime); wake=$(secs kern.waketime)
last=$(( wake > boot ? wake : boot ))
[ $(( $(date +%s) - last )) -lt 600 ] && exit 0

slot=""
for t in $(echo "$RUN_TIMES" | tr ',' '\n' | sort); do
  [ "${t/:/}" -le "$now" ] && slot=$t
done
[ -z "$slot" ] && exit 0

key="data/state/${today}_${slot/:/}"
[ -e "$key.done" ] && exit 0
tries=$(cat "$key.tries" 2>/dev/null || echo 0)
[ "$tries" -ge 3 ] && exit 0            # give up on this slot after 3 failed attempts

mkdir data/state/lock 2>/dev/null || exit 0
trap 'rmdir data/state/lock' EXIT
echo $(( tries + 1 )) > "$key.tries"

if node --disable-warning=ExperimentalWarning src/index.js --slot "$slot" >> data/run.out 2>&1; then
  touch "$key.done"
fi
find data/state -name '20*' -mtime +7 -delete 2>/dev/null
