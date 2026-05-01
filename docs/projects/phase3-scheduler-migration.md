# Phase 3: Scheduler v2 Migration Plan

**Status:** Tier 1 + Tier 2 migrated to v2 — Tier 3 left on legacy per plan
**Linear:** [Tango Architecture Rebuild](https://linear.app/seaside-hq/project/tango-architecture-rebuild-8b6d65e9227d), Phase 3 milestone
**Date:** 2026-04-21

---

## Overview

Phase 3 connects the existing scheduler engine to the v2 Claude Code runtime. Each schedule has a `runtime` field (`legacy` | `v2`) that controls which execution path it uses. All existing schedules default to `legacy`. Migration happens per-schedule with stakeholder approval.

### What the v2 bridge does differently

| Aspect | Legacy | v2 |
|--------|--------|-----|
| Execution | Worker bridge → turn executor → provider | Fresh `ClaudeCodeAdapter` spawn per job |
| Context | Warm-start prompt reconstruction | Atlas:memory cold-start (pinned facts + relevant memories) |
| Tools | Worker-scoped tool contracts | Full MCP server access per agent config |
| Session | Shared orchestrator session | Isolated per-job (no cross-job context bleed) |
| Model run | Via turn executor | Direct `model_run` persistence |

---

## Per-Schedule Risk Classification

### Tier 1: Low Risk — Flip after stakeholder approval

Safe to migrate first. Fires during daylight hours or is non-critical. Stakeholder can observe and correct.

| Schedule | Timing | Agent | Mode | Why Low Risk |
|----------|--------|-------|------|-------------|
| `weekly-email-subscriptions` | Sun 10:00am | Watson | agent | Weekend daytime, informational only, easy to observe |
| `ai-intelligence-briefing` | Daily 3:05pm | Sierra | agent | Afternoon, informational summary, no writes |
| `slack-summary` | Daily 4:00pm | Sierra | agent | Afternoon, read-only summary, non-critical |
| `memory-maintenance` | Sun/Wed 2:00pm | Watson | agent | Daytime, low-stakes memory housekeeping |
| `evening-review` | Daily 8:30pm | Watson | agent | Evening, backstop only (user usually does it manually) |

**Recommendation:** Flip 1-2 of these after the dummy smoke test validates at 10am on 2026-04-22. `weekly-email-subscriptions` (next fire: Sunday 10am) and `ai-intelligence-briefing` are the best candidates.

### Tier 2: Medium Risk — Flip after Tier 1 validates

User-impacting or involves write operations. Should only flip after at least one Tier 1 schedule runs successfully on v2.

| Schedule | Timing | Agent | Mode | Why Medium Risk |
|----------|--------|-------|------|----------------|
| `morning-planning` | Daily 8:15am | Watson | agent | Morning routine — user relies on it. But it's a backstop (user often does it manually). Priority 10. |
| `weekly-finance-review` | Sun 7:00am | Watson | agent | Financial data, early morning. User reviews output. |
| `sinking-fund-reconciliation` | Sun 7:00am | Watson | conditional | Financial writes, runs with pre-check. Same time as finance review. |
| `sinking-fund-reconciliation-month-end` | 28-29th 7:00am | Watson | conditional | Month-end financial, time-sensitive window. |
| `daily-email-review` | Daily 4:00pm | Watson | agent | Currently **disabled** — safe to flip when re-enabled. |

**Recommendation:** After 2+ successful Tier 1 runs, flip `morning-planning` on a day the stakeholder is available to observe. Then `weekly-finance-review` on a Sunday.

### Tier 3: High Risk — DO NOT flip without overnight observation plan

Fires overnight, handles financial transactions, or uses browser automation. Failure modes are harder to observe and correct.

| Schedule | Timing | Agent | Mode | Why High Risk |
|----------|--------|-------|------|--------------|
| `nightly-transaction-categorizer` | Daily 11:00pm | Watson | conditional | Financial writes (categorizes transactions), runs overnight |
| `receipt-cataloger` | Daily 2:00am | Watson | conditional | Browser automation (Amazon/Walmart login), overnight, 15-min timeout |
| `memory-reflections` | Daily 5:30am | — | deterministic | **Not applicable for v2** — deterministic handler, no agent involved |
| `memory-obsidian-index` | Daily 5:00am | — | deterministic | **Not applicable for v2** — deterministic handler |
| `memory-archive-stale` | Daily 4:00am | — | deterministic | **Not applicable for v2** — deterministic handler |
| `memory-eval-report` | Daily 6:15am | — | deterministic | **Not applicable for v2** — deterministic handler |
| `contacts-sync` | Daily 4:00am | — | deterministic | **Not applicable for v2** — deterministic handler |
| `claude-artifact-cleanup` | Daily 6:05am | — | deterministic | **Not applicable for v2** — deterministic handler |
| `health-daily-reset` | Daily midnight | — | deterministic | **Not applicable for v2** — deterministic handler |

**Recommendation:** `nightly-transaction-categorizer` and `receipt-cataloger` should only migrate after all Tier 1 and Tier 2 agent schedules are stable on v2. Consider running both legacy and v2 in parallel (v2 to smoke test channel, legacy to production) for one cycle before switching.

### Not Applicable: Deterministic and Interval Schedules

These schedules use `mode: deterministic` (direct handler functions) or high-frequency intervals. They don't use the agent/worker execution path, so the `runtime: v2` flag has no effect on them.

| Schedule | Timing | Mode | Notes |
|----------|--------|------|-------|
| `active-threads-tracker` | Every 180s | deterministic | Interval-based, no agent |
| `printer-monitor` | Every 120s | deterministic | Interval-based, no agent |
| `memory-reflections` | Daily 5:30am | deterministic | Handler-based |
| `memory-obsidian-index` | Daily 5:00am | deterministic | Handler-based |
| `memory-archive-stale` | Daily 4:00am | deterministic | Handler-based |
| `memory-eval-report` | Daily 6:15am | deterministic | Handler-based |
| `contacts-sync` | Daily 4:00am | deterministic | Handler-based |
| `claude-artifact-cleanup` | Daily 6:05am | deterministic | Handler-based |
| `health-daily-reset` | Daily midnight | deterministic | Handler-based |

### Disabled / Manual Test Schedules

These are either disabled or used for manual testing only. No action needed.

| Schedule | Status | Notes |
|----------|--------|-------|
| `manual-test-ai-intelligence-briefing` | Disabled | Test variant |
| `manual-test-daily-email-review` | Disabled | Test variant |
| `manual-test-nightly-transaction-categorizer` | Disabled | Test variant |
| `manual-test-slack-summary` | Disabled | Test variant |
| `manual-test-weekly-finance-review` | Disabled | Test variant |
| `manual-test-receipt-cataloger` | Disabled | Test variant |
| `daily-email-review` | Disabled | Production disabled |

---

## Dummy Smoke Test Schedule

A one-shot test schedule (`v2-bridge-smoke-test`) is configured to fire at **10:00am PT on 2026-04-22**:
- Agent: Malibu (already on v2 runtime, lowest risk)
- Task: Return a one-sentence hello message
- Delivery: Malibu smoke test channel (`100000000000001002`)
- Auto-deletes after execution

This validates the v2 bridge infrastructure without affecting any real schedule.

---

## Migration Sequence (Recommended)

```
Phase 3a — Infrastructure (DONE, overnight 2026-04-21):
  [x] Build v2 bridge code (runtime field, executor path, main.ts wiring)
  [x] Create dummy smoke test schedule
  [x] Document migration plan (this file)

Phase 3b — Validation (DONE, 2026-04-21 evening):
  [x] v2-bridge-smoke-test confirmed v2 runtime working (3.1s, claude-sonnet-4-6, runtime:v2)
  [x] memory-maintenance validated on v2 (135s, runtime:v2 in metadata)
  [x] v2 scheduler path isolated from TGO-290 dispatch bug (executor.ts:1696 does per-agent config lookup)

Phase 3c — Tier 1 rollout (DONE, 2026-04-21):
  [x] Flip `weekly-email-subscriptions` to v2 — validated run:ok 157s
  [x] Flip `ai-intelligence-briefing` to v2 — validated run:ok 93.5s, runtime:v2
  [x] Flip `slack-summary` to v2 — validated run:ok 149s
  [x] Flip `memory-maintenance` to v2 — validated run:ok 135s, runtime:v2
  [x] Flip `evening-review` to v2 — validated run:ok 42s (disabled in profile, trigger still works)
  Note: First 3 Tier 1 triggers ran on stale bot process (legacy). Confirmed v2 after PID fix.

Phase 3d — Tier 2 rollout (DONE, 2026-04-21):
  [x] Flip `morning-planning` to v2 (disabled in profile overlay, config ready)
  [x] Flip `weekly-finance-review` to v2
  [x] Flip `sinking-fund-reconciliation` to v2
  [x] Flip `sinking-fund-reconciliation-month-end` to v2
  [x] Flip `daily-email-review` to v2 (disabled, config ready)
  Note: Tier 2 triggers hit completion tracking (already ran today on legacy).
  Natural validation: each will fire on v2 at next scheduled time.

Phase 3e — Tier 3 rollout (NOT STARTED — left on legacy per plan):
  [ ] `nightly-transaction-categorizer` — DO NOT flip without overnight observation plan
  [ ] `receipt-cataloger` — DO NOT flip without overnight observation plan
  Reason: fires overnight (11pm, 2am), involves financial writes and browser automation.
  Stakeholder will flip manually when they can observe.
```

### Validation Results (2026-04-21)

| Schedule | Tier | runtime:v2 | Manual Trigger | Result |
|----------|------|------------|----------------|--------|
| v2-bridge-smoke-test | — | Yes | run:ok 3.1s | runtime:v2 confirmed |
| weekly-email-subscriptions | T1 | Yes | run:ok 157s | Output delivered to Discord |
| ai-intelligence-briefing | T1 | Yes | run:ok 93.5s | runtime:v2 confirmed |
| slack-summary | T1 | Yes | run:ok 149s | Output delivered to Discord |
| memory-maintenance | T1 | Yes | run:ok 135s | runtime:v2 confirmed |
| evening-review | T1 | Yes | run:ok 42s | Output delivered to Discord |
| morning-planning | T2 | Yes | Ran on legacy (stale PID) | Config verified, awaiting next fire |
| weekly-finance-review | T2 | Yes | Ran on legacy (stale PID) | Config verified, awaiting next fire |
| sinking-fund-reconciliation | T2 | Yes | Ran on legacy (stale PID) | Config verified, awaiting next fire |
| sinking-fund-reconciliation-month-end | T2 | Yes | Ran on legacy (stale PID) | Config verified, awaiting next fire |
| daily-email-review | T2 | Yes | Ran on legacy (stale PID) | Config verified, awaiting next fire |
| nightly-transaction-categorizer | T3 | No | — | Left on legacy |
| receipt-cataloger | T3 | No | — | Left on legacy |

### Issue Discovered: Stale Bot Process

During validation, discovered that `tmux send-keys C-c` was not reliably killing the bot process. The old process (PID 76220, started 10:13 PM) survived multiple C-c attempts, causing Tier 2 triggers to run on legacy. Fixed by using `kill <PID>` directly. All triggers after the fix confirmed runtime:v2 in metadata.

---

## Rollback

Each schedule can be rolled back independently by removing the `runtime: v2` line from its YAML (or setting `runtime: legacy`). The legacy execution path is untouched and runs in parallel.

---

## Key Files

| File | Purpose |
|------|---------|
| `packages/core/src/scheduler/types.ts` | `ScheduleConfig.runtime` field |
| `packages/core/src/scheduler/executor.ts` | v2 execution routing |
| `packages/core/src/scheduler/engine.ts` | v2 dep passthrough |
| `packages/core/src/scheduler/index.ts` | Service-level v2 dep |
| `packages/discord/src/main.ts` | `executeV2TurnForScheduler` bridge function |
| `config/defaults/schedules/v2-bridge-smoke-test.yaml` | Dummy test schedule |
