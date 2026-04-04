#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/session.sh"

SESSION_NAME="$(resolve_tmux_target_session_name)"

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  tmux kill-session -t "$SESSION_NAME"
  echo "Stopped tmux session '$SESSION_NAME'"
else
  echo "No tmux session named '$SESSION_NAME'"
fi
