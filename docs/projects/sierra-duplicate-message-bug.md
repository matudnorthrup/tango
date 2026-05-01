# Sierra Duplicate Message Detection Bug

## Status: Deployed — Awaiting Live Validation

**Shipped:** 2026-04-18
**Commit:** f3608be (merged to main, rebuilt, bot restarted)
**Branch:** feature/fix-duplicate-message-retry (deleted after merge)

## Problem

Agents (Sierra, Malibu — likely all agents) falsely tell users their message "came through twice" when it did not. The agent references specific response content it claims to have already provided, but no such prior response exists.

## Root Cause

**The narrated dispatch retry mechanism in `turn-executor.ts` resumes the first attempt's provider session, sending the user's message to Claude a second time.**

### Detailed flow

1. User sends a message (e.g., Sierra receives "My son had a discouraging day at basketball...")
2. Claude generates a full, correct response — BUT the response matches the `looksLikeNarratedDispatch()` pattern (e.g., "Let me grab that" or "Checking on that" language)
3. The turn executor detects this and triggers a retry
4. **BUG:** The retry code builds `retryContinuity` that includes the first attempt's `providerSessionId`:
   ```typescript
   const retryContinuity = { ...continuityByProvider };
   if (response1.providerSessionId) {
     retryContinuity[phase1ProviderName] = response1.providerSessionId;
   }
   ```
5. This gets passed to `generateWithFailover()`, which sees the session ID and uses `--resume` instead of warm-start
6. Claude's resumed session already has: `user message → Claude's first response`
7. The retry sends the same user message as a new turn
8. Claude now sees: `user message → response → user message (again)` and says "came through twice"

### Affected code

- `packages/discord/src/turn-executor.ts` lines 1805–1807 (narrated dispatch retry)
- `packages/discord/src/turn-executor.ts` lines 1745–1748 (conversational follow-up retry)

### Evidence

Both incidents share the same telemetry pattern:
- `attemptCount: 2, attemptedRetry: true, attemptErrors: []` (two successful attempts, no errors — not a crash retry)
- `warmStartUsed: true` for the overall turn (warm-start was used on the initial attempt since no provider session existed)
- Fresh provider session IDs (confirming no pre-existing continuity)

**Sierra incident (2026-04-19 02:32):**
- Session: `topic:03004e75-...` (Growth Mindset thread)
- Message 1946: first message in session, unique content
- Response 1947: "Looks like this came through twice — I just answered this one above!"
- Model run 1253: `attemptCount: 2, attemptErrors: [], orchestratorContinuityMode: "stateless"`

**Malibu incident (2026-04-15 19:52):**
- Session: `project:wellness`
- Message 1683: unique content about recovery/exercise
- Response 1684: "looks like you sent that one twice"
- Model run 1081: `attemptCount: 2, attemptErrors: [], warmStartContextChars: 20568`

### Why this didn't surface before

The previous fix (commit 84fcc4e) addressed a different duplicate detection issue — supplemental channel messages in warm-start context causing duplicates. That fix is working correctly. This bug is in the turn executor retry logic, which is a separate code path.

## Proposed Fix

**Don't pass the first attempt's provider session ID on narrated dispatch / conversational follow-up retries.** Instead, use empty continuity and pass the warm-start prompt.

### Changes in `turn-executor.ts`:

**Narrated dispatch retry (~line 1805):**
```typescript
// Before (BUG):
const retryContinuity = { ...continuityByProvider };
if (response1.providerSessionId) {
    retryContinuity[phase1ProviderName] = response1.providerSessionId;
}
const guardedFailoverResult = await generateWithFailover(
    providerChain,
    { ... },
    dependencies.providerRetryLimit,
    retryContinuity,
    {}
);

// After (FIX):
const guardedFailoverResult = await generateWithFailover(
    providerChain,
    { ... },
    dependencies.providerRetryLimit,
    {},  // Fresh session — do not resume first attempt
    { warmStartPrompt: effectiveWarmStartPrompt }
);
```

**Conversational follow-up retry (~line 1745):**
Same pattern — replace `retryContinuity` with `{}` and pass warm-start prompt.

### Why this is safe

- The retry system prompt (`NARRATED_DISPATCH_RETRY_SYSTEM_PROMPT`) already provides adequate instruction ("answer directly, don't narrate dispatch")
- Warm-start provides sufficient conversation context for the retry to understand the request
- The worker synthesis retry (line 1950) already uses this pattern (empty continuity `{}`) and works correctly
- Claude doesn't need to "see its mistake" from the first attempt — it just needs clearer instructions

### Tests to add

- Unit test: narrated dispatch retry should NOT pass provider session ID from first attempt
- Unit test: conversational follow-up retry should NOT pass provider session ID from first attempt
- Verify both retries pass warm-start prompt in options

## Key Files

- `packages/discord/src/turn-executor.ts` — retry logic with the bug
- `packages/discord/src/provider-failover.ts` — `failoverWithRetry` where `--resume` is triggered
- `packages/discord/src/channel-surface-context.ts` — warm-start dedup (not the issue; working correctly)
- `packages/core/src/provider.ts` — Claude CLI args builder (`--resume` flag)
