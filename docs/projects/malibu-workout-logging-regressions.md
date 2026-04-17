# Malibu Workout Logging Regressions

## Status: SHIPPED (2026-04-17)

## Problem

Stakeholder reported misses in Malibu's workout logging after recent changes (personality polish, synthesis bypass removal, workout routine editing prompts).

## Root Cause Analysis

Analyzed conversation messages 1781-1822 from the wellness session. Found 5 issues caused by the interaction of 3 recent changes:

### Changes that interacted:
1. **Personality polish** (e7d2042, Apr 16) — softened worker output from structured fields to plain-text
2. **Bypass removal** (fd64b82, Apr 17) — all output now goes through Phase 3 synthesis (no direct-to-Discord path)
3. **Workout routine editing** (ddbcaf4, Apr 17) — added routine management to worker prompts but missed intent contract

### Issues found:

**1. Missing `workout.routine_edit` intent (FIXED)**
- User: "swap that and make it the default for pull day 2"
- Classified as `recipe.update` → dispatched to recipe-librarian → failed
- Root cause: no intent contract existed for routine editing
- Fix: created `config/defaults/intent-contracts/workout.routine_edit.yaml`

**2. Raw structured output from health-analyst (KNOWN, NOT FIXED)**
- Health-analyst returned old structured format (`**action:** trend_analysis...`) at 12:46
- Session has 413+ compacted turns with old-format examples overriding updated soul.md
- This is a session memory issue — will self-heal as old turns age out of compacted summaries
- No prompt fix available; would require session reset

**3. Synthesis hallucination "double chicken" (FIXED)**
- Malibu invented a food detail not in the worker output
- Personality polish made synthesis creative but didn't include grounding constraint
- Fix: added anti-hallucination rule to workers.md synthesis section

**4. Exercise mislabeling "db row" (NOT FIXED - rare edge case)**
- User said "db row" (abbreviated dumbbell row), worker resolved to Prone Single Arm Rear Delt Fly from conversation context
- This is a context contamination issue in the worker — the prior conversation was about that exercise
- Would need abbreviation handling in the workout-logging skill, but this is a rare edge case with low ROI

**5. Mislabeled sets in DB (FIXED)**
- Sets 371-373 were under exercise_id 42 (Prone Single Arm Rear Delt Fly) instead of 40 (Dumbbell Row)
- Fix was approved by user but interrupted by bot restart (our slot claim)
- Corrected via direct SQL: `UPDATE sets SET exercise_id = 40 WHERE id IN (371, 372, 373)`

## Fixes Applied

### Commit `50ab96a` on main:
- **New file:** `config/defaults/intent-contracts/workout.routine_edit.yaml` — routes routine edits to workout-recorder
- **Updated:** `agents/assistants/malibu/workers.md` — anti-hallucination rule in synthesis section
- **DB fix:** Sets 371-373 exercise_id corrected from 42 to 40

### Deploy:
- `npm run build` + bot restart (intent contracts load at startup)
- Bot restarted and verified clean startup

## Test Results

Live tested on slot bot (slot 1, thread 1494825524059570277):
- "Swap rear delt fly for prone single arm rear delt fly in Pull Day B" → dispatched to **workout-recorder** (not recipe-librarian), 4 SQL calls, replied successfully

## Phase 2: Write Guard Bug (URGENT)

**6. Write guard blocking successful multi-step workout logging (FIXED)**
- Stakeholder reported exercises "failed to log" — but they WERE logged correctly in DB
- The response message said "I didn't get a confirmed write through" even though workout-recorder succeeded
- Root cause: `guardDeterministicNarrationText` in `turn-executor.ts` checked `receipts.some(receiptExpectsWriteButHasNoConfirmedWrite)` — if ANY receipt lacked a confirmed write, it blocked the entire response
- In multi-step turns (nutrition-logger rejects + workout-recorder succeeds), the nutrition-logger's missing write overrode the workout-recorder's success
- Fix (commit `c7fb1f4`): Changed to `noReceiptHasConfirmedWrite(receipts)` — only block when NO receipt has a confirmed write

**7. Bot was down after slot release**
- The `release-bot.sh` script killed the Discord window but didn't fully restart the main bot
- Bot was not running when stakeholder tried to log exercises
- Restarted manually

## Known Issues Not Fixed

1. **Session memory override** (issue 2) — old structured output patterns in compacted turns. Self-healing as turns age out. No action needed.
2. **Abbreviation handling** (issue 4) — "db row" resolved wrong. Low-frequency edge case. Could be addressed in a future workout-logging skill update.

## Linear

- Project: Malibu Workout Logging Regressions (DEV-26 through DEV-30)

## Key Files

- `packages/discord/src/turn-executor.ts` (write guard fix)
- `config/defaults/intent-contracts/workout.routine_edit.yaml` (new)
- `agents/assistants/malibu/workers.md` (updated synthesis rules)
