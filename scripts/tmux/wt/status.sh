#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <slot: 1|2|3> [lines]" >&2
  exit 1
}

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  usage
fi

slot="$1"
lines="${2:-40}"

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

if ! tmux_service_target_is_running "$TARGET"; then
  echo "status=stopped"
  echo "target=$TARGET"
  exit 1
fi

echo "status=running"
echo "target=$TARGET"
tmux list-panes -t "$TARGET" -F "pane=#{pane_index} dead=#{pane_dead} command=#{pane_current_command}"
echo "--- recent logs ---"
tmux capture-pane -t "$TARGET" -p | tail -n "$lines"
