# Voice Decoder Corruption — Root Cause Analysis

**Date:** 2026-05-01
**Status:** Analysis complete, fix proposed

## Summary

The voice pipeline becomes completely deaf when Discord's DAVE (Discord Audio Visual Encryption) session state gets out of sync with the passthrough monkey-patch. Encrypted audio packets reach the Opus decoder as if they were plaintext Opus, producing continuous "The compressed data passed is corrupted" errors. Every audio packet fails, no speech is detected, and there is no self-recovery mechanism.

## Root Cause

### The audio packet path

1. Discord sends UDP audio packets (encrypted with xchacha20poly1305)
2. `@discordjs/voice` VoiceReceiver decrypts the transport-layer encryption (`parsePacket`, line ~2115 in `@discordjs/voice/dist/index.js`)
3. If a DAVE session exists, `daveSession.decrypt(packet, userId)` is called for end-to-end decryption (line ~2124)
4. The resulting Opus packet is pushed into the `AudioReceiveStream`
5. `AudioReceiver` pipes this stream through `prism-media` `opus.Decoder` to get PCM
6. PCM is fed to local VAD → Whisper STT → pipeline

### Where it breaks: DAVE decrypt fallback

In `@discordjs/voice/dist/index.js` line 967-969:

```js
decrypt(packet, userId) {
    const canDecrypt = this.session?.ready &&
        (this.protocolVersion !== 0 || this.session?.canPassthrough(userId));
    if (packet.equals(SILENCE_FRAME) || !canDecrypt || !this.session) return packet;
```

When `canDecrypt` is false, **the packet is returned as-is**. If the sender's Discord client is sending DAVE-encrypted audio, this means encrypted data is passed through as if it were Opus. The Opus native decoder (libopus via `@discordjs/opus`) cannot decode encrypted data and throws "The compressed data passed is corrupted".

### Why canDecrypt becomes false

The monkey-patch in `voice-connection.ts:18-39` calls `dave.session.setPassthroughMode(true, 86400)` on VoiceConnection state changes. This breaks when:

1. **DAVE session re-negotiation**: The DAVE session (`@snazzah/davey`) handles protocol transitions internally (via `pendingTransition`, `recoverFromInvalidTransition`). These create new session state WITHOUT triggering a VoiceConnection-level `stateChange` event, so the passthrough patch is never re-applied.

2. **Protocol version bump**: If Discord's server negotiates a higher DAVE protocol version (moving from v0 passthrough to v1+ encryption), the `protocolVersion` changes and `canPassthrough` is no longer checked — the `decrypt()` method tries actual decryption which may also fail if keys aren't properly established.

3. **Session ready flag**: If `this.session.ready` transiently becomes false during re-initialization, all packets pass through encrypted.

### Why the error persists (no self-recovery)

In `audio-receiver.ts:210-212`:

```typescript
decoder.on('error', (err: Error) => {
    console.error(`Local decoder error for ${userId}:`, err.message);
    this.closeLocalSession(userId, 'decoder-error');
});
```

When a decoder error occurs:
1. The session is closed (`closeLocalSession`)
2. The subscription is removed (`activeSubscriptions.delete`)
3. The next Discord `speaking` event (fires continuously while the user speaks) creates a new session
4. The new session gets the same encrypted packets → same error
5. This creates a rapid create→error→close→create loop

There is no:
- Error rate tracking
- Circuit breaker to stop retrying
- Mechanism to re-apply DAVE passthrough on decoder errors
- Auto-rejoin to reset the entire voice connection

### Why the corruption starts

Most likely trigger: a DAVE protocol transition. Discord periodically re-negotiates DAVE sessions (visible in logs as `[DAVE] Passthrough mode enabled` re-firing). If the transition happens between the old session being torn down and the new one being patched, there's a window where all packets are corrupted. Once the new session's `ready` flag or `canPassthrough()` returns an unexpected value, corruption becomes permanent.

## Fix Recommendations

### Fix 1: Circuit breaker with auto-rejoin (interim, high impact)

Add decoder error rate tracking to `AudioReceiver`. If errors exceed a threshold, stop listening and trigger a voice channel rejoin to fully reset the connection and DAVE session.

**File:** `apps/tango-voice/src/discord/audio-receiver.ts`

