# Conflict Talk Thread Review

**Linear:** [Conflict Talk Thread Review](https://linear.app/seaside-hq/project/conflict-talk-thread-review-203d0e2c0846)
**Status:** Discovery complete
**Date:** 2026-04-19

## Background

Stakeholder reported the "Conflict Talk" thread (in the "projects" category) had multiple failure modes. This review audits the full conversation history to categorize each failure and map it to known/in-flight fixes.

## Threads Reviewed

The "Conflict Talk" thread is actually **two threads** in the same Discord channel (`1480419557565796353`, the "projects" category channel):

1. **History Books thread** (channel `1495415258410389596`) — started as voice conversation via `project:latitude` session, later continued as text via `topic:6571d32a`
2. **Conflict and Disagreement thread** (channel `1495477838449475754`) — text conversation via `topic:cb2d28b8`, slug `conflict-and-disagreement`

Both conversations happened on 2026-04-19. All interactions were with Watson.

## Timeline of Failures

### Thread 1: History Books (channel 1495415258410389596)

| Time | Msg ID | What happened | User saw |
|------|--------|---------------|----------|
| 13:26 | 1961 | User asks to create "History Books" thread via voice | (inbound) |
| 13:28 | 1962 | Watson creates Obsidian note, asks for preferences | Normal response |
| 13:37–13:43 | 1963–1966 | Follow-up Q&A about book recommendations, Watson asks where to add | Normal |
| **13:46** | **1972** | **User says "use the notes you created earlier." Worker executes `notes.note_update` successfully (per deterministic summary msg 1973). Obsidian note IS updated. But narration guard fires — narrator output matched `looksLikeNarratedDispatch` or `looksLikeIncompleteWorkerSynthesis` patterns.** | **"Sorry, something went wrong before I could finish that step. Please try again."** |
| 13:46 | 1973 | Deterministic turn summary confirms execution was successful | (internal) |
| — | — | **3-hour gap** — user doesn't come back until 16:46 | — |
| 16:46 | 1980 | User types "can you try again? you never responded to my last message" — session has changed to `topic:6571d32a` (new topic session, NOT the original `project:latitude` voice session) | (inbound) |
| 16:47 | 1981 | Watson successfully updates the note with new book recommendations | Normal response |

### Thread 2: Conflict and Disagreement (channel 1495477838449475754)

| Time | Msg ID | What happened | User saw |
|------|--------|---------------|----------|
| 17:35 | 1988 | User asks for help preparing LDS talk on disagreement, requests Obsidian draft | (inbound) |
| 17:35 | 1989 | Watson asks where to save in vault | Normal |
| 17:35 | 1990 | User says "Root." | (inbound) |
| **17:37** | **1991** | **Worker executes `notes.note_update` successfully (per deterministic summary msg 1992). File "LDS Talk - How We Live and Disagree.md" IS created in Obsidian vault. But narration guard fires again — same pattern as above. Latency: 105 seconds.** | **"Sorry, something went wrong before I could finish that step. Please try again."** |
| 17:38 | 1993 | User says "Try again please." | (inbound) |
| **17:39** | **1994** | Watson retries, creates SECOND file "LDS Talk - Living and Disagreeing.md" (different title). This time narration passes the guard. | Normal response — but now there are **two duplicate notes** in the vault |
| 17:42 | 1996 | User says "Hmm. Not seeing those things in the doc. Check again" | (inbound) |
| **17:43** | **1997** | **Classifier marks turn as "conversational" (fallback). Watson says "I need to answer that directly from the current conversation context, not start another worker task." — effectively refuses to check the doc.** | **"Sorry, I need to answer that directly from the current conversation context, not start another worker task."** |

## Failure Classification

### Failure 1: False "something went wrong" on successful worker execution (msgs 1972, 1991)

**What happened:** The deterministic routing worker (`personal-assistant`) successfully wrote to Obsidian both times. The governance log shows `obsidian` permission checks all granted. Model runs show `is_error=0` for all runs. But the **narration guard** (`guardDeterministicNarrationText` in `turn-executor.ts:1202`) replaced the narrator's output with the generic error message.

**Root cause:** The narration guard checks if the narrator's text `looksLikeNarratedDispatch()` or `looksLikeIncompleteWorkerSynthesis()`. These regex patterns (lines 805-817, 1121-1131) are quite broad — e.g., `/\b(?:let me|i(?:'ll| will)|i(?:'m| am))\s+(?:grab|fetch|pull|open|check|look up|...)\b/i` would match normal conversational text like "Let me check the note" or "I'm looking for the right file." When the guard fires and no receipt expects an unconfirmed write (i.e., the write DID succeed), it falls through to the generic "Sorry, something went wrong" message (line 1214).

**Map to known fix:** This is a **NEW issue** — not covered by any existing fix:
- Silent Message Failures (4a74a3f): Handles delivery failures, not narration guard false positives
- Reply-in-Context (6afe84b): Handles context confusion, not narration guard
- Sierra Duplicate (f3608be): Handles false duplicate detection, not narration guard

**Evidence:** Both metadata records show `attemptCount: 2, attemptedRetry: true` — the system tried once, the narration guard blocked it, then it retried and the retry also got blocked. The deterministic summary proves the worker succeeded.

### Failure 2: Duplicate Obsidian notes from retry (vault state)

**What happened:** After the first "something went wrong" on the Conflict Talk thread, the user asked Watson to try again. Watson created a second note with a slightly different title ("Living and Disagreeing" vs "How We Live and Disagree"). Now there are two notes in the vault root covering the same content.

**Root cause:** Direct consequence of Failure 1. The user was told to "try again" because the system falsely claimed failure. Watson didn't check for the existing note before creating a new one.

**Map to known fix:** **NEW issue** — downstream effect of Failure 1. Also a gap in the notes.note_update intent: no idempotency check for recently-created notes.

### Failure 3: Conversational fallback refuses tool-appropriate request (msg 1997)

**What happened:** User asked Watson to "check again" on the doc content. The intent classifier categorized this as "conversational" rather than routing to a worker. Watson responded with "Sorry, I need to answer that directly from the current conversation context, not start another worker task." This is an unhelpful response — the user clearly wanted Watson to re-read/verify the Obsidian note.

**Root cause:** The intent classifier's conversational-vs-tool boundary isn't handling "check again" / "verify the doc" properly. The `deterministicFallbackReason` is "Intent classifier marked this turn as conversational." The classifier was likely influenced by the retry/failure context and decided this was meta-conversation rather than a new tool request.

**Map to known fix:** **Partially covered** by Reply-in-Context fix (6afe84b) which added context-confusion detection, but that fix targets the "reply in context" failure loop, not intent misclassification on verification requests. This is a **NEW edge case** in the intent classifier.

### Failure 4: Session split between voice and text (threads 1 only)

**What happened:** The History Books conversation started as a voice session (`project:latitude`, source=`tango`). When the user came back 3 hours later via text, a new session was created (`topic:6571d32a`, source=`discord`). Watson successfully handled the retry because warm-start context bridged the gap.

**Map to known fix:** This is **working as designed** after the Reply-in-Context fix (6afe84b) which added thread-scoped sessions. The warm start (`warmStartContextChars: 8081` on the text session) correctly carried over context from the earlier voice session. **No issue here.**

## Summary Matrix

| # | Failure | Severity | Status | Mapped Fix |
|---|---------|----------|--------|------------|
| 1 | Narration guard false positive — blocks successful worker output | **High** | NEW | None — narration guard regex too broad |
| 2 | Duplicate Obsidian notes from false-failure retry | Medium | NEW | Downstream of #1; also missing idempotency |
| 3 | Intent classifier miscategorizes "check the doc" as conversational | Medium | NEW edge case | Partially: Reply-in-Context (6afe84b) |
| 4 | Session split voice→text | None | Working | Reply-in-Context (6afe84b) ✅ |

## Dead Letters & Model Run Errors

- **Zero dead letters** for either channel — no delivery failures occurred
- **All model runs** show `is_error=0` — no provider-level failures
- **No sub-agent runs** for these sessions — all work done via deterministic worker dispatch

## Recommendations

### Priority 1: Fix narration guard false positives (Failure 1)
The narration guard in `guardDeterministicNarrationText()` (turn-executor.ts:1202-1226) is the root cause. When:
- The narrator text matches `looksLikeNarratedDispatch` or `looksLikeIncompleteWorkerSynthesis` patterns
- But the receipts confirm the write was successful (no receipt expects an unconfirmed write)

...the guard should pass through the narrator's text (or synthesize a success message from receipts), not replace it with "something went wrong." The current logic at line 1211-1214 falls to the generic error when no receipt "expects write but has no confirmed write" — but this is the WRONG branch for the case where writes actually succeeded.

**Specific fix:** When `receipts.some(r => receiptHasConfirmedWriteOutcome(r))` is true, don't replace the text — the worker succeeded. The guard should only fire when no receipt confirms a write.

### Priority 2: Intent classifier "check again" handling (Failure 3)
After a failed-or-retried tool use, user messages like "check again", "look at the doc", "verify" should be classified as tool requests, not conversational turns. This may need a classifier prompt update or a heuristic that detects verification-after-failure patterns.

### Priority 3: Note creation idempotency (Failure 2)
Before creating a new Obsidian note, the personal-assistant worker should check for recently-created notes with similar titles. This prevents the duplicate-note problem when users retry after false failures.

## Key Files

- `packages/discord/src/turn-executor.ts` — narration guard logic (lines 799-1226)
- `docs/projects/silent-message-failures.md` — related but different failure class
- `docs/projects/reply-in-context-bug.md` — related session isolation fix
- Obsidian vault: `/Users/devinnorthrup/Documents/main/` — two duplicate LDS talk notes exist
