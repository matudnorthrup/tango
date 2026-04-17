# Malibu Personality & Output Polish

**Status:** Shipped
**Linear:** [Malibu Personality & Output Polish](https://linear.app/latitudegames/project/malibu-personality-and-output-polish-2860bdbd4a30)
**Date:** 2026-04-16 (spec), 2026-04-17 (shipped)

## Problem

Malibu's Discord output reads like a status report, not a conversation with a laid-back surfer wellness coach. Users see things like:

- "Logged protein yogurt bowl for breakfast — 6 ingredients, ~452 cal, 38g protein. Day total: 452 cal, 38g protein."
- Structured field dumps with `action`, `status`, `totals` labels
- Template-fill summaries that sound identical every time regardless of context

The personality described in `soul.md` — California surfer dude, enigmatic depth, unconventional phrasing, teasing humor — never makes it into the actual output.

## Root Cause

Three layers are working against the personality:

### 1. Worker output instructions demand structured data

All four worker `soul.md` files end with nearly identical output instructions:

```
## Output
Return structured data with:
- action
- status
- logged / results
- unresolved
- totals
- errors / follow_up
```

This tells workers to return JSON-like structured blobs. The workers are doing exactly what they're told — producing machine-readable output, not human-readable content.

### 2. Malibu's synthesis rules are template-based

`workers.md` lines 86-89 define synthesis as fill-in-the-blank templates:

> "Logged [recipe] for [meal] — [count] ingredients, ~[cal] cal, [protein]g protein. Day total: [cal] cal, [protein]g protein."

This guarantees every meal log response sounds the same — robotic, formulaic, zero personality. The template overrides whatever voice Malibu's soul.md establishes.

### 3. Malibu's soul.md has no output formatting guidance

`soul.md` is only 18 lines. It describes the personality beautifully but says nothing about how to format responses, how to synthesize worker results in-character, or what "Malibu-sounding" output actually looks like. The personality section is disconnected from the output pipeline.

### The gap

```
soul.md says: "surfer dude, unconventional, teasing, enigmatic"
workers.md says: "Logged [X] for [Y] — [N] ingredients, ~[cal] cal"
Result: template wins, personality loses
```

## Proposed Fix

Three targeted changes to close the gap. All are prompt file edits, no TypeScript.

### Change 1: Expand Malibu's `soul.md` with output voice guidance

Add a `## Voice in Action` section with concrete examples of how Malibu sounds when reporting different types of results. This bridges the personality description to actual output behavior.

**What to add:**
- Examples of meal log responses in Malibu's voice (not templates — demonstrations of tone)
- Examples of health/sleep summaries in voice
- Examples of workout log responses in voice
- Anti-patterns: "never sound like a database receipt", "never use the same phrasing twice in a row"
- Guidance on when to tease, when to encourage, when to be brief vs. elaborate

### Change 2: Replace template-based synthesis rules in `workers.md`

Replace the current `## Synthesis Rules` section with personality-driven guidance that tells Malibu *how to think about* synthesis rather than giving it fill-in-the-blank templates.

**Current (remove):**
```
- For meal logs: "Logged [recipe] for [meal] — [count] ingredients, ~[cal] cal, [protein]g protein..."
```

**Proposed (replace with):**
- Lead with the vibe, not the data: "You just logged food — what does Malibu care about? The protein hit, the calorie budget impact, whether they're crushing it or need to course-correct for dinner."
- Always include the key numbers (calories, protein, day totals) but weave them into natural speech, not a template
- Vary your phrasing — never say the same thing twice in a row
- For health reads: pick the most interesting number and riff on it. Don't recite every metric.
- For workouts: celebrate PRs, note volume trends, keep it coaching-flavored
- Keep it to 1-3 sentences (this rule stays — it's good)
- Do not echo raw JSON (this rule stays)

### Change 3: Soften worker output instructions

The workers don't need to change dramatically — they're internal. But the rigid "return structured data with: action, status, logged..." instruction pushes them toward JSON-like output that's harder for Malibu to synthesize naturally.

**Proposed change for each worker soul.md:**

Replace:
```
## Output
Return structured data with:
- action
- status
- ...
```

With:
```
## Output
Return a concise plain-text summary with the key facts the assistant needs to compose a user-facing reply:
- What happened (what was logged, queried, created)
- Key numbers (calories, macros, weights, reps, metrics)
- Anything that went wrong or needs follow-up
Keep it compact. Do not address the user directly.
```

This preserves the "don't address the user" rule and the "compact output" intent, but shifts from field-list structure to natural summary. Malibu gets the same data in a form that's easier to rephrase in personality.

## Files to Change

| File | Change |
|------|--------|
| `agents/assistants/malibu/soul.md` | Add `## Voice in Action` section with examples and anti-patterns |
| `agents/assistants/malibu/workers.md` | Replace `## Synthesis Rules` with personality-driven guidance |
| `agents/workers/nutrition-logger/soul.md` | Soften output format instructions |
| `agents/workers/workout-recorder/soul.md` | Soften output format instructions |
| `agents/workers/health-analyst/soul.md` | Soften output format instructions |
| `agents/workers/recipe-librarian/soul.md` | Soften output format instructions |

## What NOT to change

- **No functionality changes.** Workers still do the same lookups, logging, and queries.
- **No changes to worker rules or workflows.** The lookup cascades, safety rules, and tool usage stay identical.
- **No changes to shared AGENTS.md or RULES.md.** The generic synthesis rules there are fine; the problem is Malibu-specific.

## Phase 2: Code Fix (discovered post-initial-ship)

Initial prompt-only changes were insufficient. Investigation revealed a **fourth root cause**: a performance optimization in `turn-executor.ts` that bypassed Phase 3 synthesis (agent voice) when worker output "looked deliverable" (non-JSON, well-formatted markdown). This sent raw worker output directly to Discord without the agent ever touching it.

### Change 4: Remove direct-worker-text bypass (DEV-20)

Removed both bypass paths so ALL worker results go through Phase 3 synthesis:
- **Deterministic path** (`extractDeliverableWorkerTextsFromReceipts` in turn-executor.ts ~line 1537)
- **Orchestrator path** (`extractDeliverableWorkerTextFromReport` in turn-executor.ts ~line 2056)
- Deleted `deliverable-worker-text.ts` (dead code after bypass removal)
- Simplified `scheduled-turn-response.ts` to use synthesized response directly
- Removed `directResponse` flag from `DeterministicTurnState`

**Trade-off:** ~20-30% latency increase on 10-15% of turns (one extra LLM call). Accepted because agent personality IS the product — skipping synthesis to save latency was the wrong trade for every agent, not just Malibu.

## Files Changed

| File | Change |
|------|--------|
| `agents/assistants/malibu/soul.md` | Add `## Voice in Action` section with examples and anti-patterns |
| `agents/assistants/malibu/workers.md` | Replace `## Synthesis Rules` with personality-driven guidance |
| `agents/workers/nutrition-logger/soul.md` | Soften output format instructions |
| `agents/workers/workout-recorder/soul.md` | Soften output format instructions |
| `agents/workers/health-analyst/soul.md` | Soften output format instructions |
| `agents/workers/recipe-librarian/soul.md` | Soften output format instructions |
| `packages/discord/src/turn-executor.ts` | Remove both direct-worker-text bypass paths |
| `packages/discord/src/deliverable-worker-text.ts` | Deleted (dead code) |
| `packages/discord/src/scheduled-turn-response.ts` | Simplified — use synthesized response directly |
| `packages/discord/src/deterministic-runtime.ts` | Remove `directResponse` narration flag |

## Risk

Low-moderate. Prompt changes are easily tunable per-file. The code change adds latency but is functionally safe — Phase 3 synthesis was already the normal path for most turns; now it's the only path.

## Test Plan

1. Live test through Discord after deploy
2. Test each worker type:
   - Log a meal → verify response has personality + correct numbers
   - Ask for sleep/health data → verify conversational tone + accurate metrics
   - Log a workout → verify coaching tone + correct sets/weights
   - Ask for a recipe → verify natural response
3. Test edge cases:
   - Unresolved food items → should still be clear something failed, but in voice
   - Evening calorie check-in → budget info delivered conversationally
4. Verify numbers are still accurate (personality shouldn't compromise data correctness)
5. Monitor response latency for regression

## Live Test Results

**Test: "how's my weight looking this week?"**
Response: "Week started a little spicy — you hit 177.4 on Monday — but you've been sliding back down since, sitting at 174.1 this morning. Weekly average lands around 175.2, which is actually running about a pound above your recent trend, so the wave hasn't fully turned yet. Keep the nutrition tight through the weekend and you'll likely see that average come back in line."

Confirmed: Phase 3 synthesis running (log: `[turn-executor] synthesizing completed worker result with a fresh tool-free prompt`). No structured fields, full personality, accurate numbers.

## Known Issues

- Provider failover latency: some responses took 80s+ due to claude-oauth failures, but that's infrastructure, not this change
- All 7 worker soul.md files updated (4 Malibu workers + dev-assistant, personal-assistant, research-assistant). research-coordinator was already in a different format.
