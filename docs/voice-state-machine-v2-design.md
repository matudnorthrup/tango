# Voice State Machine — V2 Design

This document describes the target architecture for the Tango voice pipeline. It is a forward-looking design spec meant to guide the rewrite, not a description of the current system. For the current system, see `docs/voice-state-machine.md`.

---

## Section 1: Design Principles

- **Indicate mode is the primary and first-class interaction model.** The system is designed around it, not retrofitted.
- **The system is closed by default** — all speech is ignored until a wake word is detected.
- **The state machine is flat and minimal** — only states that reflect meaningfully different user experiences are kept. Internal transitions (like routing) are not user-visible states.
- **A parallel interrupt layer runs continuously** alongside the main state machine. This handles wake words, cancel commands, and system commands without needing the state machine to be "in" a specific state. This is how the system can transcribe + listen for interrupts simultaneously — they are separate processing pipelines, not concurrent states.
- **System commands are cross-cutting** — commands like "cancel", "check inbox", "what's next" work regardless of what state the machine is in.

---

## Section 2: Core States

These are the only states in the new model. Each represents a meaningfully different user experience.

### CLOSED (default)

The gate is fully closed. No speech is processed or acted on.

- The wake word detector runs continuously in the background.
- **Transition out:** Wake word detected → LISTENING

### LISTENING

The gate is open. Speech is being accepted and transcribed.

Covers two sub-modes (not separate states — just different exit conditions):

- **Quick mode:** A single short utterance followed by natural silence. No close word required.
- **Indicate mode (primary):** Session is held open until the close word ("Tango") is spoken, or a timeout occurs.

The interrupt layer also runs here (for cancel, system commands).

**Transitions out:**
- Close word or silence timeout → DISPATCHING
- Cancel command → CLOSED

### DISPATCHING

The message has been assembled. Routing is running to determine which agent/topic/thread receives it.

This is invisible to the user — it should feel instantaneous or nearly so. An earcon may play to confirm the message was received.

