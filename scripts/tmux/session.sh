#!/usr/bin/env bash
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  set -euo pipefail
fi

# All Tango services live as windows inside one tmux session. By default, that
# session runs on a dedicated tmux socket so service processes are not children
# of a long-lived interactive tmux server with stale macOS auth/session state.
# Override the session name with TANGO_TMUX_SESSION if needed.
resolve_tango_tmux_session_name() {
  printf '%s\n' "${TANGO_TMUX_SESSION:-tango}"
}

resolve_tango_service_tmux_socket_name() {
  printf '%s\n' "${TANGO_SERVICE_TMUX_SOCKET_NAME:-tango-service}"
}

tango_service_tmux() {
  if [ -n "${TANGO_SERVICE_TMUX_SOCKET:-}" ]; then
    command tmux -S "$TANGO_SERVICE_TMUX_SOCKET" "$@"
  else
    command tmux -L "$(resolve_tango_service_tmux_socket_name)" "$@"
  fi
}

tango_service_tmux_command_hint() {
  if [ -n "${TANGO_SERVICE_TMUX_SOCKET:-}" ]; then
    printf 'tmux -S %q' "$TANGO_SERVICE_TMUX_SOCKET"
  else
    printf 'tmux -L %q' "$(resolve_tango_service_tmux_socket_name)"
  fi
}

# Backward-compatible helper kept for any callers that still expect a session name.
# The default changed from `tango-discord` to `tango`.
resolve_tmux_session_name() {
  resolve_tango_tmux_session_name
}

resolve_tmux_target_session_name() {
  resolve_tango_tmux_session_name
}

# Returns a tmux target string for a given service window. Examples:
#   resolve_tmux_service_target discord   -> tango:discord
#   resolve_tmux_service_target voice     -> tango:voice
#
# If a pre-consolidation standalone session (e.g. `tango-discord`, `tango-voice`,
# `kokoro`, `whisper-server`, `whisper-partials`, `owntracks`) is still running,
# the resolver returns that legacy target instead so in-flight services keep
# working through the migration.
resolve_tmux_service_target() {
  local window="$1"
  local session
  session="$(resolve_tango_tmux_session_name)"

  if tango_service_tmux has-session -t "$session" 2>/dev/null; then
    if tango_service_tmux list-windows -t "$session" -F '#{window_name}' 2>/dev/null | grep -qx "$window"; then
      printf '%s:%s\n' "$session" "$window"
      return 0
    fi
  fi

  local legacy
  case "$window" in
    discord) legacy="tango-discord" ;;
    voice) legacy="tango-voice" ;;
    kokoro) legacy="kokoro" ;;
    whisper-main) legacy="whisper-server" ;;
    whisper-partials) legacy="whisper-partials" ;;
    owntracks) legacy="owntracks" ;;
    *) legacy="" ;;
  esac

  if [ -n "$legacy" ] && tango_service_tmux has-session -t "$legacy" 2>/dev/null; then
    printf '%s\n' "$legacy"
    return 0
  fi

  # Nothing running yet — return the intended consolidated target so callers
  # have a stable string to create or report against.
  printf '%s:%s\n' "$session" "$window"
}

# True (exit 0) if the given tmux target currently has a live window/session.
tmux_service_target_is_running() {
  local target="$1"
  case "$target" in
    *:*)
      local s="${target%%:*}" w="${target##*:}"
      tango_service_tmux has-session -t "$s" 2>/dev/null \
        && tango_service_tmux list-windows -t "$s" -F '#{window_name}' 2>/dev/null | grep -qx "$w"
      ;;
    *)
      tango_service_tmux has-session -t "$target" 2>/dev/null
      ;;
  esac
}

# Kill whatever the target refers to — a window inside the shared session or a
# legacy standalone session.
tmux_service_target_kill() {
  local target="$1"
  case "$target" in
    *:*)
      tango_service_tmux kill-window -t "$target" 2>/dev/null || true
      ;;
    *)
      tango_service_tmux kill-session -t "$target" 2>/dev/null || true
      ;;
  esac
}

resolve_tango_repo_dir() {
  if [ -n "${TANGO_REPO_DIR:-}" ]; then
    printf '%s\n' "$TANGO_REPO_DIR"
    return 0
  fi

  local script_dir current_repo
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  current_repo="$(cd "$script_dir/../.." && pwd -P)"

  printf '%s\n' "$current_repo"
}

sync_tmux_service_environment() {
  local session_name="$1"

  if ! tango_service_tmux has-session -t "$session_name" 2>/dev/null \
    && ! tango_service_tmux list-sessions >/dev/null 2>&1; then
    return 0
  fi

  # Claude Code OAuth can depend on the GUI/login session environment. Long-lived
  # tmux servers may keep a stale SSH-style environment, so refresh the small set
  # of launch/session variables before creating service windows.
  local name value
  for name in \
    HOME \
    USER \
    LOGNAME \
    SHELL \
    PATH \
    TMPDIR \
    SSH_AUTH_SOCK \
    SECURITYSESSIONID \
    XPC_FLAGS \
    XPC_SERVICE_NAME \
    __CF_USER_TEXT_ENCODING \
    __CFBundleIdentifier \
    COMMAND_MODE \
    LaunchInstanceID
  do
    if printenv "$name" >/dev/null 2>&1; then
      value="$(printenv "$name")"
      tango_service_tmux set-environment -g "$name" "$value"
    fi
  done
}

