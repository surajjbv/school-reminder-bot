#!/bin/bash
# Installs (or reinstalls) the launchd agent for the current user.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_DIR="$(dirname "$(command -v node)")"
DEST="$HOME/Library/LaunchAgents/com.school-reminder-bot.plist"
mkdir -p "$ROOT/data" "$HOME/Library/LaunchAgents"
sed -e "s|__ROOT__|$ROOT|g" -e "s|__NODE_DIR__|$NODE_DIR|g" "$ROOT/launchd/com.school-reminder-bot.plist" > "$DEST"
launchctl bootout "gui/$(id -u)" "$DEST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DEST"
echo "Installed: $DEST (checks every 5 min; runs at RUN_TIMES from .env)"
echo "Uninstall: launchctl bootout gui/$(id -u) $DEST && rm $DEST"
