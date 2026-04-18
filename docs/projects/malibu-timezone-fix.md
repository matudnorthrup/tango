# Malibu Timezone Fix

## Status: SHIPPED (2026-04-17)

## Problem

Stakeholder reports Malibu returning weird data from workouts and activities — suspected timezone issue.

## Root Cause

**Confirmed.** Postgres timezone is set to UTC. Three places use UTC date instead of local (Pacific) date:

### 1. Workout skill (`CURRENT_DATE` in SQL examples)

`workout-logging.md` and `workout-sql.md` use `CURRENT_DATE` for:
- Creating new workout sessions: `INSERT INTO workouts (date, ...) SELECT CURRENT_DATE, ...`
- Date range queries: `WHERE w.date >= CURRENT_DATE - INTERVAL '30 days'`

Since Postgres runs in UTC, `CURRENT_DATE` returns the UTC date. After 5 PM PDT (midnight UTC), this flips to the **next day**. Result: evening workouts get stored with tomorrow's date.

**Two existing workouts have wrong dates:**

| Workout | Stored Date | Actual Local Date | Error |
|---------|-----------|------------------|-------|
| 28 | 2026-04-07 | 2026-04-06 | +1 day |
| 27 | 2026-04-01 | 2026-03-31 | +1 day |

Both were evening workouts after 5 PM PDT.

### 2. Workout tool (INSERT examples in tool doc)

`workout-sql.md` line 100: `SELECT CURRENT_DATE, wr.workout_type, wr.id` — same UTC issue.

### 3. Health query tool (JS date default)

`wellness-agent-tools.ts:592`: `new Date().toISOString().slice(0, 10)` — returns UTC date, not local. When the `date` command is called without an explicit date after 5 PM PDT, it queries the wrong day.

### What's NOT affected

- `started_at` and `ended_at` columns use `timestamptz` — stores the actual UTC moment correctly
- Explicit date parameters from the user (e.g., "what did I do on April 10?") work fine
- Workouts started before 5 PM PDT have correct dates (UTC date = Pacific date)

## Proposed Fix

### Prompt changes (no build needed):

**`workout-logging.md`** and **`workout-sql.md`**: Replace all `CURRENT_DATE` with:
```sql
(now() AT TIME ZONE 'America/Los_Angeles')::date
```

Also add a timezone rule to the skill:
```
- The Postgres server runs in UTC. Always use `(now() AT TIME ZONE 'America/Los_Angeles')::date`
  instead of `CURRENT_DATE` to get the user's local date.
```

### TypeScript change (build + restart needed):

**`wellness-agent-tools.ts:592`**: Replace:
```typescript
new Date().toISOString().slice(0, 10)
```
With:
```typescript
new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })
```
(`en-CA` locale produces `YYYY-MM-DD` format)

### Data correction:

Fix 2 misdated workout records:
```sql
UPDATE workouts SET date = '2026-04-06' WHERE id = 28;
UPDATE workouts SET date = '2026-03-31' WHERE id = 27;
```

## Scope

- 2 prompt files (workout-logging.md, workout-sql.md)
- 1 TypeScript file (wellness-agent-tools.ts) — requires build + restart
- 2 DB records to correct
- Note: hardcoded to America/Los_Angeles; if multi-timezone support is needed later, this should come from user config

## Linear

- Project: Malibu Timezone Fix
- Issues: DEV-31 (Discovery, Done), DEV-32–34 (Implementation), DEV-35 (Validation)
