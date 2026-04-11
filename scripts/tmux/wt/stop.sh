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
export TANGO_TMUX_SESSION="$SESSION_NAME"
TARGET="$(resolve_tmux_service_target "$WINDOW_NAME")"

if tmux_service_target_is_running "$TARGET"; then
  tmux_service_target_kill "$TARGET"
  echo "Stopped slot probe at tmux target '$TARGET'"
else
  echo "No slot probe tmux target running (expected '$TARGET')"
fi
