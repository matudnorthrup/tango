# Project: Parallel Worktree Development Workflow

**Date:** 2026-04-11 (single-session build)
**PM:** Claude (TANGO-PM tmux session)
**Developer:** Codex GPT-5.4 xhigh (TANGO-DEV tmux session)
**PR:** [#19](https://github.com/matudnorthrup/tango/pull/19) — merged to main

## Problem

Tango development was sequential — one feature at a time on one checkout. Multiple agents couldn't work in parallel because:
- Shared database and runtime state
- Single Discord bot token (one gateway connection)
- Shared test channels (agents would step on each other)
- No tooling to spin up isolated dev environments

## What we built

A complete parallel development workflow using git worktrees with 3 numbered slots, each providing full isolation (own DB, config, cache, prompts, logs) via Tango's existing `TANGO_PROFILE` mechanism, shared Discord bot access via a claim/release queue, and per-agent test thread provisioning.

### Implementation phases

| Phase | Scope | Key files |
|---|---|---|
| 1 | Slot isolation primitives (shell) | `scripts/dev/slot-env.sh`, `verify-slot-isolation.sh`, `scripts/tmux/wt/*.sh`, `session.sh` refactor |
| 2a | `DISCORD_ALLOWED_CHANNELS` env var guard | `packages/discord/src/allowed-channels.ts` + test |
| 2b | Bot claim/release with dry-run default | `scripts/dev/bot-lock.sh`, `claim-bot.sh`, `release-bot.sh` |
| 2c | Slot-mode thread provisioning | `packages/discord/src/slot-mode.ts` — bot creates test threads at startup |
| 2c fix | Per-agent access control mutation | Inject smoke-test parent channels into `defaultAccessPolicy.allowlistChannelIds` |
| 2c fix | Empty-prompt diagnostic | Warn log at `buildPrompt` empty-prompt check for cold-boot debugging |
| 2d | Nickname, timer, queue, history | Guild nickname `Tango [wt-N]`, 5-min auto-release, `--wait` queue, event log |
| 3 | Spawn automation | `spawn.sh`, `release-worktree.sh`, `list.sh`, `worktree-common.sh` |
| 4 | Docs | `docs/guides/parallel-dev.md` workflow guide |

Total: ~3,230 lines across 13 commits. 44 test files / 340 Discord tests.

## Key design decisions

### Single shared bot with claim queue (not N bot tokens)
**Decision:** Use the existing Discord bot token. One slot at a time can claim the bot for live testing; others queue.
**Why:** Devin vetoed the N-bot-registration approach as too heavy. Most dev work is coding + unit tests, not live Discord tests. Sequential live testing with short holds (5-min default) is acceptable.
**Trade-off:** Main Tango is offline during dev claims (~30-60s per cycle). Acceptable for a personal assistant with one user.

### Profile isolation via `TANGO_PROFILE`
**Decision:** Set `TANGO_PROFILE=wt-{N}` — this single env var routes ALL runtime state (DB, cache, config overrides, prompts, logs) to `~/.tango/profiles/wt-{N}/`.
**Why:** `packages/core/src/runtime-paths.ts` already had `hasExplicitProfileRuntimeSelection()` that short-circuits the legacy repo-local fallback when `TANGO_PROFILE` is set. Zero new code paths needed for isolation. Validated via POC before implementation.

### Bot-native thread provisioning (not external script)
**Decision:** The slot bot itself creates test threads at `ClientReady` time, not a separate Node REST script.
**Why:** Self-contained — no chicken-and-egg where threads must exist before the bot can be useful. The bot already has Discord client auth. Each claim creates fresh threads (auto-archive at 60 min), so test history is clean.
**User input:** Devin specified threads should go in each agent's existing `smoke_test_channel_id` test channels, not the main agent channels. One thread per agent per claim.

### Closed-by-default allowlist
**Decision:** When `TANGO_SLOT` is set and no explicit `DISCORD_ALLOWED_CHANNELS` override exists, `allowedChannels` initializes as an empty Set (drops everything). Only after thread creation succeeds does it swap to the created thread IDs.
**Why:** Prevents a race window where the dev bot could process real user traffic before its test threads are ready.

### Two-layer allowlist
**Discovery during live test 1:** Tango has TWO allowlist mechanisms:
1. Phase 2a's `DISCORD_ALLOWED_CHANNELS` — guards `messageCreate` with `message.channelId` (thread ID)
2. Per-agent `access-control.ts` — uses `resolveRoutingChannelId(message)` which normalizes threads to parent channel IDs, then checks against `defaultAccessPolicy.allowlistChannelIds`

The second layer was unknown at design time. Slot-mode thread IDs passed layer 1 but the parent channels weren't in layer 2's allowlist (which only contained channels from session configs, not `smoke_test_channel_id`s).
**Fix:** After slot-mode thread creation, mutate `defaultAccessPolicy.allowlistChannelIds` to include the smoke-test parent channels. Agents without access overrides share the Set reference, so mutation propagates instantly.

### Dry-run default for claim/release
**Decision:** `claim-bot.sh` and `release-bot.sh` default to dry-run mode. `--live` must be explicitly passed.
**Why:** These commands stop and restart production Tango. Dry-run default prevents accidental main downtime during development and testing of the scripts themselves.

## Lessons learned

### POC before implementation
Running a quick proof-of-concept (create a worktree, write to a wt-poc DB, verify main's DB is untouched) before any implementation gave high confidence that the isolation mechanism worked. This saved multiple potential false-starts.

### macOS bash 3.2
`source <(cmd)` via process substitution does NOT propagate exported vars to the parent shell in bash 3.2 (macOS system bash). Fix: use `eval "$(cmd)"` or source from a real file. This was discovered during Phase 1 self-testing and fixed immediately.

### Pre-flight gotchas for slot profiles
Each slot needs: (a) profile config seeded from default, (b) `.env` symlinked into the worktree, (c) discord dist built. These were manual steps during live testing and are now automated in `spawn.sh`.

### Flaky first-message-after-cold-boot
Live test 2 showed `buildPrompt` returning empty despite the user posting real text. Test 3 could not reproduce it. A diagnostic log was added (`[tango-discord] empty-prompt rawLen=...`) to capture the state on next occurrence. Root cause not confirmed — likely Discord Message Content Intent cold-start timing or thread membership propagation delay.

## Open items

- **Empty-prompt quirk**: diagnostic log is in place but root cause is not yet confirmed. Will fire automatically on next occurrence.
- **Voice stack isolation**: not supported. Voice-touching branches must be tested on the main checkout. Documenting this as a known limitation.
- **More than 3 slots**: slot count is hardcoded at 3 in `slot-env.sh`. Expanding requires updating the validation in multiple scripts. Low priority — 3 is sufficient for current needs.
- **Merge conflict risk**: long-lived feature branches in parallel slots may diverge from main. Standard git merge/rebase discipline applies.
