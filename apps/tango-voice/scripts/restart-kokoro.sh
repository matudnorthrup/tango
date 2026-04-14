#!/usr/bin/env bash
set -euo pipefail

# Kokoro runs as a window inside the shared `tango` tmux session. Fall back to a
# legacy standalone `kokoro` session if one is still around during migration.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SESSION_HELPER="$SCRIPT_DIR/../../../scripts/tmux/session.sh"

if [ -f "$SESSION_HELPER" ]; then
  # shellcheck source=/dev/null
  source "$SESSION_HELPER"
  TARGET="$(resolve_tmux_service_target kokoro)"
else
  TARGET="tango:kokoro"
fi

tmux send-keys -t "$TARGET" C-c
sleep 1
tmux send-keys -t "$TARGET" "cd ~/Kokoro-FastAPI && source .venv/bin/activate && USE_GPU=false DEVICE_TYPE=cpu python -m uvicorn api.src.main:app --host 0.0.0.0 --port 8880" C-m
