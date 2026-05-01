# Narration Guard Read-Query Gap

**Status:** In Progress
**Linear:** [Project](https://linear.app/seaside-hq/project/narration-guard-read-query-gap-a4a5b4ebb7ee)
**Date:** 2026-04-21

## Problem

Malibu returned "Sorry, something went wrong before I could finish that step. Please try again." on a legitimate health trend analysis query (msg 2119). The worker (health-analyst) completed successfully with a read-only receipt, but the narration guard suppressed the response.

## Root Cause

`guardDeterministicNarrationText` in `turn-executor.ts` (line 1204-1238) has a gap for read-only queries:

1. **Line 1221**: `noReceiptHasConfirmedWrite(receipts)` is always `true` for read queries — there are no writes to confirm
2. **Line 1223**: `receiptExpectsWriteButHasNoConfirmedWrite` is `false` for read receipts (mode="read")
3. **Result**: If narration text matches `looksLikeNarratedDispatch` or `looksLikeIncompleteWorkerSynthesis` patterns (e.g. "let me pull up", "grabbing", "fetching"), it falls into the generic suppression: `"Sorry, something went wrong..."`

The cf76dec fix (narration guard false positive) added a receipt-success bypass, but it only checks for **confirmed writes**. Read-only queries have no writes, so they can never pass the bypass.

## Fix

**Add a completed-receipt bypass**: If any receipt has `status === "completed"`, the worker actually ran and returned data. The narration text is the real synthesis, not a hallucinated dispatch. Pass it through.

In `guardDeterministicNarrationText`, before the narrated-dispatch check (line 1216), add:

```typescript
// If any receipt completed successfully, the worker ran — narration is real, not hallucinated
const anyReceiptCompleted = receipts.some(r => r.status === "completed");
if (anyReceiptCompleted) {
  return stripped;
}
```

This is safe because:
- Completed receipts mean the worker executed and returned data
- Write receipts with confirmed writes already bypass via `receiptHasConfirmedWriteOutcome`
- Failed/skipped receipts still hit the guard (correct behavior)
- The `looksLikeDeterministicWriteSuccess` check (line 1231) is redundant when receipt is completed, but harmless

## Affected queries

Any read-only worker path: health-analyst, nutrition queries, memory queries, trend analysis. All use mode="read" receipts.

## Key Files

- `packages/discord/src/turn-executor.ts` — `guardDeterministicNarrationText` (line 1204)
- `packages/discord/src/deterministic-runtime.ts` — `ExecutionReceipt` interface
- `packages/discord/test/turn-executor.test.ts` — guard tests

## Related

- cf76dec: narration guard false positive fix (write-only bypass)
- TGO-232: discovery investigation
- TGO-233: implementation
- TGO-234: unit tests
