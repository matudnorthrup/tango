# Voice Close Word Latency

## Problem

Close word detection (e.g., "thank you", "go ahead Watson") has increasing latency correlated with conversation length. After short exchanges, close words are detected in ~1s. After longer rambling, multi-second delays occur between speaking the close word and hearing the confirmation earcon.

## Root Cause

Pipeline serialization during indicate capture creates a queue bottleneck.

### The flow

1. During indicate capture, each speech segment triggers `handleUtterance` which transitions the pipeline to `TRANSCRIBING` state
2. While in `TRANSCRIBING`, `isProcessing()` returns `true` — any new utterance arriving is **buffered** rather than processed
3. Whisper STT processing time scales linearly with audio length (~200ms for 2s audio, ~1-3s for 10-15s audio)
4. The close word arrives as a short utterance while the previous segment is still transcribing — it gets **buffered**
5. Only after the previous segment's transcription completes does the buffered close word get replayed and transcribed

**Total perceived delay** = remaining Whisper time for previous segment + Whisper time for close word (~200ms)

### Why it correlates with conversation length

Longer conversations involve longer individual speech segments (users ramble more, pause less). Longer segments = longer Whisper processing time = longer queue wait for the close word utterance.

### Key code path

```
AudioReceiver.onUtterance
  → VoicePipeline.handleUtterance
    → isProcessing() check (TRANSCRIBING = true)
    → bufferUtterance (QUEUED — waits for previous segment)
    → [previous segment completes]
    → replay buffered utterance
    → transcribe(wavBuffer) — Whisper STT
    → consumeIndicateCaptureUtterance — close word text matching
    → playFastCue('listening') — earcon
```

## Fix: Concurrent Close Word Probe

When indicate capture is active and a new utterance arrives during `TRANSCRIBING` state, start transcribing it immediately in parallel ("probe") while still buffering it as a fallback.

### How it works

1. New utterance arrives during `TRANSCRIBING` + indicate capture active
2. Utterance is buffered (normal path, for fallback)
3. Additionally, `startIndicateCloseWordProbe(wavBuffer)` fires concurrently
4. The probe sends the audio to Whisper immediately (doesn't wait for state machine)
5. If the probe detects a close word: plays the listening earcon immediately
6. Probe result is cached in `indicateProbeResult`
7. When the buffered utterance is eventually replayed through `handleUtterance`, it checks the cache:
   - Cache hit: uses the cached transcript (skips re-transcription entirely)
   - Cache miss (probe still in flight): transcribes normally, but checks `indicateProbeEarconPlayed` to avoid duplicate earcon

### Timing improvement

Before:
```
T=0.0  Previous segment transcribing (10s audio)
T=0.5  Close word arrives → BUFFERED
T=1.5  Previous segment transcription completes → replay buffer
T=1.7  Close word transcribed → earcon plays
       Perceived delay: 1.2s
```

After:
```
T=0.0  Previous segment transcribing (10s audio)
T=0.5  Close word arrives → buffered + probe starts
T=0.7  Probe transcription completes → earcon plays immediately
       Perceived delay: 0.2s
T=1.5  Previous segment completes → replay uses cached probe result
```

### Edge cases handled

- **Probe finishes after replay starts**: `indicateProbeEarconPlayed` flag checked after `await transcribe()` to suppress duplicate earcon
- **Indicate capture cleared during probe**: probe checks `indicateCaptureActive` before caching
- **Multiple utterances during TRANSCRIBING**: only one probe at a time (`indicateProbeInFlight` guard); subsequent utterances buffer normally
- **Probe failure**: caught and logged; falls back to normal buffer replay path

### Files changed

- `apps/tango-voice/src/pipeline/voice-pipeline.ts`
  - Added `indicateProbeInFlight`, `indicateProbeResult`, `indicateProbeEarconPlayed` fields
  - Added `startIndicateCloseWordProbe()` method
  - Modified `handleUtterance()` buffering section to start probe during indicate capture
  - Modified transcription step to use cached probe result
  - Modified earcon play to suppress duplicate when probe already played
  - Modified `clearIndicateCapture()` to reset probe state
