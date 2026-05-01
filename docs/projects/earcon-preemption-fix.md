# Earcon Preemption Fix

**Status:** Shipped
**Date:** 2026-04-26
**Linear:** TGO-381 through TGO-385
**Commit:** ae5be75

## Problem

When idle notify nudge and indicate-capture still-listening earcons fire near-simultaneously, one overrides the other because Discord.js `AudioPlayer.play()` replaces currently-playing audio. The nudge earcon would get logged but never actually heard.

## Fix

Added `isPlayingAnyEarcon()` to `DiscordAudioPlayer` and guards at both earcon call sites:

1. **Indicate-capture timeout** (`voice-pipeline.ts:1123`): Skips `still-listening` if any earcon is already playing.
2. **Idle notification** (`voice-pipeline.ts:6838`): Skips `nudge` if any earcon is already playing, returns `nudge-skipped-earcon-active` delivery result.

Both paths log when they skip, making collisions visible in logs.

## Key Files

- `apps/tango-voice/src/discord/audio-player.ts` — `isPlayingAnyEarcon()` method
- `apps/tango-voice/src/pipeline/voice-pipeline.ts` — guards at both earcon sites
