# Tango — Claude Code Instructions

## Roles

Claude may operate in different roles depending on context. Role-specific authority and behavioral instructions are in the auto-memory system at `~/.claude/projects/-Users-devinnorthrup-GitHub-tango/memory/`. Check `MEMORY.md` there for the index. Key files:

- `user_pm_role.md` — PM authority model, decision-making boundaries, anti-patterns, escalation criteria
- `feedback_done_means_live_tested.md` — "done" means live tested, not unit tested
- `feedback_project_docs.md` — document major work in `docs/projects/`

## Project Tracking

All active work is tracked in **Linear** (Seaside HQ workspace). See memory file `reference_linear_seaside_hq.md` for API details.

- Create a project from the **General Project** template for every new initiative
- Update issue status as work progresses (Todo → In Progress → Done)
- Update project status to reflect the current milestone (Discovery → Implementation → Validation → Ship)
- Link PRs and docs in project descriptions
- When completing work, update Linear BEFORE reporting to stakeholder

## Engineering Standards

### Live Testing

A fix or feature is NOT done until **live tested end-to-end**. Unit tests are a milestone, not a finish line.

**Hard gate**: Do NOT move a Linear project to Ship or merge a PR until every Validation milestone issue is marked Done with documented test results in the issue comments. No exceptions — check the Linear project before merging.

### Parallel Development

```bash
scripts/dev/spawn.sh feature/x --agent codex   # create isolated dev slot
scripts/dev/list.sh                              # slot status
scripts/dev/claim-bot.sh 1 --live                # claim Discord bot for testing
scripts/dev/run-slot-tests.sh 1                  # automated Discord test suite
scripts/dev/release-bot.sh 1 --live              # release bot back to main
scripts/dev/release-worktree.sh 1                # tear down slot
```

Full docs: `docs/guides/parallel-dev.md`

### Agent Monitoring (CRITICAL)

**After every handoff to a dev agent, create a CronCreate monitoring job.** Without this, agents complete work that sits unreviewed until someone manually checks.

```
CronCreate: */12 * * * *   (adjust interval to expected task duration)
Prompt: check status file + list slots + tail tmux pane.
  If done → review/merge/update Linear/delete cron.
  If blocked → unblock. If needs approval → approve.
  If still working → exit silently.
  If all slots empty → delete cron.
```

- Short tasks (< 15 min): every 5-8 min
- Medium tasks (15-30 min): every 12 min
- Long tasks (browser automation, 30+ min): every 20-30 min
- Self-delete the cron when work completes or all slots are empty
- Keep check-in prompts minimal to reduce token cost
- Approve Codex sandbox permissions automatically (send 'p' to persist)

### Project Documentation

Major projects and design decisions go in `docs/projects/` as markdown. See existing files for format.

## Technical Notes

- macOS bash 3.2: use `eval "$(cmd)"` not `source <(cmd)` for env propagation
- Profile isolation: `TANGO_PROFILE=wt-{N}` routes all state to `~/.tango/profiles/wt-{N}/`
- Two Discord allowlist layers: `DISCORD_ALLOWED_CHANNELS` (event-level) + `access-control.ts` (per-agent, uses parent channel via `resolveRoutingChannelId`)
- Singleton services (Kokoro, Whisper, voice pipeline) stay on main — never duplicated per worktree
