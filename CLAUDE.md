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

### Project Documentation

Major projects and design decisions go in `docs/projects/` as markdown. See existing files for format.

## Technical Notes

- macOS bash 3.2: use `eval "$(cmd)"` not `source <(cmd)` for env propagation
- Profile isolation: `TANGO_PROFILE=wt-{N}` routes all state to `~/.tango/profiles/wt-{N}/`
- Two Discord allowlist layers: `DISCORD_ALLOWED_CHANNELS` (event-level) + `access-control.ts` (per-agent, uses parent channel via `resolveRoutingChannelId`)
- Singleton services (Kokoro, Whisper, voice pipeline) stay on main — never duplicated per worktree
