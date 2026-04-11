#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
BOT_LOCK_SCRIPT="$SCRIPT_DIR/bot-lock.sh"
WT_STOP_SCRIPT="$REPO_DIR/scripts/tmux/wt/stop.sh"
MAIN_START_SCRIPT="$REPO_DIR/scripts/tmux/start.sh"

usage() {
  echo "Usage: $0 <slot: 1|2|3> [--live]" >&2
  exit 1
}

fail() {
  echo "$*" >&2
  exit 1
}

validate_slot() {
  case "$1" in
    1|2|3) ;;
    *)
      fail "Invalid slot '$1'. Expected 1, 2, or 3."
      ;;
  esac
}

read_lock_slot() {
  local status_output="$1"
  printf '%s\n' "$status_output" | sed -n 's/^slot=//p' | sed -n '1p'
}

main_discord_target() {
  if tmux has-session -t tango 2>/dev/null \
    && tmux list-windows -t tango -F '#{window_name}' 2>/dev/null | grep -qx 'discord'; then
    printf 'tango:discord\n'
    return 0
  fi

  if tmux has-session -t tango-discord 2>/dev/null; then
    printf 'tango-discord\n'
    return 0
  fi

  printf 'tango:discord\n'
}

wait_for_discord_ready() {
  local target="$1"
  local timeout_seconds="$2"
  local waited=0

  while [ "$waited" -lt "$timeout_seconds" ]; do
    if tmux capture-pane -t "$target" -p 2>/dev/null | grep -q '\[tango-discord\] connected as '; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done

  return 1
}

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  usage
fi

slot="$1"
validate_slot "$slot"
shift

live_mode=0
if [ "$#" -eq 1 ]; then
  [ "$1" = "--live" ] || usage
  live_mode=1
fi

lock_status="$("$BOT_LOCK_SCRIPT" status)"
lock_slot="$(read_lock_slot "$lock_status")"

if [ "$lock_status" = "not held" ]; then
  fail "Bot lock is not held."
fi

if [ "$lock_slot" != "$slot" ]; then
  fail "Bot lock is held by slot ${lock_slot:-unknown}, not slot $slot."
fi

if [ "$live_mode" -eq 0 ]; then
  echo "[DRY-RUN] would stop tango-wt-$slot:discord"
  echo "[DRY-RUN] would wait for tango-wt-$slot:discord to exit"
  echo "[DRY-RUN] would start tango:discord"
  echo "[DRY-RUN] would wait for main Discord bot to report ready"
  echo "[DRY-RUN] would release lock for slot $slot"
  exit 0
fi

"$WT_STOP_SCRIPT" "$slot" --window discord
"$MAIN_START_SCRIPT"

main_target="$(main_discord_target)"
if ! wait_for_discord_ready "$main_target" 60; then
  fail "Main Discord bot did not report ready within 60 seconds."
fi

"$BOT_LOCK_SCRIPT" release "$slot" >/dev/null
echo "Released Discord bot for slot wt-$slot and restarted main at $main_target"
