#!/bin/zsh
# Double-click in Finder to run the bot once now (the same as `npm start`).
cd "${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
npm start --silent
code=$?
echo; read -k1 -s "?Finished (exit $code; details in data/bot.log). Press any key to close."