```typescript
// Add to AudioReceiver class
private consecutiveDecoderErrors = 0;
private static readonly DECODER_ERROR_THRESHOLD = 5;
private onDecoderCorruption: (() => void) | null = null;

// In constructor, accept a corruption callback
constructor(
    connection: VoiceConnection,
    onUtterance: UtteranceHandler,
    onRejectedAudio?: RejectedAudioHandler,
    onDecoderCorruption?: () => void,
) {
    // ...
    this.onDecoderCorruption = onDecoderCorruption ?? null;
}

// In subscribeWithLocalVad, modify the decoder error handler:
decoder.on('error', (err: Error) => {
    console.error(`Local decoder error for ${userId}:`, err.message);
    this.consecutiveDecoderErrors++;
    if (this.consecutiveDecoderErrors >= AudioReceiver.DECODER_ERROR_THRESHOLD) {
        console.error(`Decoder corruption threshold reached (${this.consecutiveDecoderErrors} errors). Triggering recovery.`);
        this.stop(); // Stop listening to prevent error loop
        this.onDecoderCorruption?.();
        return;
    }
    this.closeLocalSession(userId, 'decoder-error');
});

// Reset counter on successful decode:
decoder.on('data', (chunk: Buffer) => {
    this.consecutiveDecoderErrors = 0; // healthy data received
    // ... existing logic
});
```

**File:** `apps/tango-voice/src/index.ts` — wire the callback to leave+rejoin:

```typescript
const receiver = new AudioReceiver(connection, onUtterance, onRejected, () => {
    console.log('Decoder corruption detected, auto-rejoining voice channel...');
    handleLeave();
    handleJoin(guildId).catch(err =>
        console.error(`Recovery rejoin failed: ${err.message}`)
    );
});
```

### Fix 2: Re-apply DAVE passthrough on networking state changes (targeted)

The current monkey-patch only hooks VoiceConnection state changes. The DAVE session lives deeper in `state.networking.state.dave`. Hook the networking layer's state changes as well.

**File:** `apps/tango-voice/src/discord/voice-connection.ts`

```typescript
function enableDavePassthrough(connection: VoiceConnection): void {
    const patchDave = (state: any) => {
        const dave = state?.networking?.state?.dave;
        if (dave?.session) {
            try {
                dave.session.setPassthroughMode(true, 86400);
                console.log('[DAVE] Passthrough mode enabled');
            } catch (e: any) {
                console.log('[DAVE] Could not set passthrough:', e.message);
            }
        }
        // Also hook the networking layer's internal state changes
        const networking = state?.networking;
        if (networking && !networking.__davePatched) {
            networking.__davePatched = true;
            networking.on?.('stateChange', (_: any, netState: any) => {
                if (netState?.dave?.session) {
                    try {
                        netState.dave.session.setPassthroughMode(true, 86400);
                        console.log('[DAVE] Passthrough re-applied after networking state change');
                    } catch (e: any) {
                        console.log('[DAVE] Could not re-apply passthrough:', e.message);
                    }
                }
            });
        }
    };

    connection.on('stateChange', (_old: any, newState: any) => {
        patchDave(newState);
    });
    patchDave(connection.state);
}
```

### Fix 3: Health monitor integration

Add a `decoderErrors` counter to `HealthCounters` and alert when decoder errors spike, so the issue is visible even before auto-recovery kicks in.

**File:** `apps/tango-voice/src/services/health-snapshot.ts` — add `decoderErrors: number` to `HealthCounters`

## Recommended Implementation Order

1. **Fix 1 (circuit breaker)** — highest priority, prevents the system from being permanently deaf. Even if we can't prevent the corruption, we can recover from it automatically in ~5 seconds.
2. **Fix 2 (deeper DAVE patching)** — reduces the frequency of corruption by catching more DAVE session transitions.
3. **Fix 3 (health monitoring)** — visibility into how often this happens.

## Key Files

| File | Role |
|------|------|
| `apps/tango-voice/src/discord/audio-receiver.ts` | Creates Opus decoder, handles errors, manages sessions |
| `apps/tango-voice/src/discord/voice-connection.ts` | DAVE passthrough monkey-patch, connection lifecycle |
| `apps/tango-voice/src/index.ts` | Voice connection setup, reconnection handling |
| `node_modules/@discordjs/voice/dist/index.js:967` | DAVE decrypt — returns encrypted packet as-is on failure |
| `node_modules/@discordjs/voice/dist/index.js:2122-2124` | `parsePacket` — DAVE decrypt integration point |
| `node_modules/prism-media/src/opus/Opus.js:183` | Opus Decoder — throws on invalid data |
