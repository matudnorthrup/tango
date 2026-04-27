import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/claude.js', () => ({
  getResponse: vi.fn(async () => ({ response: 'unused', history: [] })),
  quickCompletion: vi.fn(async () => ''),
}));

vi.mock('../src/discord/audio-player.js', () => ({
  DiscordAudioPlayer: class {
    attach() {}
    isPlaying() { return false; }
    isWaiting() { return false; }
    isPlayingEarcon() { return false; }
    isPlayingAnyEarcon() { return false; }
    async playEarcon() {}
    playEarconSync() {}
    async playStream() {}
    async waitForPlaybackSettled() {}
    startWaitingLoop() {}
    stopWaitingLoop() {}
    stopPlayback() {}
  },
}));

vi.mock('../src/discord/audio-receiver.js', () => ({
  AudioReceiver: class {
    constructor() {}
    start() {}
    stop() {}
    hasActiveSpeech() { return false; }
    getLastSpeechStartedAt() { return 0; }
  },
}));

vi.mock('../src/audio/earcons.js', () => ({
  initEarcons: vi.fn(),
}));

vi.mock('../src/services/tts.js', () => ({
  textToSpeechStream: vi.fn(async () => Buffer.from('tts')),
}));

vi.mock('../src/services/whisper.js', () => ({
  transcribe: vi.fn(async () => ''),
}));

vi.mock('../src/services/voice-settings.js', () => ({
  getVoiceSettings: vi.fn(() => ({
    gated: true,
    audioProcessing: 'local',
    silenceThreshold: 0.01,
    silenceDuration: 1500,
    endpointingMode: 'silence',
    indicateCloseWords: ["i'm done", "i'm finished", 'go ahead'],
    indicateTimeoutMs: 20_000,
    sttStreamingEnabled: false,
    sttStreamingChunkMs: 900,
    sttStreamingMinChunkMs: 450,
    sttStreamingOverlapMs: 180,
    sttStreamingMaxChunks: 8,
  })),
  setSilenceDuration: vi.fn(),
  setSpeechThreshold: vi.fn(),
  setGatedMode: vi.fn(),
  setEndpointingMode: vi.fn(),
  setIndicateTimeoutMs: vi.fn(),
  resolveNoiseLevel: vi.fn(() => 0.01),
  getNoisePresetNames: vi.fn(() => ['low', 'medium', 'high']),
}));

vi.mock('../src/services/tango-voice.js', () => ({
  shouldUseTangoVoiceBridge: vi.fn(() => true),
  requestTangoVoiceTurn: vi.fn(async () => ({
    responseText: 'unused',
    providerName: 'test-provider',
  })),
}));

import { VoicePipeline } from '../src/pipeline/voice-pipeline.js';
import { createTransientContext, resetTransientContext } from '../src/pipeline/transient-context.js';

describe('reply context', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makePipeline() {
    return new VoicePipeline({} as any);
  }

  it('tracks lifecycle and resets reply context defaults', () => {
    const standaloneCtx = createTransientContext();
    expect(standaloneCtx.replyContextAgentId).toBeNull();
    expect(standaloneCtx.replyContextSessionKey).toBeNull();
    expect(standaloneCtx.replyContextChannelName).toBeNull();
    expect(standaloneCtx.replyContextUntil).toBe(0);

    const pipeline = makePipeline();
    const ctx = (pipeline as any).ctx;

    expect((pipeline as any).hasActiveReplyContext()).toBe(false);

    (pipeline as any).setReplyContext('watson', 'veo:watson', 'watson-thread', 45_000);
    expect(ctx.replyContextAgentId).toBe('watson');
    expect(ctx.replyContextSessionKey).toBe('veo:watson');
    expect(ctx.replyContextChannelName).toBe('watson-thread');
    expect(ctx.replyContextUntil).toBeGreaterThan(Date.now());
    expect((pipeline as any).hasActiveReplyContext()).toBe(true);

    (pipeline as any).clearReplyContext();
    expect(ctx.replyContextAgentId).toBeNull();
    expect(ctx.replyContextSessionKey).toBeNull();
    expect(ctx.replyContextChannelName).toBeNull();
    expect(ctx.replyContextUntil).toBe(0);
    expect((pipeline as any).hasActiveReplyContext()).toBe(false);

    (pipeline as any).setReplyContext('malibu', 'veo:malibu', 'malibu-thread', 45_000);
    resetTransientContext(ctx);
    expect(ctx.replyContextAgentId).toBeNull();
    expect(ctx.replyContextSessionKey).toBeNull();
    expect(ctx.replyContextChannelName).toBeNull();
    expect(ctx.replyContextUntil).toBe(0);

    pipeline.stop();
  });

  it('expires reply context after its deadline', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-26T12:00:00.000Z'));

    const pipeline = makePipeline();

    (pipeline as any).setReplyContext('watson', 'veo:watson', 'watson-thread', 1_000);
    expect((pipeline as any).hasActiveReplyContext()).toBe(true);

    vi.advanceTimersByTime(999);
    expect((pipeline as any).hasActiveReplyContext()).toBe(true);

    vi.advanceTimersByTime(1);
    expect((pipeline as any).hasActiveReplyContext()).toBe(false);

    pipeline.stop();
  });

  it('overwrites reply context with the most recent notification', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-26T12:00:00.000Z'));

    const pipeline = makePipeline();
    const ctx = (pipeline as any).ctx;

    (pipeline as any).setReplyContext('watson', 'veo:watson', 'watson-thread', 10_000);
    vi.advanceTimersByTime(500);
    (pipeline as any).setReplyContext('malibu', 'veo:malibu', 'malibu-thread', 45_000);

    expect(ctx.replyContextAgentId).toBe('malibu');
    expect(ctx.replyContextSessionKey).toBe('veo:malibu');
    expect(ctx.replyContextChannelName).toBe('malibu-thread');
    expect(ctx.replyContextUntil).toBe(Date.now() + 45_000);
    expect((pipeline as any).hasActiveReplyContext()).toBe(true);

    pipeline.stop();
  });
});
