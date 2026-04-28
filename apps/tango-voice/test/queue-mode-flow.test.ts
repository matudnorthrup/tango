/**
 * Layer 3: Queue Mode Tests
 *
 * Verifies the async queue mode flow: enqueue → notify → read.
 * Tests mode switching, queue prompt dispatch, idle notifications,
 * and queue prompt handling during grace windows.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Service mocks ──────────────────────────────────────────────────────────

let transcribeImpl: (buf: Buffer) => Promise<string>;

vi.mock('../src/services/whisper.js', () => ({
  transcribe: vi.fn(async (buf: Buffer) => transcribeImpl(buf)),
}));

let getResponseImpl: (user: string, msg: string, opts?: any) => Promise<{ response: string; history: any[] }>;

vi.mock('../src/services/claude.js', () => ({
  getResponse: vi.fn(async (user: string, msg: string, opts?: any) => getResponseImpl(user, msg, opts)),
  quickCompletion: vi.fn(async () => ''),
}));

let ttsStreamImpl: (text: string) => Promise<Buffer>;

vi.mock('../src/services/tts.js', () => ({
  textToSpeechStream: vi.fn(async (text: string) => ttsStreamImpl(text)),
}));

vi.mock('../src/discord/audio-receiver.js', () => ({
  AudioReceiver: class {
    private onUtterance: any;
    constructor(_conn: any, onUtterance: any, _onRejected: any) {
      this.onUtterance = onUtterance;
    }
    start() {}
    stop() {}
    hasActiveSpeech() { return false; }
    getLastSpeechStartedAt() { return 0; }
    simulateUtterance(userId: string, wav: Buffer, durationMs: number) {
      return this.onUtterance(userId, wav, durationMs);
    }
  },
}));

const earconHistory: string[] = [];
const playerCalls: string[] = [];

vi.mock('../src/discord/audio-player.js', () => ({
  DiscordAudioPlayer: class {
    attach() {}
    isPlaying() { return false; }
    isWaiting() { return false; }
    isPlayingEarcon(_name?: string) { return false; }
    async playEarcon(name: string) {
      earconHistory.push(name);
      playerCalls.push(`earcon:${name}`);
    }
    playEarconSync(name: string) {
      earconHistory.push(name);
      playerCalls.push(`earcon:${name}`);
    }
    async playStream(_stream: any) {
      playerCalls.push('playStream');
    }
    startWaitingLoop() { playerCalls.push('startWaitingLoop'); }
    stopWaitingLoop() { playerCalls.push('stopWaitingLoop'); }
    stopPlayback(_reason?: string) { playerCalls.push('stopPlayback'); }
  },
}));

vi.mock('../src/audio/earcons.js', () => ({
  initEarcons: vi.fn(),
}));

let voiceSettings = {
  gated: true,
  silenceThreshold: 0.01,
  silenceDuration: 1500,
  silenceDurationMs: 1500,
  speechThreshold: 500,
  minSpeechDurationMs: 300,
  endpointingMode: 'silence',
  indicateCloseWords: ["i'm done", "i'm finished", 'go ahead'],
  indicateTimeoutMs: 20000,
};

vi.mock('../src/services/voice-settings.js', () => ({
  getVoiceSettings: vi.fn(() => voiceSettings),
  setSilenceDuration: vi.fn(),
  setSpeechThreshold: vi.fn(),
  setGatedMode: vi.fn((enabled: boolean) => { voiceSettings.gated = enabled; }),
  setEndpointingMode: vi.fn((mode: 'silence' | 'indicate') => { voiceSettings.endpointingMode = mode; }),
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

// ── Mock helpers ───────────────────────────────────────────────────────────

function makeQueueState(mode: 'wait' | 'queue' | 'ask' = 'queue') {
  const items: any[] = [];
  return {
    getMode: vi.fn(() => mode),
    setMode: vi.fn((m: string) => { mode = m as any; }),
    enqueue: vi.fn((params: any) => {
      const item = { id: `q-${items.length}`, ...params, status: 'pending', summary: '', responseText: '', timestamp: Date.now() };
      items.push(item);
      return item;
    }),
    markReady: vi.fn((id: string, summary: string, text: string) => {
      const item = items.find((i: any) => i.id === id);
      if (item) { item.status = 'ready'; item.summary = summary; item.responseText = text; }
    }),
    markHeard: vi.fn((id: string) => {
      const item = items.find((i: any) => i.id === id);
      if (item) item.status = 'heard';
    }),
    getReadyItems: vi.fn(() => items.filter((i: any) => i.status === 'ready')),
    getPendingItems: vi.fn(() => items.filter((i: any) => i.status === 'pending')),
    getNextReady: vi.fn(() => items.find((i: any) => i.status === 'ready') ?? null),
    getReadyByChannel: vi.fn((ch: string) => items.find((i: any) => i.status === 'ready' && i.channel === ch) ?? null),
    getSnapshots: vi.fn(() => ({})),
    setSnapshots: vi.fn(),
    clearSnapshots: vi.fn(),
    _items: items,
  };
}

function makeRouter(channelName = 'walmart', displayName = 'Walmart') {
  return {
    getActiveChannel: vi.fn(() => ({ name: channelName, displayName })),
    getActiveSessionKey: vi.fn(() => `agent:main:discord:channel:${channelName}`),
    getTangoRouteFor: vi.fn(() => ({ sessionId: 'tango-default', agentId: 'main', source: 'tango-config', channelKey: 'discord:default' })),
    getSystemPrompt: vi.fn(() => 'system prompt'),
    refreshHistory: vi.fn(async () => {}),
    getHistory: vi.fn(() => []),
    setHistory: vi.fn(),
    listChannels: vi.fn(() => [{ name: channelName, displayName }]),
    getLogChannel: vi.fn(async () => null),
    getLogChannelFor: vi.fn(async () => null),
    getLastMessage: vi.fn(() => null),
    getLastMessageFresh: vi.fn(async () => null),
    getAllChannelSessionKeys: vi.fn(() => []),
    findForumChannel: vi.fn(() => null),
    listForumChannels: vi.fn(() => []),
    getForumThreads: vi.fn(async () => []),
    switchTo: vi.fn(async () => ({ success: true, displayName })),
    switchToDefault: vi.fn(async () => ({ success: true, displayName: 'Default' })),
    createForumPost: vi.fn(async () => ({ success: false, error: 'not implemented' })),
  };
}

function makeResponsePoller() {
  return { check: vi.fn() };
}

function makePipeline(mode: 'wait' | 'queue' | 'ask' = 'queue') {
  const pipeline = new VoicePipeline({} as any);
  const qs = makeQueueState(mode);
  const router = makeRouter();
  const poller = makeResponsePoller();

  pipeline.setQueueState(qs as any);
  pipeline.setRouter(router as any);
  pipeline.setResponsePoller(poller as any);

  return { pipeline, qs, router, poller };
}

async function simulateUtterance(
  pipeline: VoicePipeline,
  userId: string,
  transcript: string,
  durationMs = 500,
) {
  transcribeImpl = async () => transcript;
  const receiver = (pipeline as any).receiver;
  await receiver.simulateUtterance(userId, Buffer.from('fake-audio'), durationMs);
  await new Promise((r) => setTimeout(r, 10));
}

function getState(pipeline: VoicePipeline): string {
  return (pipeline as any).stateMachine.getStateType();
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Layer 3: Queue Mode Flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    earconHistory.length = 0;
    playerCalls.length = 0;
    voiceSettings = {
      gated: true,
      silenceThreshold: 0.01,
      silenceDuration: 1500,
      silenceDurationMs: 1500,
      speechThreshold: 500,
      minSpeechDurationMs: 300,
      endpointingMode: 'silence',
      indicateCloseWords: ["i'm done", "i'm finished", 'go ahead'],
      indicateTimeoutMs: 20000,
    };
    transcribeImpl = async () => '';
    getResponseImpl = async () => ({ response: 'LLM response.', history: [] });
    ttsStreamImpl = async () => Buffer.from('tts-audio');
  });

  // ── 3.1: Mode switch ─────────────────────────────────────────────────

  it('3.1 — background mode command sets background delivery and speaks confirmation', async () => {
    const { pipeline, qs } = makePipeline('wait');

    await simulateUtterance(pipeline, 'user1', 'Tango, background mode');

    expect(qs.setMode).toHaveBeenCalledWith('queue');
    expect(playerCalls).toContain('playStream'); // spoke "Inbox mode..."
    expect(earconHistory).toContain('ready');
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  it('3.1b — focus mode command sets inline delivery from background mode', async () => {
    const { pipeline, qs } = makePipeline('queue');

    await simulateUtterance(pipeline, 'user1', 'Tango, focus mode');

    expect(qs.setMode).toHaveBeenCalledWith('wait');
    expect(playerCalls).toContain('playStream');
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  it('3.1c — focus-mode inline responses open follow-up reply context on the active channel', async () => {
    const { pipeline, qs } = makePipeline('wait');
    playerCalls.length = 0;
    earconHistory.length = 0;

    await simulateUtterance(pipeline, 'user1', 'Tango, what is my protein intake today? go ahead');
    await new Promise((resolve) => setTimeout(resolve, 350));

    expect(qs.markHeard).toHaveBeenCalled();
    expect((pipeline as any).ctx.lastSpokenIsChannelMessage).toBe(true);
    expect((pipeline as any).ctx.followupPromptGraceUntil).toBeGreaterThan(Date.now());
    expect((pipeline as any).ctx.followupPromptChannelName).toBe('walmart');
    expect(earconHistory).toContain('ready');
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  // ── 3.2: Queue prompt happy path ──────────────────────────────────────

  it('3.2 — queue mode prompt enqueues, acknowledges, speaks status, plays ready', async () => {
    const { pipeline, qs, router } = makePipeline('queue');

    await simulateUtterance(pipeline, 'user1', 'Tango, add milk to my list');

    // Should have enqueued (transcript includes wake word prefix)
    expect(qs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'walmart',
        userMessage: 'Tango, add milk to my list',
      }),
    );
    // Should have played acknowledged earcon
    expect(earconHistory).toContain('acknowledged');
    // Should have spoken "Queued to Walmart." and inbox status via TTS
    expect(playerCalls.filter((c) => c === 'playStream').length).toBeGreaterThanOrEqual(2);
    // Should have played ready earcon
    expect(earconHistory).toContain('ready');
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  it('3.2b — indicate mode in queue captures across grace and enqueues on wake close', async () => {
    const { pipeline, qs } = makePipeline('queue');
    voiceSettings.endpointingMode = 'indicate';

    await simulateUtterance(pipeline, 'user1', 'Tango, voice status');

    await simulateUtterance(pipeline, 'user1', 'add milk to my list');
    expect((pipeline as any).ctx.indicateCaptureActive).toBe(true);
    expect(qs.enqueue).not.toHaveBeenCalled();

    await simulateUtterance(pipeline, 'user1', 'and eggs');
    expect(qs.enqueue).not.toHaveBeenCalled();

    await simulateUtterance(pipeline, 'user1', "Tango, I'm done");
    expect((pipeline as any).ctx.indicateCaptureActive).toBe(false);
    expect(qs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'walmart',
        userMessage: 'add milk to my list and eggs',
      }),
    );
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  it('3.2b2 — indicate mode in queue keeps wake-only close in background mode', async () => {
    const { pipeline, qs } = makePipeline('queue');
    voiceSettings.endpointingMode = 'indicate';

    await simulateUtterance(pipeline, 'user1', 'Tango, voice status');
    playerCalls.length = 0;
    earconHistory.length = 0;

    await simulateUtterance(pipeline, 'user1', 'add milk to my list');
    await simulateUtterance(pipeline, 'user1', 'and eggs');
    await simulateUtterance(pipeline, 'user1', 'Tango');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(qs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'walmart',
        userMessage: 'add milk to my list and eggs',
      }),
    );
    expect(qs.markReady).toHaveBeenCalled();
    expect(qs.markHeard).not.toHaveBeenCalled();
    expect(playerCalls).not.toContain('startWaitingLoop');
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  it('3.2b3 — same-breath "go ahead" in queue mode waits inline instead of background-dispatching', async () => {
    const { pipeline, qs } = makePipeline('queue');
    voiceSettings.endpointingMode = 'indicate';
    playerCalls.length = 0;
    earconHistory.length = 0;

    await simulateUtterance(pipeline, 'user1', 'Watson, what is on my calendar tomorrow go ahead');

    expect(qs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'walmart',
        userMessage: 'what is on my calendar tomorrow',
      }),
    );
    expect(qs.markHeard).toHaveBeenCalled();
    expect(earconHistory).not.toContain('acknowledged');
    expect(playerCalls).toContain('playStream');
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  it('3.2b4 — same-breath wake + complete prompt auto-finalizes in queue mode without a close word', async () => {
    const { pipeline, qs } = makePipeline('queue');
    voiceSettings.endpointingMode = 'indicate';
    playerCalls.length = 0;
    earconHistory.length = 0;

    await simulateUtterance(pipeline, 'user1', 'Hello Malibu, what is my protein intake today?');

    expect(qs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'walmart',
        userMessage: 'what is my protein intake today?',
      }),
    );
    expect((pipeline as any).ctx.indicateCaptureActive).toBe(false);
    expect(earconHistory).toContain('acknowledged');
    expect(playerCalls).not.toContain('startWaitingLoop');
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  it('3.2b5 — same-breath wake + complete prompt defaults to background dispatch even in wait mode', async () => {
    const { pipeline, qs } = makePipeline('wait');
    voiceSettings.endpointingMode = 'indicate';
    playerCalls.length = 0;
    earconHistory.length = 0;

    await simulateUtterance(pipeline, 'user1', 'Hello Malibu, what is my protein intake today?');

    expect(qs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'walmart',
        userMessage: 'what is my protein intake today?',
      }),
    );
    expect((pipeline as any).ctx.indicateCaptureActive).toBe(false);
    expect(earconHistory).toContain('acknowledged');
    expect(playerCalls).not.toContain('startWaitingLoop');
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  it('3.2b6 — wake-led prompt containing "what about" stays a prompt outside inbox flow', async () => {
    const { pipeline, qs } = makePipeline('wait');
    voiceSettings.endpointingMode = 'indicate';
    playerCalls.length = 0;
    earconHistory.length = 0;

    await simulateUtterance(pipeline, 'user1', 'Hello Malibu, what about my sleep data?');

    expect(qs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'walmart',
        userMessage: 'what about my sleep data?',
      }),
    );
    expect(playerCalls).not.toContain('playStream');
    expect((pipeline as any).ctx.indicateCaptureActive).toBe(false);
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  it('3.2c — indicate mode in queue treats bare switch command in grace as command, not dictation capture', async () => {
    const { pipeline, router } = makePipeline('queue');
    voiceSettings.endpointingMode = 'indicate';

    await simulateUtterance(pipeline, 'user1', 'Tango, voice status');
    earconHistory.length = 0;
    playerCalls.length = 0;

    await simulateUtterance(pipeline, 'user1', 'switch to health');

    expect((pipeline as any).ctx.indicateCaptureActive).toBe(false);
    expect(router.switchTo).toHaveBeenCalledWith('health');

    const listeningIdx = earconHistory.indexOf('listening');
    const acknowledgedIdx = earconHistory.indexOf('acknowledged');
    expect(listeningIdx).toBeGreaterThanOrEqual(0);
    expect(acknowledgedIdx).toBeGreaterThan(listeningIdx);

    pipeline.stop();
  });

  it('3.2c2 — agent-addressed system commands run as commands, not prompts', async () => {
    const { pipeline, qs } = makePipeline('queue');

    await simulateUtterance(pipeline, 'user1', 'Watson, voice status');

    expect(qs.enqueue).not.toHaveBeenCalled();
    expect(playerCalls).toContain('playStream');
    expect(earconHistory).toContain('ready');
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  it('3.2d — indicate mode treats wake-prefixed cancel as interrupt command, not dictation', async () => {
    const { pipeline } = makePipeline('queue');
    voiceSettings.endpointingMode = 'indicate';

    await simulateUtterance(pipeline, 'user1', 'Tango, voice status');
    earconHistory.length = 0;
    playerCalls.length = 0;

    await simulateUtterance(pipeline, 'user1', 'Hello Tango cancel');

    expect((pipeline as any).ctx.indicateCaptureActive).toBe(false);
    expect(playerCalls).toContain('stopPlayback');
    expect(earconHistory).toContain('listening');

    pipeline.stop();
  });

  // ── 3.3: Background completion → idle notification ────────────────────

  it('3.3 — notifyIfIdle is called when LLM dispatch completes', async () => {
    const { pipeline, qs } = makePipeline('queue');
    const notifySpy = vi.spyOn(pipeline, 'notifyIfIdle');

    // Fast LLM
    getResponseImpl = async () => ({ response: 'Done.', history: [] });

    await simulateUtterance(pipeline, 'user1', 'Tango, add milk to my list');

    // Allow the fire-and-forget dispatch to complete
    await new Promise((r) => setTimeout(r, 50));

    expect(notifySpy).toHaveBeenCalled();

    pipeline.stop();
  });

  it('3.3b — idle notification is deferred while indicate capture is active', async () => {
    const { pipeline } = makePipeline('queue');
    vi.useFakeTimers();

    try {
      (pipeline as any).ctx.gateGraceUntil = 0;
      (pipeline as any).ctx.promptGraceUntil = 0;
      (pipeline as any).ctx.indicateCaptureActive = true;

      pipeline.notifyIfIdle('Background message pending.');

      await vi.advanceTimersByTimeAsync(300);
      expect(playerCalls).not.toContain('playStream');
      const firstDiag = pipeline.getIdleNotificationDiagnostics(12);
      expect(firstDiag.recentEvents.some(
        (event) => event.stage === 'deferred' && event.reason === 'indicate capture active',
      )).toBe(true);

      (pipeline as any).ctx.indicateCaptureActive = false;
      await vi.advanceTimersByTimeAsync(3000);
      expect(playerCalls).toContain('earcon:nudge');
    } finally {
      pipeline.stop();
      vi.useRealTimers();
    }
  });

  // ── 3.6: Queue prompt during grace ────────────────────────────────────

  it('3.6 — utterance in queue mode during grace without wake word is enqueued', async () => {
    const { pipeline, qs } = makePipeline('queue');

    // First: wake check to open grace window
    await simulateUtterance(pipeline, 'user1', 'Watson');
    const enqueueBefore = qs.enqueue.mock.calls.length;
    earconHistory.length = 0;
    playerCalls.length = 0;

    // Now speak without wake word during grace in queue mode — should enqueue
    await simulateUtterance(pipeline, 'user1', 'add milk to my list');

    expect(qs.enqueue.mock.calls.length).toBe(enqueueBefore + 1);
    expect(qs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'walmart',
        userMessage: 'add milk to my list',
      }),
    );
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  it('3.6a — queue mode does not misparse incidental "go" or "which" speech as a bare switch command', async () => {
    const { pipeline, router } = makePipeline('queue');

    await simulateUtterance(pipeline, 'user1', 'go cancel');
    await simulateUtterance(pipeline, 'user1', 'which happens with');

    expect(router.switchTo).not.toHaveBeenCalled();
    expect(playerCalls).not.toContain('playStream');

    pipeline.stop();
  });

  it('3.6a2 — queue mode requires grace or wake for channel switching', async () => {
    const { pipeline, router, qs } = makePipeline('queue');
    earconHistory.length = 0;
    playerCalls.length = 0;

    await simulateUtterance(pipeline, 'user1', 'switch to walmart');
    await simulateUtterance(pipeline, 'user1', 'go to walmart');

    expect(router.switchTo).not.toHaveBeenCalled();
    expect(qs.enqueue).not.toHaveBeenCalled();
    expect(earconHistory).not.toContain('error');
    expect(playerCalls).not.toContain('playStream');

    pipeline.stop();
  });

  it('3.6a3 — queue mode silently ignores bare inbox/navigation words outside grace', async () => {
    const { pipeline, qs } = makePipeline('queue');
    earconHistory.length = 0;
    playerCalls.length = 0;

    await simulateUtterance(pipeline, 'user1', 'inbox');
    await simulateUtterance(pipeline, 'user1', 'next');
    await simulateUtterance(pipeline, 'user1', "next we're gonna do");

    expect(earconHistory).not.toContain('error');
    expect(qs.enqueue).not.toHaveBeenCalled();
    expect(playerCalls).not.toContain('playStream');

    pipeline.stop();
  });

  it('3.6b — read-ready consumes a locally ready response from the active channel', async () => {
    const { pipeline, qs } = makePipeline('queue');
    const item = qs.enqueue({
      channel: 'walmart',
      displayName: 'Walmart',
      sessionKey: 'agent:main:discord:channel:walmart',
      userMessage: 'queued prompt',
    });
    qs.markReady(item.id, 'Ready summary.', 'Ready response text.');
    playerCalls.length = 0;
    earconHistory.length = 0;

    await simulateUtterance(pipeline, 'user1', 'Tango, go ahead');

    expect(qs.markHeard).toHaveBeenCalledWith(item.id);
    expect(playerCalls).toContain('playStream');
    expect(earconHistory).toContain('ready');
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  it('3.6b2 — empty indicate capture wake-check lets bare "go ahead" read a ready response', async () => {
    const { pipeline, qs } = makePipeline('queue');
    voiceSettings.endpointingMode = 'indicate';
    const item = qs.enqueue({
      channel: 'walmart',
      displayName: 'Watson',
      sessionKey: 'agent:main:discord:channel:walmart',
      userMessage: 'queued prompt',
      speakerAgentId: 'watson',
    });
    qs.markReady(item.id, 'Ready summary.', 'Ready response text.');
    playerCalls.length = 0;
    earconHistory.length = 0;

    await simulateUtterance(pipeline, 'user1', 'Watson');

    expect((pipeline as any).ctx.indicateCaptureActive).toBe(true);
    expect((pipeline as any).ctx.indicateCaptureSegments).toEqual([]);

    await simulateUtterance(pipeline, 'user1', 'go ahead');

    expect(qs.enqueue).toHaveBeenCalledTimes(1);
    expect(qs.markHeard).toHaveBeenCalledWith(item.id);
    expect((pipeline as any).ctx.indicateCaptureActive).toBe(false);
    expect((pipeline as any).ctx.indicateCaptureSegments).toEqual([]);
    expect(playerCalls).toContain('playStream');
    expect(earconHistory).toContain('ready');
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  it('3.6c — agent-targeted read-ready consumes a matching local response', async () => {
    const { pipeline, qs } = makePipeline('queue');
    const item = qs.enqueue({
      channel: 'walmart',
      displayName: 'Watson',
      sessionKey: 'agent:main:discord:channel:walmart',
      userMessage: 'queued prompt',
      speakerAgentId: 'watson',
    });
    qs.markReady(item.id, 'Ready summary.', 'Agent-targeted response.');
    playerCalls.length = 0;
    earconHistory.length = 0;

    await simulateUtterance(pipeline, 'user1', 'Watson, go ahead');

    expect(qs.markHeard).toHaveBeenCalledWith(item.id);
    expect(playerCalls).toContain('playStream');
    expect(earconHistory).toContain('ready');
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  it('3.7 — queue mode accepts immediate follow-up prompt after read-last-message', async () => {
    const { pipeline, qs, router } = makePipeline('queue');
    router.getLastMessageFresh.mockResolvedValue({
      role: 'assistant',
      content: 'Sleep score was down last night. Hydration looked good.',
    });

    await simulateUtterance(pipeline, 'user1', 'Tango, read the last message');

    const enqueueBefore = qs.enqueue.mock.calls.length;
    await simulateUtterance(
      pipeline,
      'user1',
      'compare that with the week average and tell me if there is any risk',
    );

    expect(qs.enqueue.mock.calls.length).toBe(enqueueBefore + 1);
    expect(qs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'walmart',
        userMessage: 'compare that with the week average and tell me if there is any risk',
      }),
    );

    pipeline.stop();
  });

  it('3.8 — read-last-message follow-up grace starts after ready cue', async () => {
    const { pipeline, router } = makePipeline('queue');
    router.getLastMessageFresh.mockResolvedValue({
      role: 'assistant',
      content: 'Long message body for readback.',
    });

    const order: string[] = [];
    const originalPlayReadyEarcon = (pipeline as any).playReadyEarcon.bind(pipeline);
    const originalAllowFollowupPromptGrace = (pipeline as any).allowFollowupPromptGrace.bind(pipeline);

    (pipeline as any).playReadyEarcon = vi.fn(async () => {
      order.push('ready:start');
      await originalPlayReadyEarcon();
      order.push('ready:end');
    });
    (pipeline as any).allowFollowupPromptGrace = vi.fn((ms: number) => {
      order.push('followup:set');
      return originalAllowFollowupPromptGrace(ms);
    });

    await simulateUtterance(pipeline, 'user1', 'Tango, read the last message');

    expect(order).toContain('ready:end');
    expect(order).toContain('followup:set');
    expect(order.indexOf('followup:set')).toBeGreaterThan(order.indexOf('ready:end'));

    pipeline.stop();
  });

  it('3.9 — long follow-up utterance is accepted when it starts inside follow-up grace', async () => {
    const { pipeline, qs, router } = makePipeline('queue');
    router.getLastMessageFresh.mockResolvedValue({
      role: 'assistant',
      content: 'Long message body for readback.',
    });

    await simulateUtterance(pipeline, 'user1', 'Tango, read the last message');
    const enqueueBefore = qs.enqueue.mock.calls.length;

    // Simulate tail-end capture: grace timestamp is slightly in the past at
    // capture time, but the utterance start (capture minus duration) is still
    // within the grace+tolerance window.
    const now = Date.now();
    (pipeline as any).ctx.followupPromptGraceUntil = now - 200;
    (pipeline as any).ctx.gateGraceUntil = now + 2000;

    await simulateUtterance(
      pipeline,
      'user1',
      'what did my calorie deficit end up looking like with actual numbers',
      1200,
    );

    expect(qs.enqueue.mock.calls.length).toBe(enqueueBefore + 1);
    expect(qs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'walmart',
      }),
    );

    pipeline.stop();
  });

  it('3.10 — channel switch handoff allows one immediate follow-up prompt', async () => {
    const { pipeline, qs } = makePipeline('queue');

    await simulateUtterance(pipeline, 'user1', 'Tango, switch to walmart');
    const enqueueBefore = qs.enqueue.mock.calls.length;

    await simulateUtterance(
      pipeline,
      'user1',
      'what did my calorie deficit end up looking like with actual numbers',
      1400,
    );

    expect(qs.enqueue.mock.calls.length).toBe(enqueueBefore + 1);
    expect(qs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'walmart',
      }),
    );

    pipeline.stop();
  });

  it('3.11 — bare "switch to" remains a valid switch command during grace', async () => {
    const { pipeline, router, qs } = makePipeline('queue');

    await simulateUtterance(pipeline, 'user1', 'Watson');
    await simulateUtterance(pipeline, 'user1', 'switch to walmart');

    expect(router.switchTo).toHaveBeenCalledWith('walmart');
    expect(qs.enqueue).not.toHaveBeenCalled();

    pipeline.stop();
  });

  it('3.11b — bare "to walmart" is never treated as a switch command', async () => {
    const { pipeline, router, qs } = makePipeline('queue');

    await simulateUtterance(pipeline, 'user1', 'Watson');
    await simulateUtterance(pipeline, 'user1', 'to walmart');

    expect(router.switchTo).not.toHaveBeenCalled();
    expect(qs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: 'to walmart',
      }),
    );

    pipeline.stop();
  });

  // ── Queue mode with commands ──────────────────────────────────────────

  it('commands still work in queue mode with wake word', async () => {
    const { pipeline } = makePipeline('queue');

    await simulateUtterance(pipeline, 'user1', 'Tango, voice status');

    expect(playerCalls).toContain('playStream');
    expect(getState(pipeline)).toBe('IDLE');

    pipeline.stop();
  });

  // ── Counter tracking ──────────────────────────────────────────────────

  it('increments llmDispatches counter on queue mode dispatch', async () => {
    const { pipeline } = makePipeline('queue');
    getResponseImpl = async () => ({ response: 'Done.', history: [] });

    await simulateUtterance(pipeline, 'user1', 'Tango, add milk to my list');
    await new Promise((r) => setTimeout(r, 20));

    expect(pipeline.getCounters().llmDispatches).toBeGreaterThanOrEqual(1);

    pipeline.stop();
  });
});
