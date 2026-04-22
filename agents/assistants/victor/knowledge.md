# Victor Domain Knowledge

## CoS Operations

### Spawning a PM
tmux new-session -d -s TANGO-PM-{slug} -c /Users/devinnorthrup/GitHub/tango
tmux send-keys -t TANGO-PM-{slug} \
  'claude --dangerously-skip-permissions --append-system-prompt "$(cat docs/guides/pm-role-prompt.md)"' C-m

### Sending a project brief
Write brief to /tmp/pm-brief-{slug}.md, then:
scripts/send-tmux-message.sh TANGO-PM-{slug} /tmp/pm-brief-{slug}.md

### Monitoring PMs
- tmux capture-pane -t TANGO-PM-{slug} -p -S -30
- scripts/pm-audit.sh (session boundary hygiene)
- scripts/dev/list.sh (worktree slot status)

### Linear API
Load credentials:
export OP_SERVICE_ACCOUNT_TOKEN=$(grep OP_SERVICE_ACCOUNT_TOKEN .env | cut -d= -f2-)
export LINEAR_KEY=$(op read "op://Watson/Linear Seaside-HQ Tango API Key/credential")

Team ID: 16a6e1a5-809b-46aa-a9b5-a6205c1b92c5
Issue prefix: TGO-

### Status tracking
Maintain /tmp/tango-cos-status.md with active PMs, compliance observations,
escalation items.

## Persistent Session Pattern (VICTOR-COS)

For complex coordination tasks that take more than a few minutes (multi-PM
coordination, complex investigation, debugging), spawn a persistent tmux
session instead of handling inline:

```bash
# Spawn persistent CoS session
tmux new-session -d -s VICTOR-COS -c /Users/devinnorthrup/GitHub/tango
tmux send-keys -t VICTOR-COS 'claude --dangerously-skip-permissions' C-m
# Wait for Claude to initialize, then send the task
sleep 5
scripts/send-tmux-message.sh VICTOR-COS /tmp/cos-task-{slug}.md
```

**When to use persistent session vs. inline:**
- Quick status checks, Linear updates, single PM spawns → handle inline in the v2 turn
- Multi-PM coordination, complex investigation, anything > 5 minutes → spawn VICTOR-COS session
- Only one VICTOR-COS session at a time — check if it exists before spawning:
  `tmux has-session -t VICTOR-COS 2>/dev/null && echo "already running"`

**Checking persistent session status:**
```bash
tmux capture-pane -t VICTOR-COS -p -S -30  # last 30 lines of output
```

**Tearing down when done:**
```bash
tmux kill-session -t VICTOR-COS
```

The CoS pulse scheduled job automatically monitors VICTOR-COS session status
and includes it in state change reports.

## Communicating with the Stakeholder

**ALL user-facing messages MUST go to Discord.** The stakeholder reads Victor's
Discord channel — not tmux, not status files. If you have something to say to
the stakeholder, post it to Discord.

### How to post to Discord from the persistent session

Use the bot's MCP server at port 9100:

```bash
curl -s -X POST http://127.0.0.1:9100/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "discord_manage",
      "arguments": {
        "operation": "send_message",
        "channel_id": "1480579160056397958",
        "content": "Your message here"
      }
    }
  }'
```

Channel ID `1480579160056397958` is Victor's Discord channel.

### When to post to Discord

- **PM completed work** — report what shipped, what's waiting on validation
- **PM is stuck or blocked** — escalate so the stakeholder can unblock
- **Monitoring cron finds something noteworthy** — state changed, error detected
- **Task fully shipped** — final summary with Linear links
- **Questions or scope clarifications** — anything you need stakeholder input on

### When NOT to post

- PM is still working normally — don't spam progress updates
- State unchanged on monitoring check — stay silent
- Internal coordination (sending briefs to PMs, tmux commands) — that's backstage

**Rule: If the stakeholder would want to know, post it. If they wouldn't, don't.**

## Available Tools

**Development** (via `tango-dev` MCP server):
- `mcp__tango-dev__tango_shell` - execute shell commands (tmux, scripts, git, Linear API)
- `mcp__tango-dev__tango_file` - read/write files (briefs, status, prompt edits)

**Discord Management** (via `discord-manage` MCP server):
- `mcp__discord-manage__discord_manage` - channel/thread operations

**Memory** (via `memory` MCP server):
- `mcp__memory__memory_search` - search cross-session CoS state
- `mcp__memory__memory_add` - persist CoS decisions, PM observations
- `mcp__memory__memory_reflect` - periodic reflection on coordination patterns
