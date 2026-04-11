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
"$SCRIPT_DIR/stop.sh" "$slot" >/dev/null 2>&1 || true
"$SCRIPT_DIR/start.sh" "$slot"
echo "Restarted slot probe in tmux session 'tango-wt-$slot'"
