# Silent Message Failures & "Something Went Wrong" Errors

**Status:** Shipped
**Created:** 2026-04-19
**Shipped:** 2026-04-19
**Linear:** https://linear.app/seaside-hq/project/silent-message-failures-and-something-went-wrong-errors-2ee73e79b349
**Commit:** 4a74a3f

## Problem Statement

Two related failure modes reported:
1. Generic "Sorry, something went wrong before I could finish that step" errors across agents — no specifics about what failed
2. Sierra ghost messages in the "Growth Mindset" thread (2026-04-18) — Sierra's side shows messages sent, user never received them

PR #37 (commit `870725e`, 2026-04-16) was supposed to fix "silent message drops" but the ghost messages happened AFTER that fix.

## Discovery Findings

### What PR #37 Actually Fixed

PR #37 addressed a specific scenario: when `handleMessage` threw an unhandled exception inside `enqueueChannelWork`, the error was logged but the user got **no response at all**. The fix:
1. Wrapped `handleMessage` in try/catch to send a visible error reply
2. Added a 300s timeout to `enqueueChannelWork` to prevent stuck tasks from blocking a channel's queue

**This was necessary but insufficient.** PR #37 only catches errors at the outermost layer (handleMessage throws). The ghost message and "something went wrong" issues occur in deeper layers that PR #37 doesn't reach.

### Root Cause Analysis

There are **two distinct failure classes** with different root causes:

---

### Issue 1: "Sorry, something went wrong" Errors

**Three distinct triggers in `turn-executor.ts`:**

| Error Message | Trigger | Location |
|---|---|---|
| "Sorry, something went wrong before I could finish that step." | `guardDeterministicNarrationText` — LLM response contains `<worker-dispatch>` tags or matches narrated-dispatch patterns, but no actual worker dispatch occurred. Guard replaces fabricated "I'm doing it" narration with error. | `turn-executor.ts:1214` |
| "Sorry, something went wrong before I could actually start that worker task." | After retry, LLM still narrates dispatch progress without producing a real `<worker-dispatch>` tag. Repeated narrated dispatch without execution. | `turn-executor.ts:1891` |
| "Sorry, something went wrong processing that request." | Response contains literal `<worker-dispatch` XML tag but both strict and lenient dispatch parsers failed to extract it. Prevents raw XML from reaching user. | `turn-executor.ts:2096` |

**Root cause:** These are all LLM behavior failures — the model narrates what it would do instead of actually producing structured dispatch tags. The guards correctly prevent fabricated status from reaching the user, but the error messages are generic and unhelpful.

**Impact:** User has no idea what failed or why. The response generation worked (LLM returned text), but the text was garbage (narrated intent instead of structured dispatch).

---

### Issue 2: Ghost Messages (Sierra Growth Mindset Thread)

**Four silent failure paths in message delivery:**

#### Path A: Silent null/invalid channel (CRITICAL — `reply-presentation.ts:233-240`)
```typescript
if (!channel?.isSendable() || typeof channel.send !== "function") {
    return { sentChunks: 0, delivery: "bot", ... };  // Silent success with 0 chunks
}
```
- If channel becomes unsendable between message receipt and response delivery, `sendChunked` returns a "success" result with `sentChunks: 0` and no `lastMessageId`
- Caller at `main.ts:6960` records the outbound message in DB with `discordMessageId: null` — looks like a successful turn
- **No error logged. No error sent to user. No dead letter created.**
- This is the cleanest ghost message path: Sierra's DB shows she replied, Discord shows nothing

#### Path B: Uncaught exceptions in webhook-to-bot fallback (`reply-presentation.ts:281-285`)
- When webhook send fails partway through multi-chunk messages, fallback to `channel.send()` has **no try/catch**
- If both webhook AND bot send fail, exception propagates to `handleMessage`'s catch block
- User sees partial response (chunks that succeeded) plus a generic error
- Or if all chunks fail, user sees only the generic error

#### Path C: Uncaught exceptions in pure bot send (`reply-presentation.ts:298-302`)
- Same issue as Path B but for the non-webhook path
- `channel.send()` in a loop with no error handling per chunk

#### Path D: Fire-and-forget voice sync (`main.ts:3724`)
```typescript
void syncVoiceAgentResponseToDiscord(resolvedVoiceSyncChannelId, turnResult.responseText, targetAgent);
```
- Voice responses are synced to Discord text channels via fire-and-forget
- If the sync fails, it logs a warning and moves on — the voice TTS already played
- **Sierra's voice responses would show as "sent" in voice pipeline logs but never appear in Discord text**
- This is the most likely cause of the Growth Mindset ghost messages, since Sierra's logs show all `delivery=webhook` via voice-discord-sync

#### Path E: Delivery failure masked as turn failure (`main.ts:7129-7277`)
- Single try/catch wraps BOTH turn execution AND response delivery
- If turn succeeds but `sendPresentedReply` throws, the catch block can't distinguish the two
- User sees "I hit an error while generating a response" even though the response was ready
- Response is lost; dead letter records the prompt but not the successful response

### Correlation

The "something went wrong" errors (Issue 1) and ghost messages (Issue 2) are **different failure classes**:
- Issue 1 is an LLM behavior failure (narrating instead of dispatching) caught by output guards
- Issue 2 is a delivery infrastructure failure (response generated successfully but lost before/during Discord send)

They share a common symptom (user doesn't get what they expected) but require different fixes.

## Proposed Fixes

### Fix 1: Improve "something went wrong" error specificity
- Add context to the error messages: which worker was being dispatched, what the user asked for
- Log the raw LLM response when narration guards fire, for debugging
- Consider a structured error format: "I tried to dispatch {worker} for '{task}' but the request didn't go through. Please try again."

### Fix 2: Fix silent delivery failures in `reply-presentation.ts`
- **Path A:** When `sentChunks === 0` and channel was unsendable, throw an error or return a clearly-failed result. Caller must handle it.
- **Path B/C:** Wrap `channel.send()` calls in try/catch with per-chunk error tracking. Log partial delivery failures.
- Add a delivery validation check: if `sentChunks === 0` and we expected to send content, that's an error, not a success.

### Fix 3: Make voice-discord-sync await and handle failures (`main.ts:3724`)
- Change from fire-and-forget `void` to `await` with error handling
- If Discord text sync fails, log a structured error and potentially retry once
- Or at minimum: record the sync failure in the DB so ghost messages are detectable

### Fix 4: Separate turn execution from delivery error handling (`main.ts:6903-7277`)
- Nest an inner try/catch around `sendPresentedReply` (line 6960) to catch delivery failures separately
- If delivery fails but turn succeeded: retry delivery, save the response in dead letter for manual recovery, send a specific "response ready but delivery failed" error

## Priority

1. **Fix 2 (silent delivery)** — highest priority, causes invisible data loss
2. **Fix 3 (voice sync)** — likely cause of the specific Sierra incident
3. **Fix 4 (error separation)** — prevents response loss on delivery failure
4. **Fix 1 (error specificity)** — quality of life, helps debugging

## Key Files

- `packages/discord/src/reply-presentation.ts` — message delivery layer
- `packages/discord/src/turn-executor.ts` — narration guards (lines 1202-1226, 1888-1915, 2093-2119)
- `packages/discord/src/main.ts` — handleMessage flow (lines 6903-7277), voice sync (lines 3188-3223, 3724)
