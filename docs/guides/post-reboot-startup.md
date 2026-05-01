# Tango Post-Reboot Startup Checklist

Steps to bring Tango back online after a machine reboot. Work through top to bottom.

## 1. Create tmux windows (inside a `tango` session)

```bash
tmux new-session -d -s tango
tmux rename-window -t tango:0 kokoro
tmux new-window -t tango -n whisper-main
tmux new-window -t tango -n whisper-partials
tmux new-window -t tango -n owntracks
tmux new-window -t tango -n discord
tmux new-window -t tango -n voice
tmux new-window -t tango -n remote-control
```

If a `tango` session already exists from tmux resurrect, just verify the windows are present with `tmux list-windows -t tango`.

## 2. Start Kokoro (TTS) — window `tango:kokoro`

Command Devin normally runs: check `~/.zsh_history` or the window's previous contents. Common pattern:
```bash
# In ~/kokoro or wherever Kokoro lives
./start-kokoro.sh
# or
python -m kokoro.server
```

(If unsure, ask Devin — the exact command varies per setup.)

## 3. Start Whisper (STT) — windows `tango:whisper-main` and `tango:whisper-partials`

Both run the same binary with different ports. Pattern:
```bash
whisper-server --model /Users/devinnorthrup/whisper-models/ggml-small.en.bin [--port N]
```

## 4. Start OwnTracks bridge — window `tango:owntracks`

```bash
TANGO_LOCATION_DIR=~/.tango/profiles/default/data/location \
  node /Users/devinnorthrup/GitHub/tango/apps/owntracks-receiver/server.js
```

Must point at the profile data dir so Sierra's `location_read` tool sees live data.
Confirm start with: `[owntracks] Writing to /Users/devinnorthrup/.tango/profiles/default/data/location`

## 5. Start Discord bot — window `tango:discord`

```bash
cd /Users/devinnorthrup/GitHub/tango
npm run start:discord 2>&1
```

Wait for these log lines to confirm clean start:
- `[scheduler] initialized with 28 schedules`
- `[scheduler] trigger endpoint listening on http://127.0.0.1:9200/trigger/<id>`
- `[tango-discord] connected as Watson#1912`
- `[tango-voice] v2-router-agents=juliet,malibu,sierra,victor,watson`

Verify port 9200 (scheduler trigger) and 9100 (mcp-wellness) are listening:
```bash
lsof -iTCP -sTCP:LISTEN -P | grep -E "9100|9200"
```

## 6. Start voice app — window `tango:voice`

```bash
cd /Users/devinnorthrup/GitHub/tango/apps/tango-voice
npm start
```

## 7. Start Remote Control watchdog — window `tango:remote-control`

```bash
cd /Users/devinnorthrup/GitHub/tango
scripts/remote-control-watchdog.sh Tango
```

This auto-restarts the `claude remote-control` process with `caffeinate -i` wrapping so it survives idle timeouts.

## 8. Verify end-to-end

Quick sanity checks:
```bash
# 1. All ports
lsof -iTCP -sTCP:LISTEN -P | grep -E "9100|9200|3456|5173|24678"

# 2. Bot processes
ps aux | grep -E "(tango|whisper|kokoro)" | grep -v grep | wc -l   # should be >8

# 3. Atlas:memory accessible
sqlite3 ~/.tango/atlas/memory.db "SELECT count(*) FROM memories;"   # should be ~3,276

# 4. Active PMs (should be empty right after reboot)
scripts/pm-audit.sh
```

## 9. Resume CoS work

Once everything is up, CoS can respawn any PMs that were in flight pre-reboot.

**Known pending work (as of 2026-04-22 ~7:45am):**
- **Victor-as-CoS PM** — was in discovery. Brief saved at `docs/projects/victor-cos-pm-brief.md`. Respawn with:
  ```bash
  tmux new-session -d -s TANGO-PM-victor-cos -c /Users/devinnorthrup/GitHub/tango
  tmux send-keys -t TANGO-PM-victor-cos 'claude --dangerously-skip-permissions --append-system-prompt "$(cat docs/guides/pm-role-prompt.md)"' C-m
  sleep 12
  scripts/send-tmux-message.sh TANGO-PM-victor-cos docs/projects/victor-cos-pm-brief.md
  ```

## 10. Schedule window awareness (if reboot was long)

If reboot took more than 15-30 min, some scheduled jobs may have missed their fire window. Check:
```bash
# Most recent scheduled runs
sqlite3 ~/.tango/profiles/default/data/tango.sqlite \
  "SELECT id, agent_id, model, created_at FROM model_runs WHERE created_at > datetime('now','-6 hours') ORDER BY id DESC LIMIT 20;"
```

Morning routines fire 5-7am. If bot was down during that window, manually trigger via:
```bash
curl -X POST http://127.0.0.1:9200/trigger/<schedule-id>
```

(Note: completion-tracked schedules will skip if already fired for the period. Check status with the trigger's response JSON.)

---

**Services that should auto-recover:**
- Remote Control watchdog reconnects the `claude remote-control` session if it drops
- Atlas:memory DB at `~/.tango/atlas/memory.db` survives reboot (no daemon)
- MCP servers are spawned on-demand by Claude Code subprocesses

**Services that need explicit start:**
- Discord bot (step 5)
- Voice app (step 6)
- Kokoro, Whisper (steps 2-3)
- OwnTracks (step 4)
- Remote Control watchdog (step 7)
