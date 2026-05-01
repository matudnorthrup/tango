# Voice Gate Ready Earcon Audit

**Date:** 2025-05-01
**Status:** Research complete — no code changes made

## 1. Earcon Inventory

All earcons are synthesized procedurally in `apps/tango-voice/src/audio/earcons.ts`. No audio files — pure tone generation.

| Earcon | Sound | Duration | Purpose |
|--------|-------|----------|---------|
| `listening` | Single high A5 tap (880 Hz) | ~200ms | "Heard you" — confirms utterance captured |
| `acknowledged` | Ascending G4->C5 | ~500ms | "Got it" — confirms action accepted |
| `ready` | Ascending E5->G5->C6 charge refrain | ~700ms | "Your turn!" — gate open, speak now |
| `error` | Descending E4->C4 | ~450ms | "Didn't understand" |
| `timeout-warning` | Tick-tock clock (4 alternating knocks) | ~700ms | "Time running out" |
| `cancelled` | Descending G4->E4->C4 | ~600ms | "Flow ended / winding down" |
| `question` | Rising C5->E5 | ~320ms | "Confirm?" — after route confirmation prompt |
| `busy` | Low C4 hum | ~300ms | "Heard you but busy" |
| `gate-closed` | Single soft A4 tap | ~250ms | "Gate shut" — gated mode, not listening |
| `paused` | Descending C5->G4 | ~400ms | "Paused" |
| `resumed` | Ascending G4->C5 | ~400ms | "Resumed" |
| `still-listening` | Low overlapping C3+Eb3 bloom | ~1.2s | "I'm still here" — indicate capture nudge |
| `nudge` | Single F5 bell | ~900ms | "Something finished" — background response ready |
| **waiting-tone** | Two G4 bell strikes + echo trail + silence | ~3s/cycle | Processing loop (separate from earcons: `waiting-sound.ts`) |

Earcons play via `DiscordAudioPlayer.playEarcon()` (`audio-player.ts:193`). A configurable minimum gap (`EARCON_MIN_GAP_MS`, default 500ms) prevents overlap.

## 2. Gate-Open Triggers and Ready Earcon Analysis

The `ready` earcon specifically plays via two methods:
- `playReadyEarcon()` (async, line ~7291) — opens 5s gate grace window
- `playReadyEarconSync()` (fire-and-forget, line ~7297) — same but non-blocking

### V1 State Machine (active — `PipelineStateMachine`)

The V1 state machine does NOT directly emit the `ready` earcon. It only emits `cancelled`, `error`, and `timeout-warning` via `TransitionEffect`. The `ready` earcon is played by the pipeline logic itself.

### V2 State Machine (defined but NOT wired into VoicePipeline)

The `V2PipelineStateMachine` in `pipeline-state.ts` has its own earcon logic (e.g., `ready` on `INTERRUPT_WAKE` for indicate mode at line 771), but it is **not instantiated** anywhere in `voice-pipeline.ts`. The V2 SM is currently unused code.

### Complete Map of Ready Earcon Triggers

