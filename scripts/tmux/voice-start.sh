#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/session.sh"
REPO_DIR="$(resolve_tango_repo_dir)"
SESSION_NAME="${TANGO_VOICE_TMUX_SESSION:-tango-voice}"
NODE_BIN="${TANGO_NODE_BIN:-/opt/homebrew/opt/node@22/bin/node}"
APP_DIR="$REPO_DIR/apps/tango-voice"

if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
fi

if [ -z "${NODE_BIN:-}" ]; then
  echo "No Node runtime found. Install Node 22 or set TANGO_NODE_BIN."
  exit 1
fi

if [ ! -f "$APP_DIR/dist/index.js" ]; then
  echo "Build output not found at apps/tango-voice/dist/index.js"
  echo "Run: npm run build:voice-app"
  exit 1
fi

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "tmux session '$SESSION_NAME' already running"
  exit 0
fi

RUN_CMD="cd \"$APP_DIR\" && \"$NODE_BIN\" dist/index.js"
tmux new-session -d -s "$SESSION_NAME" "$RUN_CMD"

echo "Started Tango Voice in tmux session '$SESSION_NAME'"
