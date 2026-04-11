#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <slot: 1|2|3>" >&2
  exit 1
}

if [ "$#" -ne 1 ]; then
  usage
fi

slot="$1"

case "$slot" in
  1|2|3) ;;
  *)
    echo "Invalid slot '$slot'. Expected 1, 2, or 3." >&2
    exit 1
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../session.sh"

SESSION_NAME="tango-wt-$slot"
WINDOW_NAME="slot-probe"
TARGET="${SESSION_NAME}:${WINDOW_NAME}"

tmux_window_exists() {
  tmux has-session -t "$SESSION_NAME" 2>/dev/null \
    && tmux list-windows -t "$SESSION_NAME" -F '#{window_name}' 2>/dev/null | grep -qx "$WINDOW_NAME"
}

if tmux_window_exists; then
  tmux kill-window -t "$TARGET"
  echo "Stopped slot probe at tmux target '$TARGET'"
else
  echo "No slot probe tmux target running (expected '$TARGET')"
fi
