# Victor Runtime Redesign Audit

**Status:** Discovery complete
**Date:** 2026-05-19
**Owner:** CoS
**Related docs:** `docs/projects/victor-operations-chief-redesign.md`, `docs/guides/cos-pm-architecture.md`

## Summary

Victor currently has two meanings of "persistent":

1. `config/v2/agents/victor.yaml` sets `runtime.mode: persistent`, but the v2 runtime is not a standing Claude Code process. It is an in-memory runtime pool that spawns `claude --print` turns and carries a provider session id while the bot process is alive.
2. `VICTOR-COS` is a real standing tmux Claude Code session, but Discord and voice reach it through a file bridge plus tmux paste automation.

Neither gives the product guarantee the user wants: Victor should be able to coordinate work, make or delegate Tango changes, survive restarts, and recover active work without relying on tmux scrollback or a live Claude pane as the source of truth.

## Current Design

Normal Victor text and voice turns route through Tango v2. The `VICTOR-COS` bridge is a manual-console mode and is inactive by default.

The bridge is used only when both conditions are true:

- `VICTOR_BRIDGE_MODE=manual-console` is set for the Discord bot process.
- `packages/discord/src/victor-bridge.ts` confirms `tmux has-session -t VICTOR-COS`.

When the bridge is explicitly enabled and `VICTOR-COS` exists:

- Text routing in `packages/discord/src/main.ts` and voice routing in `executeVoiceTurn` short-circuit into the bridge.
- The bot writes a JSON request under `/tmp/victor-cos-inbox`.
- `scripts/victor-cos-inbox-watcher.sh` watches the directory, builds a prompt, and pastes it into `VICTOR-COS:0`.
- The bot waits up to 120 seconds for `/tmp/victor-cos-outbox/{requestId}.json`.
- On response, the bot presents the answer and writes the outbound message.

The watcher is not a durable worker. It deletes inbox files after paste and, if the Claude pane does not look idle after five seconds, it delivers anyway.

## Findings

- `tmux has-session` is not a health check. It does not prove Claude is running, in the right repo, authenticated, watching the inbox, on the expected branch, or able to respond.
- `/tmp/victor-cos-inbox` and `/tmp/victor-cos-outbox` are not durable queues. Reboots remove state, and bot restarts lose in-memory request mappings.
- The watcher deletes requests before a response exists. If Claude blocks, crashes, asks for approval, or receives a malformed paste, the request is effectively lost.
- The five-second idle heuristic can interleave user requests with ongoing work.
- Before the manual-console gate, text and voice behavior changed depending on whether a tmux session existed, which made Victor feel nondeterministic.
- Direct Discord webhook guidance in `agents/assistants/victor/knowledge.md` conflicts with the product requirement that stakeholder-facing messages go through Tango presentation and session storage.
- The current design does not protect Tango from self-modification hazards. `VICTOR-COS` runs in the main repo and can edit live files, collide with user changes, or continue on old code while the bot restarts on new code.
- The bridge gate now has focused tests in `packages/discord/test/victor-bridge.test.ts`; the watcher script still lacks coverage.

## Product Direction

Victor should be a durable orchestrator, not a standing terminal session.

The core product model should be:

- User talks to Victor through Discord or voice.
- Victor creates durable work records first: Linear project or issue, local task record, status, owner, next check, recovery path.
- Small read/status tasks can run inline.
- Code changes go through isolated worktrees and dev agents.
- Major initiatives go through PM agents.
- Scheduled jobs and monitors provide proactive updates.
- On restart, Victor reconstructs state from Linear, Tango storage, worktrees, and PM/dev slots, not from tmux history.

`VICTOR-COS` can remain, but only as an optional operator-visible console and emergency workbench. It should not be Victor's brain or the primary queue.

## Recommended Architecture

### 1. Durable Victor Work Records

Add a durable task/status store for Victor work. Linear can be the user-facing source of truth, but Tango should also have local restart recovery data.

Minimum fields:

- `id`
- `title`
- `kind`: status, code-change, project, prompt-doc-update, monitor
- `owner`: victor, pm, dev slot
- `status`: queued, in_progress, blocked, validating, done, failed
- `linear_project_id` / `linear_issue_id`
- `branch` / `worktree_slot`
- `next_check_at`
- `last_event`
- `recovery_instructions`

