# Voice Pipeline State Machine

*A product and UX reference for how the voice pipeline manages what it's doing at any moment.*

---

## Overview

The voice pipeline is always in exactly one **state**. The state controls how it reacts to incoming speech, what audio it plays, and what it expects from the user next. Think of it like a traffic light — you can't be green and red at the same time. Every voice interaction moves the pipeline through a defined sequence of states and back to idle.

The authoritative implementation is `PipelineStateMachine` in
`apps/tango-voice/src/pipeline/pipeline-state.ts`, driven by `VoicePipeline`
(`voice-pipeline.ts`). This document covers all ten states, how the pipeline
moves between them, the supervision layers around them (timers, watchdog,
buffered utterances), and the known gaps that remain.

> **History — the V2 rewrite (retired July 2026).** A second machine
> (`V2PipelineStateMachine`, with `InterruptLayer` and a V2 test harness) was
> built as Phase 1–2 of the rewrite described in
> [`../specs/voice-state-machine-v2-design.md`](../specs/voice-state-machine-v2-design.md).
> It was never wired into `VoicePipeline`, and production evolved past its core
> assumptions (grace windows were kept and extended, route confirmation became
> a first-class state, indicate capture gained origin tracking and timeouts).
> The V2 artifacts were removed in July 2026; the spec is retained as a
> retired design document. The V1 machine below is the only state machine.

---

## The States

### 🟢 IDLE
**The pipeline is ready and waiting for you to speak.**

Nothing is happening. No audio is playing, no command is being processed, no response is pending. This is the "home base" state the pipeline always tries to return to.

---

### 🎙️ TRANSCRIBING
**The pipeline heard something and is converting your speech to text.**

This state is entered the moment a voice activity event arrives (the microphone detected someone speaking). The audio is being sent to the speech-to-text (STT) service. The pipeline is waiting for the text version of what was said before doing anything else.

---

### 🧠 PROCESSING
**The pipeline has your words and is figuring out what to do.**

The transcript has arrived. The appropriate agent or handler is now working on a response. This might involve calling an AI, looking something up, or routing to a different channel. New speech that arrives now is **buffered** (up to 3 utterances) and replayed when the pipeline is ready again; a "busy" tone plays.

Note that wait-mode prompt dispatches are fire-and-forget: the machine returns
to IDLE while the LLM works, and `pendingWaitCallback` (a `TransientContext`
flag, not a state) tracks the outstanding response.

---

### 🔊 SPEAKING
**The pipeline is playing audio back to you.**

The system is actively speaking a response through the voice channel.

- **Open (ungated) mode:** new speech stops playback immediately; the
  interrupting audio is buffered and re-processed as soon as playback wraps up.
- **Gated mode:** interrupting speech must contain a wake word (or arrive
  inside a grace window, or while an agent is focused). Non-wake speech is
  discarded and playback continues.

SPEAKING is entered two ways: inline (within `handleUtterance`) and
out-of-band (wait-response delivery, idle auto-read). Both paths drain the
utterance buffer when they finish.

---

### 📋 AWAITING_CHANNEL_SELECTION
**The system asked you to pick a channel and is waiting for your answer.**

*Timeout: 15 seconds (warning tone at 10s)*

The system has presented a list of channels (by number or name) and is listening for your choice. Valid responses are a number, a channel name, or "cancel."

---

### 📬 AWAITING_QUEUE_CHOICE
**The system asked what to do with a message and is waiting for your answer.**

*Timeout: 20 seconds (warning at 15s)*

A prompt has been dispatched speculatively and the system needs to know where the response should go. Valid responses are "send to inbox," "wait here," "silent," or "cancel."

---

### 🔀 AWAITING_SWITCH_CHOICE
**The system switched contexts and is asking what you want to do next.**

*Timeout: 30 seconds (warning at 25s)*

The pipeline switched to a new channel or agent and is asking whether you want to hear the last message, send a new prompt, or cancel.

---

### ✅ AWAITING_ROUTE_CONFIRMATION
**The route classifier found a likely destination and is asking you to confirm.**

*Timeout: 20 seconds (warning at 15s); redirect phase: 8 seconds*

