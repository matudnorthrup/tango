# Daily Brief Domain Log Validation

**Status:** Shipped
**Linear:** TGO-434 through TGO-444
**Date:** 2026-04-29

## Problem

The daily brief architecture requires overnight jobs to write structured log entries to `~/Documents/main/Records/Jobs/{domain}/YYYY-MM.md`. The daily-brief aggregator at 5:15am reads these logs. But no domain job had ever successfully written a log entry (except slack-saved-review).

## Root Cause

v2 agents running via `claude --print` CAN write files (proven by slack-saved-review), but they don't reliably follow through on the Obsidian log instruction when it's the last step of a complex task. The agent completes the main work in 7-8 turns and returns before reaching the log step. Prompt restructuring (moving the step earlier, adding "REQUIRED" language) did not help.

## Solution

Added a **deterministic post-execution hook** in the scheduler executor (`packages/core/src/scheduler/executor.ts`). After any job completes successfully with a summary, the executor checks for an `obsidianLog` config and writes the log file directly — no agent instruction-following required.

### New config field

```yaml
obsidian_log:
  domain: Finance          # subdirectory under Records/Jobs/
  job_name: Nightly Transaction Categorizer  # entry header
```

### How it works

1. Job runs normally via v2/deterministic/worker runtime
2. Executor captures the summary (already truncated to 2000 chars)
3. `writeObsidianLog()` appends a formatted entry to `~/Documents/main/Records/Jobs/{domain}/YYYY-MM.md`
4. Fail-open: log write errors are caught and logged, never fail the job

## Additional Fixes

### Slack saved items date filter (TGO-443)
- `stars.list` returned ALL saved items including years-old ones
- Added `since_hours` parameter (default 48h) to filter by `date_create`
- Added `remove_star` action to unsave processed items via `stars.remove`
- Updated slack-saved-review task to use both

### Morning planning schedule time (TGO-444)
- Cron is `15 8` (8:15am), stakeholder expected 5:15am
- Not changed yet — daily-brief runs at 5:15am in same concurrency group
- Needs stakeholder decision on timing

## Validation Results

- **morning-planning trigger**: Log written to `Records/Jobs/Planning/2026-04.md` — confirmed
- **daily-brief trigger**: Successfully read Planning log, reported "one job ran at 08:20, no flags" — confirmed
- **Finance/Email logs**: Not yet tested (jobs haven't run today; will validate on next natural run)

## Key Files

| File | Change |
|---|---|
| `packages/core/src/scheduler/types.ts` | Added `ObsidianLogConfig` interface |
| `packages/core/src/config.ts` | Zod schema + mapping for `obsidian_log` |
| `packages/core/src/scheduler/executor.ts` | `writeObsidianLog()` post-hook |
| `packages/discord/src/slack-tools.ts` | `since_hours` filter + `remove_star` action |
| `config/defaults/schedules/*.yaml` | Added `obsidian_log` to 6 schedules, removed agent-instructed log steps |

## Known Issues

- TGO-440: nightly-transaction-categorizer not yet live-tested (runs at 11pm, will validate tonight)
- TGO-444: morning-planning cron time needs stakeholder decision
- The post-hook writes a generic "No flagged items." — it doesn't parse the summary for flags. A future enhancement could extract **Flagged:** sections from the agent's summary.
