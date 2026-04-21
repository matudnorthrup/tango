# Route Classifier Confidence & Recency Weighting

**Status:** Discovery complete — awaiting stakeholder design approval
**Linear:** [Route Classifier Confidence & Recency Weighting](https://linear.app/seaside-hq/project/route-classifier-confidence-and-recency-weighting-0287783a4a24)
**Issues:** TGO-224 through TGO-231
**Date:** 2026-04-20

---

## 1. Incident Timeline (2026-04-20)

The stakeholder reported a voice session where explicit "hello Watson" commands were repeatedly overridden by the route classifier:

1. **Said "hello Watson"** → classifier suggested routing to the Lunch Money thread (a Watson forum thread with `topicId: 0f73c1e2-8700-4d65-aaae-c67c8fc157c4`)
2. **Retried** → classifier suggested routing to the Personal Tasks thread
3. **Tried to correct toward Watson** → classifier picked Sierra instead
4. **Original prompt was lost** in the confusion — the transcript was consumed by the confirmation flow
5. **Audio cues** (ready tones, beeps) fired during each confirmation, confusing the UX — stakeholder asked "what's ready" and got an unhelpful response

### What the database shows

- Message 2090 (23:51 UTC): Watson inbound to thread `1481116631613706260`, routed to `topic:0f73c1e2` (Lunch Money). `naturalRoute.explicitAddress: null` — the callsign was stripped before the natural route was logged, or the voice transcript didn't start with Watson's wake word.
- Messages 2097-2098 (00:36 UTC): Sierra inbound via voice-bridge — "I haven't done planning in a while and I haven't stayed up to date on my task lists" — routed to Sierra, but content is task-management (Watson's domain). This may be the "classifier picked Sierra" incident.
- Message 2099 (00:40 UTC): Watson inbound via voice-bridge — "could you help me capture a few tasks" — successfully routed to Watson (channel `100000000000000002`).

**Note:** The route classifier's candidate list and confidence scores are only logged to `console.log` (not persisted to DB), so exact confidence values from the incident are not recoverable. This is itself a finding — classifier decisions should be logged for debugging.

---

## 2. Current Classifier Logic

### Architecture

The route classifier is a **separate LLM call** (Haiku, 3-second timeout) that runs on every voice prompt in parallel with address resolution. It operates in `apps/tango-voice/src/services/route-classifier.ts`.

### Flow (voice-pipeline.ts lines 2526-2636)

```
User speaks → Whisper transcription
                ├── Address resolution (callsign matching)
                └── Route classifier (Haiku LLM call)
                         ↓
              ┌─ High confidence (>0.85) → AUTO-ROUTE (overrides callsign)
              ├─ Medium confidence (0.60-0.85) → ASK CONFIRMATION + ready earcon
              ├─ High create confidence (>0.90) → AUTO-CREATE thread
              ├─ Medium create confidence (0.70-0.90) → ASK CREATE confirmation
              └─ None/low → FALL THROUGH to explicit address default channel
```

### The Bug

**The route classifier result is evaluated BEFORE the explicit address fallback** (line 2534 vs line 2623). When the classifier returns high confidence for a thread match, it auto-routes there even when the user explicitly addressed an agent by callsign. The callsign-to-default-channel logic only runs if `!routeApplied` — meaning it's treated as a fallback, not a priority signal.

### What the classifier knows

The classifier prompt (`buildClassifierPrompt`, line 227) receives:
- List of existing routing targets (forum threads, topics, channels)
- Current active channel and topic
- Routing rules from `config/defaults/routing-rules.yaml`
- The stripped transcript (callsign already removed)

**What it does NOT know:**
- Whether the user explicitly addressed an agent by callsign
- How recently each thread was active
- Whether the user has ever interacted with a suggested thread
- Short/ambiguous vs detailed/specific input distinction

### Confidence thresholds

| Threshold | Value | Behavior |
|-----------|-------|----------|
| HIGH_CONFIDENCE | >0.85 | Auto-route |
| MEDIUM_CONFIDENCE | 0.60-0.85 | Ask confirmation |
| HIGH_CREATE_CONFIDENCE | >0.90 | Auto-create |
| MEDIUM_CREATE_CONFIDENCE | 0.70-0.90 | Ask create confirmation |

### Target inventory

`buildRouteTargetInventory()` (line 128) gathers:
1. Active forum threads (Discord API)
2. Forum channels (as creation containers)
3. Agent default channels (as creation containers)
4. Non-default channels from the router

Agent default channels are deliberately excluded from routing targets (line 139-145) — they serve as the fallback. **This is correct behavior** — the problem is that the fallback priority is too low.

---

## 3. Audio UX Issue: False-Positive Ready Earcon

### Current earcon triggers

The "ready" earcon fires in `pipeline-state.ts` line 771 when entering indicate-mode listening (`INTERRUPT_WAKE` → `LISTENING` with mode `indicate`).

In the route confirmation flow (voice-pipeline.ts lines 2589-2617), `playReadyEarcon()` fires after speaking the confirmation question ("Route to Lunch Money?"). This is **technically correct** — the system IS ready for the user's yes/no answer.

**However**, from the user's perspective:
- They said "hello Watson" expecting to talk to Watson
- Instead they hear "Route to Lunch Money?" + ready-beep
- The ready-beep suggests "something is ready" — but nothing the user asked for is ready
- User asks "what's ready?" → system responds about processing state, not the confirmation

### Recommendation

The confirmation earcon should be a **distinct tone** from the ready earcon — possibly a "question" earcon. The user needs to understand they're being asked something, not told something is ready.

---

## 4. Design Proposals

### Proposal A: Wake word → default agent wins

When the user's transcript starts with an agent callsign (e.g., "hello Watson", "hey Malibu"), that agent's default channel is the **baseline route**. The route classifier can only override if:
- The user explicitly names a thread/topic in the transcript (e.g., "for lunch money", "in the personal tasks thread")
- OR the classifier returns **very high confidence** (>0.95) AND the matched entity name appears in the transcript

**Implementation:** In `voice-pipeline.ts` around line 2534, check `explicitAddress?.kind === 'agent'` before evaluating `routeResult`. If the user addressed an agent, raise the threshold from 0.85 to 0.95, and additionally require the target name to appear in the transcript.

### Proposal B: Recency weighting

Add recency metadata to the classifier prompt so the LLM can make better-informed decisions:

**Scoring model:**
- Thread the user posted in **today** → label as "active today" (full weight)
- Thread active in **past 3 days** → label as "recent" (moderate weight)
- Thread inactive **>3 days** → label as "stale" (require explicit mention or very high topical match)
- Thread inactive **>7 days** → label as "very stale" (require explicit mention even at high confidence — never auto-route)

**Data source:** Query `messages` table:
```sql
SELECT discord_channel_id, MAX(created_at) as last_active
FROM messages
WHERE direction = 'inbound'
  AND discord_channel_id IN (/* thread IDs from target inventory */)
GROUP BY discord_channel_id
```

**Implementation:** Add a `lastActiveLabel` field to each `RouteTarget`. Include it in the classifier prompt's target list. Add a classifier rule: "Stale threads (>3 days inactive) require the user to explicitly mention the thread name or a clearly matching keyword. Very stale threads (>7 days) should never be auto-routed — require explicit mention even at high confidence."

### Proposal C: Unprompted → default bias

When the input is short/ambiguous AND doesn't explicitly name a thread or topic, bias toward the default agent channel:

**Criteria for "default bias" mode:**
- Input is short (<10 words) OR
- Input doesn't contain any thread/topic name from the target inventory
- AND the user doesn't use phrases like "for [topic]", "in the [thread]", "about [topic]"

**Implementation:** In `inferRouteTarget()`, before calling the LLM, check if the stripped prompt mentions any target name. If not, add a system instruction to the classifier: "The user did not mention any specific thread or topic. Prefer action: none unless there is an extremely strong topical match (confidence >0.95)."

---

## 5. Proposed Combined Model (A + B + C)

The three proposals are complementary and should be combined:

### New routing decision flow

```
User speaks → Whisper transcription
                ├── Address resolution (callsign matching)
                │         ↓
                │   explicitAddress detected?
                │     YES → set callsignOverride = true
                │     NO  → set callsignOverride = false
                │
                └── Route classifier (with recency metadata)
                         ↓
              Gate 0: Follow-up grace active?
                YES → bypass classifier entirely, route to active channel at 100% weight
                NO  → continue to Gate 1

              Gate 1: callsignOverride?
                YES → require confidence > 0.95 AND target name in transcript
                NO  → continue to Gate 2

              Gate 2: short/ambiguous input with no explicit topic mention?
                YES → require confidence > 0.90
                NO  → use current thresholds (0.85/0.60)

              Gate 3: target is stale (>3 days)?
                YES → require confidence > 0.90 OR explicit mention
                NO  → apply gate result from above

              Gate 4: target is very stale (>7 days)?
                YES → require explicit mention in transcript (no auto-route regardless of confidence)
                NO  → apply gate result from above

              Final: apply route or fall through to default channel
```

### Concrete scoring formula

```
effectiveConfidence = classifierConfidence

# Penalties
if callsignOverride:
    effectiveConfidence -= 0.15  # user explicitly addressed an agent
if targetStale:
    effectiveConfidence -= 0.10  # thread hasn't been active recently
if shortAmbiguousInput and noExplicitTopicMention:
    effectiveConfidence -= 0.10  # generic input shouldn't route to threads

# Thresholds stay the same (0.85 high, 0.60 medium)
# But the penalties make it harder for the classifier to cross them
```

Alternative (simpler, recommended): **raise the threshold dynamically** rather than adjusting the score:

```
baseThresholdHigh = 0.85
baseThresholdMedium = 0.60

if callsignOverride:
    thresholdHigh = 0.95
    thresholdMedium = 0.90
elif shortAmbiguousInput and noExplicitTopicMention:
    thresholdHigh = 0.92
    thresholdMedium = 0.80
else:
    thresholdHigh = baseThresholdHigh
    thresholdMedium = baseThresholdMedium

# Staleness gates (applied AFTER threshold selection):
# - Stale (>3 days): always require thresholdHigh (never medium confirm)
# - Very stale (>7 days): require explicit target name in transcript (block auto-route entirely)
```

---

## 5a. Gate 0: Follow-up Grace

Before any of the confidence gates (1–4) are evaluated, the pipeline checks whether the system has **just spoken a channel message** and the user is replying within a grace window. If so, the route classifier is **bypassed entirely**.

### Behavior

When the system speaks a channel message and the gate opens for the user's reply, the route classifier does not run. The reply routes directly to the active channel with **100% weight** — stronger than any classifier confidence could achieve. This grace window lasts **15 seconds** (`FOLLOWUP_PROMPT_GRACE_MS` in `voice-pipeline.ts`).

### Conditions (all must be true)

1. `lastSpokenIsChannelMessage` = `true` — the system's most recent spoken output was a channel message (not a system prompt or earcon)
2. `followupPromptChannelName` is set — identifies which channel the system just spoke into
3. The active channel matches the locked channel — the user hasn't switched context
4. `explicitAddress` is `null` OR matches the active channel's routed agent — the user didn't address a different agent by callsign

### Re-arming

The grace timer **re-arms on every new spoken turn**. In an ongoing thread conversation, the channel stays locked as long as the user replies within 15 seconds of each system response. This means a back-and-forth exchange with an agent in a specific thread will never be interrupted by the classifier.

### Position in the flow

Gate 0 sits **before** all other gates (callsign priority, ambiguous bias, recency). If the grace is active and conditions are met, Gates 1–4 are never evaluated.

### Code location

`shouldPreserveCurrentChannelForFollowupPrompt()` in `voice-pipeline.ts:4150`

---

## 6. Edge Cases

| Case | Expected behavior |
|------|-------------------|
| **New user with no history** | All threads are "stale" (>3 days since user's last inbound) → default channel wins unless explicit topic mention |
| **Topical query like "lunch money status"** | "lunch money" appears in transcript → matches target name → callsign gate bypassed, route applies |
| **Multi-agent thread** (e.g., Watson+Sierra thread) | Thread recency is based on user's last inbound message in that thread. If user posted there today, full weight; >3 days = stale |
| **"Hello Watson, check the lunch money thread"** | Callsign detected (Watson) + explicit topic mention ("lunch money") → route to lunch money thread |
| **"Hello Watson"** (no additional context) | Callsign detected, short input, no topic mention → default to Watson's channel |
| **Follow-up in same thread** | Handled by **Gate 0 (Follow-up Grace)** — classifier is bypassed entirely for 15s after the system speaks a channel message. Reply routes to active channel at 100% weight. Re-arms on each spoken turn. See §5a. |
| **User says "route to X"** | Explicit route command — handled by voice-commands.ts, not the classifier. No change needed. |

---

## 7. Audio UX Fix Scope

### Problem
The ready earcon (`playReadyEarcon()`) fires during route confirmation, making users think "something is ready" when really the system is asking a yes/no question.

### Fix
1. Add a new earcon type: `'question'` — a rising two-note tone (vs the single "ready" tone)
2. Use `'question'` earcon when entering `ROUTE_CONFIRMATION` state
3. Keep `'ready'` earcon for actual ready states (listening after completion, etc.)

### Scope
- `apps/tango-voice/src/audio/earcons.ts` — add `'question'` earcon
- `apps/tango-voice/src/pipeline/voice-pipeline.ts` — replace `playReadyEarcon()` calls in confirmation flow with `playEarcon('question')`

---

## 8. Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Over-correcting: legitimate thread suggestions never fire | Medium | Keep medium-confidence confirmation flow for non-callsign inputs. Only raise thresholds when callsign or ambiguity detected. |
| Recency query adds latency | Low | Query runs in parallel with classifier LLM call. Messages table has index on `channel_created`. |
| Breaking existing route commands | Low | Explicit "route to X" commands bypass the classifier entirely (handled by voice-commands.ts). |
| Earcon change confuses users | Low | Rising question tone is intuitive. Can A/B test if needed. |
| Classifier prompt gets too long | Low | Recency labels add ~5 tokens per target. Target inventory is typically <20 items. |

---

## 9. Implementation Plan (5 Milestones)

### Milestone 1: Discovery (TGO-224) — COMPLETE
- [x] Reproduce failure from database records
- [x] Read and document classifier logic
- [x] Audit earcon false positive
- [x] Write design spec (this document)

### Milestone 2: Implementation (TGO-225, TGO-226, TGO-227, TGO-228)
1. **TGO-225: Callsign priority gate** — modify `voice-pipeline.ts` to check `explicitAddress` before applying `routeResult`. Raise threshold when callsign detected.
2. **TGO-226: Recency weighting** — add recency query to `route-classifier.ts`, include labels in classifier prompt.
3. **TGO-227: Default-channel bias** — add short/ambiguous input detection to `inferRouteTarget()`, raise thresholds for generic input.
4. **TGO-228: Earcon fix** — add `'question'` earcon, use it in confirmation flow.

### Milestone 3: Deploy (TGO-229)
- `npm run build`, clean stale dist, restart bot, verify clean startup

### Milestone 4: Validation (TGO-230)
- Live test all scenarios from Edge Cases table
- Verify "hello Watson" routes to Watson default
- Verify "hello Watson, check lunch money" routes to Lunch Money
- Verify stale threads don't override callsigns
- Verify question earcon sounds distinct from ready earcon
- Document results in Linear issue comments

### Milestone 5: Ship (TGO-231)
- Update this doc with final results
- Report to CoS
- Clean up worktree slots and monitoring crons

---

## 10. Key Files

| File | Role |
|------|------|
| `apps/tango-voice/src/services/route-classifier.ts` | Route classifier LLM call, confidence scoring, target inventory |
| `apps/tango-voice/src/pipeline/voice-pipeline.ts` | Pipeline routing decision logic (lines 2526-2636) |
| `packages/voice/src/address-routing.ts` | Callsign matching, VoiceTargetDirectory |
| `packages/voice/src/natural-routing.ts` | Natural text route parsing |
| `apps/tango-voice/src/audio/earcons.ts` | Earcon generation |
| `apps/tango-voice/src/pipeline/pipeline-state.ts` | State machine, earcon triggers |
| `config/defaults/routing-rules.yaml` | Keyword routing hints |

---

## 11. Open Question: Classifier Decision Logging

The classifier's confidence scores and candidate list are only logged to `console.log` — not persisted to DB or structured logs. This made incident reconstruction difficult. Consider adding classifier results to `metadata_json` on the inbound message record, or to a dedicated `classifier_decisions` table. This is out of scope for this project but should be tracked as follow-up.
