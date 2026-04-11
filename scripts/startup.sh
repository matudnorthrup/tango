#!/bin/bash
# Tango full-stack startup script
# Run after reboot from any checkout path.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/tmux/session.sh"
REPO_DIR="$(resolve_tango_repo_dir)"
VOICE_APP_DIR="$REPO_DIR/apps/tango-voice"

echo "=== Starting Tango services ==="

# 1. Kokoro TTS server (port 8880)
echo "[1/6] Kokoro TTS..."
tmux new-session -d -s kokoro -c "$HOME/Kokoro-FastAPI" \
  '.venv/bin/python -m uvicorn api.src.main:app --host 0.0.0.0 --port 8880'

# 2. Whisper STT server (port 8178) - main
echo "[2/6] Whisper server (main)..."
tmux new-session -d -s whisper-server \
  'whisper-server --model ~/whisper-models/ggml-small.en.bin --port 8178 --language en --prompt "Malibu Watson Sierra Tango Victor"'

# 3. Whisper STT server (port 8179) - partials
echo "[3/6] Whisper server (partials)..."
tmux new-session -d -s whisper-partials \
  'whisper-server --model ~/whisper-models/ggml-small.en.bin --port 8179 --language en --prompt "Malibu Watson Sierra Tango Victor Charlie Tango"'

# 4. OwnTracks receiver (port 3456)
echo "[4/6] OwnTracks receiver..."
tmux new-session -d -s owntracks -c "$REPO_DIR" \
  'source .env && export OWNTRACKS_AUTH_TOKEN OWNTRACKS_PORT && node apps/owntracks-receiver/server.js'

# 5. Tango Discord bot
echo "[5/6] Tango Discord..."
tmux new-session -d -s tango-discord -c "$REPO_DIR" \
  'env -u CLAUDECODE node packages/discord/dist/main.js'

# 6. Tango Voice pipeline
echo "[6/6] Tango Voice..."
tmux new-session -d -s tango-voice -c "$VOICE_APP_DIR" \
  'node dist/index.js 2>&1 | tee /tmp/tango-voice.log'

echo ""
echo "=== All services started ==="
echo ""
echo "Verify with: tmux list-sessions"
echo "Check a session: tmux attach -t <name>"
echo ""
echo "=== Claude Code sessions to resume manually ==="
echo "These had active work and can be resumed with 'claude --resume':"
echo "  - agent-fixes    (agent improvements / provider failover)"
echo "  - memory         (memory retrieval ranking tuning)"
echo "  - post-create-flow (voice post-create UX flow)"
echo "  - voice-redesign (voice pipeline / wake word work)"
echo "  - obsidian-sierra (Sierra/Obsidian integration)"
echo "  - jobs           (misc tasks)"
