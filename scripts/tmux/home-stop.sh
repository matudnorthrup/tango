#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/session.sh"

WINDOW_NAME="${TANGO_HOME_WINDOW:-home}"
TARGET="$(resolve_tmux_service_target "$WINDOW_NAME")"

if tmux_service_target_is_running "$TARGET"; then
  tmux_service_target_kill "$TARGET"
  echo "Stopped home directory site at tmux target '$TARGET'"
else
  echo "No home tmux target running (expected '$TARGET')"
fi