# --- Cold-boot startup helpers (used by scripts/startup.sh) ---

_tango_startup_planned_windows=()

tango_startup_reset_planned_windows() {
  _tango_startup_planned_windows=()
}

tango_startup_add_planned_window() {
  _tango_startup_planned_windows+=("$1")
}

tango_startup_planned_windows() {
  if [ "${#_tango_startup_planned_windows[@]}" -gt 0 ]; then
    printf '%s\n' "${_tango_startup_planned_windows[@]}"
    return 0
  fi
  tango_startup_full_stack_windows
}

tango_startup_full_stack_windows() {
  printf '%s\n' kokoro whisper-main whisper-partials owntracks discord voice
}

tango_startup_expected_windows() {
  tango_startup_planned_windows
}

tango_startup_kokoro_ready() {
  [ -x "$HOME/Kokoro-FastAPI/.venv/bin/python" ] \
    && [ -f "$HOME/Kokoro-FastAPI/api/src/main.py" ]
}

tango_startup_whisper_ready() {
  command -v whisper-server >/dev/null 2>&1 \
    && [ -f "$HOME/whisper-models/ggml-small.en.bin" ]
}

tango_startup_voice_ready() {
  local voice_dir="${TANGO_VOICE_APP_DIR:-}"
  local voice_env="$voice_dir/.env"
  [ -n "$voice_dir" ] && [ -f "$voice_dir/dist/index.js" ] || return 1
  [ -f "$voice_env" ] || return 1
  grep -Eq '^DISCORD_VOICE_CHANNEL_ID=[0-9]+$' "$voice_env" 2>/dev/null
}

tango_startup_discord_ready() {
  local repo_dir="${TANGO_REPO_DIR:-}"
  [ -n "$repo_dir" ] && [ -f "$repo_dir/packages/discord/dist/main.js" ]
}

tango_startup_owntracks_ready() {
  local repo_dir="${TANGO_REPO_DIR:-}"
  [ -n "$repo_dir" ] \
    && [ -f "$repo_dir/apps/owntracks-receiver/server.js" ] \
    && [ -f "$repo_dir/.env" ]
}

tango_startup_window_exists() {
  local session="$1" window="$2"
  tango_service_tmux list-windows -t "$session" -F '#{window_name}' 2>/dev/null | grep -qx "$window"
}

tango_startup_session_is_complete() {
  local session="$1" window
  if ! tango_service_tmux has-session -t "$session" 2>/dev/null; then
    return 1
  fi
  while IFS= read -r window; do
    [ -z "$window" ] && continue
    if ! tango_startup_window_exists "$session" "$window"; then
      return 1
    fi
  done <<EOF
$(tango_startup_planned_windows)
EOF
  return 0
}

tango_startup_session_is_satisfied() {
  local session="$1"

  if ! tango_service_tmux has-session -t "$session" 2>/dev/null; then
    return 1
  fi

  if tango_startup_discord_ready && ! tango_startup_window_exists "$session" discord; then
    return 1
  fi

  if tango_startup_kokoro_ready && ! tango_startup_window_exists "$session" kokoro; then
    return 1
  fi

  if tango_startup_whisper_ready; then
    tango_startup_window_exists "$session" whisper-main || return 1
    tango_startup_window_exists "$session" whisper-partials || return 1
  fi

  if tango_startup_owntracks_ready && ! tango_startup_window_exists "$session" owntracks; then
    return 1
  fi

  if tango_startup_voice_ready && ! tango_startup_window_exists "$session" voice; then
    return 1
  fi

  return 0
}

resolve_tango_service_tmux_socket_path() {
  if [ -n "${TANGO_SERVICE_TMUX_SOCKET:-}" ]; then
    printf '%s\n' "$TANGO_SERVICE_TMUX_SOCKET"
    return 0
  fi
  printf '/private/tmp/tmux-%s/%s\n' "$(id -u)" "$(resolve_tango_service_tmux_socket_name)"
}

tango_service_tmux_server_alive() {
  tango_service_tmux list-sessions >/dev/null 2>&1
}

cleanup_stale_tango_service_tmux_socket() {
  local socket_path
  socket_path="$(resolve_tango_service_tmux_socket_path)"
  if [ -e "$socket_path" ] && ! tango_service_tmux_server_alive; then
    echo "Removing stale tmux socket: $socket_path"
    rm -f "$socket_path"
  fi
}

