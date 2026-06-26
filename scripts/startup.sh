#!/bin/bash
# Tango full-stack startup script
# Run after reboot from any checkout path.
#
# All Tango services run inside a single tmux session named `tango`, with one
# named window per service. By default this uses the dedicated `tango-service`
# tmux socket to avoid inheriting stale auth/session state from interactive tmux.
#
# Services (started when dependencies exist on the host):
#   tango:kokoro           Kokoro TTS server (port 8880)
#   tango:whisper-main     Whisper STT server (port 8178)
#   tango:whisper-partials Whisper STT server (port 8179)
#   tango:owntracks        OwnTracks receiver (port 3456)
#   tango:discord          Tango Discord bot (required)
#   tango:voice            Tango Voice pipeline
#
# Attach:      tmux -L tango-service attach -t tango
# Pick window: Ctrl-b w  (or Ctrl-b 0..5)
# Detach:      Ctrl-b d
# List:        tmux -L tango-service list-windows -t tango
#
# Cold-boot resilience:
#   - Bootstrap tmux session with a durable window (not Kokoro — may be missing)
#   - Skip optional services when binaries/paths are absent on this host
#   - Clears stale sockets and incomplete sessions before starting
#   - Retries transient tmux failures
#   - Re-runs up to TANGO_STARTUP_MAX_ATTEMPTS times on failure

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/tmux/session.sh"
REPO_DIR="$(resolve_tango_repo_dir)"
VOICE_APP_DIR="$REPO_DIR/apps/tango-voice"
SESSION="$(resolve_tango_tmux_session_name)"
NODE_BIN="${TANGO_NODE_BIN:-/Users/devinnorthrup/.nvm/versions/node/v24.14.0/bin/node}"
MAX_ATTEMPTS="${TANGO_STARTUP_MAX_ATTEMPTS:-3}"
RETRY_DELAY="${TANGO_STARTUP_RETRY_DELAY:-5}"

export TANGO_REPO_DIR="$REPO_DIR"
export TANGO_VOICE_APP_DIR="$VOICE_APP_DIR"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/sbin:/sbin:${PATH:-/usr/bin:/bin}"

if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
fi

if [ -z "${NODE_BIN:-}" ]; then
  echo "No Node runtime found. Install Node 22 or set TANGO_NODE_BIN."
  exit 1
fi

if ! tango_startup_discord_ready; then
  echo "Discord build missing at packages/discord/dist/main.js — run: npm run build"
  exit 1
fi

cleanup_failed_startup() {
  tango_service_tmux kill-session -t "$SESSION" 2>/dev/null || true
  cleanup_stale_tango_service_tmux_socket
}

tango_startup_start_window() {
  local window="$1"
  shift
  tango_startup_add_planned_window "$window"
  tango_service_tmux_retry 5 1 new-window -t "$SESSION" -n "$window" "$@"
}