**Transitions out:**
- Route resolved → FOCUS or BACKGROUND (based on user's current mode preference or explicit instruction)
- Routing needs clarification → CLARIFYING (system asks user a question before completing dispatch)
- Routing failure → CLOSED (with error earcon)

### CLARIFYING

The system needs more information before it can complete routing or respond. This is a system-initiated question — fundamentally different from SPEAKING, where the agent is delivering a response.

Examples:
- "Which agent should I send this to — Watson or Malibu?"
- "Did you mean your workout for today or a specific past date?"

A distinct TTS tone or earcon may distinguish this from normal agent speech. The system speaks a question, then opens a short LISTENING window for the answer.

**Transitions out:**
- User answers → back to DISPATCHING (with clarification context attached)
- Cancel → CLOSED
- No response / timeout → CLOSED (with timeout earcon)

### FOCUS

Waiting for the agent's response synchronously.

A waiting earcon plays to signal the system is working. The user is expected to stay present and receive the response when it arrives. The interrupt layer still runs (user can cancel, switch to background, etc.).

**Transitions out:**
- Response received → SPEAKING
- Cancel → CLOSED
- "Put it in the background" / explicit switch → BACKGROUND

### BACKGROUND

*(Previously called Queue/Inbox mode)*

The agent is processing in the background. The user is free.

No earcon plays — the system is silent. The user can return to CLOSED (or immediately to LISTENING via wake word) and trigger more commands. When the response is ready, a nudge earcon plays.

**Transitions out:**
- Response ready + user acknowledges → SPEAKING
- Wake word while waiting → nested LISTENING (doesn't cancel the background task)
- Cancel background task → CLOSED

### SPEAKING

TTS is playing the agent's response.

The interrupt layer listens for wake word or cancel simultaneously (this is the parallel pipeline — not a concurrent state).

**Transitions out:**
- TTS finishes → CLOSED (gate closes)
- Interrupt detected (cancel, wake word) → CLOSED or LISTENING depending on interrupt type

---

## Section 3: The Parallel Interrupt Layer

This runs continuously, separate from the main state machine. It is not a state — it's a background process.

**What it monitors:**
- Wake word (opens LISTENING from any state)
- Cancel word ("Tango, cancel") — stops current state and returns to CLOSED
- System commands (see Section 4)

**Why this matters architecturally:**

The old system tried to handle simultaneous transcription + interrupt detection by layering flags and grace periods onto states. This created the fragmentation bugs. The new model separates these concerns cleanly — the state machine handles the main flow, the interrupt layer handles everything that crosses state boundaries.

---

## Section 4: System Commands (Cross-Cutting)

These are recognized by the interrupt layer regardless of current state. They don't require a full wake-word + indicate sequence (or they may use a simplified trigger).

- **Cancel** — Stop whatever is happening, return to CLOSED
- **Check inbox** — Report how many background responses are waiting
- **Next / What's the response** — Read the next background response
- **Switch to background** — Move current FOCUS task to BACKGROUND
- **Switch to focus** — Move the most recently dispatched BACKGROUND task to FOCUS (notify when ready if still processing)

*(More system commands to be defined during implementation — this is not an exhaustive list.)*

---

## Section 5: Routing (Internal to DISPATCHING)

Routing is not a user-visible state. It happens inside DISPATCHING. The user doesn't wait for routing confirmation as a distinct experience.

The routing layer determines:
- Which agent handles this message (Malibu, Watson, Sierra, Victor, etc.)
- Which thread/topic/channel context it belongs to
- Whether it's a new conversation or continues an existing one

If routing is ambiguous, the system may ask a quick clarifying question — but this should be rare and handled as a short LISTENING follow-up, not a dedicated state.

---

## Section 6: Flows to Redesign Separately

These features exist today but need redesign and are **not part of this state machine rewrite:**

- **Post creation flow** — Currently NEW_POST_FLOW state with multi-step prompts. Needs to be redesigned as a natural language flow, likely just using LISTENING + smart routing.
- **Queue choice prompt** — Currently presents a choice when dispatching. Will be replaced by implicit mode selection based on context or a simple system command.
- **Agent switching** — Currently a state. Will be folded into routing intelligence.

---

## Section 7: What Changes from V1

| V1 Concept | V2 Approach |
|---|---|
| IDLE | Renamed CLOSED, clearer semantics |
| TRANSCRIBING | Folded into LISTENING |
| AWAITING_CLOSE | Folded into LISTENING (indicate mode sub-flow) |
| PROCESSING | Invisible — part of DISPATCHING |
| AWAITING_ROUTE_CONFIRMATION | Removed as a state; routing is internal |
| SPEAKING | Kept, same role |
| NEW_POST_FLOW | Deprecated — redesign separately |
| QUEUE_CHOICE | Deprecated — replaced by system commands |
| AGENT_SWITCHING | Deprecated — folded into routing |
| Indicate mode as a flag | Indicate mode as the primary model |
| Gate grace period logic | Replaced by clean LISTENING → DISPATCHING transition |

---

## Section 8: Resolved Design Questions

*(All open questions resolved — no blocking items before implementation)*

**Q1: How does the wake word interact with SPEAKING?**
Wake word during SPEAKING immediately stops TTS and transitions to LISTENING. The user having something to say takes priority over delivery.

**Q2: What happens when a wake word is detected during BACKGROUND?**
A new LISTENING session opens in parallel. The existing background task continues unaffected — it is not paused or cancelled. When it completes, the nudge earcon plays as normal.

**Q3: What triggers the switch between Quick and Indicate modes?**
Timing after the wake word determines the mode:
- **Quick mode** — User starts speaking immediately after the wake word (no perceptible pause). The system captures the utterance and dispatches on natural silence.
- **Indicate mode (primary)** — User pauses after the wake word, receives the ready confirmation earcon, then speaks. The session stays open until the close word ("Tango") or a timeout.

This is already captured in the LISTENING state description above. No explicit mode-switch command is needed — the behavior is inferred from pause detection.

**Q4: When routing asks a clarifying question, is that a SPEAKING → LISTENING cycle?**
No — it's a distinct state (CLARIFYING, defined above in Section 2). The semantic difference matters: in SPEAKING, the agent is delivering a response. In CLARIFYING, the system is asking the user a question before it can proceed. These should feel different to the user (distinct earcon or tone) and are handled differently by the state machine. After the user answers, routing resumes with the clarification attached.

**Q5: What is the default mode — FOCUS or BACKGROUND?**
Default is **BACKGROUND**. The system assumes the user may be doing something else. FOCUS is an explicit opt-in, either per-message or as a mode switch.

---

## Section 9: Implementation Plan

This section describes how to execute the V2 rewrite in safe, testable vertical slices. Each phase has a clear scope, acceptance test, and does not break the running system until the final cutover.

### Guiding constraints

- `voice-pipeline.ts` is ~250KB of logic — we are **not rewriting it from scratch**. We're replacing the state machine layer underneath it and rerouting the transitions.
- The interrupt layer (wake word, cancel detection) already exists as scattered logic. We are extracting and centralizing it, not rebuilding it.
- Deprecated states (NEW_POST_FLOW, AWAITING_QUEUE_CHOICE, AWAITING_SWITCH_CHOICE, AWAITING_ROUTE_CONFIRMATION) are removed after V2 transitions are proven stable — not before.
- Each phase ends with the system in a working, deployable state.

---

### Phase 1 — New state type definitions (no behavior change)

**Scope:** Replace `PipelineStateType` in `pipeline-state.ts` with V2 types. Keep all V1 state interfaces in place as a parallel set (prefixed `V1`) until Phase 5 removes them.

**Files touched:**
- `pipeline-state.ts` — add V2 types and interfaces alongside V1

**V2 state types:**
```typescript
export type V2PipelineStateType =
  | 'CLOSED'      // was IDLE
  | 'LISTENING'   // was TRANSCRIBING + AWAITING_CLOSE combined
  | 'DISPATCHING' // was PROCESSING (invisible, no UX wait needed)
  | 'CLARIFYING'  // new — system asks a question before routing
  | 'FOCUS'       // was wait-for-response synchronous mode
  | 'BACKGROUND'  // was queue/inbox async mode
  | 'SPEAKING';   // unchanged
```

**New state interfaces to add:**
```typescript
export interface ClosedState { type: 'CLOSED' }
export interface ListeningState {
  type: 'LISTENING';
  mode: 'quick' | 'indicate';  // inferred from pause detection
  startedAt: number;
  timeoutMs: number;
}
export interface DispatchingState { type: 'DISPATCHING' }
export interface ClarifyingState {
  type: 'CLARIFYING';
  question: string;
  enteredAt: number;
  timeoutMs: number;
}
export interface FocusState {
  type: 'FOCUS';
  taskId: string;
}
export interface BackgroundState {
  type: 'BACKGROUND';
  tasks: BackgroundTask[];  // queue of pending responses
}
export interface SpeakingV2State { type: 'SPEAKING' }

export interface BackgroundTask {
  taskId: string;
  status: 'pending' | 'ready';
  response?: string;
}
```

**Acceptance test:** Project still builds. No runtime behavior changes.

---

### Phase 2 — Extract parallel interrupt layer

**Scope:** Move wake word detection and cancel handling out of state-conditional branches and into a dedicated `InterruptLayer` class that fires regardless of current state.

**Files touched:**
- New file: `pipeline/interrupt-layer.ts`
- `voice-pipeline.ts` — wire interrupt layer; remove duplicated cancel/wake-word checks from individual state handlers

**InterruptLayer responsibilities:**
- Runs a continuous listener alongside the main state machine
- On wake word: emits `interrupt:wake` event
- On cancel command: emits `interrupt:cancel` event
- On system commands (switch-to-background, switch-to-focus, check-inbox, what's-next): emits typed events
- Does NOT modify state directly — the pipeline responds to events and drives transitions

**Key constraint:** The interrupt layer fires during SPEAKING, FOCUS, BACKGROUND, and LISTENING. The current system handles these as special cases in each state; the new layer removes that duplication.

**Acceptance test:** Wake word during SPEAKING stops TTS and opens LISTENING. Cancel during SPEAKING returns to CLOSED. Both behaviors work without state-conditional branches in the pipeline.

---

### Phase 3 — LISTENING state (indicate mode primary)

**Scope:** Replace the V1 TRANSCRIBING + AWAITING_CLOSE combination with a single LISTENING state. Implement pause-based mode detection (quick vs indicate).

**Files touched:**
- `voice-pipeline.ts` — replace TRANSCRIBING/AWAITING_CLOSE handling with LISTENING handler
- `pipeline-state.ts` — remove V1 TRANSCRIBING and AWAITING_CLOSE state types
- `transient-context.ts` — remove `isIndicateMode`, `indicateModeActive`, and related grace period flags (these are now encoded in LISTENING state)

**Quick vs indicate mode detection:**
- After wake word: start a **300ms pause timer**
- If user starts speaking within 300ms → enter `mode: 'quick'` (dispatch on natural VAD silence)
- If 300ms elapses with no speech → play ready earcon → enter `mode: 'indicate'` (hold open until close word "Tango" or 60s timeout)
- This eliminates the gate grace fragmentation bug entirely

**Gate grace period:** Eliminated. LISTENING simply waits for the close word or VAD silence. No post-TTS grace window is needed because CLOSED→LISTENING is always via explicit wake word.

**Acceptance test:**
- "Tango [pause] [long message] Tango" routes correctly without fragment splitting
- "Tango [immediate speech]" routes correctly in quick mode
- Cancel during LISTENING returns to CLOSED

---

### Phase 4 — DISPATCHING and CLARIFYING states

**Scope:** Replace PROCESSING with DISPATCHING (invisible; earcon plays). Add CLARIFYING state with distinct earcon for system-initiated questions.

**Files touched:**
- `voice-pipeline.ts` — rename PROCESSING → DISPATCHING; add CLARIFYING entry/exit logic
- `pipeline-state.ts` — remove V1 PROCESSING; add ClarifyingState
- `pipeline-state.ts` — remove AWAITING_ROUTE_CONFIRMATION (replaced by CLARIFYING)

**CLARIFYING behavior:**
- System TTS plays a question in a distinct tone (different from agent response)
- Short LISTENING window opens (15s timeout, not the full indicate timeout)
- User response is appended to dispatch context and routing resumes
- Cancel returns to CLOSED

**Acceptance test:** When routing is ambiguous, system asks a short question; user answers; dispatch completes to the correct agent. Behavior is distinct from a normal agent response.

---

### Phase 5 — FOCUS and BACKGROUND modes

**Scope:** Replace the V1 queue/wait mode choice (AWAITING_QUEUE_CHOICE) with V2 FOCUS/BACKGROUND. Default is BACKGROUND. FOCUS is explicit opt-in.

**Files touched:**
- `voice-pipeline.ts` — remove AWAITING_QUEUE_CHOICE handling; wire FOCUS/BACKGROUND transitions
- `pipeline-state.ts` — remove V1 AWAITING_QUEUE_CHOICE, AWAITING_SWITCH_CHOICE
- `interrupt-layer.ts` — add "switch to focus" / "switch to background" system commands

**BACKGROUND behavior:**
- Task dispatched, no waiting earcon
- User free — can issue new commands (nested LISTENING opens)
- When response ready: nudge earcon plays
- "What's the response" / "next" → SPEAKING

**FOCUS behavior:**
- Waiting earcon plays after dispatch
- User is expected to be present
- Response arrives → SPEAKING
- "Put it in the background" → transitions to BACKGROUND mid-wait

**Acceptance test:** Two commands dispatched in BACKGROUND mode; both complete; responses read in order. Switching from FOCUS to BACKGROUND mid-wait works without losing the task.

---

### Phase 6 — SPEAKING state cleanup and interrupt wiring

**Scope:** Ensure SPEAKING properly uses the interrupt layer. Remove all state-conditional TTS interrupt checks.

**Files touched:**
- `voice-pipeline.ts` — remove manual interrupt checks from SPEAKING handler; confirm interrupt layer handles them

**Acceptance test:** Wake word mid-SPEAKING stops TTS immediately and opens LISTENING. Cancel stops TTS and returns to CLOSED. No delay or garbled state.

---

### Phase 7 — Remove deprecated states and clean up

**Scope:** Remove V1 state types, interfaces, and all handling logic that is no longer reachable after Phase 6.

**Removals:**
- `NEW_POST_FLOW` state and all handling (marked for separate redesign — see Section 6)
- `AWAITING_CHANNEL_SELECTION` (replaced by routing intelligence)
- V1 prefixed type aliases added in Phase 1
- Dead flags in `transient-context.ts`

**Acceptance test:** Project builds cleanly with zero references to removed types. No TypeScript errors.

---

### Phase 8 — Transition table validation

Run the full V2 transition table against the implemented system and confirm every documented transition behaves as specified. This is the final gate before considering V2 complete.

---

## Section 10: Testing & Validation Strategy

### Guiding principle: maximize automation, minimize live voice sessions

Voice UX testing is expensive — it requires a human with a microphone, a running voice bot, and time. The strategy here minimizes the surface that requires direct user participation to a handful of short smoke sessions, while covering everything else through automated and text-injection tests.

---

### Layer 1 — Deterministic harness tests (zero human interaction required)

The existing `InteractionFlowHarness` in `apps/tango-voice/src/testing/interaction-flow-harness.ts` simulates the full state machine without Discord or audio. It accepts typed utterances and validates state transitions, recognized intents, and feedback sequences.

**For V2:** Extend the harness to support V2 states. For each phase, add harness scenarios before touching `voice-pipeline.ts`. This gives a safety net: if the harness passes, the transition logic is correct before any live testing.

**How to run:** `npx ts-node apps/tango-voice/src/testing/flow-report.ts`

**What to cover per phase:**
- Phase 3: All LISTENING transitions (quick mode, indicate mode, cancel, timeout)
- Phase 4: DISPATCHING → CLARIFYING → DISPATCHING with answer; cancel in CLARIFYING
- Phase 5: FOCUS → SPEAKING; BACKGROUND → SPEAKING; mid-wait FOCUS → BACKGROUND switch
- Phase 6: SPEAKING interrupt scenarios
- Phase 7: Regression — run all 28 stress-flow scenarios against V2, confirm none regressed

**Target:** All harness scenarios pass before any phase is merged.

---

### Layer 2 — Discord text-injection testing (agent-operated, no user needed)

The existing E2E harness (`e2e-voice-loop-report.ts`) injects utterances directly into the live voice pipeline. The development agent can run these without user participation.

**Approach:**
1. A dedicated `#voice-test` channel is used for all injection tests.
2. Victor dispatches test utterances via the E2E harness after each phase.
3. Results (state transitions, earcons fired, TTS content) are captured in the report output.
4. Victor fixes any failures before tagging the phase complete.

**What to cover:**
- Happy path for each V2 state transition
- Interrupt scenarios (cancel, wake word during SPEAKING)
- BACKGROUND mode: dispatch + nudge + read response cycle
- CLARIFYING: ambiguous dispatch triggers question → answer → correct routing

**Run command:** `npx ts-node apps/tango-voice/src/testing/e2e-voice-loop-report.ts`

---

### Layer 3 — Live voice smoke tests (user participates — short, focused)

These are the only sessions that require the user. Each is short (5–10 min) and targets a specific behavior that cannot be validated without real audio.

**Recommended schedule:**

| After Phase | What to test | Time |
|---|---|---|
| Phase 3 | Indicate mode: "Tango [pause] [long utterance] Tango" — confirm no fragmentation | 5 min |
| Phase 5 | Background mode: issue a command, do something else, hear the nudge earcon | 5 min |
| Phase 6 | Wake word mid-speaking: interrupt TTS cleanly | 5 min |
| Phase 7 (final) | Full regression: one loop through all common daily interactions | 15 min |

**Total live testing time estimate: ~30 minutes** across the full V2 implementation.

---

### Layer 4 — Regression protection (ongoing)

After V2 is live, the harness scenarios become the regression suite. Before any future pipeline change:
1. Run `flow-report.ts` — must pass
2. Run `stress-flow-report.ts` — must pass
3. Victor runs text-injection E2E on the test channel — must pass

No user participation required for routine regression checks.

---

### Known testing gaps to address during implementation

- **Pause-detection (quick vs indicate mode):** The 300ms threshold is an educated guess. It should be configurable and tunable. During Phase 3 live testing, the user should try both quick and indicate utterances to calibrate this threshold.
- **Nudge earcon timing:** The delay between "response ready" and nudge earcon in BACKGROUND mode may need adjustment based on feel. Worth noting during Phase 5 smoke test.
- **Clarifying question UX:** The distinct earcon for CLARIFYING vs SPEAKING should feel meaningfully different. The development agent can test the earcon selection in text-injection, but the user should confirm it feels right in the Phase 4 smoke (this can be folded into one of the other phase smoke sessions to avoid adding a dedicated session).
