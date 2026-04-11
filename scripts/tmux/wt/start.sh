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

export TANGO_REPO_DIR="$PWD"
REPO_DIR="$(resolve_tango_repo_dir)"
SESSION_NAME="tango-wt-$slot"
WINDOW_NAME="slot-probe"
SLOT_ENV_FILE="$REPO_DIR/.env.slot"

if [ ! -f "$SLOT_ENV_FILE" ]; then
  echo "Missing required $SLOT_ENV_FILE" >&2
  echo "Run: scripts/dev/slot-env.sh $slot > .env.slot from the worktree root" >&2
  exit 1
fi

export TANGO_TMUX_SESSION="$SESSION_NAME"
TARGET="$(resolve_tmux_service_target "$WINDOW_NAME")"

printf "would launch node packages/discord/dist/main.js with env from .env + .env.slot in window %s:discord\n" "$SESSION_NAME"

if tmux_service_target_is_running "$TARGET"; then
  echo "tmux target '$TARGET' already running"
  exit 0
fi

printf -v PROBE_CMD '%s' "cd \"$REPO_DIR\" && set -a && if [ -f .env ]; then source .env; fi && source .env.slot && set +a && while true; do date; printf 'TANGO_PROFILE=%s\nTANGO_SLOT=%s\nTANGO_VOICE_BRIDGE_ENABLED=%s\n' \"\$TANGO_PROFILE\" \"\$TANGO_SLOT\" \"\$TANGO_VOICE_BRIDGE_ENABLED\"; sleep 5; done"
printf -v RUN_CMD 'bash -lc %q' "$PROBE_CMD"

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  tmux new-window -t "$SESSION_NAME" -n "$WINDOW_NAME" -c "$REPO_DIR" "$RUN_CMD"
else
  tmux new-session -d -s "$SESSION_NAME" -n "$WINDOW_NAME" -c "$REPO_DIR" "$RUN_CMD"
fi

echo "Started slot probe in tmux target '${SESSION_NAME}:${WINDOW_NAME}'"