The pipeline detected where a message should be routed (an existing thread, topic, or channel) and is asking you to confirm with "yes" or "no." This state has richer exits than the other awaiting states:

- **Yes** — the route/create is applied, then the original transcript is dispatched there.
- **No / cancel** — enters a short **redirect phase** ("Say route-to to redirect", 8s): a route command redirects, anything else dispatches to the current channel.
- **"Route to X"** at any point overrides the confirmation and redirects.
- **Two unrecognized replies** — auto-dispatches to the fallback channel.
- **Timeout** — the transcript is *not* lost: it is dispatched to the fallback channel.

---

### 📝 NEW_POST_FLOW
**The system is walking you through creating a new forum post, step by step.**

*Timeout: 30 seconds per step (warning at 25s)*

A two-step guided flow (forum → title). Each step has its own 30-second timeout; a step timeout cancels the whole flow and briefly guards against the next utterance being misread as a channel prompt (`newPostTimeoutPromptGuardUntil`). Say "cancel" at any point to exit.

This flow is deprecated in favor of natural-language creation via the route
classifier, but remains wired.

---

### 📥 INBOX_FLOW
**The system is reading through your inbox, item by item.**

*Idle limit: 120 seconds (enforced by the stall watchdog, not machine timers)*

A structured browsing mode where the system reads inbox items aloud and waits for navigation commands ("next," "done," "cancel," topic selection). Unlike the `AWAITING_*` states, `INBOX_FLOW` carries no state-machine timers — browsing is user-paced. Instead, the stall watchdog lets it idle up to the 120-second interaction contract, then expires it as a cancelled flow (cancelled earcon, return channel restored).

---

## State Transition Table

| From State | Trigger / Event | To State | User-visible effect |
|---|---|---|---|
| **IDLE** | Speech detected | TRANSCRIBING | Pipeline begins listening |
| **TRANSCRIBING** | Transcript ready | PROCESSING | STT complete, now working |
| **PROCESSING** | Processing complete | IDLE | Silent completion |
| **PROCESSING** | Speaking started | SPEAKING | Response audio begins |
| **PROCESSING** | New speech arrives | (unchanged, speech buffered) | Busy earcon; audio queued for replay |
| **SPEAKING** | Playback complete | IDLE | Ready earcon; buffered speech replays |
| **SPEAKING** | New speech (open mode) | (unchanged, speech buffered) | Playback stops; busy earcon; replayed after completion |
| **SPEAKING** | New speech (gated, wake word) | TRANSCRIBING | Playback stops; utterance handled |
| **Any** | ENTER_CHANNEL_SELECTION | AWAITING_CHANNEL_SELECTION | Prompts for channel pick |
| **Any** | ENTER_QUEUE_CHOICE | AWAITING_QUEUE_CHOICE | Prompts for queue decision |
| **Any** | ENTER_SWITCH_CHOICE | AWAITING_SWITCH_CHOICE | Prompts for switch decision |
| **Any** | ENTER_ROUTE_CONFIRMATION | AWAITING_ROUTE_CONFIRMATION | Prompts for yes/no confirm |
| **Any** | ENTER_NEW_POST_FLOW | NEW_POST_FLOW (forum step) | Begins post creation |
| **NEW_POST_FLOW** (forum) | Forum chosen (NEW_POST_ADVANCE) | NEW_POST_FLOW (title step) | Advances to title prompt |
| **NEW_POST_FLOW** (title) | Title given, post created | IDLE | Confirmation + ready earcon |
| **Any** | ENTER_INBOX_FLOW | INBOX_FLOW | Begins inbox browsing |
| **INBOX_FLOW** | "Next" (INBOX_ADVANCE / INBOX_JUMP) | INBOX_FLOW (next item) | Advances to next item |
| **INBOX_FLOW** | "Done" / last item | IDLE | Exits inbox, restores channel |
| **Any AWAITING_*** | Utterance received | (unchanged, timers paused) | Listening earcon; timers resume when handled |
| **Any AWAITING_*** | Valid response | IDLE, then handler action | Acknowledged earcon + action |
| **Any AWAITING_*** | Unrecognized response | Same AWAITING state | Error earcon + reprompt; timeout window restarts |
| **Any AWAITING_*** | Warning threshold (5s before timeout) | Same AWAITING state | Warning tone |
| **Any AWAITING_*** | Timeout | IDLE | Cancelled earcon + timeout message (route confirmation additionally dispatches to fallback) |
| **Any** | "Cancel" (CANCEL_FLOW) | IDLE | Cancelled earcon |
| **Any** | RETURN_TO_IDLE | IDLE | Silent reset |