### 2. Code Change Workflow

Victor may coordinate Tango changes, but should not edit the live main worktree directly.

Required path:

1. Create work record.
2. Create branch/worktree through `scripts/dev/spawn.sh`.
3. Assign a dev agent or PM agent.
4. Monitor with scheduled/heartbeat check.
5. Run focused tests.
6. Live-test the bot when behavior changes.
7. Merge/deploy/restart deliberately.
8. Update Linear/status before reporting complete.

### 3. Bridge Reframe

Short term:

- Treat the current bridge as manual-console mode only.
- Make text/voice routing use normal v2 unless the user explicitly asks to use the `VICTOR-COS` console.
- Remove or rewrite the direct webhook instructions in Victor knowledge.

If the bridge remains:

- Move queue state from `/tmp` to `~/.tango/profiles/${TANGO_PROFILE}/runtime/victor/`.
- Add `queued`, `processing`, `outbox`, `archive`, and `dead-letter`.
- Add lock/lease/ack semantics.
- Do not paste when Claude is busy.
- Require atomic response writes.
- Support structured responses: `ok`, `accepted_async`, `needs_more_time`, `error`.
- Add stale response cleanup and duplicate handling.

### 4. Runtime Supervisor

If `VICTOR-COS` survives as a feature, add a real supervisor:

- `packages/discord/src/victor-runtime-supervisor.ts`
- `scripts/victor-cos-start.sh`
- `scripts/victor-cos-status.sh`

Health should verify:

- tmux session exists
- Claude pane exists
- watcher pane/process exists
- cwd is expected
- git branch and commit are recorded
- queue directory is profile-scoped
- heartbeat is fresh
- no stale processing requests exceed lease

### 5. Restart Recovery

On bot startup or scheduled CoS pulse, Victor should inspect:

- active Linear projects/issues
- active PM tmux sessions
- active dev worktrees
- claimed bot slots
- durable Victor work records
- bridge dead letters, if bridge remains

Then it should report only meaningful state changes.

## Proposed Implementation Slices

### Slice 1: Stop Unsafe Bridge Semantics

- Gate bridge usage behind explicit config or command instead of `tmux has-session`. `VICTOR_BRIDGE_MODE=manual-console` now gates the bot-side bridge.
- Update watcher so "not idle" leaves work queued instead of pasting anyway.
- Remove direct webhook guidance from Victor knowledge.
- Add tests around text/voice fallback behavior.

### Slice 2: Durable Victor Work Records

- Add a small SQLite-backed Victor work table or equivalent storage layer.
- Add helpers to create/update/list records.
- Add startup/pulse recovery summary.
- Add tests for restart-like recovery.

### Slice 3: Safe Code Change Workflow

- Add a Victor-facing helper around `scripts/dev/spawn.sh`, `scripts/dev/list.sh`, and release/status operations.
- Require dirty-worktree checks before assigning or releasing.
- Document and test the "Victor can change Tango" workflow.

### Slice 4: Optional Supervised Console

- Add `victor-runtime-supervisor`.
- Move bridge queue out of `/tmp`.
- Add durable queue states, leases, dead letters, and a status command.
- Add a live bridge smoke test.

## Tests To Add

- `packages/discord/test/victor-bridge.test.ts`
- `packages/discord/test/victor-runtime-supervisor.test.ts`
- `packages/discord/test/victor-routing.test.ts`
- `packages/core/test/session-lifecycle.test.ts`
- script dry-runs for `scripts/victor-cos-start.sh` and `scripts/victor-cos-status.sh`
- live validation: `npm run test:deterministic-victor-live` plus a bridge smoke test if the bridge remains

## Open Questions

- Should Victor ever be allowed to make very small repo edits directly, or must every code change use a dev worktree?
- Should Linear be the only source of truth, or should Tango keep a local task table and sync to Linear?
- When a PM is blocked, should Victor only report, or should it take corrective action automatically?
- Should `VICTOR-COS` remain as an operator-visible console, or should it be replaced by a proper Victor activity/status view?

## Recommendation

Proceed with Slice 1 and Slice 2 first. They remove the most dangerous behavior and create the restart recovery foundation. Keep `VICTOR-COS` available as a manual console, but stop treating it as the primary Victor runtime.
