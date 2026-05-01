# Narration Guard False Positive Fix

**Linear:** [Narration Guard False Positive Fix](https://linear.app/seaside-hq/project/narration-guard-false-positive-fix-7831fad3d399)
**Status:** SHIPPED
**Commit:** cf76dec
**Deployed:** 2026-04-19
**Date:** 2026-04-19
**Origin:** Conflict Talk Thread Review audit

## Problem

`guardDeterministicNarrationText()` in `turn-executor.ts:1202-1226` replaces successful worker output with "Sorry, something went wrong before I could finish that step. Please try again." even when the worker executed successfully and all writes are confirmed.

## Root Cause

The guard function has a logic path that produces the wrong result for successful writes:

```typescript
function guardDeterministicNarrationText(text, receipts) {
  const stripped = stripWorkerDispatchTags(text);
  if (
    text.includes("<worker-dispatch")
    || looksLikeNarratedDispatch(stripped)       // ← OVERLY BROAD
    || looksLikeIncompleteWorkerSynthesis(stripped) // ← OVERLY BROAD
  ) {
    return receipts.some(receiptExpectsWriteButHasNoConfirmedWrite)
      ? buildDeterministicWriteGuardReply(receipts)  // write failed → guard reply
      : "Sorry, something went wrong...";            // ← THE BUG: write succeeded!
  }
  // ...
}
```

### Why this happens

1. The narrator model generates a response like: "I'm **checking** the note now — here's what was added..." or "Let me **open** the updated file..."
2. `looksLikeNarratedDispatch()` has extremely broad regex patterns (line 811-812):
   - `/\b(?:let me|i(?:'ll| will)|i(?:'m| am))\s+(?:grab|fetch|pull|open|check|look up|...)\b/i` — matches "Let me check" which is normal conversational narration
   - `/\b(?:grabbing|fetching|pulling|opening|checking|looking up|looking for|reading|reviewing|searching|...)\b/i` — matches ANY present participle of common verbs like "checking", "reading", "opening"
3. Guard enters the first `if` block (line 1207-1211)
4. All receipts have confirmed writes → `receiptExpectsWriteButHasNoConfirmedWrite` returns false for all
5. Falls to the else → generic "something went wrong" error — **even though the worker succeeded**

### The logic error

The else branch at line 1214 assumes: "if the text looks like a narrated dispatch AND no receipt has an unconfirmed write, then something went wrong." But this is wrong. The correct conclusion is: "if the text looks like a narrated dispatch AND all writes are confirmed, then the narrator is just narrating in a dispatch-like style — the work actually succeeded."

## Fix Specification

### Primary fix: Add receipt-success bypass in `guardDeterministicNarrationText`

When receipts confirm writes succeeded, the guard should not replace the narrator text with an error. Change the logic:

```typescript
function guardDeterministicNarrationText(text, receipts) {
  const stripped = stripWorkerDispatchTags(text);

  // If there are literal <worker-dispatch> tags, always strip them
  if (text.includes("<worker-dispatch")) {
    // Worker dispatch tags must always be stripped — they're internal markup.
    // If a write was expected but unconfirmed, use the write guard reply.
    // If writes succeeded (or no writes expected), use stripped text.
    return receipts.some(receiptExpectsWriteButHasNoConfirmedWrite)
      ? buildDeterministicWriteGuardReply(receipts)
      : stripped;
  }

  // For narrated-dispatch or incomplete-synthesis patterns:
  // Only block if NO receipt has a confirmed write.
  if (
    (looksLikeNarratedDispatch(stripped) || looksLikeIncompleteWorkerSynthesis(stripped))
    && noReceiptHasConfirmedWrite(receipts)
  ) {
    return receipts.some(receiptExpectsWriteButHasNoConfirmedWrite)
      ? buildDeterministicWriteGuardReply(receipts)
      : "Sorry, something went wrong before I could finish that step. Please try again.";
  }

  // Existing write-success guard for non-dispatch text
  if (
    noReceiptHasConfirmedWrite(receipts)
    && looksLikeDeterministicWriteSuccess(stripped)
  ) {
    return buildDeterministicWriteGuardReply(receipts);
  }

  return stripped;
}
```

Key change: For patterns detected by `looksLikeNarratedDispatch` or `looksLikeIncompleteWorkerSynthesis`, only enter the error branch when `noReceiptHasConfirmedWrite(receipts)` is true. If any receipt HAS a confirmed write, pass through the stripped text.

### Secondary: Narrow `looksLikeNarratedDispatch` regex patterns

The current patterns are too aggressive. Line 812 in particular:
```
/\b(?:grabbing|fetching|pulling|opening|checking|looking up|looking for|reading|reviewing|searching|dispatching|asking|handing off)\b/i
```

This matches ANY use of words like "checking", "reading", "reviewing" — which are perfectly normal in narration text like "The note is updated. Here's what I'm reading from the outline..." or "Checking the vault confirms everything landed."

Proposed narrowing:
- Remove standalone present participles that overlap with normal narration ("checking", "reading", "reviewing", "opening", "searching")
- Keep only dispatch-specific terms: "dispatching", "handing off", "routing"
- OR require these words to appear in dispatch-specific context (e.g., "checking with the worker" but not just "checking")

Similarly, line 811:
```
/\b(?:let me|i(?:'ll| will)|i(?:'m| am))\s+(?:grab|fetch|pull|open|check|look up|look for|read|review|search|dig into|compare|dispatch|route|ask|hand off)\b/i
```
This matches "Let me check the note" or "I'll review what was saved." These are natural narration phrases. Narrow to dispatch-specific verbs only: "dispatch", "route", "hand off", "ask [the worker]".

### Tests to add

Export `looksLikeNarratedDispatch`, `looksLikeIncompleteWorkerSynthesis`, and `guardDeterministicNarrationText` (or test via integration tests). Cover:

1. **Confirmed-write + narration-like text → should pass through** (the bug case)
2. **No confirmed write + narration-like text → should block** (existing correct behavior)
3. **Literal `<worker-dispatch>` tags → always strip, use write guard if needed**
4. **Normal narration text without dispatch patterns → pass through**
5. **Regression: "checking the note" should not trigger guard when writes confirmed**

## Validation Checklist

- [ ] False-positive narration guard: reproduce with confirmed-write receipt + narration text containing "checking"/"reading"/etc → should pass through
- [ ] Regression: genuine narrated dispatch (narrator says "waiting on worker results") with no confirmed write → should still block
- [ ] Regression: literal `<worker-dispatch>` tags → should strip and handle correctly
- [ ] Duplicate Obsidian notes: manual cleanup needed for "LDS Talk - How We Live and Disagree.md" vs "LDS Talk - Living and Disagreeing.md" — flag to stakeholder
- [ ] Intent classifier: verify "check the doc again" routes to tool after a recent tool use (may be fixed incidentally by this project or may need separate work)

## Key Files

- `packages/discord/src/turn-executor.ts` — lines 799-1226 (guard logic)
- `packages/discord/test/scheduled-turn-response.test.ts` — existing tests that reference the error message
- `packages/discord/src/deterministic-runtime.ts` — receipt types and narration prompt builder
