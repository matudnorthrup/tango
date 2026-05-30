# Agent Operating Model

This guide is the shared operating policy for any coding or PM agent working on
Tango, including Codex and Claude Code. Tool-specific entrypoints such as
`AGENTS.md` and `CLAUDE.md` should be thin compatibility shims that point here.

## Source Order

When starting work, gather context in this order:

1. User request and current conversation.
2. This guide.
3. Project memory, using the discovery order below.
4. Linear project or issue state.
5. Repo docs and code.

If sources conflict, prefer the newest explicit user direction, then Linear for
active project state, then repo docs for durable architecture and process.

## Operating Roles

Devin is the stakeholder and owner. The active PM/coding agent is responsible
for carrying approved work through planning, implementation, validation, and
reporting without asking permission for routine reversible steps.

Standard agent authority includes:

- creating and updating Linear projects/issues
- making tactical implementation decisions inside the requested scope
- using parallel dev slots and live-test workflows
- updating docs and prompts when that is the task
- reporting completed results, not every intermediate thought

Escalate only for irreversible destructive actions, major product-direction
changes, spending/new paid services, unclear requirements that block progress,
or anything that would surprise Devin if he saw it tomorrow with no context.

## Memory Discovery

Do not assume project memory is tied to the current agent brand. Check every
existing candidate and read the relevant `MEMORY.md` index before relying on a
memory file:

```bash
project_slug="-Users-devinnorthrup-GitHub-tango"
printf '%s\n' \
  "$TANGO_AGENT_MEMORY_ROOT" \
  "$HOME/.claude/projects/$project_slug/memory" \
  "$HOME/.Codex/projects/$project_slug/memory" \
  "$HOME/.codex/projects/$project_slug/memory"
```

Use the first existing index that contains the needed project guidance. If more
than one exists, compare their `MEMORY.md` indexes and prefer the most current
relevant file rather than assuming the directory name is authoritative.

Important memory files normally include:

- `user_pm_role.md`
- `feedback_done_means_live_tested.md`
- `feedback_project_docs.md`
- `reference_linear_seaside_hq.md`

## Linear

Linear is the source of truth for active project work in the Seaside HQ
workspace, Tango team.

- Create or use a Linear project for each new initiative.
- Use the standard milestones: Discovery, Implementation, Deploy when needed,
  Validation, and Ship.
- Move issue status as work progresses: Todo, In Progress, In Review when
  useful, Done, or Canceled.
- Post Linear Project Updates at meaningful milestones: handoff, development
  completion, test summary, deploy/restart, validation, and final ship/cancel.
- Every Project Update must include recently completed work, blockers/risks,
  and next steps with clear owner labels when ownership matters.
- Use issue comments for issue-specific evidence such as logs, validation proof,
  or cancellation rationale.
- Update Linear before reporting completion to the stakeholder.

## Done Means Live Tested

A fix or feature is not done until it is live tested end to end. Unit tests,
static checks, and local smoke tests are milestones, not the finish line.

Do not move a project to Ship or merge a PR until every Validation milestone
issue is Done with documented validation evidence in Linear.

For docs-only work, replace live product testing with the relevant validation:
link checks, inventory checks, privacy scans, and review of rendered or indexed
documentation.

## Documentation

Repo docs are for durable knowledge, not active project tracking.

Keep in repo:

- architecture decisions and current architecture references
- retros/postmortems with lessons future agents need
- operator and contributor guides
- implementation-facing specs
- prompt/runtime asset docs that are safe as repo defaults

Move to Linear:

- active project plans
- mutable status updates
- validation evidence
- open questions and approval gates
- work breakdowns and project updates

Move to profile or private storage:

- raw/generated personal analysis
- private family, legal, health, financial, or relationship context
- user-specific prompt overlays
- real operational IDs when placeholders are enough
- machine-local paths unless an operator runbook explicitly needs them

Until the docs tree is reorganized, `docs/projects/` is a legacy location for
final project writeups and retros only. Do not add new mutable project-status
docs there when Linear can hold the source of truth.

## Parallel Development

Use isolated dev slots for implementation work that needs live Discord or bot
testing:

```bash
scripts/dev/spawn.sh feature/x --agent codex
scripts/dev/list.sh
scripts/dev/claim-bot.sh 1 --live
scripts/dev/run-slot-tests.sh 1
scripts/dev/release-bot.sh 1 --live
scripts/dev/release-worktree.sh 1
```

Profile isolation uses `TANGO_PROFILE=wt-{N}` so each slot gets its own
`~/.tango/profiles/wt-{N}/` state.

Singleton services such as Kokoro, Whisper, and the voice pipeline stay on main
unless a project explicitly designs otherwise.

## Monitoring

After handing work to another dev agent, create the best available monitoring
job in the current tool environment. The monitor should check the status file,
list slots, inspect the relevant tmux pane when applicable, unblock if needed,
and self-delete when the work is complete or all slots are empty.

Use short intervals for short tasks, longer intervals for browser automation or
long-running validation. Keep monitoring prompts small.

## Worktree Hygiene

The worktree may contain user or agent changes unrelated to your task.

- Never revert changes you did not make unless explicitly asked.
- Keep edits scoped to the files needed for the current issue.
- Before broad cleanup, inventory files and record the planned moves/deletes in
  Linear.
- Do not stage, commit, or report unrelated dirty files as yours.

## Technical Notes

- macOS uses bash 3.2 in some scripts: use `eval "$(cmd)"` instead of
  `source <(cmd)` for env propagation.
- Two Discord allowlist layers exist: `DISCORD_ALLOWED_CHANNELS` at the event
  layer and `access-control.ts` per-agent routing via parent channel
  resolution.
- Prefer structured parsers and existing repo helpers over ad hoc string
  manipulation when changing config or data formats.