Timeout warnings fire 5 seconds before expiry; windows of 5 seconds or less
skip the warning entirely (e.g. the 8s redirect phase warns at 3s, a 4s window
would not warn at all).

---

## Supervision Layers

Three mechanisms keep the machine honest. All three are exercised by unit
tests (`test/pipeline-state.test.ts`, `test/pipeline-fault-injection.test.ts`,
`test/pipeline-stuck-state-and-interrupt.test.ts`).

### Awaiting-state timers (pause/resume)

Every `AWAITING_*` state schedules a warning timer and a timeout timer inside
the machine. An incoming utterance **pauses** them (so STT latency doesn't eat
the response window). They are re-armed when:

- the input is unrecognized (the reprompt path restarts the full window), or
- the utterance turns out to be noise — empty transcript, non-lexical STT
  output, playback echo, or an STT failure. `handleUtterance`'s completion
  path detects an awaiting state with no timers and resumes the timeout
  contract automatically.

### Stall watchdog

A 60-second watchdog supervises everything else. On firing it checks, in order:

1. **IDLE** — nothing to do, re-arm.
2. **Audio playing/waiting** — long TTS is legitimate in any state, re-arm.
3. **Machine timers active** — the state is supervised by its own timeout
   contract; not a stall. Re-arm without resetting the idle clock.
4. **INBOX_FLOW** — user-paced; allowed to idle up to the 120s inbox-flow
   contract, then expired as a *cancelled* flow (cancelled earcon, return
   channel restored) rather than treated as a fault.
5. **Anything else** (stuck TRANSCRIBING/PROCESSING/SPEAKING — e.g. a worker
   crash or an unhandled exception) — hard reset: all timers cleared,
   transient context reset, playback stopped, error earcon, back to IDLE.

### Buffered utterances

Speech that arrives while the pipeline is busy (PROCESSING, or SPEAKING in
open mode) is buffered — up to 3 utterances, oldest dropped first. Each
buffered utterance snapshots the gate/prompt grace state *at capture time*;
replay evaluates the gate against that snapshot, not the fresh grace window
that opens when playback finishes (TGO-751 — otherwise stale wake-less speech
would slip through the gate).

The buffer is drained (one utterance per completion, via `setImmediate`)
whenever the pipeline returns to an input-ready state — both at the end of
`handleUtterance` and after out-of-band SPEAKING paths (wait-response
delivery, idle auto-read, dispatch-failure announcements).

---

## Indicate Mode

**Indicate mode is not a state — it's a capture layer that runs on top of IDLE/TRANSCRIBING.**

When endpointing is set to `indicate` (gated mode only), a wake word — or
wake-less speech inside a post-response grace window — opens a **capture
session**: subsequent utterances are accumulated as dictation segments until a
close word ends the session and the assembled transcript dispatches as one
prompt.

Tracked in `TransientContext`:

- `indicateCaptureActive` / `indicateCaptureSegments` — session flag and accumulated fragments
- `indicateCaptureStartedAt` / `indicateCaptureLastSegmentAt` — timing
- `indicateCaptureAddressedAgentId` — the agent addressed at capture start (the wake word is gone from the finalized transcript)
- `indicateCaptureOrigin` — `'wake'` (explicitly addressed) or `'grace'` (opened by wake-less speech in a grace window)

Ways a capture session ends:

