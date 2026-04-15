# Project: Deterministic Fast-Path Rollback Initiative

**Date:** 2026-04-15
**Priority:** Urgent
**Linear:** Deterministic Fast-Path Rollback Initiative

## Problem

The deterministic tool handling overhaul replaced flexible LLM reasoning with rigid code paths. The result: 13 user-facing bugs in a single day of normal usage. Every agent feels broken because the system handles edge cases poorly.

### Symptom inventory (2026-04-14 to 2026-04-15)

| # | Failure | Root cause |
|---|---|---|
| 1 | Workout tracker can't find routines | Missing tool scoping for workout intents |
| 2 | Health report is a one-liner | Direct fast-path bypasses LLM reasoning |
| 3 | Watson runs data query when asked about workflow implementation | Classifier routes planning as action intent |
| 4 | Freeze dried apples not logged | Unit conversion fails on "1 package" |
| 5 | White rice not logged | Unit conversion fails on "2 tablespoons" |
| 6 | "Ok. Try adding..." blocked | Regex bypass catches action requests |
| 7 | "want to try adding that rice?" blocked | Follow-up bypass catches action requests |
| 8 | Reimbursement receipts rejected | Wrong evidence format (email screenshots vs PDFs) |
| 9 | Watson claims 6 unsubmitted tips | Stale Obsidian data not cross-referenced with Ramp |
| 10 | Sierra drops messages silently | Processing pipeline failure, no error logged |
| 11 | Malibu says "you sent that twice" | False duplicate detection from warm-start context |
| 12 | Subway sandwich logged as 110 cal (not 730) | Restaurant item decomposed into individual ingredients |
| 13 | Watson mega-prompt timeout | 900s too short for multi-step finance operations |

### Common thread

The deterministic system is too aggressive. It handles cases it shouldn't:
- **Nutrition fast-path** decomposes restaurant meals instead of using user-provided calorie counts
- **Intent classifier** forces every message through deterministic routing even when ambiguous
- **Tool allowlists** are too narrow, preventing agents from accessing tools they need
- **Direct executor** produces thin responses that skip LLM reasoning
- **Regex bypass** (now replaced with LLM classification in PR #33) was patching the wrong layer

## Architectural principle

**The deterministic layer should be a thin acceleration for well-defined commands. The LLM should be the default path.**

From `docs/architecture/deterministic-vs-ai-boundaries.md`:
- Deterministic: identification, safety, routing of clear commands
- AI/LLM: reasoning, interpretation, disambiguation, complex tasks

## Scope

### Phase 1: Audit which fast-paths actually help vs hurt

For every intent in `wellness-direct-step-executor.ts` and `deterministic-worker-fast-path.ts`, evaluate:
1. Does the fast-path produce BETTER results than letting the LLM worker handle it?
2. What edge cases does the fast-path fail on?
3. Should this intent use the fast-path, the full LLM worker, or a hybrid?

Expected outcome: most nutrition intents should NOT use the fast-path. Simple lookups and single-item logging might benefit. Multi-item, restaurant, recipe, and modification flows should go to the LLM.

### Phase 2: Disable fast-paths that hurt

Remove intents from `wellness-direct-step-executor.ts` that produce worse results than the LLM worker. Keep only the ones that are genuinely better AND don't break on edge cases.

Already removed in this session:
- `health.trend_analysis` (PR #24 — one-liner vs full report)

Candidates for removal:
- `nutrition.log_food` (decomposition failures, unit conversion failures, restaurant items)
- `nutrition.day_summary` (may be fine — evaluate)
- Other wellness intents (evaluate each)

### Phase 3: Make the LLM worker the default

Ensure that when the fast-path is disabled for an intent, the full LLM worker handles it correctly:
- Worker has proper tool access
- Conversation context is preserved
- Response quality is acceptable
- No silent failures

### Phase 4: Harden what remains deterministic

For intents that DO stay on the fast-path:
- Add comprehensive test coverage
- Test edge cases (volume units, restaurant items, modifications)
- Ensure graceful fallback to LLM when the fast-path can't handle something

### Phase 5: Address memory/context issues

Separate from the deterministic rollback but surfaced by it:
- False duplicate detection (Malibu claims repeated messages)
- Stale warm-start context
- Sierra silent message drops

## What stays deterministic

These intents are well-suited for deterministic handling:
- Clear single-turn commands with structured inputs (what time is it, check email)
- Intent classification routing (the LLM classifier from PR #33)
- Tool scoping and safety gates
- Finance reimbursement workflow (structured, well-defined steps)

## Success criteria

- User can log food (including restaurant items, volume quantities, packages) without failures
- Agents respond conversationally to follow-ups and planning questions
- No silent message drops
- No false duplicate detection
- Complex queries produce detailed responses, not one-liners
