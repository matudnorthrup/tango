/**
 * TGO-751 regression tests — unintentional dispatch without wake words.
 *
 * Root cause: reply-context application promoted the reply agent to the
 * persistent focused agent (the state behind the explicit "focus on X"
 * command). Focus has no TTL, so focusedPromptBypass disabled the wake-word
 * gate for the rest of the session and every STT hallucination dispatched.
 *
 * Secondary: buffered utterances replayed at pipeline completion evaluated
 * grace against the fresh window that opens with the ready cue, and
 * grace-seeded indicate captures nudged forever instead of expiring.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Service mocks (mirrors foundation-wait-gated harness) ──────────────────

let transcribeImpl: (buf: Buffer, options?: any) => Promise<string>;

vi.mock('../src/services/whisper.js', () => ({
  transcribe: vi.fn(async (buf: Buffer, options?: any) => transcribeImpl(buf, options)),
  transcribeCommandTail: vi.fn(async () => null),
}));

let getResponseImpl: (user: string, msg: string) => Promise<{ response: string }>;

vi.mock('../src/services/claude.js', () => ({
  getResponse: vi.fn(async (user: string, msg: string) => getResponseImpl(user, msg)),
  quickCompletion: vi.fn(async () => ''),
}));

vi.mock('../src/services/tts.js', () => ({
  textToSpeechStream: vi.fn(async () => Buffer.from('tts-audio')),
}));

let receiverHasActiveSpeech = false;
let receiverLastSpeechStartedAt = 0;

vi.mock('../src/discord/audio-receiver.js', () => ({
  AudioReceiver: class {
    private onUtterance: any;
    constructor(_conn: any, onUtterance: any, _onRejected: any) {
      this.onUtterance = onUtterance;
    }
    start() {}
    stop() {}
    hasActiveSpeech() { return receiverHasActiveSpeech; }
    getLastSpeechStartedAt() { return receiverLastSpeechStartedAt; }
    simulateUtterance(userId: string, wav: Buffer, durationMs: number) {
      return this.onUtterance(userId, wav, durationMs);
    }
  },
}));

const earconHistory: string[] = [];
let playerIsPlaying = false;
let playerIsWaiting = false;

vi.mock('../src/discord/audio-player.js', () => ({
  DiscordAudioPlayer: class {
    attach() {}
    isPlaying() { return playerIsPlaying; }
    isWaiting() { return playerIsWaiting; }
    isPlayingEarcon(_name?: string) { return false; }
    isPlayingAnyEarcon() { return false; }
    async playEarcon(name: string) { earconHistory.push(name); }
    playEarconSync(name: string) { earconHistory.push(name); }
    async playStream(_stream: any) { playerIsPlaying = true; }
    startWaitingLoop() { playerIsWaiting = true; }
    stopWaitingLoop() { playerIsWaiting = false; }
    stopPlayback(_reason?: string) {
      playerIsPlaying = false;
      playerIsWaiting = false;
    }
  },
}));

vi.mock('../src/audio/earcons.js', () => ({
  initEarcons: vi.fn(),
}));

let voiceSettings: any;

vi.mock('../src/services/voice-settings.js', () => ({
  getVoiceSettings: vi.fn(() => voiceSettings),
  setSilenceDuration: vi.fn(),
  setSpeechThreshold: vi.fn(),
  setGatedMode: vi.fn(),
  setEndpointingMode: vi.fn(),
  setIndicateTimeoutMs: vi.fn(),
  resolveNoiseLevel: vi.fn(() => 0.01),
  getNoisePresetNames: vi.fn(() => ['low', 'medium', 'high']),
}));

vi.mock('../src/services/tango-voice.js', () => ({
  shouldUseTangoVoiceBridge: vi.fn(() => false),
  requestTangoVoiceTurn: vi.fn(async () => {
    throw new Error('tango voice bridge should be disabled in unit tests');
  }),
}));

import { VoicePipeline } from '../src/pipeline/voice-pipeline.js';
import { getResponse } from '../src/services/claude.js';

const getResponseMock = vi.mocked(getResponse);

// ── Helpers ────────────────────────────────────────────────────────────────

function makePipeline() {
  return new VoicePipeline({} as any);
}

async function simulateUtterance(pipeline: VoicePipeline, userId: string, transcript: string) {
  transcribeImpl = async () => transcript;
  const receiver = (pipeline as any).receiver;
  await receiver.simulateUtterance(userId, Buffer.from('fake-audio'), 1500);
  await new Promise((r) => setTimeout(r, 25));
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('TGO-751: wake-word gate bypass regressions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    earconHistory.length = 0;
    playerIsPlaying = false;
    playerIsWaiting = false;
    receiverHasActiveSpeech = false;
    receiverLastSpeechStartedAt = 0;
    vi.useRealTimers();
    voiceSettings = {
      gated: true,
      audioProcessing: 'local',
      silenceThreshold: 0.01,
      silenceDuration: 1500,
      endpointingMode: 'silence',
      indicateCloseWords: ["i'm done", "i'm finished", 'go ahead'],
      indicateDismissWords: ['thanks', 'thank you', "that's all", "that'll do"],
      indicateTimeoutMs: 20000,
      sttStreamingEnabled: false,
      sttStreamingChunkMs: 900,
      sttStreamingMinChunkMs: 450,
      sttStreamingOverlapMs: 180,
      sttStreamingMaxChunks: 8,
      sttCommandTailProbeEnabled: true,
      sttCommandTailMs: 2200,
      sttCommandTailMinDurationMs: 1200,
    };
    transcribeImpl = async () => '';
    getResponseImpl = async () => ({ response: 'Test response.' });
  });

  it('reply-context focus is scoped to the dispatch — the gate closes again afterwards', async () => {
    const pipeline = makePipeline();
    const ctx = (pipeline as any).ctx;
    const agent = (pipeline as any).voiceTargets.listAgents()[0];
    expect(agent).toBeTruthy();

    // An agent response just played: reply context primed, grace window open.
    (pipeline as any).setReplyContext(agent.id, null, null, 45_000);
    ctx.gateGraceUntil = Date.now() + 5_000;

    // Wake-less follow-up inside grace — legitimate, must dispatch.
    await simulateUtterance(pipeline, 'user1', 'yes please go check on that for me');
    expect(getResponseMock.mock.calls.length).toBe(1);

    // The fix: applying reply context must not leave the agent focused.
    expect(ctx.focusedAgentId).toBeNull();

    // Gate closed again: a wake-less hallucination outside grace is discarded.
    ctx.gateGraceUntil = 0;
    ctx.promptGraceUntil = 0;
    playerIsPlaying = false;
    await simulateUtterance(pipeline, 'user1', 'you, bye bye.');
    expect(getResponseMock.mock.calls.length).toBe(1);
  });

  it('buffered utterance replay does not ride the grace window that opens at pipeline completion', async () => {
    const pipeline = makePipeline();
    const ctx = (pipeline as any).ctx;
    const receiver = (pipeline as any).receiver;

    // Utterance A: addressed prompt whose response we hold open.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    getResponseImpl = async () => {
      await gate;
      return { response: 'slow response' };
    };
    transcribeImpl = async () => 'hey watson, how far away is the hotel';
    const aPromise = receiver.simulateUtterance('user1', Buffer.from('audio-a'), 1500);
    await new Promise((r) => setTimeout(r, 25));

    // Utterance B: wake-less ambient speech while A is processing — buffered,
    // gate closed at capture time.
    transcribeImpl = async () => 'valero gas station in fairfield california';
    await receiver.simulateUtterance('user1', Buffer.from('audio-b'), 1500);

    // A completes; its ready cue opens a fresh grace window and B replays.
    release();
    await aPromise;
    await new Promise((r) => setTimeout(r, 60));

    // B must be gated using its at-capture grace snapshot (closed), not the
    // fresh window: no second dispatch, no indicate capture seeded.
    expect(getResponseMock.mock.calls.length).toBe(1);
    expect(ctx.indicateCaptureActive).toBe(false);
  });

  it('wake-less farewell hallucination inside grace is ignored instead of dispatched', async () => {
    const pipeline = makePipeline();
    const ctx = (pipeline as any).ctx;

    ctx.gateGraceUntil = Date.now() + 5_000;
    await simulateUtterance(pipeline, 'user1', 'you, bye!');

    expect(getResponseMock).not.toHaveBeenCalled();
    expect(ctx.indicateCaptureActive).toBe(false);
  });

  it('wake-less truncated gratitude hallucination inside grace is ignored instead of dispatched', async () => {
    const pipeline = makePipeline();
    const ctx = (pipeline as any).ctx;

    ctx.gateGraceUntil = Date.now() + 5_000;
    await simulateUtterance(pipeline, 'user1', 'Thank you. you but');

    expect(getResponseMock).not.toHaveBeenCalled();
    expect(ctx.indicateCaptureActive).toBe(false);
  });

  it('wake-less farewell hallucination inside indicate grace does not seed capture', async () => {
    voiceSettings.endpointingMode = 'indicate';
    const pipeline = makePipeline();
    const ctx = (pipeline as any).ctx;

    ctx.gateGraceUntil = Date.now() + 5_000;
    await simulateUtterance(pipeline, 'user1', 'you, bye!');

    expect(getResponseMock).not.toHaveBeenCalled();
    expect(ctx.indicateCaptureActive).toBe(false);
  });

  it('single-token hallucination inside indicate grace does not hold the gate open', async () => {
    voiceSettings.endpointingMode = 'indicate';
    const pipeline = makePipeline();
    const ctx = (pipeline as any).ctx;

    ctx.gateGraceUntil = Date.now() + 5_000;
    await simulateUtterance(pipeline, 'user1', 'you');

    expect(getResponseMock).not.toHaveBeenCalled();
    expect(ctx.indicateCaptureActive).toBe(false);
    expect(ctx.indicateCaptureSegments).toEqual([]);
  });

  it('grace-seeded indicate capture gets one nudge, then expires with the gate-closed cue', async () => {
    voiceSettings.endpointingMode = 'indicate';
    const pipeline = makePipeline();
    const ctx = (pipeline as any).ctx;

    // Wake-less speech inside a grace window seeds a capture marked 'grace'.
    ctx.gateGraceUntil = Date.now() + 5_000;
    await simulateUtterance(pipeline, 'user1', 'no because there is no way that diesel is four dollars');
    expect(ctx.indicateCaptureActive).toBe(true);
    expect(ctx.indicateCaptureOrigin).toBe('grace');

    // First timeout: nudge, capture stays open.
    await (pipeline as any).onIndicateCaptureTimeout();
    expect(ctx.indicateCaptureActive).toBe(true);
    expect(earconHistory).toContain('still-listening');

    // Second timeout: grace-seeded capture expires instead of nudging forever.
    await (pipeline as any).onIndicateCaptureTimeout();
    expect(ctx.indicateCaptureActive).toBe(false);
    expect(earconHistory).toContain('gate-closed');
  });

  it('wake-initiated indicate capture keeps the never-discard nudge behavior', async () => {
    const pipeline = makePipeline();
    const ctx = (pipeline as any).ctx;

    (pipeline as any).startIndicateCapture('first point about the budget meeting', 'wake');
    expect(ctx.indicateCaptureOrigin).toBe('wake');

    await (pipeline as any).onIndicateCaptureTimeout();
    await (pipeline as any).onIndicateCaptureTimeout();
    await (pipeline as any).onIndicateCaptureTimeout();
    expect(ctx.indicateCaptureActive).toBe(true);

    (pipeline as any).clearIndicateCapture('test-cleanup');
  });
});
