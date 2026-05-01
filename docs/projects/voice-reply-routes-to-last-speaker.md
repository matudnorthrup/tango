# Voice Reply Routes to Last Speaker

**Status**: Implementation
**Linear**: [Voice Reply Routes to Last Speaker](https://linear.app/seaside-hq/project/voice-reply-routes-to-last-speaker-28ddf9f15767)
**Issues**: TGO-386 through TGO-391
**Date**: 2026-04-26

## Problem

When user speaks after hearing an idle notification or TTS playback from an agent, the reply gets routed to the wrong agent. The pipeline has no "reply context" — it runs fresh routing (route classifier + address detection) on every utterance with no awareness of what just spoke.

## Root Cause

- `lastSpokenSpeakerAgentId` exists but is only used in `shouldPreserveCurrentChannelForFollowupPrompt`, which requires the user to **already be on the correct channel** and have heard a channel message (not a notification)
- `followupPromptGrace` (15s) preserves the current channel after TTS, but doesn't affect agent routing — just prevents channel switching
- Idle notifications (`deliverIdleNotification`) play a nudge earcon and log the message, but set NO reply context (no focused agent, no speaker ID propagation)
- The `focusedAgentId` concept is never set by notifications or TTS playback completion

## Design

### New transient context fields

Add to `TransientContext`:
```typescript
replyContextAgentId: string | null;       // agent that just spoke/notified
replyContextSessionKey: string | null;    // session key for that agent's channel
replyContextChannelName: string | null;   // channel name to route to
replyContextUntil: number;                // timestamp when context expires
```

### Set reply context on:

1. **Idle notification delivery** — when `deliverIdleNotification` succeeds, set reply context from `item.speakerAgentId` and `item.sessionKey`. Look up the channel name from the session key.
2. **TTS playback of channel message** — when `speakResponse` completes for a channel message (not inbox/system), set reply context from `speakerAgentId`.
3. **Auto-read active channel** — when `readReadyForActiveChannel` reads a queued response, set reply context from the response's speaker agent.

### Use reply context:

In the utterance handler (around line 2552), BEFORE running the route classifier:
1. Check if `replyContextUntil > Date.now()` and reply context is set
2. If user has an explicit address for a **different** agent → ignore reply context (override)
3. If user has NO explicit address OR explicit address matches the reply context agent → use reply context:
   - Set `focusedAgentId` temporarily to the reply context agent
   - Switch to `replyContextChannelName` if not already there
   - Skip the route classifier (treat as preserveCurrentChannelForFollowup)
4. Consume the reply context after use

### Expiry: 45 seconds

The reply context expires after 45s (tunable constant). This is longer than `FOLLOWUP_PROMPT_GRACE_MS` (15s) because:
- Idle notifications are async — user may take time to formulate a response
- 15s is too short for "hear nudge → think → speak reply"
- 60s+ risks stale context causing surprise routing

### Override rules:
- Explicit wake word for a **different** agent → override (clear reply context, route to addressed agent)
- Explicit wake word for the **same** agent → use reply context (enhances the routing)
- No wake word → use reply context
- Reply context expired → normal routing

## Key Files

| File | Role |
|------|------|
| `apps/tango-voice/src/pipeline/transient-context.ts` | Add reply context fields |
| `apps/tango-voice/src/pipeline/voice-pipeline.ts` | Set context on notification/TTS, use context in utterance handler |

## Test Plan

1. Queue mode: send a message to Watson, wait for idle notification nudge, speak a reply → should route to Watson
2. Wait mode: hear Sierra's response, speak a follow-up → should route to Sierra
3. Override: hear notification from Watson, say "Hey Sierra, do X" → should route to Sierra (override)
4. Expiry: hear notification, wait 50s, speak → should route normally (expired)
5. Multiple notifications: hear Watson nudge then Sierra nudge → reply should go to Sierra (most recent)
