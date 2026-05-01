# Voice Queue Mode Wake Word Fix

**Status:** Implementation
**Linear:** [Voice Queue Mode Wake Word Fix](https://linear.app/seaside-hq/project/voice-queue-mode-wake-word-fix-26d197dbb74a)
**Issues:** TGO-362 through TGO-368

## Problem

Wake commands like "Hello Juliet" and "Hello Watson" are rejected by the voice gate with "no bare command match in queue mode." The pipeline appears stuck — wake phrases don't work, and conversational close phrases ("thank you", "bye") are also rejected.

## Root Cause

**Primary:** `extractNamedWakeWord()` in `packages/voice/src/address-routing.ts` only detects wake words in three positions:
1. At the start of the transcript (`^(?:hey|hello),?\s+NAME\b`)
2. After a single filler word (`^(and|so|okay|oh|um|uh|well|like|but|now|of)`)
3. At the start of a sentence-boundary segment (split on `.!?\n`)

Whisper STT frequently produces transcripts with preamble text before the wake phrase, separated by commas — e.g., `"testing, hello, Juliet."`. Commas don't create sentence boundaries in the current splitter, so the wake word is never found.

**Secondary:** `downgradeWeakAddress()` in `voice-pipeline.ts` checks for greeting prefix (`^(?:hey|hello)...`) anchored to the START of the raw transcript. When `extractNamedWakeWord` returns a mid-transcript match, the `ResolvedVoiceAddress.transcript` field has the preamble stripped (starting from the greeting), but `downgradeWeakAddress` checks the raw transcript and fails the `^` anchor.

**Not a regression from recent changes.** The gating logic and wake word detection code haven't been modified since initial release. The recent changes (indicate timeout 20s->45s in commit 99620ac, Victor bridge in ce06893, voice formatting in 1bf7e40) don't touch the wake word or gating paths. However, the longer indicate timeout (45s) may make the pipeline feel more "stuck" — the nudge loop takes longer to signal the user.

## Evidence

```
Whisper STT: " testing, hello, Juliet.
Gated: discarded " testing, hello, Juliet." (no bare command match in queue mode)
Failed-wake guard: emitting error earcon

Whisper STT: " hello, victor.
Switched to ad-hoc channel: #victor / type=0 (50 history messages)
```

"hello, victor" worked because it was at the transcript start — `extractNamedWakeWord` matched it directly. "testing, hello, Juliet" failed because "testing," preamble broke all three detection paths.

## Fix Plan

### 1. extractNamedWakeWord fallback scan (`packages/voice/src/address-routing.ts`)

After the existing start-match and sentence-segment checks fail, add a non-anchored scan for `(?:hey|hello),?\s+NAME\b` anywhere in the transcript. Return `{ matchedName, transcript: text-from-match-position }`.

This is safe because:
- The greeting prefix (hey/hello) provides strong intent signal
- `downgradeWeakAddress` provides a second check for ambiguous cases
- Subject references like "Juliet says hello" won't match (name comes before greeting)

### 2. downgradeWeakAddress greeting check (`apps/tango-voice/src/pipeline/voice-pipeline.ts`)

In addition to checking the raw transcript, also check `address.transcript` (which has preamble stripped by `extractNamedWakeWord`) for the greeting prefix. If the address transcript starts with "hello, Juliet", the address should not be downgraded even though the raw transcript starts with "testing,".

### 3. Unit tests (`packages/voice/test/address-routing.test.ts`)

- `"testing, hello, Juliet."` → detects Juliet
- `"oh um hello Watson"` → detects Watson
- `"so, hello, Malibu, how are you?"` → detects Malibu
- `"Juliet says hello to everyone"` → should NOT match as Juliet wake (no greeting prefix before name)

## Key Files

- `packages/voice/src/address-routing.ts` — `extractNamedWakeWord()`, `matchWakeNameAtStart()`
- `apps/tango-voice/src/pipeline/voice-pipeline.ts:349` — `downgradeWeakAddress()`
- `apps/tango-voice/src/pipeline/voice-pipeline.ts:2300` — gate check that produces the error
- `packages/voice/test/address-routing.test.ts` — existing tests
- `apps/tango-voice/src/services/voice-settings.ts` — `indicateTimeoutMs` default

## Not In Scope

- The indicate timeout change (20s→45s) is intentional and separate
- The "thank you"/"bye" rejection in gated queue mode (outside indicate capture) is by design — these only work as close phrases during active indicate capture or grace period
