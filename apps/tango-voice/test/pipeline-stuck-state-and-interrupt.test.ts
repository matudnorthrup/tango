import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/services/claude.js', () => ({
  getResponse: vi.fn(async () => ({ response: 'ok', history: [] })),
  quickCompletion: vi.fn(async () => ''),
}));

vi.mock('../src/discord/audio-player.js', () => ({
  DiscordAudioPlayer: class {
    attach() {}
    isPlaying() { return false; }
    isWaiting() { return false; }
    isPlayingEarcon() { return false; }
    async playEarcon() {}
    playEarconSync() {}
    async playStream() {}
    playSingleTone() {}
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
  textToSpeechStream: vi.fn(async () => Buffer.from('')),
}));

vi.mock('../src/services/whisper.js', () => ({
  transcribe: vi.fn(async () => ''),
  transcribeCommandTail: vi.fn(async () => null),
}));

vi.mock('../src/services/tango-voice.js', () => ({
  shouldUseTangoVoiceBridge: vi.fn(() => false),
  requestTangoVoiceTurn: vi.fn(async () => {
    throw new Error('tango voice bridge should be disabled in unit tests');
  }),
}));

import { VoicePipeline } from '../src/pipeline/voice-pipeline.js';
import { PipelineStateMachine, type TransitionEffect } from '../src/pipeline/pipeline-state.js';
import { transcribe } from '../src/services/whisper.js';
import { setGatedMode, setEndpointingMode } from '../src/services/voice-settings.js';

const transcribeMock = vi.mocked(transcribe);

const SELECTION_OPTIONS = [{ index: 1, name: 'general', displayName: 'General' }];

function enterChannelSelection(pipeline: VoicePipeline): void {
  (pipeline as any).stateMachine.transition({
    type: 'ENTER_CHANNEL_SELECTION',
    options: SELECTION_OPTIONS,
  });
}

describe('Stuck-state regressions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setGatedMode(true);
    setEndpointingMode('silence');
  });

  describe('awaiting-state timers survive noise utterances', () => {
    // UTTERANCE_RECEIVED intentionally pauses awaiting timers while STT runs.
    // When the transcript turns out to be noise, the timers must be re-armed —
    // otherwise the awaiting state sits without a timeout until the 60s stall
    // watchdog instead of its 15–30s contract timeout.

    it('re-arms timers after an empty transcript in AWAITING_CHANNEL_SELECTION', async () => {
      transcribeMock.mockResolvedValueOnce('');
      const pipeline = new VoicePipeline({} as any);
      enterChannelSelection(pipeline);
      expect((pipeline as any).stateMachine.hasActiveTimers()).toBe(true);

      await (pipeline as any).handleUtterance('user1', Buffer.alloc(100), 800);

      expect((pipeline as any).stateMachine.getStateType()).toBe('AWAITING_CHANNEL_SELECTION');
      expect((pipeline as any).stateMachine.hasActiveTimers()).toBe(true);
      pipeline.stop();
    });

    it('re-arms timers after a non-lexical transcript in AWAITING_CHANNEL_SELECTION', async () => {
      transcribeMock.mockResolvedValueOnce('[BLANK_AUDIO]');
      const pipeline = new VoicePipeline({} as any);
      enterChannelSelection(pipeline);

      await (pipeline as any).handleUtterance('user1', Buffer.alloc(100), 800);

      expect((pipeline as any).stateMachine.getStateType()).toBe('AWAITING_CHANNEL_SELECTION');
      expect((pipeline as any).stateMachine.hasActiveTimers()).toBe(true);
      pipeline.stop();
    });

    it('re-arms timers after an STT failure in AWAITING_CHANNEL_SELECTION', async () => {
      transcribeMock.mockRejectedValueOnce(new Error('Whisper local error'));
      const pipeline = new VoicePipeline({} as any);
      enterChannelSelection(pipeline);

      await (pipeline as any).handleUtterance('user1', Buffer.alloc(100), 800);

      expect((pipeline as any).stateMachine.getStateType()).toBe('AWAITING_CHANNEL_SELECTION');
      expect((pipeline as any).stateMachine.hasActiveTimers()).toBe(true);
      pipeline.stop();
    });
  });

  describe('stall watchdog vs INBOX_FLOW', () => {
    // INBOX_FLOW is user-paced browsing with a 120s interaction contract.
    // The 60s stall watchdog must not hard-reset it mid-browse with an error
    // earcon; expiry at the contract limit should read as a cancel, not a fault.

    it('does not hard-reset INBOX_FLOW at 60s; expires it after the 120s contract window', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: false });
      try {
        const pipeline = new VoicePipeline({} as any);
        const playEarconSpy = vi.spyOn((pipeline as any).player, 'playEarcon');

        (pipeline as any).stateMachine.transition({
          type: 'ENTER_INBOX_FLOW',
          items: [{ agentId: 'a', agentDisplayName: 'A', channels: [], totalUnread: 1 }],
          returnChannel: null,
        });
        (pipeline as any).resetStallWatchdog();

        vi.advanceTimersByTime(61_000);
        expect((pipeline as any).stateMachine.getStateType()).toBe('INBOX_FLOW');
        expect(playEarconSpy).not.toHaveBeenCalledWith('error');

        vi.advanceTimersByTime(61_000); // past the 120s inbox-flow contract
        expect((pipeline as any).stateMachine.getStateType()).toBe('IDLE');
        expect(playEarconSpy).toHaveBeenCalledWith('cancelled');
        expect(playEarconSpy).not.toHaveBeenCalledWith('error');

        pipeline.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it('still hard-resets a genuinely stuck PROCESSING state', () => {
      vi.useFakeTimers({ shouldAdvanceTime: false });
      try {
        const pipeline = new VoicePipeline({} as any);
        const playEarconSpy = vi.spyOn((pipeline as any).player, 'playEarcon');

        (pipeline as any).stateMachine.transition({ type: 'UTTERANCE_RECEIVED' });
        (pipeline as any).stateMachine.transition({ type: 'TRANSCRIPT_READY' });
        expect((pipeline as any).stateMachine.getStateType()).toBe('PROCESSING');
        (pipeline as any).resetStallWatchdog();

        vi.advanceTimersByTime(61_000);
        expect((pipeline as any).stateMachine.getStateType()).toBe('IDLE');
        expect(playEarconSpy).toHaveBeenCalledWith('error');
        pipeline.stop();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe('Interrupt regressions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEndpointingMode('silence');
  });

  afterEach(() => {
    setGatedMode(true);
  });

  it('replays an utterance buffered while a wait response was speaking (open mode)', async () => {
    setGatedMode(false);
    const pipeline = new VoicePipeline({} as any);
    const player = (pipeline as any).player;

    // Controllable playback: playStream stays pending until stopped/finished,
    // mirroring the real DiscordAudioPlayer contract.
    let playing = false;
    let finishPlayback: (() => void) | null = null;
    player.isPlaying = () => playing;
    player.isWaiting = () => false;
    player.playStream = vi.fn(() => new Promise<void>((resolve) => {
      playing = true;
      finishPlayback = () => {
        playing = false;
        resolve();
      };
    }));
    player.stopPlayback = vi.fn(() => {
      finishPlayback?.();
      finishPlayback = null;
    });

    // Out-of-band speaking path: wait-mode responses are delivered from the
    // LLM callback, not from within handleUtterance.
    (pipeline as any).deliverWaitResponse('A long response the user interrupts.', 'watson');
    await vi.waitFor(() => {
      expect((pipeline as any).stateMachine.getStateType()).toBe('SPEAKING');
      expect(playing).toBe(true);
    });

    // User speaks over playback: open mode stops playback and buffers the audio.
    await (pipeline as any).handleUtterance('user1', Buffer.alloc(100), 800);
    expect(player.stopPlayback).toHaveBeenCalled();

    // Once SPEAKING completes, the buffered interrupt must be re-processed —
    // transcribe is only invoked for it on replay.
    await vi.waitFor(() => {
      expect(transcribeMock).toHaveBeenCalledTimes(1);
      expect((pipeline as any).stateMachine.hasBufferedUtterance()).toBe(false);
    }, { timeout: 2000 });

    pipeline.stop();
  });
});

describe('PipelineStateMachine timer hardening', () => {
  it('does not fire the timeout warning immediately for timeouts at or below the warning threshold', () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    try {
      const sm = new PipelineStateMachine();
      const fired: TransitionEffect[] = [];
      sm.setTimeoutHandler((effects) => fired.push(...effects));

      sm.transition({
        type: 'ENTER_ROUTE_CONFIRMATION',
        userId: 'u1',
        transcript: 'send this along',
        targetId: 'chan-1',
        targetName: 'Chan One',
        timeoutMs: 3_000,
      });

      vi.advanceTimersByTime(50);
      expect(
        fired.some((e) => e.type === 'earcon' && e.name === 'timeout-warning'),
      ).toBe(false);

      vi.advanceTimersByTime(3_000);
      expect(
        fired.some((e) => e.type === 'earcon' && e.name === 'cancelled'),
      ).toBe(true);

      sm.destroy();
    } finally {
      vi.useRealTimers();
    }
  });
});
