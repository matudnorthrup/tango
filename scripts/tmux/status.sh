#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/session.sh"

SESSION_NAME="$(resolve_tmux_target_session_name)"
LINES="${1:-40}"

if ! tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "status=stopped"
  echo "session=$SESSION_NAME"
  exit 1
fi

echo "status=running"
echo "session=$SESSION_NAME"
tmux list-panes -t "$SESSION_NAME" -F "pane=#{pane_index} dead=#{pane_dead} command=#{pane_current_command}"
echo "--- recent logs ---"
tmux capture-pane -t "$SESSION_NAME" -p | tail -n "$LINES"