| # | Trigger | Code Location | Earcon | Gate Grace? | Details |
|---|---------|--------------|--------|-------------|---------|
| 1 | **Wake word detected (wake-check)** | `voice-pipeline.ts:5452-5458` | `ready` (sync) | Yes (15s prompt grace) | User says "Tango" alone. Pipeline plays `listening` upstream, then `ready` via `handleWakeCheck()`. Correct behavior. |
| 2 | **Indicate capture start (wake-check in indicate mode)** | `voice-pipeline.ts:2525-2527` | `ready` (sync) | Yes (5s gate grace) | User says "Tango" to start indicate capture. Ready cue signals "go ahead and speak." Correct. |
| 3 | **After agent response completes (wait mode)** | `voice-pipeline.ts:4164-4165` | `ready` | Yes (5s gate grace) | `deliverWaitResponse()` — after speaking the agent's response. Signals "your turn to reply." Correct. |
| 4 | **After agent response completes (queue fallback)** | `voice-pipeline.ts:4536-4537` | `ready` | Yes | Same pattern in fallback dispatch path. Correct. |
| 5 | **After reading queued ready item** | `voice-pipeline.ts:4765-4766` | `ready` | Yes | After reading a queued response to the user. Correct. |
| 6 | **Queue dispatch confirmed** | `voice-pipeline.ts:4586-4589` | `ready` | Yes | After "Queued to [channel]" confirmation + inbox status. Correct. |
| 7 | **Queue choice: already dispatched** | `voice-pipeline.ts:4726-4729` | `ready` | Yes | After confirming a speculative queue item. Correct. |
| 8 | **Indicate capture: cancel intent** | `voice-pipeline.ts:1277-1279` | `ready` | Yes (5s gate grace) | User says "Tango cancel" during indicate capture. Speaks "Cancelled." then plays ready. **Questionable** — see below. |
| 9 | **Indicate capture: empty dismiss** | `voice-pipeline.ts:1289-1293` | `ready` | Yes | User dismisses but no content captured. Correct — signals ready for new input. |
| 10 | **Indicate capture: empty close** | `voice-pipeline.ts:1305-1308`, `1319-1323` | `ready` | Yes | Close word detected but no content. Correct. |
| 11 | **New post flow: forum selected** | `voice-pipeline.ts:3195-3197` | `ready` | Yes | After acknowledging forum selection, prompts for title. Correct. |
| 12 | **Unrecognized input in AWAITING state** | `voice-pipeline.ts:3495-3497` | `ready` | Yes | Channel selection reprompt. After error earcon + reprompt text. Correct. |
| 13 | **Switch choice: read** | `voice-pipeline.ts:4889-4890` | `ready` | Yes | After reading back the last message. Correct. |
| 14 | **Switch choice: prompt** | `voice-pipeline.ts:4893-4897` | `ready` (sync) | Yes (15s prompt grace) | User chose "prompt" — skip reading. Ready signals "go ahead." Correct. |
| 15 | **Unrecognized switch choice** | `voice-pipeline.ts:4922-4924` | `ready` | Yes | Reprompt after error. Correct. |
| 16 | **Endpoint mode changed** | `voice-pipeline.ts:5449` | `ready` | Yes | After confirming mode change. Correct. |
| 17 | **What's up command** | `voice-pipeline.ts:5539` | `ready` | Yes | After speaking status summary. Correct. |

## 3. Specific Scenarios Investigated

### a. "Tango cancel" — ready earcon after cancel

**The reported bug.** Two distinct code paths:

1. **"Tango cancel" as a voice command (pause type):** The interrupt layer (`interrupt-layer.ts:83-85`) matches `CANCEL_PATTERN` when wake-prefixed, emitting `interrupt:cancel`. The pipeline's `parseVoiceCommand()` maps this to `{ type: 'pause' }` (`voice-commands.ts:332`). The `handlePause()` method (`voice-pipeline.ts:5461-5468`) plays the `paused` earcon (descending C5->G4). **No ready earcon plays here.** However, the `listening` earcon plays *before* the command is identified (line 2538-2539), so the sequence is: `listening` -> `paused`. This is correct — `listening` confirms receipt, `paused` confirms action.

2. **"Tango cancel" during indicate capture:** `consumeIndicateCaptureUtterance()` (line 1276-1280) catches the cancel intent, speaks "Cancelled.", then plays the `ready` earcon. **This is the problematic path.** The user cancelled, so hearing "Your turn!" immediately after "Cancelled." is confusing. The user's intent was to stop, not to be re-prompted.

   **Recommendation:** Suppress the ready earcon after cancel in indicate capture. Play `cancelled` earcon instead (or nothing). The user can re-engage with a fresh wake word.

### b. After agent response completes

The `deliverWaitResponse()` (line 4151-4177) plays `ready` after speaking the agent's response. This **makes sense** — it's a conversational handoff ("the agent answered, now it's your turn").

However, if the user has already moved on (e.g., they queued the request and walked away), the ready earcon plays to silence. This is harmless but slightly wasteful. No change recommended — the gate-closed cue will follow after 5s if they don't speak.

### c. Wake word false positives (Whisper hallucination)

If Whisper hallucinates a wake word, the pipeline will:
1. Play `listening` (line 2538-2539)
2. Classify as `wake-check` command
3. Play `ready` via `handleWakeCheck()` (line 5452-5458)

**This does result in a spurious ready earcon.** However, the false-positive mitigation is upstream (STT confidence, VAD thresholds). The pipeline correctly processes what it receives. The ready earcon here is consistent — if the system thinks it heard a wake word, it should signal readiness.

**Recommendation:** No change to earcon logic. False positives are an STT problem, not an earcon problem.

### d. Indicate mode — gate opens for capture

