#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
BOT_LOCK_SCRIPT="$SCRIPT_DIR/bot-lock.sh"

usage() {
  cat <<'EOF'
Usage:
  scripts/dev/run-slot-tests.sh <slot: 1|2|3> [--timeout 45] [--no-cleanup]

Runs the Discord webhook harness against the active slot smoke-test threads after
verifying that the bot lock is currently held by the requested slot.
EOF
}

if [ $# -lt 1 ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

slot="$1"
shift

case "$slot" in
  1|2|3) ;;
  *)
    echo "Invalid slot '$slot'. Expected 1, 2, or 3." >&2
    exit 1
    ;;
esac

status="$("$BOT_LOCK_SCRIPT" status)"
if [ "$status" = "not held" ]; then
  echo "Bot lock is not currently held." >&2
  exit 1
fi

lock_slot="$(printf '%s\n' "$status" | sed -n 's/^slot=//p' | sed -n '1p')"
if [ "$lock_slot" != "$slot" ]; then
  echo "Bot lock is held by slot ${lock_slot:-unknown}, not slot $slot." >&2
  exit 1
fi

exec node --import tsx "$REPO_DIR/apps/tango-voice/src/testing/discord-slot-test-runner.ts" --slot "$slot" "$@"
