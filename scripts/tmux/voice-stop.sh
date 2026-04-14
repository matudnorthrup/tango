#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/session.sh"

WINDOW_NAME="${TANGO_VOICE_WINDOW:-voice}"
TARGET="$(resolve_tmux_service_target "$WINDOW_NAME")"

if tmux_service_target_is_running "$TARGET"; then
  tmux_service_target_kill "$TARGET"
  echo "Stopped Tango Voice at tmux target '$TARGET'"
else
  echo "No Tango Voice tmux target running (expected '$TARGET')"
fi
