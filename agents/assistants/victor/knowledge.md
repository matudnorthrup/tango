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
