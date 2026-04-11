#!/usr/bin/env bash
set -euo pipefail

resolve_tmux_session_name() {
  local preferred="${TANGO_TMUX_SESSION:-tango-discord}"
  local legacy="tango"

  if tmux has-session -t "$preferred" 2>/dev/null; then
    printf '%s\n' "$preferred"
    return 0
  fi

  if [ -z "${TANGO_TMUX_SESSION:-}" ] && [ "$preferred" != "$legacy" ] && tmux has-session -t "$legacy" 2>/dev/null; then
    printf '%s\n' "$legacy"
    return 0
  fi

  return 1
}

resolve_tmux_target_session_name() {
  local preferred="${TANGO_TMUX_SESSION:-tango-discord}"
  local resolved=""

  if resolved="$(resolve_tmux_session_name 2>/dev/null)"; then
    printf '%s\n' "$resolved"
    return 0
  fi

  printf '%s\n' "$preferred"
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
