# Victor as Chief-of-Staff

**Status:** Stage 2: Implementation
**Linear:** [Victor as Chief-of-Staff](https://linear.app/seaside-hq/project/victor-as-chief-of-staff-ca2e60674ae1)
**Date:** 2026-04-22

## Overview

Reframe Victor from an under-utilized developer agent into Tango's Chief-of-Staff (CoS) — the coordination layer that receives high-level direction from the stakeholder, decomposes into projects, spawns PMs, monitors them, and reports status. This is the role currently operated manually by a main Claude Code session.

## Part 1: Discovery — Proactive Messaging Mechanism

### How scheduled jobs deliver to Discord today

The full code path:

```
Schedule YAML config
  → SchedulerEngine.tick() (15s interval, checks due jobs)
    → executeSchedule() (executor.ts)
      → For v2 runtime: executeV2TurnForScheduler()
        → ClaudeCodeAdapter.send(task) — fresh adapter per run
        → Returns { text, durationMs, model, metadata }
      → For legacy: executeWorker() or executeScheduledTurn()
    → Engine receives ExecutionResult { status, summary }
    → If status=ok AND summary exists AND delivery.channelId set:
      → deliverToChannel(channelId, agentId, summary)
        → Discord.js: client.channels.fetch(channelId)
        → sendPresentedReply(channel, content, speaker) — posts with agent avatar
        → writeMessage() to session DB — enables warm-start context
```

Key config fields in schedule YAML:
- `delivery.channel_id` — Discord channel to post to
- `delivery.agent_id` — agent identity for avatar/display name
- `delivery.mode` — "message" (default), "webhook", or "none"
- `schedule.every_seconds` — for high-frequency runs (alternative to cron)
- `execution.timeout_seconds` — per-run timeout
- `runtime: v2` — use Claude Code adapter (required for MCP tool access)

### Key Questions — Answered

**Q: Can a scheduled job post to a CHANNEL without using the "start a thread" pattern?**
A: **Yes.** `deliverToChannel` fetches the channel by ID and posts directly via `sendPresentedReply`. No thread creation logic. The message appears as a top-level channel message from the agent's avatar.

**Q: When a scheduled job posts, does it appear in the agent's next conversation context?**
A: **Yes.** `deliverToChannel` calls `writeMessage()` to the session DB with `{ scheduledDelivery: true }` metadata. This message is included in the warm-start context when the user next replies in that channel. The agent sees its own proactive messages.

**Q: Is there throttling/spam-protection on rapid scheduled posts?**
A: **No explicit throttling** beyond:
- Concurrency groups (jobs in same group run serially)
- `maxConcurrent` limit (default 3 simultaneous jobs)
- Backoff on consecutive failures
- Discord's own rate limits (250 messages/channel/minute)

For CoS-frequency posting (every few minutes), none of these are constraints.

**Q: Can multiple distinct messages post from the same scheduled run?**
A: **No.** Each run produces one `summary` string (truncated to 2000 chars), delivered as one message. Multiple proactive messages require separate scheduled runs firing independently. This is the correct pattern for CoS — each run checks state and posts if changed.

### Existing proactive patterns

| Schedule | Frequency | Runtime | Delivery | Agent |
|----------|-----------|---------|----------|-------|
| morning-planning | 8:15am daily | v2 | Watson's channel | watson |
| daily-email-review | cron | v2 | Watson's channel | watson |
| slack-summary | cron | v2 | Watson's channel | watson |
| memory-maintenance | cron | v2 | varies | varies |
| receipt-cataloger | cron | v2 | Malibu's channel | malibu |

All follow the same pattern: cron fires → agent processes task → summary delivered to channel. The "CoS pulse" would be identical structurally, just with higher frequency.

## Part 2: Prototype — CoS Pulse

### Design

A scheduled job `cos-pulse` that:
1. Fires every 2 minutes via `schedule.every_seconds: 120`
2. Uses v2 runtime with Victor's agent config
3. Task: check `/tmp/cos-pulse-state.json` for last known state, compare against current tmux sessions (`tmux list-sessions`), write new state, and if changed, return a notification message
4. Delivery: a dedicated test channel (Victor's smoke test channel `100000000000001004`)
5. Completion: no scope (runs every fire, no "already completed" check)

### Schedule config

```yaml
id: cos-pulse-test
display_name: CoS Pulse Test
description: >
  Prototype proactive messaging job. Checks tmux PM session state
  every 2 minutes and posts changes to Victor's test channel.
enabled: true
runtime: v2

schedule:
  every_seconds: 120

execution:
  mode: agent
  worker_id: dev-assistant
  task: |
    Check the current state of TANGO-PM tmux sessions by running:
    tmux list-sessions -F '#{session_name}' 2>/dev/null | grep TANGO-PM || echo "none"

    Compare against the last known state in /tmp/cos-pulse-state.json.
    If the file doesn't exist, create it with the current state.

    If state changed (sessions added or removed), return a brief
    notification like "PM sessions changed: [old] → [new]"

    If state is unchanged, return exactly: __NO_OUTPUT__

    Always update /tmp/cos-pulse-state.json with current state.
  timeout_seconds: 60

provider:
  model: haiku

delivery:
  channel_id: "100000000000001004"
  agent_id: victor
  mode: message

policy:
  max_consecutive_failures: 5
  alert_channel_id: "100000000000000010"
  concurrency_group: cos-pulse
  priority: 1

tags:
  - victor
  - cos
  - prototype
```

### Validation criteria

Run for ~15 minutes with active PM sessions being created/destroyed:
- [ ] Multiple distinct messages appear in Victor's test channel as state changes
- [ ] Messages show Victor's avatar and display name
- [ ] Silent when state unchanged (no __NO_OUTPUT__ delivery)
- [ ] When user messages Victor after proactive posts, Victor's context includes the proactive messages
- [ ] No duplicate or malformed output
- [ ] State file persists correctly between runs

### Important note on prototype timing
The brief mentions TGO-292 has a pending bot restart deploy. The prototype schedule config is purely additive (new file in `config/defaults/schedules/`), but adding it requires a restart to load. Coordinate with CoS on timing to avoid conflicting with the TGO-292 deploy.

## Part 3: Full Victor-as-CoS Specification

### 1. Role Definition

**Victor as CoS** replaces the manual Claude Code session. Responsibilities:

| Responsibility | How Victor does it |
|---|---|
| Receive direction from stakeholder | Discord text/voice in Victor's channel |
| Decompose into project briefs | Write briefs to `/tmp/pm-brief-{slug}.md` |
| Spawn PM agents | `scripts/dev/spawn.sh` equivalent via `tango_shell` |
| Monitor PM compliance | CoS pulse + on-demand tmux inspection |
| Surface specs/results | Post in channel, update Linear |
| Iterate on PM prompt | Edit `docs/guides/pm-role-prompt.md` via `tango_file` |
| Manage multiple PMs | Track in memory + status file |

**What Victor does NOT do:**
- Write implementation code (delegates to PMs who delegate to dev agents)
- Make irreversible actions without stakeholder confirmation (force pushes, production deploys, data deletion)
- Spawn more than 3 concurrent PMs without stakeholder awareness
- Override a PM's tactical decisions — intervene on process, not judgment

### 2. Updated soul.md for Victor

```markdown
You are Victor.

Chief of Staff for Tango. You coordinate development work by receiving
high-level direction from the stakeholder, decomposing it into projects,
spawning PM agents, monitoring their compliance, and reporting results.

You do NOT write code. You manage the people (agents) who manage the
people (dev agents) who do.

## Style

- Strategic and organized — always know what's in flight
- Direct and concise — status updates, not essays
- Process-disciplined — every project follows the flow:
  Linear → PM spawn → monitoring → validation → ship
- Proactively surface issues — don't wait to be asked
- When uncertain about scope or trade-offs, ask the stakeholder

## Domains

- **Project Coordination** — Decompose briefs, spawn PMs, track progress
- **PM Compliance** — Monitor that PMs follow process (Linear, delegation, testing)
- **Status Reporting** — Proactive updates when state changes
- **Linear Management** — Projects, milestones, issues
- **Process Iteration** — Improve the PM prompt based on observed failures
- **Resource Management** — Worktree slots, bot claims, scheduling
```

### 3. Updated knowledge.md for Victor

```markdown
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
```

### 4. MCP Server Allowlist

Victor already has the three key servers:

| Server | Purpose | Status |
|--------|---------|--------|
| `tango-dev` | Shell + file — tmux, scripts, git, Linear API curl | Already configured |
| `discord-manage` | Channel/thread operations | Already configured |
| `memory` | Cross-session CoS state | Already configured |

**No new MCP servers needed.** Linear access is via curl through `tango_shell` (same pattern PMs use). A dedicated Linear MCP server would be nice-to-have but not required for Stage 1.

### 5. Shell Command Patterns

Commands Victor-as-CoS uses regularly:

```bash
# PM lifecycle
tmux new-session -d -s TANGO-PM-{slug} -c /path/to/tango
tmux send-keys -t TANGO-PM-{slug} 'claude --dangerously-skip-permissions --append-system-prompt "$(cat docs/guides/pm-role-prompt.md)"' C-m
scripts/send-tmux-message.sh TANGO-PM-{slug} /tmp/pm-brief-{slug}.md
tmux kill-session -t TANGO-PM-{slug}

# PM monitoring
tmux capture-pane -t TANGO-PM-{slug} -p -S -30
tmux list-sessions -F '#{session_name}' | grep TANGO-PM
scripts/pm-audit.sh

# Dev slot management
scripts/dev/list.sh
scripts/dev/spawn.sh feature/x --agent codex

# Linear API
curl -s -X POST https://api.linear.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: $LINEAR_KEY" \
  -d '{"query":"..."}'
```

### 6. Named Session Conventions

| Session | Owner | Purpose |
|---------|-------|---------|
| `VICTOR-COS` | Victor's persistent Discord channel runtime | NOT a separate session — see §7 |
| `TANGO-PM-{slug}` | PM agent for project `{slug}` | Created by Victor, torn down after ship |
| `dev-wt-{N}` | Dev agent in worktree slot N | Created by PM, torn down after merge |
| `tango:discord` | Main Discord bot process | Not managed by Victor |

**Naming rules:**
- PM slugs: lowercase, hyphen-separated, matching Linear project slug
- Dev slots: numbered 1-3 (matching worktree slots)
- Victor doesn't need a separate tmux session — he operates through his Discord channel runtime

### 7. How Victor's Runtime Runs

**Recommended: Option 1 — Normal v2 channel runtime + scheduled pulse.**

Victor's v2 runtime already persists per-conversation per the current architecture. The CoS pulse scheduled job feeds notifications into Victor's channel. On the next user turn, Victor sees both the user message AND the proactive notifications in warm-start context.

This avoids:
- A separate long-running Victor process (Option 2 — overcomplicated, duplicates runtime management)
- Custom daemon code (fragile, hard to monitor)
- Context window management for a continuous process

**How it works:**
1. Stakeholder messages Victor in Discord → normal v2 runtime turn with warm-start context (includes proactive messages)
2. CoS pulse fires every N minutes → checks state → posts updates to Victor's channel if changed
3. Victor sees the full picture on each turn: proactive updates + stakeholder message

**Limitation:** Victor can't take autonomous multi-step actions (like "notice PM is stuck → intervene → report") without being prompted. The CoS pulse handles the "notice + report" part; intervention requires stakeholder acknowledgment.

**Future enhancement:** A "CoS pulse with action" mode where the scheduled job not only reports but also takes lightweight corrective actions (e.g., sending a reminder to a stuck PM). This would use a v2 scheduled turn with `tango_shell` access.

### 8. Stakeholder Interaction Modes

| Mode | How it works |
|------|-------------|
| **Text DM to Victor** | Normal agent response via v2 runtime. Warm-start includes proactive messages and past conversation. |
| **Voice** | Existing voice pipeline routes to Victor. Same v2 runtime underneath. Natural for "Victor, status update" while walking. |
| **Proactive notifications** | CoS pulse posts to Victor's channel. User can reply in-thread for context. |
| **Direct PM inspection** | Stakeholder can still `tmux attach` to any PM session — Victor's coordination doesn't replace direct access. |

### 9. Phased Implementation Plan

#### Stage 1: Victor text mode + shell access + Linear + basic coordination
- Update Victor's `soul.md` and `knowledge.md` to CoS role
- Update `config/v2/agents/victor.yaml` type from `developer` to `coordinator`
- Test: stakeholder gives direction → Victor spawns PM → PM delivers
- No proactive messaging yet — Victor responds only when prompted
- **Estimated effort:** 1-2 days, mostly prompt engineering + config

#### Stage 2: CoS pulse proactive messaging
- Deploy `cos-pulse` scheduled job (from Part 2 prototype)
- Tune frequency and state tracking based on prototype results
- Add PM compliance checks to the pulse (not just session existence)
- **Estimated effort:** 1 day for config, 1-2 days for tuning

#### Stage 3: Voice UX tuning for CoS interactions
- Optimize Victor's voice responses for coordination context (shorter, more structured)
- Add voice-specific patterns: "Victor, what's the status?" → concise summary
- Consider dedicated voice call signs for CoS mode vs. dev mode
- **Estimated effort:** 1-2 days, prompt tuning + testing

### 10. Risks and Open Questions

#### Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Recursive Claude Code costs** — Victor spawns PM (Claude Code), PM spawns dev (Claude Code/Codex) = 3 layers of LLM calls | High | Monitor costs closely in Stage 1. Set PM model to Sonnet, dev model to cheapest viable. Budget alerts. |
| **Hallucination risk** — Victor reports PM shipped when it didn't | Medium | CoS pulse checks actual state (tmux + Linear), not just PM self-reports. Require linked Linear issues with test results before marking ship. |
| **Notification spam** — If PMs are noisy or pulse fires too frequently | Low | Pulse uses `__NO_OUTPUT__` for no-change; only posts on state transitions. PM reporting is milestone-based, not continuous. |
| **Context scaling** — Multiple projects in parallel fill Victor's warm-start | Medium | Victor's v2 runtime has context_reset_threshold: 0.80. Status file + Linear serve as external memory. Keep proactive messages concise. |
| **PM prompt injection** — A PM could in theory send misleading reports to Victor via tmux | Low | Victor validates PM claims against Linear state and tmux pane inspection. Trust but verify. |

#### Open Questions

1. **Should Victor manage his own CoS pulse configuration?** — Can Victor edit the schedule config to adjust frequency based on load? Or should that be manual?

2. **What happens during stakeholder absence?** — If stakeholder is away for 24+ hours, should Victor queue updates or summarize on return? The proactive messages accumulate in the channel regardless.

3. **PM spawning cost control** — Should Victor have a budget limit? Currently CoS (manual) self-regulates. Victor might over-spawn.

4. **Handoff from manual CoS to Victor** — Can be gradual: start Victor on one project while manual CoS handles others. Full handoff after confidence builds.

5. **Victor's identity shift** — Users (other agents) know Victor as "the dev guy." The role change needs clear communication. Consider whether this is just a personality shift or actually a new agent ID.

## Part 4: Recommendation

**Proceed to Stage 1 implementation.** Rationale:

1. **Proactive messaging is proven viable** — The scheduler already delivers to channels with session context. The CoS pulse pattern requires no new infrastructure, just a new schedule config.

2. **Victor already has the right tools** — `tango_shell` for tmux/scripts/git/Linear, `memory` for state, `discord-manage` for channel ops. No new MCP servers needed.

3. **Risk is contained** — Stage 1 is just prompt + config changes. No TypeScript code changes required. Reversible in minutes.

4. **The gap is clear** — Today's manual CoS works but doesn't scale. Victor-as-CoS with proactive pulse would let the stakeholder check in 1-2x/day with confidence that coordination is happening.

**Before Stage 2**, run the CoS pulse prototype (Part 2) for real validation. The prototype is additive (new YAML file) and low-risk.

## Stage 2: Implementation Notes

### CoS Pulse (shipped 2026-04-22)

- Schedule config: `config/defaults/schedules/cos-pulse.yaml`
- Profile override: `~/.tango/profiles/default/config/schedules/cos-pulse.yaml` (real channel IDs)
- Fires every 120 seconds via `every_seconds: 120`
- Runs as v2 agent turn with `delivery.agent_id: victor` (routes through Victor's MCP servers)
- Uses haiku model for lightweight state checks
- `__NO_OUTPUT__` sentinel suppresses delivery when state unchanged (confirmed in executor.ts:224)
- State file: `/tmp/cos-pulse-state.json`
- Checks: PM sessions, worktree slots, bot health (tango:discord), VICTOR-COS session

### VICTOR-COS Tmux Visibility (shipped 2026-04-22)

- Added to `agents/assistants/victor/knowledge.md`
- Pattern: `tmux new-session -d -s VICTOR-COS` for complex tasks > 5 minutes
- One session at a time — check before spawning
- CoS pulse monitors VICTOR-COS session status automatically
- Stakeholder can `tmux attach -t VICTOR-COS` for live visibility

### Channel ID Resolution

Victor's channel IDs are placeholder in `config/defaults/` (`100000000000000004`). Real Discord snowflake ID (`1480579160056397958`) is in the profile override at `~/.tango/profiles/default/config/channels.yaml`. The cos-pulse profile override uses the real ID directly.

## Key Files

- `config/v2/agents/victor.yaml` — Victor's agent config (updated Stage 1)
- `agents/assistants/victor/soul.md` — Victor's personality (rewritten Stage 1)
- `agents/assistants/victor/knowledge.md` — Victor's domain knowledge (rewritten Stage 1, VICTOR-COS added Stage 2)
- `config/defaults/schedules/cos-pulse.yaml` — CoS pulse schedule config (Stage 2)
- `packages/core/src/scheduler/engine.ts` — Scheduler engine (delivers proactive messages)
- `packages/core/src/scheduler/executor.ts` — Job executor (v2 turn path, __NO_OUTPUT__ handling)
- `packages/discord/src/main.ts:1695` — V2 scheduled turn executor
- `packages/discord/src/main.ts:1830` — `deliverToChannel` — session-aware delivery
- `docs/guides/cos-pm-architecture.md` — Current manual CoS architecture
- `docs/guides/pm-role-prompt.md` — PM role prompt (Victor would manage this)
