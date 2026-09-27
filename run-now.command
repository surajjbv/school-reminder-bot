#!/bin/zsh
# Double-click in Finder to run the bot once, on demand, with live progress.
# Optionally quits other apps first (QUIT_ALL_COMMAND in .env) to free memory for the model.
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

echo "  ${GRN}[Enter]${OFF}  run and ${B}send${OFF} today's reminder to the group"
echo "  ${CYN}[d]${OFF}      dry run: show the reminder, send nothing"
echo "  ${YEL}[q]${OFF}      quit"
echo
read -k1 -s "choice?Your choice: "
echo
case "$choice" in
  q|Q) echo "Cancelled."; exit 0 ;;
  d|D) MODE="--dry-run"; echo "${CYN}Dry run selected.${OFF}" ;;
  *)   MODE="";          echo "${GRN}Live run selected.${OFF}" ;;
esac

QUIT_ALL=$(grep -E '^QUIT_ALL_COMMAND=' .env | cut -d= -f2- | tr -d '"')
QUIT_ALL=${QUIT_ALL/#\~/$HOME}
if [[ -n "$QUIT_ALL" && -x "$QUIT_ALL" ]]; then
  echo; echo "${MAG}[0/5]${OFF} ${B}Quitting other apps${OFF} ${DIM}($QUIT_ALL)${OFF}"
  "$QUIT_ALL" && sleep 3
fi

# Don't overlap with a scheduled run.
mkdir -p data/state
if ! mkdir data/state/lock 2>/dev/null; then
  echo "${YEL}Another run is in progress. Try again in a few minutes.${OFF}"; say_done 1
fi
trap 'rmdir data/state/lock 2>/dev/null' EXIT

START=$SECONDS
node --disable-warning=ExperimentalWarning src/index.js $MODE --slot "manual-$(date +%H%M%S)"
CODE=$?
echo
if (( CODE == 0 )); then
  echo "${GRN}✔ Done in $(( SECONDS - START ))s.${OFF} ${DIM}Log: data/bot.log${OFF}"
else
  echo "${RED}✘ Failed after $(( SECONDS - START ))s.${OFF} See the red lines above, or data/bot.log."
fi
say_done $CODE
