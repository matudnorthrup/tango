# Daily Brief Flow Hardening

**Status:** Validation
**Started:** 2026-05-25
**Owner:** Codex
**Linear:** [Daily brief flow hardening](https://linear.app/seaside-hq/project/daily-brief-flow-hardening-5d60bb452e2b) / [TGO-492](https://linear.app/seaside-hq/issue/TGO-492/harden-daily-brief-and-daily-note-morning-flow)

## Problem

The daily note was expected to exist before Devin started the day, but on 2026-05-25 it was created only after a later Watson interaction. Scheduler evidence showed the morning jobs did fire, but all Claude Code v2 agent jobs failed quickly with `Claude Code exited with code 1. No stderr output.` The deterministic vault audit still ran, which narrowed the failure to agent execution rather than the scheduler tick loop.

## Findings

- `daily-brief` writes `Records/Briefs/YYYY-MM-DD.md`.
- `morning-planning` is the job that creates and fills `Planning/Daily/YYYY-MM-DD.md`.
- Daily note creation was prompt-driven inside `morning-planning`, so an agent runtime failure meant no note.
- The scheduler does not perform catch-up after a restart. After the bot restarted at 07:29, it loaded the next morning's jobs.
- Alert thresholds on critical morning jobs allowed one missed morning to pass without immediate escalation.
- Slack saved review had drifted from the docs: the job writes a rich Slack domain log entry, while `obsidian_log` also appended a second generic entry.

## Changes

- Added deterministic `daily-note-bootstrap` handler and schedule.
- Added deterministic `morning-flow-sentinel` handler and schedule.
- The sentinel repairs existing brief frontmatter and adds a `Pipeline Warnings` section when upstream jobs failed, so stale briefs do not look healthy.
- Added `config/defaults/daily-brief-inputs.json` as the input registry for morning source jobs.
- Updated daily brief frontmatter instructions to include `types` and `areas`.
- Set first-failure alerts for `daily-brief`, `morning-planning`, `daily-email-review`, and `slack-saved-review`.
- Removed the duplicate `obsidian_log` hook from `slack-saved-review`.
- Added the data input contract at `docs/guides/daily-brief-data-inputs.md`.
- Replaced the prompt-driven `daily-brief` aggregator with the deterministic `daily-brief-aggregate` handler. It reads `config/defaults/daily-brief-inputs.json`, parses recent domain logs, fetches calendar events through `gog`, and writes the brief directly.

## New Runtime Shape

1. `daily-note-bootstrap` runs at 04:55 and creates or repairs today's daily note from the template.
2. Source jobs registered in `config/defaults/daily-brief-inputs.json` write domain logs.
3. `daily-brief` runs the deterministic `daily-brief-aggregate` handler and writes `Records/Briefs/YYYY-MM-DD.md`.
4. `morning-planning` reads the brief and fills priorities in the daily note.
5. `morning-flow-sentinel` runs at 05:25 and verifies artifacts and source job status. It creates a fallback brief if needed, or annotates the existing brief if upstream failures make it suspect.

## Validation

- `npm run test -w @tango/discord -- test/morning-flow.test.ts` passed with 6 tests.
- `npm run test -w @tango/discord -- test/daily-brief-aggregator.test.ts` passed with 2 tests.
- `npm run test -w @tango/core -- test/config.test.ts` passed with 30 tests.
- `npm run build -w @tango/discord` passed.
- `npm run bot:restart` passed and the live process restarted with the deterministic handler registered.
- `config/defaults/daily-brief-inputs.json` parses as valid JSON.
- `GET /trigger/daily-note-bootstrap` completed successfully and verified `Planning/Daily/2026-05-25.md`.
- `GET /trigger/morning-flow-sentinel` completed successfully before the warning-section patch and recorded the failed upstream jobs.
- A direct live invocation of the compiled sentinel repaired `Records/Briefs/2026-05-25.md`, adding `types`, `areas`, and `Pipeline Warnings`. A second direct invocation was idempotent. The HTTP trigger could not be re-run after the patch because the scheduler daily completion guard correctly skipped duplicate execution.

## Current Status

As of 2026-05-25, the hardening implementation is live, but the process is still in Validation.

- Waiting for the May 26 scheduled run is the right next validation step for the new bootstrap/sentinel path.
- The 2026-05-25 scheduled v2 agent jobs failed earlier with `Claude Code exited with code 1. No stderr output.`
- A later manual `daily-brief` trigger succeeded after the bot restart, so agent execution is not known to be globally broken right now.
- There are still useful things that can be pushed before May 26: investigate the May 25 scheduled v2 exits, fix Slack `stars:write`, and make daily-brief aggregation more deterministic.
- The Slack saved review project is part of this system. It still has validation gaps because the Slack domain log has recent entries, but the May 25 brief claimed no recent Slack entry.
- 2026-05-25 update: the v2 runtime failure was already validated under TGO-516 in the architecture project and did not reproduce after rebuild/restart. Manual v2 validation schedules passed, so TGO-524 was closed as covered by TGO-516. The remaining daily-flow question is unattended May 26 behavior.
- 2026-05-25 update: Slack saved review now defaults `saved_items` to a 48-hour recent window and returns a structured `missing_scope` warning for `stars.remove`. Devin added `stars:write`, live validation confirmed cleanup works, and the old saved-message backlog was cleared. Slack still has seven starred non-message objects, which the job intentionally skips.
- 2026-05-25 update: `daily-brief` now uses deterministic aggregation instead of an agent prompt. Config validation confirms the schedule is `mode: deterministic` with handler `daily-brief-aggregate`; today's HTTP trigger skipped because `daily-brief` had already completed, so the first production proof is still the May 26 unattended run.
- 2026-05-26 validation: the morning source jobs, old agent-based `daily-brief`, and `morning-planning` all ran and produced usable artifacts. However, the live tmux service was running from `/Users/devinnorthrup/GitHub/tango-finance-review-hardening`, while the hardening had been applied in `/Users/devinnorthrup/GitHub/tango`. As a result, `daily-note-bootstrap`, deterministic `daily-brief-aggregate`, and `morning-flow-sentinel` were not active for the scheduled 04:55/05:00/05:25 proof. The hardening was ported to the active worktree, rebuilt, and restarted at 05:58 PDT. Manual triggers then verified `daily-note-bootstrap` and `morning-flow-sentinel`; the sentinel repaired the May 26 brief frontmatter.
- 2026-05-26 update: removed the daily brief calendar event cap. The deterministic aggregator now calls `gog calendar events` with `--all-pages` and renders every same-day event returned by the calendar source.

## Remaining Work

- Investigate the underlying Claude Code v2 agent exits. This hardening makes failures visible and preserves the daily note, but it does not by itself fix the provider/runtime failure that caused the missed 2026-05-25 agent jobs.
- Add startup catch-up for missed critical daily schedules.
- Validate the May 27 unattended run from the active production worktree. This replaces the May 26 proof because May 26 ran the old active config.

## Linear Follow-Ups

- [TGO-523](https://linear.app/seaside-hq/issue/TGO-523/validate-may-26-scheduled-daily-brief-flow) - validate the May 26 scheduled run.
- [TGO-524](https://linear.app/seaside-hq/issue/TGO-524/root-cause-claude-code-v2-scheduled-agent-exits) - closed as covered by TGO-516; v2 failures did not reproduce after rebuild/restart.
- [TGO-525](https://linear.app/seaside-hq/issue/TGO-525/make-daily-brief-aggregation-deterministic-or-registry-driven) - implemented and awaiting May 26 unattended validation.
- [TGO-526](https://linear.app/seaside-hq/issue/TGO-526/resolve-slack-saved-item-clearing-blocker) - completed after `stars:write` validation and saved-message backlog cleanup.
