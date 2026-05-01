# Universal Claude Code Session Watchdog

**Status:** Shipped
**Linear:** [Universal Claude Code Session Watchdog](https://linear.app/seaside-hq/project/universal-claude-code-session-watchdog-b6ddca6035f7)
**Issues:** TGO-356 through TGO-361

## Problem

Claude Code sessions in tmux disconnect for various reasons (remote-control drops, WebSocket death, server-side idle TTL). The existing `scripts/remote-control-watchdog.sh` only monitors a single named remote-control session. We needed universal monitoring of ALL Claude Code sessions.

## Solution

`scripts/claude-session-watchdog.sh` — a daemon that:

1. **Scans all tmux panes** every 30s for running `claude` processes
2. **Tracks** discovered sessions in `~/.tango/watchdog/state.json`
3. **Detects deaths** when a tracked session's claude process disappears
4. **Auto-restarts** dead sessions after a 60s grace period using `claude --resume --dangerously-skip-permissions`
5. **Unregisters** sessions whose tmux session is completely gone
6. **Cooldown** of 5 min between restart attempts for the same session

### Key Design Decisions

- **Uses `ps` instead of `pgrep`** for child process detection. macOS `pgrep -P` has edge cases where it misses children across sandbox/session boundaries. `ps -ax` with `awk` is 100% reliable.
- **Grace period** (60s) prevents restarting during normal exits or intentional shutdowns.
- **Restart cooldown** (300s) prevents restart loops if a session keeps crashing.
- **Caffeinate** wraps the daemon to prevent system idle sleep.
- **State file persistence** means the watchdog survives restarts and picks up where it left off.

## Deployment

Runs in `tango:watchdog` tmux window:
```bash
tmux new-window -t tango -n watchdog -c /path/to/tango 'bash scripts/claude-session-watchdog.sh --daemon'
```

Should be added to `scripts/startup.sh` as step 7.

## Key Files

- `scripts/claude-session-watchdog.sh` — the watchdog script
- `~/.tango/watchdog/state.json` — tracked session state
- `~/.tango/watchdog/watchdog.log` — action log

## Test Results

Validated 2026-04-24:
- Watchdog detected all 8 active Claude Code sessions across different tmux sessions
- Killed a test session → watchdog detected death within 30s
- After 60s grace period, watchdog sent restart command
- Claude started successfully via `--resume`
- After test session was removed, watchdog cleaned up tracking state
