#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/session.sh"
REPO_DIR="$(resolve_tango_repo_dir)"

SESSION_NAME="$(resolve_tango_tmux_session_name)"
WINDOW_NAME="${TANGO_DISCORD_WINDOW:-discord}"
TARGET="$(resolve_tmux_service_target "$WINDOW_NAME")"
NODE_BIN="${TANGO_NODE_BIN:-/Users/devinnorthrup/.nvm/versions/node/v24.14.0/bin/node}"

if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
fi

if [ -z "${NODE_BIN:-}" ]; then
  echo "No Node runtime found. Install Node 22 or set TANGO_NODE_BIN."
  exit 1
fi

if [ ! -f "$REPO_DIR/packages/discord/dist/main.js" ]; then
  echo "Build output not found at packages/discord/dist/main.js"
  echo "Run: npm run build"
  exit 1
fi

if tmux_service_target_is_running "$TARGET"; then
  echo "tmux target '$TARGET' already running"
  exit 0
fi

RUN_CMD="cd \"$REPO_DIR\" && env -u CLAUDECODE DISCORD_LISTEN_ONLY=false \"$NODE_BIN\" packages/discord/dist/main.js"

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  tmux new-window -t "$SESSION_NAME" -n "$WINDOW_NAME" -c "$REPO_DIR" "$RUN_CMD"
else
  tmux new-session -d -s "$SESSION_NAME" -n "$WINDOW_NAME" -c "$REPO_DIR" "$RUN_CMD"
fi

echo "Started Tango Discord in tmux target '${SESSION_NAME}:${WINDOW_NAME}'"
