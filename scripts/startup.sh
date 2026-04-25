#!/bin/bash
# Tango full-stack startup script
# Run after reboot from any checkout path.
#
# All Tango services run inside a single tmux session named `tango`, with one
# named window per service:
#
#   tango:kokoro           Kokoro TTS server (port 8880)
#   tango:whisper-main     Whisper STT server (port 8178)
#   tango:whisper-partials Whisper STT server (port 8179)
#   tango:owntracks        OwnTracks receiver (port 3456)
#   tango:discord          Tango Discord bot
#   tango:voice            Tango Voice pipeline
#
# Attach:      tmux attach -t tango
# Pick window: Ctrl-b w  (or Ctrl-b 0..5)
# Detach:      Ctrl-b d
# List:        tmux list-windows -t tango

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/tmux/session.sh"
REPO_DIR="$(resolve_tango_repo_dir)"
VOICE_APP_DIR="$REPO_DIR/apps/tango-voice"
SESSION="$(resolve_tango_tmux_session_name)"
NODE_BIN="${TANGO_NODE_BIN:-/Users/devinnorthrup/.nvm/versions/node/v24.14.0/bin/node}"

if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
fi

if [ -z "${NODE_BIN:-}" ]; then
  echo "No Node runtime found. Install Node 22 or set TANGO_NODE_BIN."
  exit 1
fi

echo "=== Starting Tango services in tmux session '$SESSION' ==="

if tmux has-session -t "$SESSION" 2>/dev/null; then
  echo "tmux session '$SESSION' already exists."
  echo "Stop it first with: tmux kill-session -t $SESSION"
  exit 1
fi

# Warn about legacy standalone sessions from the pre-consolidation layout.
for legacy in tango-discord tango-voice kokoro whisper-server whisper-partials owntracks; do
  if tmux has-session -t "$legacy" 2>/dev/null; then
    echo "Warning: legacy tmux session '$legacy' is still running."
    echo "  Stop it with: tmux kill-session -t $legacy"
  fi
done

# 1. Kokoro TTS server (port 8880) — creates the session with its first window
echo "[1/6] Kokoro TTS..."
tmux new-session -d -s "$SESSION" -n kokoro -c "$HOME/Kokoro-FastAPI" \
  '.venv/bin/python -m uvicorn api.src.main:app --host 0.0.0.0 --port 8880'

# 2. Whisper STT server (port 8178) - main
echo "[2/6] Whisper server (main)..."
tmux new-window -t "$SESSION" -n whisper-main \
  'whisper-server --model ~/whisper-models/ggml-small.en.bin --port 8178 --language en --prompt "Malibu Watson Sierra Tango Victor"'

# 3. Whisper STT server (port 8179) - partials
echo "[3/6] Whisper server (partials)..."
tmux new-window -t "$SESSION" -n whisper-partials \
  'whisper-server --model ~/whisper-models/ggml-small.en.bin --port 8179 --language en --prompt "Malibu Watson Sierra Tango Victor Charlie Tango"'

# 4. OwnTracks receiver (port 3456)
echo "[4/6] OwnTracks receiver..."
tmux new-window -t "$SESSION" -n owntracks -c "$REPO_DIR" \
  'source .env && export OWNTRACKS_AUTH_TOKEN OWNTRACKS_PORT && node apps/owntracks-receiver/server.js'

# 5. Tango Discord bot
echo "[5/6] Tango Discord..."
tmux new-window -t "$SESSION" -n discord -c "$REPO_DIR" \
  "env -u CLAUDECODE DISCORD_LISTEN_ONLY=false \"$NODE_BIN\" packages/discord/dist/main.js"

# 6. Tango Voice pipeline
echo "[6/6] Tango Voice..."
tmux new-window -t "$SESSION" -n voice -c "$VOICE_APP_DIR" \
  "\"$NODE_BIN\" dist/index.js 2>&1 | tee /tmp/tango-voice.log"

echo ""
echo "=== All services started in tmux session '$SESSION' ==="
echo ""
echo "List windows: tmux list-windows -t $SESSION"
echo "Attach:       tmux attach -t $SESSION   (then Ctrl-b w to pick a window)"
echo "Detach:       Ctrl-b d"
echo ""
echo "Per-service management via npm scripts:"
echo "  npm run bot:status    / voice:status"
echo "  npm run bot:logs      / voice:logs"
echo "  npm run bot:restart   / voice:restart"
echo ""
echo "=== Claude Code sessions to resume manually ==="
echo "These had active work and can be resumed with 'claude --resume':"
echo "  - agent-fixes    (agent improvements / provider failover)"
echo "  - memory         (memory retrieval ranking tuning)"
echo "  - post-create-flow (voice post-create UX flow)"
echo "  - voice-redesign (voice pipeline / wake word work)"
echo "  - obsidian-sierra (Sierra/Obsidian integration)"
echo "  - jobs           (misc tasks)"
