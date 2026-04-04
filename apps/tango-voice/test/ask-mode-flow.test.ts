/**
 * Layer 4: Legacy ask mode compatibility
 *
 * Ask mode now normalizes to background mode. These tests keep coverage on the
 * legacy alias without preserving the removed queue-choice prompt.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    waitForPlaybackSettled() { return Promise.resolve(); }
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

function makeQueueState(mode: 'wait' | 'queue' | 'ask' = 'ask') {
  const items: any[] = [];
  return {
    getMode: vi.fn(() => mode),
    setMode: vi.fn((nextMode: string) => { mode = nextMode as any; }),
    enqueue: vi.fn((params: any) => {
      const item = { id: `q-${items.length}`, ...params, status: 'pending', summary: '', responseText: '', timestamp: Date.now() };
      items.push(item);
      return item;
    }),
    markReady: vi.fn((id: string, summary: string, text: string) => {
      const item = items.find((candidate: any) => candidate.id === id);
      if (item) {
        item.status = 'ready';
        item.summary = summary;
        item.responseText = text;
      }
    }),
    markHeard: vi.fn((id: string) => {
      const item = items.find((candidate: any) => candidate.id === id);
      if (item) item.status = 'heard';
    }),
    getReadyItems: vi.fn(() => items.filter((item: any) => item.status === 'ready')),
    getPendingItems: vi.fn(() => items.filter((item: any) => item.status === 'pending')),
    getNextReady: vi.fn(() => items.find((item: any) => item.status === 'ready') ?? null),
    getReadyByChannel: vi.fn((channel: string) => items.find((item: any) => item.status === 'ready' && item.channel === channel) ?? null),
    getSnapshots: vi.fn(() => ({})),
    setSnapshots: vi.fn(),
    clearSnapshots: vi.fn(),
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
    listChannels: vi.fn(() => [
      { name: 'walmart', displayName: 'Walmart' },
      { name: 'health', displayName: 'Health' },
    ]),
    getLogChannel: vi.fn(async () => null),
    getLogChannelFor: vi.fn(async () => null),
    getAllChannelSessionKeys: vi.fn(() => []),
    findForumChannel: vi.fn(() => null),
    listForumChannels: vi.fn(() => []),
    getForumThreads: vi.fn(async () => []),
    switchTo: vi.fn(async (target: string) => {
      const channels = [
        { name: 'walmart', displayName: 'Walmart' },
        { name: 'health', displayName: 'Health' },
      ];
      const channel = channels.find((candidate) => candidate.name === target);
      return channel ? { success: true, displayName: channel.displayName } : { success: false, displayName: target };
    }),
    switchToDefault: vi.fn(async () => ({ success: true, displayName: 'Walmart' })),
    createForumPost: vi.fn(async () => ({ success: false, error: 'not implemented' })),
  };
}

function makeResponsePoller() {
  return { check: vi.fn() };
}

function makePipeline(mode: 'wait' | 'queue' | 'ask' = 'ask') {
  const pipeline = new VoicePipeline({} as any);
  const queueState = makeQueueState(mode);
  const router = makeRouter();
  const poller = makeResponsePoller();

  pipeline.setQueueState(queueState as any);
  pipeline.setRouter(router as any);
  pipeline.setResponsePoller(poller as any);

  return { pipeline, queueState, router, poller };
}

async function simulateUtterance(pipeline: VoicePipeline, transcript: string) {
  transcribeImpl = async () => transcript;
  const receiver = (pipeline as any).receiver;
  await receiver.simulateUtterance('user1', Buffer.from('fake-audio'), 500);
  await new Promise((resolve) => setTimeout(resolve, 10));
}

function getState(pipeline: VoicePipeline): string {
  return (pipeline as any).stateMachine.getStateType();
}

describe('Layer 4: Legacy ask mode compatibility', () => {
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

  it('treats ask mode prompts as background dispatches', async () => {
    const { pipeline, queueState } = makePipeline('ask');

    await simulateUtterance(pipeline, 'Tango, add milk to my list');
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(queueState.enqueue).toHaveBeenCalled();
    expect(getState(pipeline)).toBe('IDLE');
    expect(earconHistory).toContain('acknowledged');
    expect(playerCalls).toContain('playStream');

    pipeline.stop();
  });

  it('maps the spoken ask mode command onto background mode', async () => {
    const { pipeline, queueState } = makePipeline('queue');

    await simulateUtterance(pipeline, 'Tango, ask mode');

    expect(queueState.setMode).toHaveBeenCalledWith('queue');
    expect(getState(pipeline)).toBe('IDLE');
    expect(playerCalls).toContain('playStream');

    pipeline.stop();
  });
});
