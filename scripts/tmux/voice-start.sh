#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/session.sh"
REPO_DIR="$(resolve_tango_repo_dir)"

SESSION_NAME="$(resolve_tango_tmux_session_name)"
WINDOW_NAME="${TANGO_VOICE_WINDOW:-voice}"
TARGET="$(resolve_tmux_service_target "$WINDOW_NAME")"
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

if tmux_service_target_is_running "$TARGET"; then
  echo "tmux target '$TARGET' already running"
  exit 0
fi

RUN_CMD="cd \"$APP_DIR\" && \"$NODE_BIN\" dist/index.js"

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  tmux new-window -t "$SESSION_NAME" -n "$WINDOW_NAME" -c "$APP_DIR" "$RUN_CMD"
else
  tmux new-session -d -s "$SESSION_NAME" -n "$WINDOW_NAME" -c "$APP_DIR" "$RUN_CMD"
fi

echo "Started Tango Voice in tmux target '${SESSION_NAME}:${WINDOW_NAME}'"
