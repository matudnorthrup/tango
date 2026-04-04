# Voice Pipeline State Machine

*A product and UX reference for how the voice pipeline manages what it's doing at any moment.*

---

## Overview

The voice pipeline is always in exactly one **state**. The state controls how it reacts to incoming speech, what audio it plays, and what it expects from the user next. Think of it like a traffic light — you can't be green and red at the same time. Every voice interaction moves the pipeline through a defined sequence of states and back to idle.

This document covers all ten states, how the pipeline moves between them, and a set of known issues to watch for.

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

The transcript (text version of your speech) has arrived. The appropriate agent or handler is now working on a response. This might involve calling an AI, looking something up, or routing to a different channel. During this time, new speech will play a "busy" tone to let you know the system is occupied.

---

### 🔊 SPEAKING
**The pipeline is playing audio back to you.**

The system is actively speaking a response through the voice channel. If new speech arrives during this state, playback stops and a "busy" tone plays. The response you interrupted is not replayed.

---

### 📋 AWAITING_CHANNEL_SELECTION
**The system asked you to pick a channel and is waiting for your answer.**

*Timeout: 15 seconds*

The system has presented a list of channels (by number or name) and is listening for your choice. Valid responses are a number, a channel name, or "cancel." If no response is received within 15 seconds, a warning tone plays at the 10-second mark and the flow cancels at 15 seconds.

---

### 📬 AWAITING_QUEUE_CHOICE
**The system asked what to do with a message and is waiting for your answer.**

*Timeout: 20 seconds*

A message or transcript is ready, and the system needs to know where it should go. Valid responses are "send to inbox," "wait here," "silent," or "cancel." Warning at 15 seconds, timeout at 20 seconds.

---

### 🔀 AWAITING_SWITCH_CHOICE
**The system switched contexts and is asking what you want to do next.**

*Timeout: 30 seconds*

The pipeline switched to a new channel or agent and is asking whether you want to hear the last message, send a new prompt, or cancel. Warning at 25 seconds, timeout at 30 seconds.

---

### ✅ AWAITING_ROUTE_CONFIRMATION
**The system identified a destination and is asking you to confirm.**

*Timeout: 10 seconds*

The pipeline detected where a message should be routed (a specific agent or channel) and is asking you to confirm with "yes" or "no." This is a short window — if you don't respond within 10 seconds (warning at 5 seconds), the route is cancelled.

---

### 📝 NEW_POST_FLOW
**The system is walking you through creating a new forum post, step by step.**

*Timeout: 30 seconds per step*

This is a multi-step guided flow with two steps:

1. **Forum step** — "Which forum?" — expects a forum name.
2. **Title step** — "What's the title?" — expects the post title.

Each step has its own 30-second timeout. If a step times out, the entire flow cancels. You can say "cancel" at any point to exit early.

---

### 📥 INBOX_FLOW
**The system is reading through your inbox, item by item.**

*Timeout: 120 seconds (but see Known Issues)*

A structured browsing mode where the system reads inbox items aloud and waits for navigation commands between each one. Valid responses include "next," "done," and "cancel." Unlike the other awaiting states, `INBOX_FLOW` does not track a timeout timer in the state machine itself (the 120-second value is defined in the contract but not enforced by the core state machine).

---

## State Transition Table

This table shows every state, what events move you out of it, and where you land.

| From State | Trigger / Event | To State | User-visible effect |
|---|---|---|---|
| **IDLE** | Speech detected | TRANSCRIBING | Pipeline begins listening |
| **TRANSCRIBING** | Transcript ready | PROCESSING | STT complete, now working |
| **PROCESSING** | Processing complete (no audio) | IDLE | Silent completion |
| **PROCESSING** | Speaking started | SPEAKING | Response audio begins |
| **PROCESSING** | New speech arrives | PROCESSING (buffered) | Busy earcon plays; speech queued |
| **SPEAKING** | Playback complete | IDLE | Returns to ready |
| **SPEAKING** | New speech arrives | SPEAKING (interrupted) | Playback stops; busy earcon |
| **Any** | ENTER_CHANNEL_SELECTION | AWAITING_CHANNEL_SELECTION | Prompts for channel pick |
| **Any** | ENTER_QUEUE_CHOICE | AWAITING_QUEUE_CHOICE | Prompts for queue decision |
| **Any** | ENTER_SWITCH_CHOICE | AWAITING_SWITCH_CHOICE | Prompts for switch decision |
| **Any** | ENTER_ROUTE_CONFIRMATION | AWAITING_ROUTE_CONFIRMATION | Prompts for yes/no confirm |
| **Any** | ENTER_NEW_POST_FLOW | NEW_POST_FLOW (forum step) | Begins post creation |
| **NEW_POST_FLOW** (forum) | Forum chosen | NEW_POST_FLOW (title step) | Advances to title prompt |
| **NEW_POST_FLOW** (title) | Title given | PROCESSING | Submits the post |
| **Any** | ENTER_INBOX_FLOW | INBOX_FLOW | Begins inbox browsing |
| **INBOX_FLOW** | "Next" | INBOX_FLOW (next item) | Advances to next item |
| **INBOX_FLOW** | "Done" / last item | IDLE | Exits inbox |
| **Any AWAITING_*** | Valid response received | PROCESSING | Processes the answer |
| **Any AWAITING_*** | Unrecognized response | Same AWAITING state | Error earcon + reprompt |
| **Any AWAITING_*** | Warning threshold hit | Same AWAITING state | Warning tone plays |
| **Any AWAITING_*** | Timeout | IDLE | Cancelled earcon + timeout message |
| **Any** | "Cancel" | IDLE | Cancelled earcon |
| **Any** | RETURN_TO_IDLE | IDLE | Silent reset |

