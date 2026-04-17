# Malibu Workout Routine Editing

## Status: SHIPPED (2026-04-17)

## Problem

When asked to modify a workout routine, Malibu says it can't. Editing workout routines is core to the fitness/wellness domain.

## Root Cause

**Prompt-only gap.** The `workout_sql` tool already has full INSERT/UPDATE access to `workout_routines` and `workout_routine_exercises`. No TypeScript or tool changes needed.

Three prompt files only described logging and querying — none mentioned routine management:

1. **`agents/skills/workout-logging.md`** — covered session logging, set logging, history queries, session closing. No "managing routines" section.
2. **`agents/workers/workout-recorder/soul.md`** — described worker as "track workout sessions, log sets, and query exercise history." No mention of routine CRUD.
3. **`agents/assistants/malibu/workers.md`** — dispatch rule said "workout logging, exercise history queries." Routine editing not listed as a dispatchable task.

## Fix Applied

### File 1: `agents/skills/workout-logging.md`

Added "Managing routines" section with full SQL examples for:
- Creating a routine (INSERT into `workout_routines` + `workout_routine_exercises`)
- Adding exercises (with position management)
- Removing exercises (with position reordering)
- Reordering exercises
- Renaming routines and updating aliases
- Deleting routines (with safety: check for referencing sessions first)

### File 2: `agents/workers/workout-recorder/soul.md`

- Updated description to include "and manage workout routines"
- Updated workflow reference to include routine management

### File 3: `agents/assistants/malibu/workers.md`

- Updated dispatch rule to include "routine management (create, edit, rename, reorder, delete workout routines)"
- Added dispatch example for editing a routine

## Test Results

Live tested on slot bot (slot 1, smoke test thread 1494819934784716870):

1. **Query routine (PASS):** "What exercises are in Push Day A?" → workout-recorder dispatched, 1 SQL call, replied
2. **Edit routine (PASS):** "Add lateral raises to Push Day A as the last exercise" → workout-recorder dispatched, 2 SQL calls (lookup + write, both readOnly=no), replied

## Scope

- **Prompt-only changes** — no TypeScript, no build, no restart needed
- **3 files** changed, commit `ddbcaf4` on main
- **No new tools** required

## Linear

- Project: Malibu Workout Routine Editing (DEV-21 through DEV-25, all Done)

## Key Files

- `agents/skills/workout-logging.md`
- `agents/workers/workout-recorder/soul.md`
- `agents/assistants/malibu/workers.md`
- `agents/tools/workout-sql.md` (reference — no changes needed)
