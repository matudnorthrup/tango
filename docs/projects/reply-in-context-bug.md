# Reply-in-Context Failure Mode Bug

**Status:** Shipped (2026-04-20, hotfix)
**Commits:** 6afe84b (initial fix), fce2143 (hotfix — suppression escape hatch)
**Linear:** https://linear.app/seaside-hq/project/reply-in-context-failure-mode-bug-37e35b739065
**Agents:** Watson (original report), Malibu (recurrence)
**Server:** Latitude → History Books category (Watson), Wellness channel (Malibu)

## Hotfix (2026-04-20)

The initial fix missed a second code path. The hardcoded suppression message at turn-executor.ts:1812 ("Sorry, I need to answer that directly from the current conversation context, not start another worker task") was emitted when BOTH conversational follow-up attempts (tools disabled) still produced worker dispatch narration. This happened because the LLM genuinely needed tools (e.g., workout_sql for Malibu) to answer.

**Fix (fce2143):** Instead of emitting the hardcoded error, retry one more time with the original system prompt and tools re-enabled. Also expanded `looksLikeContextConfusion()` regex to match the hardcoded suppression text.

**Live validation:** Malibu workout history queries immediately started working after deploy. Stakeholder's messages got real workout history tables instead of error strings.

## Problem

Watson gives nonsensical responses mentioning something like "it needs to reply in context." Once triggered, the thread becomes stuck in a bad state and is hard to recover.

## Root Cause Analysis

### The Failure Chain

The bug is a **provider session continuity + conversational follow-up interaction**. Here's the sequence:

1. **Watson responds in a thread** — the system saves a Claude provider session ID for the conversation key `project:latitude:watson`.

2. **On the next message in the same thread**, the system loads the persisted provider session ID.

3. **Provider session blocks warm-start context** — In `provider-failover.ts:182-185`, the warm-start prompt is ONLY used when there is NO provider session ID:
   ```typescript
   const shouldWarmStart =
     !!warmStartPrompt &&
     warmStartPrompt.length > 0 &&
     !providerSessionId;  // ← warm-start skipped when session exists
   ```

4. **The intent classifier marks the turn as "conversational"** — The deterministic routing classifier decides the user's message is a conversational follow-up (not a new intent), which triggers the `conversationalTurnBypass` path.

5. **The conversational bypass path injects a system prompt** (turn-executor.ts:151-157) telling the LLM to:
   > "Answer directly from the conversation context and prior turns."
   > "Do not call tools or workers in this step."

6. **But the provider session may be stale or context-poor** — If the session was from a different thread, or if it's aged out, or if the resumed Claude session doesn't contain the thread's conversation history, the LLM has NO context to answer from. It can't use tools (they're disabled), and it has no warm-start context (it was skipped because a session ID existed).

7. **The LLM responds about "context"** — With no actual conversation context available and instructions to "answer from the conversation context," Watson's LLM generates a meta-response about needing to reply in context, because that's literally what its instructions say to do but it can't.

### Why It Gets Stuck

Once this happens, the broken response gets saved as a new outbound message, and a new provider session is saved pointing to this broken conversation. The next message from the user will:
- Load the same (or a new) provider session that includes the broken exchange
- Get classified as conversational again (because the user is probably asking "what?" or trying to recover)
- Hit the same bypass path with the same tool-disabled, context-dependent system prompt
- Generate another nonsensical response

**The thread is now in a self-reinforcing failure loop.** Each broken response makes the next one worse.

### Contributing Factors

1. **Session-level provider continuity, not thread-level** — The conversation key is `sessionId:agentId` (e.g., `project:latitude:watson`). All threads in the Latitude session share a single provider session. A response in one thread can set a session ID that breaks context in another thread.

2. **The stale session normalization is insufficient** — `normalizeProviderContinuityMap` (main.ts:5160-5218) only drops a session if the latest assistant turn's provider doesn't match. It doesn't check whether the session is from the right thread.

3. **The conversational follow-up retry is too aggressive about disabling tools** — When the retry fires (turn-executor.ts:1745-1760), it uses `tools: { mode: "off" }` and empty continuity `{}`. The empty continuity means warm-start WILL be used on the retry, which should help. But the retry only fires if the first attempt tried to dispatch a worker or narrated progress. If the first attempt just generated a garbled "I need context" response, the retry doesn't fire.

4. **No detection pattern for "context confusion" responses** — The system has `looksLikeNarratedDispatch()` and `looksLikeIncompleteWorkerSynthesis()` but no detector for "I can't answer because I lack context" style responses.

## Proposed Fix

### Phase 1: Break the stuck loop (critical)

**Add a "context confusion" detector** to `turn-executor.ts` that catches responses like:
- "reply in context"
- "I don't have the context"
- "I need to see the conversation"
- "I can't answer without context"
- "based on the conversation context" (when the response is < 100 chars)

When detected on the conversational bypass path, retry with:
- Empty provider continuity `{}` (forces warm-start)
- Tools enabled (allows the LLM to actually do work)
- A system prompt that doesn't demand context-only answers

### Phase 2: Fix the root cause

**Make provider session continuity thread-aware.** Options:

**Option A: Thread-scoped conversation keys**
Change `getConversationKey()` to include the Discord channel/thread ID when in a thread. This gives each thread its own provider session.
- Pro: Clean isolation
- Con: Breaks session-level provider continuity for non-thread messages; may increase API costs (more cold starts)

**Option B: Drop provider session when thread changes**
In `normalizeProviderContinuityMap`, also drop the session if the current message's thread ID differs from the thread where the session was last used.
- Pro: Minimal change, falls back to warm-start gracefully
- Con: Requires tracking which thread last used each provider session

**Option C: Always include warm-start alongside provider sessions**
Remove the `!providerSessionId` guard in `provider-failover.ts:185` so warm-start context is always prepended, even when resuming a session.
- Pro: Belt-and-suspenders — even stale sessions get thread context
- Con: Increases prompt size; may confuse the LLM with redundant context if session is valid

**Recommended: Option A (thread-scoped keys) + Phase 1 detector as safety net.**

### Phase 3: Recovery mechanism

Add a `/reset-thread` or automatic recovery that:
- Clears the provider session for the current conversation key
- Forces a fresh warm-start on the next message
- Logs the recovery for diagnostics

## Key Files

- `packages/discord/src/turn-executor.ts` — Turn execution, conversational bypass, retry logic
- `packages/discord/src/provider-failover.ts` — Provider session continuity, warm-start gating
- `packages/discord/src/main.ts:5160-5218` — `normalizeProviderContinuityMap`
- `packages/discord/src/main.ts:5246-5359` — `buildWarmStartContext`
- `packages/discord/src/main.ts:2743-2745` — `getConversationKey` (session:agent, not thread-aware)
- `packages/discord/src/main.ts:6546-6593` — Thread session routing in `handleMessage`
- `packages/discord/src/channel-surface-context.ts` — Channel-scoped message filtering for warm-start