---

## Indicate Mode

**Indicate mode is not a state — it's a flag that can be active on top of any state.**

### What it is

When the system plays back a channel message or a long response, it briefly enters a **gate grace period** — a short window (tracked by `gateGraceUntil`) where the pipeline ignores stray audio to prevent its own playback from triggering a new command.

Indicate mode is designed to bridge this gap: instead of ignoring your voice during the grace period, the pipeline quietly captures speech fragments and assembles them into a command to process once the grace window closes. This lets you start speaking while playback is still finishing, without losing your words.

### How it works

When indicate capture is active, the following are tracked internally:

- **Active flag** (`indicateCaptureActive`) — whether capture is currently on
- **Segments** (`indicateCaptureSegments`) — the speech fragments collected so far
- **Start time** (`indicateCaptureStartedAt`) — when capture began
- **Last segment time** (`indicateCaptureLastSegmentAt`) — most recent speech fragment received
- **Target agent** (`indicateCaptureAddressedAgentId`) — which agent the captured command is for

Once capture ends, the assembled segments are treated as a complete utterance and routed normally.

### What it means for the user

If you speak right as the system finishes talking, your words should still land correctly. You don't need to wait for a complete silence before speaking. However, see the Known Issues section below — the current implementation has fragmentation bugs that can break this in practice.

---

## Grace Periods and Cooldowns

Several time-based flags in `TransientContext` shape how the pipeline behaves even without changing the formal state:

| Flag | Purpose |
|---|---|
| `gateGraceUntil` | Ignores (or captures) audio briefly after playback ends, to avoid echoes triggering commands |
| `promptGraceUntil` | Short window after a prompt plays to avoid capturing the prompt itself |
| `followupPromptGraceUntil` | Same as above but for follow-up/reprompt audio |
| `rejectRepromptCooldownUntil` | Prevents back-to-back reprompts from firing too quickly |
| `ignoreProcessingUtterancesUntil` | Suppresses spurious utterances after processing starts |
| `failedWakeCueCooldownUntil` | Rate-limits "I didn't catch that" style responses after a missed wake cue |

These do not change the pipeline's state but do affect what it does with incoming audio in that state.

---

## Invariants (Rules That Must Always Be True)

The pipeline monitors itself against these rules at runtime. A violation is logged as a warning but does not automatically recover:

| Rule | What it means |
|---|---|
| Any `AWAITING_*` or `NEW_POST_FLOW` state must have active timeout timers | If you're waiting for input, there must be a clock running |
| `SPEAKING` state means audio is playing or about to play | If the state says SPEAKING but nothing is playing, something went wrong |
| `IDLE` state should not have a stale waiting-loop timer | A leftover timer in IDLE could trigger incorrect behavior |
| `IDLE` with a deferred retry timer requires a pending callback | A retry with nothing to retry is a leak |

---

## Known Issues

> The following bugs exist in the current implementation. Each describes a scenario where the state machine does not behave as intended.

---

⚠️ **Gate grace + indicate fragmentation**

During the gate grace window, the voice activity detector (VAD — the component that detects when someone is speaking) delivers many tiny speech fragments rather than waiting for a natural pause. As a result, indicate mode receives a burst of micro-segments instead of a clean, complete utterance. This causes assembled commands to be garbled, cut off, or duplicated. **Impact:** Voice commands spoken right after playback may not be recognized correctly.

---

⚠️ **AWAITING_INDICATE never times out**

When indicate capture is activated (`indicateCaptureActive = true`), the pipeline is effectively "waiting" for you to finish speaking — but there is no timeout clock on this condition. If you trigger indicate mode and then go silent, the pipeline stays in indicate capture indefinitely. It will not time out, play a warning, or return to normal operation on its own. **Impact:** The pipeline can silently get stuck, appearing to work but ignoring all speech.

---

⚠️ **SPEAKING interruption is not handled cleanly**

When new speech arrives while the system is in the `SPEAKING` state, playback is stopped and a busy earcon plays — but the pipeline does not immediately move to `TRANSCRIBING`. The interrupting speech may be dropped or buffered unreliably, depending on timing. **Impact:** Interrupting the system mid-sentence often requires you to speak again after it goes quiet.

---

⚠️ **Flow states have incomplete timeout and error paths**

Some `AWAITING_*` states (particularly `AWAITING_QUEUE_CHOICE` and paths within `NEW_POST_FLOW`) have missing or unimplemented error exit paths. If something unexpected happens during one of these flows — a bad response from the AI, a network error, an exception in the handler — the state machine may not receive a `RETURN_TO_IDLE` or `CANCEL_FLOW` event and will remain stuck in the awaiting state until the timeout fires. **Impact:** Edge-case failures in multi-step flows can leave the pipeline unresponsive for up to 30 seconds.

---

⚠️ **No state reset on worker crash**

If the underlying worker (the AI agent handling a command) crashes or throws an unhandled exception mid-task, the pipeline state is not automatically reset. It will remain in `PROCESSING` or whatever state it was in when the crash occurred. There is no watchdog that detects a silent worker failure and issues a `RETURN_TO_IDLE`. **Impact:** A crashed worker leaves the pipeline stuck. It will appear to be processing indefinitely and will reject new commands with a busy earcon.

---

*Last updated: March 2026 — reflects `pipeline-state.ts`, `transient-context.ts`, `interaction-contract.ts`, and `pipeline-invariants.ts`.*
