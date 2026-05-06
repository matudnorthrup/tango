# Forum Thread Voice Context Discontinuity

**Linear:** https://linear.app/seaside-hq/project/forum-thread-voice-context-discontinuity-c21338577d8a

## Problem

When a user creates a forum post, discusses via text in the thread, then switches to voice — the voice interface has no context of the text conversation. It acts as if starting fresh.

## Root Cause

In `packages/discord/src/main.ts`, the voice turn handler builds the warm-start context prompt using `voiceRouterChannelId`:

```ts
discordChannelId: voiceRouterChannelId,
```

When a voice turn originates from a forum thread (i.e. `isVoiceThread` is true):
- `voiceRouterChannelId` resolves to the agent's **default voice channel** (line 3708-3709)
- `voiceRouterThreadId` correctly holds the forum thread ID (line 3711)

But `voiceRouterThreadId` was **never passed** to `buildWarmStartContextPrompt`.

The warm-start builder calls `listRecentMessagesForDiscordChannel(discordChannelId)` which queries stored messages by their Discord channel ID. Since text messages in the forum thread are stored with `discordChannelId = <threadId>`, querying by the default channel returns nothing.

The **text message path** (line 7532) correctly uses `threadId ?? routingChannelId`, but the voice path didn't mirror this pattern.

## Fix

One-line change — use the thread ID for warm-start when available:

```ts
// Before
discordChannelId: voiceRouterChannelId,

// After
discordChannelId: voiceRouterThreadId ?? voiceRouterChannelId,
```

This mirrors the text message path and ensures `listRecentMessagesForDiscordChannel` queries the correct forum thread.

## Why this didn't affect regular channels

In regular bot channels, voice isn't routed through a thread — `isVoiceThread` is false, so `voiceRouterChannelId` equals the actual channel where text messages live. The warm-start correctly finds prior messages.

## Verification

- Text in forum thread → voice in same thread should now have full context
- Regular channel voice should be unaffected (no thread ID, falls through to `voiceRouterChannelId`)
