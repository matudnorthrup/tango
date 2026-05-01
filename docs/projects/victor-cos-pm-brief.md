# Project Brief: Victor-as-Chief-of-Staff — Discovery + Proactive Messaging Prototype

## Vision
Reframe Victor's role. Today he's under-utilized. Target: Victor becomes a Chief-of-Staff agent that coordinates work by spawning PMs, monitoring them, and reporting status back — essentially what the main Claude Code session does for the stakeholder today, but living inside Tango with voice+Discord as the primary interface.

Reference: docs/guides/cos-pm-architecture.md and docs/guides/pm-role-prompt.md — these describe the CoS role the stakeholder currently operates manually.

## The hard part (de-risk FIRST)
**Proactive multi-message delivery to Discord.** Current Tango pattern: user messages agent → agent responds once. CoS pattern: agent pushes updates when things change (PM 1 shipped, 10 min later PM 2 shipped, etc.) WITHOUT user prompting between them.

This has been a recurring struggle per stakeholder. Before committing to full Victor-as-CoS work, validate the core capability with a minimal prototype.

## Scope

### Part 1: Discovery — proactive messaging mechanism

Study the existing patterns:
- morning-briefing scheduled job: fires daily, posts a message to Watson's channel, no user prompt required. This already demonstrates proactive posting.
- slack-summary, memory-maintenance, etc.: same pattern
- How do these deliver to Discord? What's the code path? (scheduler → agent runtime → Discord client)

Key questions:
- Can a scheduled job run and post to a CHANNEL without using the "start a thread" pattern?
- When a scheduled job posts, does it appear in the agent's next conversation context? (important — CoS needs awareness of its own past proactive messages)
- Is there any throttling/spam-protection on rapid scheduled posts?
- Can multiple distinct messages post from the same scheduled run, or must each run emit one message?

### Part 2: Prototype — minimal proactive messaging test

Goal: prove we can emit multiple proactive messages to a Discord channel over time, and that the receiving agent sees them as prior context.

Build a test "CoS pulse" scheduled job:
- Fires every 2 minutes (runs 5-6 times)
- Each fire: inspects some simple state (e.g., list of active TANGO-PM-* tmux sessions)
- If state changed from last fire: post a short notification to a dedicated test channel
- If state same: exit silently
- State persistence between fires: small JSON file in /tmp or Atlas:memory

Run the prototype for ~15 min, watching the channel. Verify:
- Multiple distinct messages appear in sequence as state changes
- When a user message is sent after these, the agent's context includes the proactive messages
- No duplicate / malformed output

If this works, de-risking is complete. If it doesn't, document why and what would need to change.

### Part 3: Full Victor-as-CoS spec

Assuming Part 2 succeeds, write a comprehensive spec at `docs/projects/victor-as-cos.md` covering:

1. **Role definition** — Victor as CoS: receives high-level direction from stakeholder, decomposes into projects, spawns PMs, monitors, reports, updates Linear. What he does NOT do (hands-on code writing, irreversible actions without confirmation).

2. **Updated soul.md + knowledge.md** for Victor — new persona (he was dev-focused before; shift to coordination-focused), with clear guidance on when to delegate vs. act.

3. **MCP server allowlist expansion:**
   - `tango-dev` (shell + file, already has) — for tmux / scripts / git
   - Add Linear MCP or a Linear wrapper — for project/issue management
   - `memory` — for cross-session CoS state
   - `discord-manage` — for channel/thread operations if needed

4. **Shell command patterns Victor uses** — full list of the scripts CoS uses today:
   - `scripts/send-tmux-message.sh`
   - `scripts/pm-audit.sh`
   - `scripts/dev/spawn.sh`, `scripts/dev/list.sh`, `scripts/dev/claim-bot.sh`
   - `tmux capture-pane`, `tmux kill-session`, `tmux list-sessions`
   - Linear API curl patterns

5. **Named session conventions** — stakeholder wants predictable tmux names so they can `tmux attach -t VICTOR-COS` or similar to observe/intervene. Document naming:
   - Victor's CoS session: `VICTOR-COS` (spawned how? See §7)
   - PMs: `TANGO-PM-{slug}` (existing convention)
   - Dev agents: `dev-wt-{N}` (existing convention)

6. **Proactive messaging pattern** (carried from Part 2 prototype) — the "CoS pulse" scheduled job. Frequency, state tracking, what triggers a message, what doesn't.

7. **How Victor's own runtime runs** — Victor is an agent, so he has a v2 runtime per conversation per the current architecture. But the CoS role needs long-running awareness. Options to evaluate:
   - Victor's Discord channel runtime stays persistent (normal v2 behavior); scheduled jobs feed notifications into the channel so Victor sees them on next user turn.
   - OR a separate long-running Victor process. Probably overcomplicated; recommend option 1.

8. **Stakeholder interaction modes**:
   - Text DM to Victor: normal agent response
   - Voice: works via existing voice pipeline
   - Notifications Victor pushes: appear in Victor's channel, user can reply in thread to get context

9. **Phased implementation plan:**
   - Stage 1: Victor text mode + shell access + Linear + basic coordination (no proactive)
   - Stage 2: CoS pulse proactive messaging
   - Stage 3: Voice UX tuning for CoS interactions

10. **Risks and open questions**:
    - Recursive Claude Code costs (Victor → Claude Code → spawns more Claude Code for PMs)
    - Hallucination risk (Victor thinks a PM shipped when it didn't)
    - Notification spam (if PMs are noisy)
    - What happens when Victor needs to coordinate multiple projects in parallel — how does context scale?

### Part 4: Report to CoS with spec + prototype results

**Report via scripts/send-tmux-message.sh CHIEF-OF-STAFF with:**
- Prototype results (did multi-message proactive work?)
- Link to spec doc
- Recommendation: proceed to Stage 1 implementation or rethink?
- Flagged risks for stakeholder review

**Do NOT implement Stage 1 without stakeholder approval.** Discovery + prototype + spec only for this project.

## Linear
Create a new project "Victor as Chief-of-Staff" under Tango team with 5 milestones (Discovery, Implementation, Deploy, Validation, Ship). Issues under each with acceptance criteria.

## Tools
```
export OP_SERVICE_ACCOUNT_TOKEN=$(grep OP_SERVICE_ACCOUNT_TOKEN /Users/devinnorthrup/GitHub/tango/.env | cut -d= -f2-)
export LINEAR_KEY=$(op read "op://Watson/Linear Seaside-HQ Tango API Key/credential")
```

## Critical reminders
- Use `scripts/send-tmux-message.sh` for ALL multi-line communication (CoS reports, dev work orders)
- There's a pending TGO-292 bot restart deploy — don't restart the bot during your prototype work without coordinating with CoS first
- The prototype scheduled job must post to a TEST channel, not any production agent channel, to avoid confusing the stakeholder during their live use

## Reference
- docs/projects/tango-architecture-rebuild.md (architecture context)
- docs/guides/cos-pm-architecture.md (CoS pattern the user wants replicated)
- docs/guides/pm-role-prompt.md (PM role that Victor-CoS would spawn)
- Existing proactive jobs: config/defaults/schedules/morning-briefing.yaml, slack-summary.yaml
- packages/core/src/scheduler/ (scheduler engine)
- packages/discord/src/main.ts (v2 runtime integration point)
