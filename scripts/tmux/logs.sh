#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/session.sh"

SESSION_NAME="$(resolve_tmux_target_session_name)"
LINES="${1:-80}"

if ! tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "No tmux session named '$SESSION_NAME'"
  exit 1
fi

tmux capture-pane -t "$SESSION_NAME" -p | tail -n "$LINES"
