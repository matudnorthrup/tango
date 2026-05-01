# Chief of Staff / PM Agent Architecture

## Overview

Tango development uses a three-tier agent hierarchy:

```
Devin (Stakeholder)
  ↓  high-level direction, reviews specs, approves scope changes
Chief of Staff (CoS) — main Claude Code session
  ↓  project briefs, monitoring, iteration on PM process
PM Agent — Claude Code instance in tmux
  ↓  work orders, monitoring, review, testing
Dev Agent — Codex/Claude Code in worktree slot
```

**Why this structure exists:** When a single agent acts as both PM and executor, it loses process discipline under cognitive load — skipping Linear tracking, writing code instead of delegating, forgetting monitoring, asking permission instead of acting. Separating the roles creates an observation layer (CoS) that can detect and correct PM process failures without requiring stakeholder intervention.

## Roles

### Stakeholder (Devin)
- Gives high-level direction ("build X", "fix Y", "harden Z")
- Reviews specs and major scope decisions
- Checks in 1–2x per day
- Expects completed work with documented results, not in-progress status
- Can interact directly with any PM agent via tmux if needed

### Chief of Staff (CoS)
This is the main Claude Code session. Responsibilities:

- **Receives work from Devin** and decomposes into project briefs
- **Spawns PM agents** in tmux with the PM role prompt loaded
- **Monitors PM compliance** — are they following the process? (Linear, delegation, monitoring, testing)
- **Surfaces specs and results** to Devin for review
- **Iterates on the PM prompt** when process failures are observed
- **Manages multiple PM agents** running in parallel on different projects

The CoS does NOT:
- Write implementation code
- Manage dev agents directly (that's the PM's job)
- Make scope decisions without Devin's input on non-trivial changes

### PM Agent
A Claude Code instance running in a tmux session. Follows the process in `docs/guides/pm-role-prompt.md`.

- **Owns one project** end-to-end
- **Creates Linear project and issues**
- **Spawns and manages dev agents** in worktree slots
- **Runs live testing** and documents results
- **Reports to CoS** via status file and Linear updates

### Dev Agent
Codex or Claude Code in a worktree slot. Receives work orders from the PM.

- **Writes code** in an isolated worktree
- **Runs tests** as specified in the work order
- **Reports completion** — the PM monitors via tmux

## Launching a PM Agent

### Tmux naming
```
TANGO-PM-{project-slug}
```
Example: `TANGO-PM-ramp-hardening`

### Launch command
```bash
# Create tmux session
tmux new-session -d -s TANGO-PM-{slug} -c /Users/devinnorthrup/GitHub/tango

# Launch Claude Code with PM role appended to default system prompt
tmux send-keys -t TANGO-PM-{slug} \
  'claude --dangerously-skip-permissions --append-system-prompt "$(cat docs/guides/pm-role-prompt.md)"' C-m
```

Key flags:
- `--dangerously-skip-permissions` — PM needs to run tools without approval prompts
- `--append-system-prompt` — adds PM role ON TOP of Claude Code's default system prompt (preserves tool instructions, MCP access, etc.)
- The PM prompt file is read at launch time via command substitution

### Passing the project brief
Write the brief to a temp file, then send it to the PM:
```bash
# Write brief
cat > /tmp/pm-brief-{slug}.md << 'EOF'
# Project Brief: {Name}
...
EOF

# Send to PM agent
tmux send-keys -t TANGO-PM-{slug} "$(cat /tmp/pm-brief-{slug}.md)" C-m
```

### PM lifecycle
1. **Spin up** when a new project is ready to start
2. **Run** until the project ships or is explicitly paused
3. **Tear down** after ship: release worktree slots, delete crons, update docs
4. The CoS tears down the tmux session after confirming ship

### PM → CoS reporting

PMs report to the CoS by sending messages to the `CHIEF-OF-STAFF` tmux session. The PM prompt defines when reports are required:
- After discovery/spec (before implementation)
- When scope changes from the original brief
- When blocked
- At ship

The CoS should NOT rely solely on monitoring crons to learn what PMs are doing. PMs are expected to proactively report. If a PM is not reporting, that's a compliance failure — the CoS should intervene.

**Lesson learned (2026-04-17):** The Malibu PM completed Phase 2 (a code change with latency trade-offs) and declared ship without reporting to the CoS. The stakeholder had to go talk to the PM directly to learn what happened. Root cause: the PM prompt said "report to CoS" but didn't specify the mechanism (tmux send-keys). Fixed in PM prompt v2.

## CoS Monitoring Protocol

### When to check
After spawning a PM agent, the CoS creates a CronCreate monitoring job:
- New PM agents: check every 15–20 minutes for the first hour
- Established PMs (past first milestone): check every 30 minutes
- **Keep the monitoring cron running until the PM explicitly reports ship** — don't delete it early
- Self-delete the cron only after confirming the PM has reported and cleaned up

### What to check

Each monitoring cycle, the CoS evaluates:

**1. Is the PM alive and working?**
```bash
tmux capture-pane -t TANGO-PM-{slug} -p -S -30
```

**2. Is Linear up to date?**
- Does a Linear project exist for this work?
- Are issues created with acceptance criteria?
- Do issue statuses reflect reality?

**3. Is the PM delegating correctly?**
- Are worktree slots active? (`scripts/dev/list.sh`)
- Did the PM write code directly? (check git log for PM-authored commits — this is a red flag)
- Are monitoring crons running for dev agents?

**4. Is testing happening?**
- Has the PM claimed the bot for live testing?
- Are test results documented in Linear issues?
- Is the PM trying to ship without live testing?

**5. Is the PM following directions?**
- Does the PM's work match the project brief?
- Is the PM inventing extra steps or scope?
- Is the PM asking the CoS for permission on standard ops?

### Intervention

When the CoS detects a process failure:
1. **Mild:** Send a correction via tmux (e.g., "You need to create a Linear project before continuing")
2. **Moderate:** Update the PM role prompt to prevent recurrence, restart the PM with the updated prompt
3. **Severe:** Tear down the PM, report the failure to Devin, iterate on the PM prompt before respawning

### Compliance log

The CoS maintains a running log of PM compliance observations in its status reporting to Devin. This informs prompt iteration.

## Status Files

### PM status file
Location: `/tmp/tango-pm-{project-slug}-status.md`
Updated by: PM agent
Read by: CoS monitoring checks

### CoS status file
Location: `/tmp/tango-cos-status.md`
Updated by: CoS
Read by: Devin (on request)

Contains:
- Active PM agents and their projects
- Compliance observations
- Prompt iteration log
- Escalation items for Devin

## Iteration

The primary value of this architecture is the ability to iterate on the PM prompt based on observed behavior. The CoS should:

1. **Log every process failure** observed during monitoring
2. **Categorize failures** (missed step? wrong judgment? context loss? tool misuse?)
3. **Update `docs/guides/pm-role-prompt.md`** to address the failure
4. **Test the updated prompt** on the next PM instance
5. **Track what works** — if a prompt change reduces a failure mode, note it

Over time, the PM role prompt should converge on reliable autonomous execution.
