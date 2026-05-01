# Malibu Workout Close Confirmation

**Linear:** [Malibu Workout Close Confirmation](https://linear.app/seaside-hq/project/malibu-workout-close-confirmation-2a66baf464fb)
**Status:** Discovery complete, awaiting approval
**Date:** 2026-04-20
**Origin:** Stakeholder report — Malibu can't confirm workout close state

## Problem

When the user says "close it" to end a workout session, Malibu replies:

> "Heads up — the worker ran but I didn't get a confirmed write on the session close. It may or may not have sealed."

The DB write actually succeeded (`ended_at` was set on workout #42), but Malibu can't confirm it due to a write guard false positive.

## Root Cause

**`isReadOnlySql()` in `agent-worker-bridge.ts:68-77` misclassifies CTE-based writes as read-only.**

The workout-logging skill recommends closing sessions with a CTE pattern:

```sql
WITH target AS (
  SELECT id FROM workouts WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1
)
UPDATE workouts w SET ended_at = now() FROM target WHERE w.id = target.id RETURNING w.id, w.ended_at;
```

The function uses this regex:
```typescript
return /^(select|with|pragma|explain)\b/i.test(normalized);
```

Since the SQL starts with `WITH`, it matches as read-only — even though the CTE body contains an `UPDATE`. This means:

1. The tool call is classified as `mode: "read"`
2. `hasWriteOperations` on the receipt is `false`
3. The write guard sees a write step with no confirmed write operations
4. Warning emitted: "No write operation was recorded for this write step"
5. Malibu obeys the warning and tells the user the close is uncertain

The retry attempt compounds the problem: the worker checks if the session is already closed (a SELECT), which is also classified as read, triggering the same warning again.

## Evidence

**Conversation trace (2026-04-20):**
- 22:53:28 — User: "yeah, close it"
- 22:53:50 — Worker completed: "Session closed — workout #42 ended at 22:53 UTC" + warning: "No write operation was recorded for this write step"
- 22:53:50 — Malibu to user: "I didn't get a confirmed write on the session close. It may or may not have sealed."
- 23:31:48 — User: "ok, run it again and check please"
- 23:31:48 — Worker: "Session is already closed — no open workouts found. The previous close attempt did go through." + same warning
- 23:31:48 — Malibu: "I didn't get a confirmed write through on that step, so I can't say it was logged yet."

**DB state:** Workout #42 has `ended_at = 2026-04-20 22:53:41 UTC` — the close succeeded.

## Proposed Fix

### Primary (TGO-219): Fix `isReadOnlySql()` CTE write detection

```typescript
function isReadOnlySql(value: unknown): boolean {
  if (typeof value !== "string") return true;
  const normalized = value.trim();
  if (!normalized) return true;
  // CTEs starting with WITH may contain DML (INSERT/UPDATE/DELETE)
  if (/^with\b/i.test(normalized)) {
    return !/\b(insert|update|delete)\b/i.test(normalized);
  }
  return /^(select|pragma|explain)\b/i.test(normalized);
}
```

This preserves the existing behavior for pure `WITH ... SELECT` CTEs while correctly classifying `WITH ... UPDATE/INSERT/DELETE` as writes.

### Secondary (TGO-220, optional): Add workout verification patterns

Add workout-specific patterns to `textIndicatesVerifiedWriteOutcome()` in `worker-report.ts` as defense-in-depth, similar to the existing diary/receipt patterns.

## Scope

**Code change.** One function fix in `agent-worker-bridge.ts`. Affects all SQL tools (`workout_sql`, `atlas_sql`) that use `isReadOnlySql()`.

## Related Work

- [Narration Guard False Positive](narration-guard-false-positive.md) — similar write guard issue, different trigger (narration regex vs SQL classification)
- [Malibu Workout Logging Regressions](malibu-workout-logging-regressions.md) — previous write guard fix for workout logging

## Key Files

- `packages/discord/src/agent-worker-bridge.ts:68-77` — `isReadOnlySql()` (the bug)
- `packages/discord/src/worker-report.ts:71-189` — write outcome verification
- `packages/discord/src/deterministic-runtime.ts:188-202` — warning emission
- `agents/skills/workout-logging.md:123-145` — close session SQL patterns
