#!/usr/bin/env bash
set -euo pipefail

SESSION_NAME="${TANGO_VOICE_TMUX_SESSION:-tango-voice}"

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  tmux kill-session -t "$SESSION_NAME"
  echo "Stopped tmux session '$SESSION_NAME'"
else
  echo "No tmux session named '$SESSION_NAME'"
fi
