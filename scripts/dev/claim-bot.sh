#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
BOT_LOCK_SCRIPT="$SCRIPT_DIR/bot-lock.sh"
WT_START_SCRIPT="$REPO_DIR/scripts/tmux/wt/start.sh"

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

resolve_thread_id() {
  local requested_slot="$1"
  local slot_config_path="$HOME/.tango/slots/wt-$requested_slot/slot.json"
  local thread_id=""

  if [ -n "${DISCORD_ALLOWED_CHANNELS_OVERRIDE:-}" ]; then
    printf '%s\n' "$DISCORD_ALLOWED_CHANNELS_OVERRIDE"
    return 0
  fi

  if [ -f "$slot_config_path" ]; then
    if command -v jq >/dev/null 2>&1; then
      thread_id="$(jq -r '.thread_id // empty' "$slot_config_path")"
    else
      thread_id="$(
        sed -nE 's/.*"thread_id"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$slot_config_path" \
          | sed -n '1p'
      )"
    fi

    if [ -n "$thread_id" ]; then
      printf '%s\n' "$thread_id"
      return 0
    fi
  fi

  fail "No thread configured for slot $requested_slot. Run Phase 2c thread provisioning first, or set DISCORD_ALLOWED_CHANNELS_OVERRIDE for testing."
}

require_slot_worktree_env() {
  local slot_env_file="$PWD/.env.slot"
  if [ ! -f "$slot_env_file" ]; then
    fail "Missing required $slot_env_file. Run scripts/dev/slot-env.sh $slot > .env.slot from the slot worktree root."
  fi
}

main_discord_window_exists() {
  tmux has-session -t tango 2>/dev/null \
    && tmux list-windows -t tango -F '#{window_name}' 2>/dev/null | grep -qx 'discord'
}

main_discord_session_exists() {
  tmux has-session -t tango-discord 2>/dev/null
}

stop_main_discord() {
  if main_discord_window_exists; then
    tmux kill-window -t tango:discord
    return 0
  fi

  if main_discord_session_exists; then
    tmux kill-session -t tango-discord
    return 0
  fi

  fail "Main Discord bot is not running in tango:discord or tango-discord."
}

wait_for_main_discord_exit() {
  local waited=0
  while [ "$waited" -lt 10 ]; do
    if ! main_discord_window_exists && ! main_discord_session_exists; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done

  return 1
}

start_main_discord() {
  local startup_script="$REPO_DIR/scripts/tmux/start.sh"
  "$startup_script"
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

thread_id="$(resolve_thread_id "$slot")"
require_slot_worktree_env

if [ "$live_mode" -eq 0 ]; then
  echo "[DRY-RUN] would acquire lock for slot $slot"
  echo "[DRY-RUN] would stop tango:discord"
  echo "[DRY-RUN] would wait for tango:discord to exit"
  echo "[DRY-RUN] would start tango-wt-$slot:discord with DISCORD_ALLOWED_CHANNELS=$thread_id"
  echo "[DRY-RUN] would wait for tango-wt-$slot:discord to report ready"
  echo "[DRY-RUN] would leave release command: scripts/dev/release-bot.sh $slot --live"
  exit 0
fi

lock_acquired=0
slot_bot_started=0
main_bot_stopped=0

cleanup_on_error() {
  local status="$1"

  if [ "$status" -eq 0 ]; then
    return 0
  fi

  if [ "$slot_bot_started" -eq 1 ]; then
    "$REPO_DIR/scripts/tmux/wt/stop.sh" "$slot" --window discord >/dev/null 2>&1 || true
  fi

  if [ "$main_bot_stopped" -eq 1 ]; then
    start_main_discord >/dev/null 2>&1 || true
  fi

  if [ "$lock_acquired" -eq 1 ]; then
    "$BOT_LOCK_SCRIPT" release "$slot" >/dev/null 2>&1 || true
  fi
}

trap 'cleanup_on_error "$?"' EXIT INT TERM

if ! "$BOT_LOCK_SCRIPT" acquire "$slot" >/dev/null; then
  fail "Unable to acquire bot lock for slot $slot. See: scripts/dev/bot-lock.sh status"
fi
lock_acquired=1

stop_main_discord
main_bot_stopped=1

if ! wait_for_main_discord_exit; then
  fail "Main Discord bot did not exit cleanly."
fi

TANGO_SLOT_MODE=discord DISCORD_ALLOWED_CHANNELS="$thread_id" "$WT_START_SCRIPT" "$slot"
slot_bot_started=1

if ! wait_for_discord_ready "tango-wt-$slot:discord" 60; then
  fail "Slot Discord bot did not report ready within 60 seconds."
fi

trap - EXIT INT TERM
echo "Claimed Discord bot for slot wt-$slot with DISCORD_ALLOWED_CHANNELS=$thread_id"
echo "Release with: scripts/dev/release-bot.sh $slot --live"
