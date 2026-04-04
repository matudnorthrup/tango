#!/usr/bin/env bash
set -euo pipefail

SESSION_NAME="${TANGO_VOICE_TMUX_SESSION:-tango-voice}"
LINES="${1:-80}"

if ! tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "No tmux session named '$SESSION_NAME'"
  exit 1
fi

tmux capture-pane -t "$SESSION_NAME" -p | tail -n "$LINES"
