# Remote Control Connection Keepalive

## Status: SHIPPED (2026-04-19)

## Problem

The Remote Control feature in Claude Code disconnects during periods of inactivity. The stakeholder uses Remote Control via the Claude mobile app to speak to Claude Code remotely, and having to reconnect is disruptive.

## Discovery Findings

### How Remote Control Works

- **Command**: `claude remote-control` runs a persistent server that accepts connections from claude.ai/code and the Claude mobile app
- **Protocol**: Outbound HTTPS polling + SSE responses on port 443, plus a WebSocket transport path (`api.anthropic.com/v1/session_ingress/ws/...`). Does NOT open inbound ports.
- **Security**: TLS transport, multiple short-lived credentials scoped per purpose
- **Architecture**: Local Claude Code process stays running; only chat messages and tool results flow through the encrypted connection. Files never leave the machine.

### Root Cause: Server-Side TTL Bug

There are **three distinct disconnection problems**, all documented in GitHub issues:

#### 1. Server-side session TTL ignores keepalives (~20 min idle death)
**GitHub Issue [#32982](https://github.com/anthropics/claude-code/issues/32982)**
- The server's session TTL only resets on **real user/model activity** (actual messages), not on transport-level keepalive frames
- Sessions die after ~20 minutes of idle time (range 5-30 minutes)
- The server returns HTTP 404 on `session_ingress` endpoint while the CLI still shows "Remote Control active"
- 100% reproduction rate across 7 tested sessions

#### 2. WebSocket disconnects every ~25 min, permanent death after 3rd reconnect
**GitHub Issue [#31853](https://github.com/anthropics/claude-code/issues/31853)**
- WebSocket connection gets server-initiated closure every ~25 min (close code 1006)
- Auto-reconnect succeeds twice, but 3rd attempt gets close code 1002 (protocol error) — client treats as permanent and stops reconnecting
- Makes Remote Control unusable after ~75 minutes without manual intervention
- Disconnections occur at identical timestamps across independent sessions (server-side root cause)

#### 3. Automatic reconnection doesn't recover
**GitHub Issue [#34255](https://github.com/anthropics/claude-code/issues/34255)**
- Connection drops silently without warning
- Auto-reconnect fails; shows "Remote Control connecting..." but hangs indefinitely
- Manual `/remote-control` restart always works — the automatic path is missing the same teardown/re-establish cycle

### Built-in Keepalive Mechanisms (All Broken)

| Mechanism | Interval | Status |
|-----------|----------|--------|
| WebSocket `keep_alive` frames | Every 5 min | **Ineffective** — server ignores for TTL |
| WebSocket ping/pong | Every 10 sec | **Ineffective** — server ignores for TTL |
| `CLAUDE_CODE_REMOTE_SEND_KEEPALIVES=1` env var | Every 30 sec | **Broken** — gated by refcount that only runs during active model processing; stops during idle (exactly when needed) |
| Server-side heartbeat (`heartbeat_interval_ms`) | Disabled (set to 0) | Infrastructure exists but turned off server-side |

### Available Configuration

- `--name <name>` — Session name
- `--spawn <mode>` — same-dir (default), worktree, session
- `--capacity <N>` — Max concurrent sessions (default: 32)
- `--verbose` — Detailed logs
- `--permission-mode <mode>` — Permission mode for spawned sessions
- **No keepalive interval setting**
- **No timeout override setting**
- **No auto-restart setting**

## Proposed Solution

The problem has two layers requiring two countermeasures:

### Layer 1: Watchdog Auto-Restart

For when the process exits (network timeout >10 min, crashes, WebSocket permanent death):

```bash
#!/bin/bash
# scripts/remote-control-watchdog.sh
# Keeps Remote Control alive by restarting on exit

SESSION_NAME="${1:-Tango Dev}"
RESTART_DELAY=5

while true; do
    echo "[$(date)] Starting Remote Control: $SESSION_NAME"
    caffeinate -i claude remote-control --name "$SESSION_NAME" --verbose
    echo "[$(date)] Remote Control exited ($?), restarting in ${RESTART_DELAY}s..."
    sleep $RESTART_DELAY
done
```

- Runs in a dedicated tmux window
- `caffeinate -i` prevents system idle sleep
- Auto-restarts on any exit

### Layer 2: Periodic Activity to Reset Server TTL

The only known workaround for the ~20 min server-side idle timeout is to send actual activity (not just keepalive frames). Options:

**Option A**: Periodic trivial message every ~15 min — but this would create noise in the conversation and isn't ideal.

**Option B**: Accept the ~20 min idle timeout as a known limitation until Anthropic fixes the server-side TTL. The watchdog handles process-exit cases; the user reconnects from mobile if idle >20 min.

**Recommendation**: Start with the watchdog (Layer 1) which solves process crashes/exits/sleep. Layer 2 is a server-side bug that Anthropic needs to fix — we can't meaningfully work around the idle TTL without sending fake messages.

### Alternatives Considered

- **Periodic ping/cron**: No exposed endpoint to ping; keepalive frames are already sent but server ignores them
- **`CLAUDE_CODE_REMOTE_SEND_KEEPALIVES=1`**: Exists but broken (only runs during active processing)
- **caffeinate alone**: Only addresses sleep; doesn't fix server-side TTL or WebSocket death

## Validation Results (2026-04-19)

1. Watchdog started in `tango:remote-control` tmux window — connected successfully
2. Killed Remote Control with Ctrl-C — watchdog detected exit, waited 5s, restarted automatically
3. New session established without interactive prompts (--spawn same-dir flag works)
4. Log file at `~/.tango/remote-control-watchdog.log` captures all restart events
5. **Known limitation confirmed**: ~20 min idle timeout is server-side (Anthropic bug #32982), unfixable client-side

## Key Files

- `scripts/remote-control-watchdog.sh` — watchdog script (to be created)
- `docs/projects/remote-control-keepalive.md` — this file

## References

- [GitHub #32982: Server TTL ignores keepalives](https://github.com/anthropics/claude-code/issues/32982)
- [GitHub #31853: WebSocket disconnects every ~25 min](https://github.com/anthropics/claude-code/issues/31853)
- [GitHub #34255: Auto-reconnection doesn't work](https://github.com/anthropics/claude-code/issues/34255)
- [Official Remote Control Docs](https://code.claude.com/docs/en/remote-control)

## Linear

- Project: [Remote Control Connection Keepalive](https://linear.app/seaside-hq/project/remote-control-connection-keepalive-5ccd6d4fa30c)
- TGO-155: Research protocol and connection management (Done)
- TGO-156: Research keepalive and reconnect options (Done)
- TGO-157: Build keepalive mechanism
- TGO-158: Write project documentation
- TGO-159: Deploy keepalive solution
- TGO-160: Live test — verify connection survives idle
- TGO-161: Final docs and CoS report
