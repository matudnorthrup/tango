#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/session.sh"
REPO_DIR="$(resolve_tango_repo_dir)"

SESSION_NAME="$(resolve_tango_tmux_session_name)"
WINDOW_NAME="${TANGO_HOME_WINDOW:-home}"
TARGET="$(resolve_tmux_service_target "$WINDOW_NAME")"
NODE_BIN="${TANGO_NODE_BIN:-/Users/devinnorthrup/.nvm/versions/node/v24.14.0/bin/node}"
APP_DIR="$REPO_DIR/apps/home"

if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
fi

if [ -z "${NODE_BIN:-}" ]; then
  echo "No Node runtime found. Install Node 24 or set TANGO_NODE_BIN."
  exit 1
fi

if tmux_service_target_is_running "$TARGET"; then
  echo "tmux target '$TARGET' already running"
  exit 0
fi

RUN_CMD="cd \"$APP_DIR\" && \"$NODE_BIN\" server.mjs"

if tango_service_tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  tango_service_tmux new-window -t "$SESSION_NAME" -n "$WINDOW_NAME" -c "$APP_DIR" "$RUN_CMD"
else
  tango_service_tmux new-session -d -s "$SESSION_NAME" -n "$WINDOW_NAME" -c "$APP_DIR" "$RUN_CMD"
fi

echo "Started home directory site in tmux target '${SESSION_NAME}:${WINDOW_NAME}' (port ${TANGO_HOME_PORT:-9310})"
