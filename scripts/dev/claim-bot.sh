#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
BOT_LOCK_SCRIPT="$SCRIPT_DIR/bot-lock.sh"
WT_START_SCRIPT="$REPO_DIR/scripts/tmux/wt/start.sh"
MAIN_START_SCRIPT="$REPO_DIR/scripts/tmux/start.sh"
source "$REPO_DIR/scripts/tmux/session.sh"

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
  local main_repo_dir=""
  local node_bin="${TANGO_NODE_BIN:-/opt/homebrew/opt/node@22/bin/node}"
  local run_cmd=""

  main_repo_dir="$(resolve_tango_repo_dir)"

  if [ ! -x "$node_bin" ]; then
    node_bin="$(command -v node || true)"
  fi

  if [ -z "${node_bin:-}" ]; then
    fail "No Node runtime found. Install Node 22 or set TANGO_NODE_BIN."
  fi

  if [ ! -f "$main_repo_dir/packages/discord/dist/main.js" ]; then
    fail "Build output not found at $main_repo_dir/packages/discord/dist/main.js"
  fi

  printf -v run_cmd '%s' "cd \"$main_repo_dir\" && env -u CLAUDECODE DISCORD_LISTEN_ONLY=false \"$node_bin\" packages/discord/dist/main.js"

  if tmux has-session -t tango 2>/dev/null; then
    if ! main_discord_window_exists; then
      tmux new-window -t tango -n discord -c "$main_repo_dir" "$run_cmd"
    fi
    return 0
  fi

  "$MAIN_START_SCRIPT"
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

wait_for_slot_mode_threads() {
  local target="$1"
  local timeout_seconds="$2"
  local waited=0

  while [ "$waited" -lt "$timeout_seconds" ]; do
    if tmux capture-pane -t "$target" -p 2>/dev/null | grep -q '\[slot-mode\] initialization complete '; then
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

require_slot_worktree_env

if [ "$live_mode" -eq 0 ]; then
  echo "[DRY-RUN] would acquire lock for slot $slot"
  echo "[DRY-RUN] would stop tango:discord"
  echo "[DRY-RUN] would wait for tango:discord to exit"
  if [ -n "${DISCORD_ALLOWED_CHANNELS_OVERRIDE:-}" ]; then
    echo "[DRY-RUN] would start tango-wt-$slot:discord with DISCORD_ALLOWED_CHANNELS=$DISCORD_ALLOWED_CHANNELS_OVERRIDE"
  else
    echo "[DRY-RUN] would start tango-wt-$slot:discord with TANGO_SLOT=$slot (bot will self-provision test threads)"
  fi
  echo "[DRY-RUN] would wait for [slot-mode] thread ready lines in slot bot logs"
  echo "[DRY-RUN] would print thread URLs to operator"
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

if [ -n "${DISCORD_ALLOWED_CHANNELS_OVERRIDE:-}" ]; then
  TANGO_SLOT_MODE=discord DISCORD_ALLOWED_CHANNELS="$DISCORD_ALLOWED_CHANNELS_OVERRIDE" "$WT_START_SCRIPT" "$slot"
else
  TANGO_SLOT_MODE=discord "$WT_START_SCRIPT" "$slot"
fi
slot_bot_started=1

if [ -n "${DISCORD_ALLOWED_CHANNELS_OVERRIDE:-}" ]; then
  if ! wait_for_discord_ready "tango-wt-$slot:discord" 60; then
    fail "Slot Discord bot did not report ready within 60 seconds."
  fi

  trap - EXIT INT TERM
  echo "Claimed Discord bot for slot wt-$slot with DISCORD_ALLOWED_CHANNELS=$DISCORD_ALLOWED_CHANNELS_OVERRIDE"
  echo "Release with: scripts/dev/release-bot.sh $slot --live"
  exit 0
fi

if ! wait_for_slot_mode_threads "tango-wt-$slot:discord" 60; then
  fail "Slot Discord bot did not finish slot-mode thread provisioning within 60 seconds."
fi

tmux capture-pane -t "tango-wt-$slot:discord" -p 2>/dev/null \
  | sed -n 's/^.*\[slot-mode\] thread ready: .* url=\(.*\)$/\1/p'

trap - EXIT INT TERM
echo "Claimed Discord bot for slot wt-$slot with self-provisioned slot-mode threads"
echo "Release with: scripts/dev/release-bot.sh $slot --live"
