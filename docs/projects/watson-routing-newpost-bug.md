# Watson Routing Bug — Main Channel → New Latitude Forum Post

**Status:** Discovery complete — awaiting fix approval
**Date:** 2026-04-22
**Reported by:** Stakeholder (live voice interaction)

---

## 1. Incident Reconstruction

### Timeline (2026-04-22, ~14:01 UTC)

1. User spoke to Watson via voice with a daily planning prompt
2. Route classifier (Haiku) returned: `action: "create"`, title: "Daily Planning - 5am Schedule & Today's Tasks", target: "latitude (forum)", confidence: 0.85
3. This hit `isMediumCreateConfidence` (0.70–0.90) → system asked: "Create Daily Planning - 5am Schedule & Today's Tasks in latitude?"
4. User said "no" → confirmation declined
5. System said "Sending to General. Say route-to to redirect." + ready earcon
6. Route confirmation timed out after 5358ms
7. Transcript dispatched to fallback → Watson processed it successfully and responded with the daily plan

### Evidence

**Voice logs (`tango:voice`):**
```
Route classifier: create "Daily Planning - 5am Schedule & Today's Tasks" in forum "latitude (forum)" (confidence: 0.85)
Route classifier: asking create confirmation — "Create Daily Planning - 5am Schedule & Today's Tasks in latitude?" (confidence: 0.85)
```

**DB (message 2347):** Watson inbound at 14:01:43, channel `1480419548212498442` (Watson's main channel) — "i have been fairly negligent of doing my daily planning, we can get started but..."

**Outcome:** The user said "no", the system fell back correctly, and Watson handled the message. But the 5+ second interruption for a bogus create confirmation is a broken UX.

---

## 2. Root Cause

### The create action bypasses ALL confidence gates

The Route Classifier Confidence & Recency Weighting project (commit `bb025c0`) added four gates that protect against false-positive routing:

| Gate | Protection | Applies to |
|------|-----------|------------|
| Gate 1: Callsign priority | Raises threshold to 0.95 when user addressed an agent | `route` only |
| Gate 2: Short/ambiguous input | Raises threshold to 0.92 for <10 word inputs | `route` only |
| Gate 3: Stale target (>3d) | Blocks medium-confidence auto-route | `route` only |
| Gate 4: Very stale target (>7d) | Blocks all auto-route unless explicit mention | `route` only |

**None of these gates apply to `create` actions.** The code path is:

```
line 2595: computeEffectiveThresholds() → sets thresholds for route action
line 2642: if (allowAutoRoute) → HIGH route (gated) ✓
line 2651: else if (isHighCreateConfidence) → AUTO-CREATE (NO GATES) ✗
line 2672: else if (isMediumCreateConfidence) → ASK CREATE confirm (NO GATES) ✗
line 2701: else if (allowRouteConfirmation) → ASK route confirm (gated) ✓
```

### Why the classifier returned `create`

The classifier prompt correctly says creation requires explicit verbs ("create a thread", "make a post", "start a new thread"). But Haiku at 0.85 confidence hallucinated a `create` action from a planning-related transcript that didn't contain any creation verb. The transcript was about doing daily planning — the model interpreted "start small" or the planning topic as creation intent.

**There is no code-level validation** that creation verbs actually exist in the transcript. The system trusts the LLM's action classification completely.

### Contributing factors

1. **Forum channels in target inventory**: `latitude (forum)` appears as a creation container (line 347-358 of `route-classifier.ts`). Its presence in the prompt gives the LLM a target to latch onto.
2. **No callsign gate for create**: Even though the user addressed Watson by callsign, the create path doesn't check `explicitAddress`.
3. **No short-input gate for create**: The daily planning prompt was long, but even short prompts would trigger create confirmations.

---

## 3. Proposed Fix

### Fix A: Apply the same confidence gates to create actions (Required)

Mirror the gate logic from route actions to create actions. When `action === 'create'`:

1. **Callsign priority**: If `explicitAddress?.kind === 'agent'` and the transcript doesn't mention the creation target by name → block create.
2. **Short/ambiguous input**: If <10 words and no target mention → raise create thresholds.
3. **Recency is N/A** for create (new threads don't have recency).

Implementation: After `computeEffectiveThresholds()`, also compute effective CREATE thresholds. Apply them before entering the `isHighCreateConfidence` / `isMediumCreateConfidence` branches.

### Fix B: Code-level creation verb validation (Required)

Before accepting `action: 'create'` from the classifier, check that the transcript actually contains a creation verb:

```typescript
const CREATION_VERBS = /\b(create|make|start|open|new)\b.*\b(thread|post|topic|conversation)\b/i;
const hasCreationIntent = CREATION_VERBS.test(strippedForRouting);
```

If the transcript lacks a creation verb, downgrade `create` to `none`. This prevents LLM hallucinations from ever triggering the create flow.

### Fix C: Raise MEDIUM_CREATE_CONFIDENCE threshold (Recommended)

Current: 0.70 allows create confirmations at fairly low confidence.
Proposed: Raise to 0.80 or even 0.85. Create actions should require high certainty since they're disruptive.

---

## 4. Key Files

| File | Lines | Role |
|------|-------|------|
| `apps/tango-voice/src/pipeline/voice-pipeline.ts` | 2595-2700 | Gate logic & create action handling |
| `apps/tango-voice/src/pipeline/voice-pipeline.ts` | 127-155 | `computeEffectiveThresholds()` |
| `apps/tango-voice/src/services/route-classifier.ts` | 549-574 | Create action parsing (no validation) |
| `apps/tango-voice/src/services/route-classifier.ts` | 619-632 | Create confidence thresholds |

---

## 5. Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Legitimate "create thread" commands blocked | Low | Creation verb regex is permissive; explicit requests like "create a thread about X" will pass |
| Callsign + create blocks intentional cross-agent thread creation | Low | If user says "Watson, create a post in latitude" the target name check will pass |
| Over-correction makes create unusable | Low | Only adding gates that match existing route protections |
