#!/usr/bin/env bash
set -euo pipefail

# All Tango services live as windows inside one tmux session.
# Override the session name with TANGO_TMUX_SESSION if needed.
resolve_tango_tmux_session_name() {
  printf '%s\n' "${TANGO_TMUX_SESSION:-tango}"
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

  if tmux has-session -t "$session" 2>/dev/null; then
    if tmux list-windows -t "$session" -F '#{window_name}' 2>/dev/null | grep -qx "$window"; then
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

  if [ -n "$legacy" ] && tmux has-session -t "$legacy" 2>/dev/null; then
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
      tmux has-session -t "$s" 2>/dev/null \
        && tmux list-windows -t "$s" -F '#{window_name}' 2>/dev/null | grep -qx "$w"
      ;;
    *)
      tmux has-session -t "$target" 2>/dev/null
      ;;
  esac
}

# Kill whatever the target refers to — a window inside the shared session or a
# legacy standalone session.
tmux_service_target_kill() {
  local target="$1"
  case "$target" in
    *:*)
      tmux kill-window -t "$target" 2>/dev/null || true
      ;;
    *)
      tmux kill-session -t "$target" 2>/dev/null || true
      ;;
  esac
}

resolve_tango_repo_dir() {
  if [ -n "${TANGO_REPO_DIR:-}" ]; then
    printf '%s\n' "$TANGO_REPO_DIR"
    return 0
  fi

  local script_dir current_repo candidate
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  current_repo="$(cd "$script_dir/../.." && pwd -P)"

  if command -v git >/dev/null 2>&1 && git -C "$current_repo" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    while IFS= read -r line; do
      case "$line" in
        worktree\ *)
          candidate="${line#worktree }"
          ;;
        branch\ refs/heads/main)
          if [ -n "${candidate:-}" ] && [ -d "$candidate" ]; then
            (cd "$candidate" && pwd -P)
            return 0
          fi
          ;;
      esac
    done < <(git -C "$current_repo" worktree list --porcelain 2>/dev/null)
  fi

  printf '%s\n' "$current_repo"
}

slot_tmux_window_exists() {
  local session_name="$1"
  local window_name="$2"

  tmux has-session -t "$session_name" 2>/dev/null \
    && tmux list-windows -t "$session_name" -F '#{window_name}' 2>/dev/null | grep -qx "$window_name"
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