- **Close/dismiss phrases** — wake-prefixed ("Watson, go ahead"), bare multi-word ("go ahead", "tango out"), "thanks [agent]", tail closes embedded in the last segment ("log eggs for breakfast, thanks Malibu"), and noisy close clusters. Dismiss closes dispatch to the background (queue); conversational closes wait inline.
- **Rapid-fire / single-shot** — wake word + a complete one-breath prompt finalizes immediately without waiting for a close word.
- **Commands** — wake-prefixed commands and a narrow set of bare playback commands interrupt capture and execute instead.
- **Cancel** — wake-prefixed cancel intent clears the capture.
- **Timeout** — a configurable timeout (default 45s, deferred while speech is active) nudges the user with a still-listening earcon rather than discarding dictation. Grace-originated captures expire after one nudge (they are usually ambient speech; nudging forever left captures that a later "thanks" would flush to an agent as garbage — TGO-751). Wake-originated captures nudge indefinitely. Empty or accidental single-fragment captures clear with a gate-closed cue.

A concurrent **close-word probe** transcribes just the audio tail on the fast
STT lane so the listening earcon can fire before the main transcription
finishes.

---

## Grace Periods and Cooldowns

Time-based flags in `TransientContext` shape behavior without changing the formal state:

| Flag | Purpose |
|---|---|
| `gateGraceUntil` | ~5s window after the assistant finishes speaking where the wake-word gate is open (set by the ready earcon) |
| `promptGraceUntil` | Window after creating/routing to a thread where the next utterance is accepted as the prompt |
| `followupPromptGraceUntil` (+ channel) | 15s after a channel response plays: follow-up prompts stay in that channel instead of re-routing |
| `replyContext*` | 45s after a message/notification plays: a reply routes to that agent/channel without re-addressing |
| `rejectRepromptCooldownUntil` | Prevents back-to-back reprompts from noise rejections |
| `ignoreProcessingUtterancesUntil` | Debounce after queue-choice resolution so trailing speech isn't misread |
| `failedWakeCueCooldownUntil` | Rate-limits the error cue for near-miss wake words |
| `newPostTimeoutPromptGuardUntil` | After a new-post timeout, blocks follow-on dictation from dispatching as a prompt |

Grace expiry is announced by a gate-closed cue, with holdoff/retry logic so it
never plays over active or just-started speech. `speakResponse` closes stale
grace windows for the duration of playback and reopens them afterward (unless
the response is terminal, e.g. a cancel).

---

## Invariants (Rules That Must Always Be True)

The pipeline checks these at the end of every utterance and counts violations (`checkPipelineInvariants`):

| Rule | What it means |
|---|---|
| Any `AWAITING_*`/`NEW_POST_FLOW` state must have active timeout timers | If you're waiting for input, there must be a clock running (auto-repaired by the timer-resume path; a violation indicates a new leak) |
| `SPEAKING` state means audio is playing or about to play | If the state says SPEAKING but nothing is playing, something went wrong |
| `IDLE` should not have a stale waiting-loop timer | A leftover timer in IDLE could trigger incorrect behavior |
| `IDLE` with a deferred retry timer requires a pending callback | A retry with nothing to retry is a leak |

---

## Known Issues / Sharp Edges

⚠️ **Awaiting timer resume restarts the full window.** When timers are resumed
after a noise utterance or reprompt, the timeout window restarts from zero
rather than resuming the remaining time. A user who coughs at second 14 of a
15-second selection window gets a fresh 15 seconds. Acceptable UX, but the
contract timeout is a floor, not a ceiling.

⚠️ **Gated interrupts require a wake word by design.** In gated mode, speaking
over TTS without a wake word (outside grace, with no focused agent) is
discarded and playback continues. This is intentional, but users experience it
as "it ignored me."

⚠️ **INBOX_FLOW timing lives in the watchdog, not the machine.** The 120s
browse limit is enforced by `VoicePipeline`'s watchdog reading the interaction
contract. If the flow ever needs warnings or per-item timing, that logic
should move into machine-owned timers like the awaiting states.

⚠️ **`InboxFlowState.items` is untyped (`any[]`).** It holds agent-grouped
`InboxAgentItem`s but historically also legacy channel-activity shapes; the
inbox handlers still cast. Tightening this requires auditing the inbox flow
end to end.

---

*Last updated: July 2026 — reflects `pipeline-state.ts`, `voice-pipeline.ts`,
`transient-context.ts`, `interaction-contract.ts`, and
`pipeline-invariants.ts` after the state-machine audit (V2 artifacts removed,
stuck-state and interrupt-replay fixes).*