# Prepare for full-stack startup: drop stale sockets and incomplete sessions.
# Exit 0 = ready to create fresh session
# Exit 2 = session already satisfies all services available on this host
prepare_tango_startup_session() {
  local session="$1"
  local windows

  cleanup_stale_tango_service_tmux_socket

  if tango_service_tmux has-session -t "$session" 2>/dev/null; then
    if tango_startup_session_is_satisfied "$session"; then
      return 2
    fi
    windows="$(tango_service_tmux list-windows -t "$session" -F '#{window_name}' 2>/dev/null | tr '\n' ' ')"
    echo "Removing incomplete tmux session '$session' (windows:${windows:+ $windows})..."
    tango_service_tmux kill-session -t "$session" 2>/dev/null || true
    sleep 1
    cleanup_stale_tango_service_tmux_socket
  fi

  return 0
}

wait_for_tmux_session() {
  local session="$1"
  local max_wait="${2:-15}"
  local waited=0

  while [ "$waited" -lt "$max_wait" ]; do
    if tango_service_tmux has-session -t "$session" 2>/dev/null \
      && tango_service_tmux_server_alive; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done

  echo "Timed out waiting for tmux session '$session' (${max_wait}s)"
  return 1
}

# Retry transient tmux failures (common on cold boot right after new-session).
tango_service_tmux_retry() {
  local max_attempts="${1:-5}"
  local delay_secs="${2:-1}"
  shift 2
  local attempt=1

  while [ "$attempt" -le "$max_attempts" ]; do
    if tango_service_tmux "$@"; then
      return 0
    fi

    if [ "$attempt" -lt "$max_attempts" ]; then
      echo "tmux $* failed (attempt ${attempt}/${max_attempts}); retrying in ${delay_secs}s..."
      cleanup_stale_tango_service_tmux_socket
      sleep "$delay_secs"
      if [ "$delay_secs" -lt 8 ]; then
        delay_secs=$((delay_secs * 2))
      fi
    fi
    attempt=$((attempt + 1))
  done

  echo "tmux command failed after ${max_attempts} attempts: $*"
  return 1
}

wait_for_tango_service_tmux_ready() {
  local max_wait="${1:-30}"
  local waited=0

  while [ "$waited" -lt "$max_wait" ]; do
    cleanup_stale_tango_service_tmux_socket
    if tango_service_tmux_server_alive; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done

  # No server yet is fine — new-session creates one once stale sockets are gone.
  cleanup_stale_tango_service_tmux_socket
  return 0
}

tango_startup_verify_session_health() {
  local session="$1"
  local window dead failures=0

  if ! tango_startup_session_is_satisfied "$session"; then
    echo "health: FAIL — missing required service windows for this host"
    return 1
  fi

  sleep "${TANGO_STARTUP_HEALTH_WAIT_SECS:-4}"

  while IFS= read -r window; do
    [ -z "$window" ] && continue
    [ "$window" = "bootstrap" ] && continue
    if ! tango_startup_window_exists "$session" "$window"; then
      continue
    fi
    dead="$(tango_service_tmux list-panes -t "$session:$window" -F '#{pane_dead}' 2>/dev/null | head -1)"
    if [ "$dead" = "1" ]; then
      echo "health: FAIL window=$window (pane dead)"
      failures=$((failures + 1))
    else
      echo "health: OK window=$window"
    fi
  done <<EOF
$(tango_service_tmux list-windows -t "$session" -F '#{window_name}' 2>/dev/null)
EOF

  if [ "$failures" -gt 0 ]; then
    echo "health: $failures window(s) failed"
    return 1
  fi

  return 0
}

tango_startup_recent_boot_wait() {
  local boot_secs now uptime_secs wait_secs
  boot_secs="$(/usr/sbin/sysctl -n kern.boottime 2>/dev/null | sed -n 's/.*sec = \([0-9]*\).*/\1/p' || true)"
  [ -z "$boot_secs" ] && return 0

  now="$(date +%s)"
  uptime_secs=$((now - boot_secs))
  wait_secs="${TANGO_STARTUP_BOOT_WAIT_SECS:-5}"
  if [ "$uptime_secs" -lt 180 ] && [ "$wait_secs" -gt 0 ]; then
    echo "Recent boot (${uptime_secs}s uptime); waiting ${wait_secs}s before tmux startup..."
    sleep "$wait_secs"
  fi
}

slot_tmux_window_exists() {
  local session_name="$1"
  local window_name="$2"

  tango_service_tmux has-session -t "$session_name" 2>/dev/null \
    && tango_service_tmux list-windows -t "$session_name" -F '#{window_name}' 2>/dev/null | grep -qx "$window_name"
}

resolve_active_slot_window_name() {
  local session_name="$1"
  local has_probe=0
  local has_discord=0

  if slot_tmux_window_exists "$session_name" "slot-probe"; then
    has_probe=1
  fi

  if slot_tmux_window_exists "$session_name" "discord"; then
    has_discord=1
  fi

  if [ "$has_probe" -eq 1 ] && [ "$has_discord" -eq 1 ]; then
    echo "Multiple slot windows running in session '$session_name': slot-probe, discord" >&2
    return 1
  fi

  if [ "$has_discord" -eq 1 ]; then
    printf 'discord\n'
    return 0
  fi

  if [ "$has_probe" -eq 1 ]; then
    printf 'slot-probe\n'
    return 0
  fi

  return 1
}
