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
