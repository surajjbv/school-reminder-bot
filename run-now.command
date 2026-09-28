#!/bin/zsh
# Double-click in Finder to run the bot once and send today's reminder, with live progress.
cd "${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

B=$'\e[1m'; DIM=$'\e[2m'; RED=$'\e[1;31m'; GRN=$'\e[1;32m'; YEL=$'\e[1;33m'; CYN=$'\e[1;36m'; MAG=$'\e[1;35m'; OFF=$'\e[0m'
say_done() { echo; echo "${DIM}Press any key to close this window.${OFF}"; read -k1 -s; exit ${1:-0}; }

clear
echo "${MAG}╭──────────────────────────────────────╮${OFF}"
echo "${MAG}│${OFF}  ${B}school-reminder-bot${OFF} · on-demand run ${MAG}│${OFF}"
echo "${MAG}╰──────────────────────────────────────╯${OFF}"
echo

[[ -f .env ]] || { echo "${RED}No .env file here. See README setup.${OFF}"; say_done 1; }
command -v node >/dev/null || { echo "${RED}Node.js not found.${OFF}"; say_done 1; }

# Don't overlap with a scheduled run.
mkdir -p data/state
if ! mkdir data/state/lock 2>/dev/null; then
  echo "${YEL}Another run is in progress. Try again in a few minutes.${OFF}"; say_done 1
fi
# On any exit: release the lock and make sure the bot's model is not left in RAM.
trap 'rmdir data/state/lock 2>/dev/null; ~/.lmstudio/bin/lms unload school-reminder-bot >/dev/null 2>&1' EXIT

START=$SECONDS
node --disable-warning=ExperimentalWarning bot.js --slot "manual-$(date +%H%M%S)"
CODE=$?
echo
if (( CODE == 0 )); then
  echo "${GRN}✔ Done in $(( SECONDS - START ))s.${OFF} ${DIM}Log: data/bot.log${OFF}"
else
  echo "${RED}✘ Failed after $(( SECONDS - START ))s.${OFF} See the red lines above, or data/bot.log."
fi
say_done $CODE