When indicate mode starts (trigger #2), the `ready` earcon plays via `playReadyEarconSync()` at line 2527. This **makes sense** — it tells the user "I'm listening, go ahead and speak your full message."

### e. Read-ready command ("go ahead" / "read it")

`handleReadReady()` (line 5550) reads the queued response then calls `playReadyEarcon()`. The ready earcon **makes sense** — it signals the user can now respond to what they just heard.

### f. Other gate-open scenarios

All other ready earcon triggers (triggers #6-17) follow the pattern: action completed -> ready earcon -> gate grace window. These are all conversational handoffs and are appropriate.

## 4. Non-Ready Earcon Observations

### Listening earcon before commands

The `listening` earcon plays at line 2538 for **every** valid interaction (except `wake-check`). This means commands like "Tango cancel," "Tango pause," etc. all get a `listening` cue before the command executes. This is generally correct (confirms receipt), but creates a rapid sequence: `listening` -> command earcon (e.g., `paused`, `cancelled`). The 500ms minimum gap (`EARCON_MIN_GAP_MS`) prevents them from colliding.

### Gate-closed cue timing

The `gate-closed` earcon (line 4281) has sophisticated suppression logic:
- Suppressed during active speech
- Suppressed during recent audio (with retry up to max deferral)
- Two-phase: preclose -> holdoff delay -> actual play
This appears well-designed.

### Nudge earcon collision avoidance

The nudge earcon (line 6948) checks `isPlayingAnyEarcon()` and skips if another earcon is already playing (line 6944). Good collision avoidance.

## 5. Recommendation Table

| # | Trigger | Earcon Plays? | Should It? | Recommendation |
|---|---------|--------------|------------|----------------|
| 1 | Wake word detected (bare "Tango") | `listening` then `ready` | Yes | Keep — correct handshake |
| 2 | Indicate capture start | `ready` | Yes | Keep — signals "go ahead" |
| 3 | Agent response delivered (wait mode) | `ready` | Yes | Keep — conversational handoff |
| 4 | Queue dispatch confirmed | `ready` | Yes | Keep — confirms + invites next |
| 5 | Queued ready item read | `ready` | Yes | Keep |
| 6 | New post: forum selected | `ready` | Yes | Keep — prompts for title |
| 7 | AWAITING reprompt (unrecognized) | `error` then `ready` | Yes | Keep — error + retry |
| 8 | Switch choice: read | `ready` | Yes | Keep |
| 9 | Switch choice: prompt | `ready` | Yes | Keep |
| 10 | Endpoint mode changed | `ready` | Yes | Keep |
| 11 | What's up summary done | `ready` | Yes | Keep |
| **12** | **Indicate cancel ("Tango cancel")** | **`listening` then spoken "Cancelled." then `ready`** | **No** | **Suppress ready; play `cancelled` earcon instead. User's intent is to stop, not continue.** |
| 13 | Indicate empty dismiss | `ready` | Marginal | Could suppress — user dismissed with no content. But "ready for new input" is also valid. Keep. |
| 14 | Indicate empty close | `ready` | Marginal | Same as #13. Keep. |
| 15 | Whisper wake false positive | `listening` then `ready` | N/A | Correct for valid wake; false positives are STT issue |

## 6. Additional UX Issues Noticed

1. **Rapid earcon sequences:** Commands like "Tango pause" produce `listening` (200ms) -> gap (500ms) -> `paused` (400ms) = ~1.1s of audio cues. This is borderline — consider whether `listening` should be suppressed for immediately-resolved commands where the command earcon itself confirms receipt.

2. **Ready earcon after spoken cancellation in indicate mode (the bug):** The sequence is `listening` -> TTS "Cancelled." -> `ready` (700ms). Three audio events for a cancel action. Should be `listening` -> `cancelled` earcon only.

3. **Still-listening nudge during indicate:** The `still-listening` earcon (line 1173) correctly checks `isPlayingAnyEarcon()` before playing. Good.

4. **V2 state machine dead code:** `V2PipelineStateMachine` in `pipeline-state.ts:620-1065` is fully implemented with its own earcon logic (including `ready` on indicate-mode wake at line 771) but is never instantiated. If V2 migration is planned, its earcon handling should be reconciled with this audit.

## 7. Summary

The ready earcon system is well-designed overall. The **one clear bug** is:

> **Indicate cancel plays `ready` after "Cancelled."** (`voice-pipeline.ts:1279`)

Fix: Replace `await this.playReadyEarcon()` with playing the `cancelled` earcon (or nothing — the spoken "Cancelled." already confirms the action). Do not open a gate grace window after cancel.

All other ready earcon triggers are appropriate conversational handoffs. The gate-closed cue suppression logic is sophisticated and correct. The earcon gap enforcement prevents collisions.
