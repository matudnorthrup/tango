# Voice Reply Routing Bug — Inbox Reply Routes to Wrong Agent

**Status**: Discovery complete, pending implementation
**Linear**: TBD
**Date**: 2026-04-29

## Problem

When a user listens to an agent's inbox message and then speaks a reply, the reply routes to the wrong agent (e.g., Malibu instead of Watson). This happens specifically within the first 15 seconds after the message plays.

## Root Cause

Two overlapping timing mechanisms interact incorrectly:

1. **Reply context** (45s): Set by `speakResponse` when reading a channel message from inbox. Stores the speaker's agent ID so the next utterance can route back to them.
2. **Followup prompt grace** (15s): Set by `allowFollowupPromptGrace` after inbox reads. Prevents the route classifier from switching the active channel for 15 seconds.

The reply context check in the utterance handler is gated behind `!preserveCurrentChannelForFollowup`:

```ts
// voice-pipeline.ts ~line 2618
if (!preserveCurrentChannelForFollowup && this.hasActiveReplyContext()) {
  // apply reply context — set focused agent to Watson, etc.
}
```

When you speak within 15 seconds of hearing Watson's inbox message:
- `preserveCurrentChannelForFollowup` is true (within grace window)
- The reply context block is **skipped entirely**
- No focused agent is set
- Dispatch falls back to `resolvePromptDispatchContext(activeChannel.name)`
- `resolvePromptAgent` finds no focused agent → uses the active channel's route agent
- If you're on Malibu's channel → routes to **Malibu** ❌

When you speak after 15 seconds but within 45 seconds:
- Grace window expired → `preserveCurrentChannelForFollowup` = false
- Reply context is applied → focused agent = Watson
- Routes to **Watson** ✓

**This is a timing-dependent bug**: speak quickly → wrong agent; speak slowly → correct agent.

## Design

Decouple **agent targeting** from **channel preservation**.

The followup prompt grace correctly prevents the route classifier from switching channels. But it should not prevent the reply context from setting the focused agent.

### Fix

In the utterance handler, split the reply context logic:

**Before** (current):
```ts
if (!preserveCurrentChannelForFollowup && this.hasActiveReplyContext()) {
  // apply reply context (channel switch + focused agent)
  replyContextApplied = true;
}
```

**After** (proposed):
```ts
if (this.hasActiveReplyContext()) {
  const replyAgentId = this.ctx.replyContextAgentId!;
  const replyChannelName = this.ctx.replyContextChannelName;
  const addressedDifferentAgent = explicitAddress?.kind === 'agent'
    && explicitAddress.agent.id !== replyAgentId;

  if (addressedDifferentAgent) {
    this.clearReplyContext();
  } else {
    // Always set the focused agent from reply context
    const replyAgent = this.voiceTargets.getAgent(replyAgentId);
    if (replyAgent) {
      this.setFocusedAgent(replyAgent);
    }

    // Only switch channels if followup grace isn't preserving the current channel
    if (!preserveCurrentChannelForFollowup && replyChannelName && this.router) {
      const currentChannel = this.router.getActiveChannel().name;
      if (currentChannel !== replyChannelName) {
        await this.router.switchTo(replyChannelName);
      }
    }

    replyContextApplied = true;
    this.clearReplyContext();
  }
}
```

Key change: **agent targeting always happens**; channel switching only happens if the followup grace isn't active.

### Files

| File | Lines | Change |
|------|-------|--------|
| `apps/tango-voice/src/pipeline/voice-pipeline.ts` | ~2617–2647 | Split reply context into agent-targeting + channel-switching; apply agent targeting regardless of followup grace |

## Test Plan

1. **Primary case**: Be on Malibu's channel, read Watson's inbox message, speak a reply within 5 seconds → verify it routes to Watson, not Malibu
2. **Channel switch case**: Be on Malibu's channel, reply after 20 seconds (grace expired) → verify it still switches to Watson's channel and routes correctly
3. **Override case**: Hear Watson's inbox message, say "Hey Malibu, do X" → verify it routes to Malibu (explicit address override)
4. **Same-agent case**: Be on Watson's channel, read Watson's message, reply quickly → verify still routes to Watson (no regression)
5. **Expiry case**: Hear Watson's message, wait 50 seconds, reply → verify normal routing (reply context expired)
