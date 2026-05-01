# Thread Routing Too Conservative — Callsign Threshold Fix

## Status: Shipped (2026-04-26)

## Problem
When the user says "Watson, for our lunch money thread...", it should route to the existing Lunch Money thread. Instead, it posts in Watson's main channel.

## Root Cause
Two issues found:

1. **Classifier timeout** — on the first attempt, the route classifier timed out (3s limit), so no routing was possible.

2. **Callsign threshold too aggressive** — `computeEffectiveThresholds` in `voice-pipeline.ts` unconditionally raised routing thresholds to 0.95/0.90 when a callsign was present, even when the user explicitly named the target thread. The classifier returned confidence 0.85 for "Lunch Money" which fell below both elevated thresholds.

The callsign priority gate (introduced in bb025c0, TGO-225) correctly blocked routing when the user didn't mention the target, but it also penalized the case where the user DID explicitly name the target.

## Fix
Commit `c1f5261`: Only elevate callsign thresholds when the target name is NOT mentioned in the transcript. When the user explicitly names the thread, normal thresholds (0.85/0.60) apply.

### Before
```typescript
if (explicitAddress?.kind === 'agent') {
    highThreshold = Math.max(highThreshold, 0.95);  // always raised
    mediumThreshold = Math.max(mediumThreshold, 0.90);  // always raised
    if (targetName && !mentioned) blocked = true;
}
```

### After
```typescript
if (explicitAddress?.kind === 'agent') {
    const targetMentioned = ...;
    if (!targetMentioned) {
        highThreshold = Math.max(highThreshold, 0.95);  // only when NOT mentioned
        mediumThreshold = Math.max(mediumThreshold, 0.90);
    }
    if (targetName && !targetMentioned) blocked = true;
}
```

## Key Files
- `apps/tango-voice/src/pipeline/voice-pipeline.ts` — `computeEffectiveThresholds` function
- `apps/tango-voice/test/voice-agent-routing.test.ts` — updated test assertions

## Linear
- Project: Thread Routing Too Conservative
- Issues: TGO-369 through TGO-374

## Related
- TGO-225 (bb025c0): Original callsign priority gate
- TGO-292 (6eb7793): Create action confidence gates (unaffected by this fix)