run_startup_once() {
  set -e
  local prep_status=0
  local step=0

  tango_startup_reset_planned_windows

  prepare_tango_startup_session "$SESSION" || prep_status=$?
  if [ "$prep_status" -eq 2 ]; then
    echo "tmux session '$SESSION' already satisfies available services — nothing to do."
    tango_startup_verify_session_health "$SESSION" || return 1
    return 0
  fi

  wait_for_tango_service_tmux_ready 30

  for legacy in tango-discord tango-voice kokoro whisper-server whisper-partials owntracks; do
    if tango_service_tmux has-session -t "$legacy" 2>/dev/null; then
      echo "Warning: legacy tmux session '$legacy' is still running."
      echo "  Stop it with: $(tango_service_tmux_command_hint) kill-session -t $legacy"
    fi
  done

  echo "[bootstrap] Creating durable tmux session..."
  tango_service_tmux_retry 5 1 new-session -d -s "$SESSION" -n bootstrap -c "$REPO_DIR" \
    "while true; do sleep 3600; done"
  if ! wait_for_tmux_session "$SESSION" 15; then
    echo "Bootstrap session failed to start."
    return 1
  fi
  sync_tmux_service_environment "$SESSION"
  sleep 1

  if tango_startup_kokoro_ready; then
    step=$((step + 1))
    echo "[$step] Kokoro TTS..."
    tango_startup_start_window kokoro -c "$HOME/Kokoro-FastAPI" \
      "export MODEL_DIR=\"$HOME/Kokoro-FastAPI/api/src/models\" VOICES_DIR=\"$HOME/Kokoro-FastAPI/api/src/voices/v1_0\" USE_GPU=true DEVICE_TYPE=mps PYTORCH_ENABLE_MPS_FALLBACK=1 PYTHONPATH=\"$HOME/Kokoro-FastAPI:$HOME/Kokoro-FastAPI/api\" && .venv/bin/python -m uvicorn api.src.main:app --host 0.0.0.0 --port 8880"
  else
    echo "[skip] Kokoro — not installed at ~/Kokoro-FastAPI/.venv"
  fi

  if tango_startup_whisper_ready; then
    step=$((step + 1))
    echo "[$step] Whisper server (main)..."
    tango_startup_start_window whisper-main \
      'whisper-server --model ~/whisper-models/ggml-small.en.bin --port 8178 --language en --prompt "Malibu Watson Sierra Tango Victor Porter"'

    step=$((step + 1))
    echo "[$step] Whisper server (partials)..."
    tango_startup_start_window whisper-partials \
      'whisper-server --model ~/whisper-models/ggml-small.en.bin --port 8179 --language en --prompt "Malibu Watson Sierra Tango Victor Charlie Porter Tango"'
  else
    echo "[skip] Whisper — whisper-server or ~/whisper-models/ggml-small.en.bin not found"
  fi

  if tango_startup_owntracks_ready; then
    step=$((step + 1))
    echo "[$step] OwnTracks receiver..."
    tango_startup_start_window owntracks -c "$REPO_DIR" \
      'source .env && export OWNTRACKS_AUTH_TOKEN OWNTRACKS_PORT && node apps/owntracks-receiver/server.js'
  else
    echo "[skip] OwnTracks — server.js or .env missing"
  fi

  step=$((step + 1))
  echo "[$step] Tango Discord..."
  tango_startup_start_window discord -c "$REPO_DIR" \
    "env -u CLAUDECODE DISCORD_LISTEN_ONLY=false \"$NODE_BIN\" packages/discord/dist/main.js"

  if tango_startup_voice_ready; then
    step=$((step + 1))
    echo "[$step] Tango Voice..."
    tango_startup_start_window voice -c "$VOICE_APP_DIR" \
      "\"$NODE_BIN\" dist/index.js 2>&1 | tee /tmp/tango-voice.log"
  elif [ -f "$VOICE_APP_DIR/dist/index.js" ]; then
    echo "[skip] Voice — set DISCORD_VOICE_CHANNEL_ID in apps/tango-voice/.env (see ~/.tango/profiles/default/reference/tango-voice-setup.md)"
  else
    echo "[skip] Voice — run: npm run build:voice-app"
  fi

  if tango_startup_window_exists "$SESSION" bootstrap; then
    tango_service_tmux kill-window -t "$SESSION:bootstrap" 2>/dev/null || true
  fi

  if ! tango_startup_session_is_complete "$SESSION"; then
    echo "Startup finished but session is incomplete."
    return 1
  fi

  if ! tango_startup_verify_session_health "$SESSION"; then
    echo "Startup finished but health check failed."
    return 1
  fi

  return 0
}

print_startup_footer() {
  echo ""
  echo "=== Tango services running in tmux session '$SESSION' ==="
  echo "Windows running: $(tango_service_tmux list-windows -t "$SESSION" -F '#{window_name}' 2>/dev/null | tr '\n' ' ')"
  echo ""
  echo "List windows: $(tango_service_tmux_command_hint) list-windows -t $SESSION"
  echo "Attach:       $(tango_service_tmux_command_hint) attach -t $SESSION   (then Ctrl-b w to pick a window)"
  echo "Detach:       Ctrl-b d"
  echo ""
  echo "Per-service management via npm scripts:"
  echo "  npm run bot:status    / voice:status"
  echo "  npm run bot:logs      / voice:logs"
  echo "  npm run bot:restart   / voice:restart"
}

main() {
  echo "=== Starting Tango services in tmux session '$SESSION' ==="
  tango_startup_recent_boot_wait

  local attempt=1
  while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
    if [ "$MAX_ATTEMPTS" -gt 1 ]; then
      echo "--- startup attempt ${attempt}/${MAX_ATTEMPTS} ---"
    fi

    if run_startup_once; then
      print_startup_footer
      exit 0
    fi

    echo "Startup attempt ${attempt} failed; cleaning up partial session..."
    cleanup_failed_startup
    tango_startup_reset_planned_windows

    if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
      echo "Retrying in ${RETRY_DELAY}s..."
      sleep "$RETRY_DELAY"
    fi
    attempt=$((attempt + 1))
  done

  echo "Startup failed after ${MAX_ATTEMPTS} attempt(s)."
  exit 1
}

main "$@"
