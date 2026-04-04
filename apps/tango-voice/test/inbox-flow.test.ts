import { describe, it, expect, vi, beforeEach } from 'vitest';

let transcribeImpl: (buf: Buffer) => Promise<string>;
let quickCompletionImpl: (system: string, user: string) => Promise<string>;

vi.mock('../src/services/whisper.js', () => ({
  transcribe: vi.fn(async (buf: Buffer) => transcribeImpl(buf)),
}));

vi.mock('../src/services/claude.js', () => ({
  getResponse: vi.fn(async () => ({ response: 'ok', history: [] })),
  quickCompletion: vi.fn(async (system: string, user: string) => quickCompletionImpl(system, user)),
}));

vi.mock('../src/services/tts.js', () => ({
  textToSpeechStream: vi.fn(async () => Buffer.from('tts-audio')),
}));

vi.mock('../src/discord/audio-receiver.js', () => ({
  AudioReceiver: class {
    private onUtterance: any;
    constructor(_conn: any, onUtterance: any) {
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
    isPlayingEarcon() { return false; }
    async playEarcon(name: string) {
      earconHistory.push(name);
      playerCalls.push(`earcon:${name}`);
    }
    playEarconSync(name: string) {
      earconHistory.push(name);
      playerCalls.push(`earcon:${name}`);
    }
    async playStream() {
      playerCalls.push('playStream');
    }
    startWaitingLoop() {}
    stopWaitingLoop() {}
    stopPlayback() {}
  },
}));

vi.mock('../src/audio/earcons.js', () => ({
  initEarcons: vi.fn(),
}));

let voiceSettings = { gated: true, silenceThreshold: 0.01, silenceDuration: 1500 };

vi.mock('../src/services/voice-settings.js', () => ({
  getVoiceSettings: vi.fn(() => voiceSettings),
  setSilenceDuration: vi.fn(),
  setSpeechThreshold: vi.fn(),
  setGatedMode: vi.fn(),
  setEndpointingMode: vi.fn(),
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

function makeQueueState(mode: 'wait' | 'queue' | 'ask' = 'queue') {
  const items: any[] = [];
  return {
    getMode: vi.fn(() => mode),
    setMode: vi.fn((next: string) => { mode = next as any; }),
    enqueue: vi.fn((params: any) => {
      const item = { id: `q-${items.length}`, ...params, status: 'pending', summary: '', responseText: '', timestamp: Date.now() };
      items.push(item);
      return item;
    }),
    markReady: vi.fn((id: string, summary: string, text: string) => {
      const item = items.find((entry: any) => entry.id === id);
      if (item) {
        item.status = 'ready';
        item.summary = summary;
        item.responseText = text;
      }
    }),
    markHeard: vi.fn((id: string) => {
      const item = items.find((entry: any) => entry.id === id);
      if (item) item.status = 'heard';
    }),
    getReadyItems: vi.fn(() => items.filter((item: any) => item.status === 'ready')),
    getPendingItems: vi.fn(() => items.filter((item: any) => item.status === 'pending')),
    getReadyByChannel: vi.fn((channel: string) => items.find((item: any) => item.status === 'ready' && item.channel === channel) ?? null),
    getNextReady: vi.fn(() => items.find((item: any) => item.status === 'ready') ?? null),
    getSnapshots: vi.fn(() => ({})),
    setSnapshots: vi.fn(),
    clearSnapshots: vi.fn(),
    _items: items,
  };
}

function makeRouter(activeChannel = { name: 'walmart', displayName: 'Walmart' }) {
  const currentChannel = { ...activeChannel };
  return {
    getActiveChannel: vi.fn(() => currentChannel),
    getActiveSessionKey: vi.fn(() => `agent:main:discord:channel:${currentChannel.name}`),
    getTangoRouteFor: vi.fn(() => ({ sessionId: 'tango-default', agentId: 'main', source: 'tango-config', channelKey: 'discord:default' })),
    getSystemPrompt: vi.fn(() => 'system prompt'),
    refreshHistory: vi.fn(async () => {}),
    getHistory: vi.fn(() => []),
    setHistory: vi.fn(),
    getLogChannel: vi.fn(async () => null),
    getLogChannelFor: vi.fn(async () => null),
    switchTo: vi.fn(async (target: string) => {
      currentChannel.name = target;
      currentChannel.displayName = target;
      return { success: true, displayName: target };
    }),
    switchToDefault: vi.fn(async () => {
      currentChannel.name = activeChannel.name;
      currentChannel.displayName = activeChannel.displayName;
      return { success: true, displayName: activeChannel.displayName };
    }),
    getLastMessage: vi.fn(() => null),
    getLastMessageFresh: vi.fn(async () => null),
  };
}

function makePipeline(inboxResponse: any, options?: { mode?: 'wait' | 'queue' | 'ask' }) {
  const pipeline = new VoicePipeline({} as any);
  const router = makeRouter();
  const queueState = makeQueueState(options?.mode ?? 'queue');
  const groupedAgents = inboxResponse.channels.reduce((acc: any[], channel: any) => {
    const agentId = channel.messages[0]?.agentId ?? 'unknown';
    const agentDisplayName = channel.messages[0]?.agentDisplayName ?? channel.displayName;
    const existing = acc.find((item) => item.agentId === agentId);
    if (existing) {
      existing.channels.push(channel);
      existing.totalUnread += channel.unreadCount;
      return acc;
    }
    acc.push({
      agentId,
      agentDisplayName,
      channels: [channel],
      totalUnread: channel.unreadCount,
    });
    return acc;
  }, []);
  const inboxClient = {
    getInbox: vi.fn(async () => inboxResponse),
    getAgentInbox: vi.fn(async () => ({
      ok: true,
      agents: groupedAgents,
      totalUnread: inboxResponse.totalUnread,
      pendingCount: inboxResponse.pendingCount,
    })),
    advanceWatermark: vi.fn(async () => true),
  };

  pipeline.setQueueState(queueState as any);
  pipeline.setRouter(router as any);
  pipeline.setInboxClient(inboxClient as any);

  return { pipeline, router, inboxClient, queueState };
}

async function simulateUtterance(pipeline: VoicePipeline, transcript: string) {
  transcribeImpl = async () => transcript;
  const receiver = (pipeline as any).receiver;
  await receiver.simulateUtterance('user1', Buffer.from('fake-audio'), 500);
  await new Promise((r) => setTimeout(r, 10));
}

function getState(pipeline: VoicePipeline): string {
  return (pipeline as any).stateMachine.getStateType();
}

describe('Layer 6: Inbox Flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    earconHistory.length = 0;
    playerCalls.length = 0;
    voiceSettings = { gated: true, silenceThreshold: 0.01, silenceDuration: 1500 };
    transcribeImpl = async () => '';
    quickCompletionImpl = async () => '';
  });

  it('enters inbox flow when unified inbox has unread channels', async () => {
    const { pipeline, inboxClient } = makePipeline({
      ok: true,
      totalUnread: 2,
      pendingCount: 0,
      channels: [
        {
          channelId: 'health',
          channelName: 'health',
          displayName: 'Health',
          unreadCount: 2,
          messages: [
            {
              messageId: 'm1',
              channelId: 'health',
              channelName: 'health',
              agentDisplayName: 'Watson',
              agentId: 'watson',
              content: 'Check the latest update.',
              timestamp: 123,
              isChunked: false,
              chunkGroupId: null,
            },
          ],
        },
      ],
    });

    await simulateUtterance(pipeline, 'Tango, check inbox');

    expect(inboxClient.getAgentInbox).toHaveBeenCalled();
    expect(getState(pipeline)).toBe('INBOX_FLOW');
    expect(playerCalls).toContain('playStream');
    expect(earconHistory).toContain('ready');
    pipeline.stop();
  });

  it('reports zero ready when unified inbox is empty', async () => {
    const { pipeline, inboxClient } = makePipeline({
      ok: true,
      totalUnread: 0,
      pendingCount: 1,
      channels: [],
    });

    await simulateUtterance(pipeline, 'Tango, check inbox');

    expect(inboxClient.getAgentInbox).toHaveBeenCalled();
    expect(getState(pipeline)).toBe('IDLE');
    expect(playerCalls).toContain('playStream');
    expect(earconHistory).toContain('ready');
    pipeline.stop();
  });

  it('includes a local ready response in "what\'s up" even when the remote inbox is empty', async () => {
    const { pipeline } = makePipeline({
      ok: true,
      totalUnread: 0,
      pendingCount: 0,
      channels: [],
    });

    (pipeline as any).storeLocalReadyItem({
      id: 'local-1',
      channel: 'malibu',
      displayName: 'Malibu',
      sessionKey: 'agent:main:discord:channel:malibu',
      userMessage: 'check the latest message',
      speakerAgentId: 'malibu',
      summary: 'Ready summary.',
      responseText: 'Here is the Malibu response.',
      timestamp: Date.now(),
      status: 'ready',
    });

    await simulateUtterance(pipeline, "Tango, what's up");

    expect((pipeline as any).ctx.lastSpokenText).toContain('Malibu has 1 message');
    expect(getState(pipeline)).toBe('IDLE');
    pipeline.stop();
  });

  it('announces local-ready agents without entering an empty inbox flow', async () => {
    const { pipeline } = makePipeline({
      ok: true,
      totalUnread: 0,
      pendingCount: 0,
      channels: [],
    });

    (pipeline as any).storeLocalReadyItem({
      id: 'local-2',
      channel: 'malibu',
      displayName: 'Malibu',
      sessionKey: 'agent:main:discord:channel:malibu',
      userMessage: 'check the latest message',
      speakerAgentId: 'malibu',
      summary: 'Ready summary.',
      responseText: 'Here is the Malibu response.',
      timestamp: Date.now(),
      status: 'ready',
    });

    await simulateUtterance(pipeline, 'Tango, check inbox');

    expect((pipeline as any).ctx.lastSpokenText).toContain('Malibu has 1 message');
    expect(getState(pipeline)).toBe('IDLE');
    pipeline.stop();
  });

  it('reads the next unified inbox item and advances its watermark', async () => {
    const { pipeline, router, inboxClient } = makePipeline({
      ok: true,
      totalUnread: 1,
      pendingCount: 0,
      channels: [
        {
          channelId: 'health',
          channelName: 'health',
          displayName: 'Health',
          unreadCount: 1,
          messages: [
            {
              messageId: 'm1',
              channelId: 'health',
              channelName: 'health',
              agentDisplayName: 'Watson',
              agentId: 'watson',
              content: 'Here is the health response.',
              timestamp: 123,
              isChunked: false,
              chunkGroupId: null,
            },
          ],
        },
      ],
    });

    inboxClient.getAgentInbox
      .mockResolvedValueOnce({
        ok: true,
        agents: [
          {
            agentId: 'watson',
            agentDisplayName: 'Watson',
            channels: [
              {
                channelId: 'health',
                channelName: 'health',
                displayName: 'Health',
                unreadCount: 1,
                messages: [
                  {
                    messageId: 'm1',
                    channelId: 'health',
                    channelName: 'health',
                    agentDisplayName: 'Watson',
                    agentId: 'watson',
                    content: 'Here is the health response.',
                    timestamp: 123,
                    isChunked: false,
                    chunkGroupId: null,
                  },
                ],
              },
            ],
            totalUnread: 1,
          },
        ],
        totalUnread: 1,
        pendingCount: 0,
      })
      .mockResolvedValueOnce({
        ok: true,
        agents: [],
        totalUnread: 0,
        pendingCount: 0,
      });

    await simulateUtterance(pipeline, 'Tango, check inbox');
    await simulateUtterance(pipeline, 'Tango, next');

    expect(router.switchTo).toHaveBeenCalledWith('health');
    expect(router.switchTo).toHaveBeenCalledTimes(1);
    expect(inboxClient.advanceWatermark).toHaveBeenCalledWith('health', 'm1', 'voice-playback');
    expect(getState(pipeline)).toBe('IDLE');
    pipeline.stop();
  });

  it('reads single-channel agent messages one at a time before moving to the next agent', async () => {
    const victorChannelInitial = {
      channelId: 'victor',
      channelName: 'victor',
      displayName: 'Victor',
      unreadCount: 2,
      messages: [
        {
          messageId: 'v1',
          channelId: 'victor',
          channelName: 'victor',
          agentDisplayName: 'Victor',
          agentId: 'victor',
          content: 'Budget review is ready for approval.',
          timestamp: 123,
          isChunked: false,
          chunkGroupId: null,
        },
        {
          messageId: 'v2',
          channelId: 'victor',
          channelName: 'victor',
          agentDisplayName: 'Victor',
          agentId: 'victor',
          content: 'I also sent the updated vendor list.',
          timestamp: 124,
          isChunked: false,
          chunkGroupId: null,
        },
      ],
    };
    const victorChannelRemaining = {
      ...victorChannelInitial,
      unreadCount: 1,
      messages: [victorChannelInitial.messages[1]],
    };
    const malibuChannel = {
      channelId: 'malibu',
      channelName: 'malibu',
      displayName: 'Malibu',
      unreadCount: 1,
      messages: [
        {
          messageId: 'm1',
          channelId: 'malibu',
          channelName: 'malibu',
          agentDisplayName: 'Malibu',
          agentId: 'malibu',
          content: 'Protein target is still on track.',
          timestamp: 125,
          isChunked: false,
          chunkGroupId: null,
        },
      ],
    };

    const { pipeline, router, inboxClient } = makePipeline({
      ok: true,
      totalUnread: 3,
      pendingCount: 0,
      channels: [
        victorChannelInitial,
        malibuChannel,
      ],
    });

    inboxClient.getAgentInbox
      .mockResolvedValueOnce({
        ok: true,
        agents: [
          {
            agentId: 'victor',
            agentDisplayName: 'Victor',
            channels: [victorChannelInitial],
            totalUnread: 2,
          },
          {
            agentId: 'malibu',
            agentDisplayName: 'Malibu',
            channels: [malibuChannel],
            totalUnread: 1,
          },
        ],
        totalUnread: 3,
        pendingCount: 0,
      })
      .mockResolvedValueOnce({
        ok: true,
        agents: [
          {
            agentId: 'victor',
            agentDisplayName: 'Victor',
            channels: [victorChannelRemaining],
            totalUnread: 1,
          },
          {
            agentId: 'malibu',
            agentDisplayName: 'Malibu',
            channels: [malibuChannel],
            totalUnread: 1,
          },
        ],
        totalUnread: 2,
        pendingCount: 0,
      })
      .mockResolvedValueOnce({
        ok: true,
        agents: [
          {
            agentId: 'victor',
            agentDisplayName: 'Victor',
            channels: [victorChannelRemaining],
            totalUnread: 1,
          },
          {
            agentId: 'malibu',
            agentDisplayName: 'Malibu',
            channels: [malibuChannel],
            totalUnread: 1,
          },
        ],
        totalUnread: 2,
        pendingCount: 0,
      })
      .mockResolvedValueOnce({
        ok: true,
        agents: [
          {
            agentId: 'malibu',
            agentDisplayName: 'Malibu',
            channels: [malibuChannel],
            totalUnread: 1,
          },
        ],
        totalUnread: 1,
        pendingCount: 0,
      });

    await simulateUtterance(pipeline, 'Tango, check inbox');
    await simulateUtterance(pipeline, 'go ahead Victor');

    expect((pipeline as any).ctx.lastSpokenText).toContain('Budget review is ready for approval.');
    expect((pipeline as any).ctx.lastSpokenText).not.toContain('tell me about a topic');
    expect(router.switchTo).toHaveBeenCalledTimes(1);
    expect(inboxClient.advanceWatermark).toHaveBeenCalledWith('victor', 'v1', 'voice-playback');

    await simulateUtterance(pipeline, 'next');

    expect((pipeline as any).ctx.lastSpokenText).toContain('I also sent the updated vendor list.');
    expect((pipeline as any).ctx.lastSpokenText).not.toContain('Protein target is still on track.');
    expect(inboxClient.advanceWatermark).toHaveBeenCalledWith('victor', 'v2', 'voice-playback');

    await simulateUtterance(pipeline, 'next');

    expect((pipeline as any).ctx.lastSpokenText).toContain('Protein target is still on track.');
    pipeline.stop();
  });

  it('does not echo-suppress topic-selection replies during inbox flow', async () => {
    quickCompletionImpl = async (system: string) => {
      if (system.includes('Summarize the topics')) {
        return 'I have an update in Budget Review and a response in Hiring Plan.';
      }
      if (system.includes('message classifier')) {
        return '1';
      }
      return '';
    };

    const { pipeline, router, inboxClient } = makePipeline({
      ok: true,
      totalUnread: 2,
      pendingCount: 0,
      channels: [
        {
          channelId: 'victor-budget',
          channelName: 'victor-budget',
          displayName: 'Budget Review',
          unreadCount: 1,
          messages: [
            {
              messageId: 'vb1',
              channelId: 'victor-budget',
              channelName: 'victor-budget',
              agentDisplayName: 'Victor',
              agentId: 'victor',
              content: 'Budget review is ready for approval.',
              timestamp: 123,
              isChunked: false,
              chunkGroupId: null,
            },
          ],
        },
        {
          channelId: 'victor-hiring',
          channelName: 'victor-hiring',
          displayName: 'Hiring Plan',
          unreadCount: 1,
          messages: [
            {
              messageId: 'vh1',
              channelId: 'victor-hiring',
              channelName: 'victor-hiring',
              agentDisplayName: 'Victor',
              agentId: 'victor',
              content: 'The hiring plan now includes two senior roles.',
              timestamp: 124,
              isChunked: false,
              chunkGroupId: null,
            },
          ],
        },
      ],
    });

    await simulateUtterance(pipeline, 'Tango, check inbox');
    await simulateUtterance(pipeline, 'go ahead Victor');
    await simulateUtterance(pipeline, 'tell me about hiring plan');

    expect((pipeline as any).ctx.lastSpokenText).toContain('The hiring plan now includes two senior roles.');
    expect(router.switchTo).toHaveBeenCalledTimes(1);
    expect(inboxClient.advanceWatermark).toHaveBeenCalledWith('victor-hiring', 'vh1', 'voice-playback');
    pipeline.stop();
  });

  it('treats read all as sequential playback for the current agent', async () => {
    quickCompletionImpl = async (system: string) => {
      if (system.includes('Summarize the topics')) {
        return 'I have messages in Calendar and Slack Summary.';
      }
      return '';
    };

    const watsonCalendarChannel = {
      channelId: 'watson-calendar',
      channelName: 'watson-calendar',
      displayName: 'Calendar',
      unreadCount: 1,
      messages: [
        {
          messageId: 'wc1',
          channelId: 'watson-calendar',
          channelName: 'watson-calendar',
          agentDisplayName: 'Watson',
          agentId: 'watson',
          content: 'Your bat exclusion appointment is booked for April 14th at 8 AM.',
          timestamp: 123,
          isChunked: false,
          chunkGroupId: null,
        },
      ],
    };
    const watsonSlackChannel = {
      channelId: 'watson-slack',
      channelName: 'watson-slack',
      displayName: 'Slack Summary',
      unreadCount: 1,
      messages: [
        {
          messageId: 'ws1',
          channelId: 'watson-slack',
          channelName: 'watson-slack',
          agentDisplayName: 'Watson',
          agentId: 'watson',
          content: 'Voyage shipped the revised friend-invite navigation to alpha today.',
          timestamp: 124,
          isChunked: false,
          chunkGroupId: null,
        },
      ],
    };

    const { pipeline, inboxClient } = makePipeline({
      ok: true,
      totalUnread: 2,
      pendingCount: 0,
      channels: [watsonCalendarChannel, watsonSlackChannel],
    });

    inboxClient.getAgentInbox
      .mockResolvedValueOnce({
        ok: true,
        agents: [
          {
            agentId: 'watson',
            agentDisplayName: 'Watson',
            channels: [watsonCalendarChannel, watsonSlackChannel],
            totalUnread: 2,
          },
        ],
        totalUnread: 2,
        pendingCount: 0,
      })
      .mockResolvedValueOnce({
        ok: true,
        agents: [
          {
            agentId: 'watson',
            agentDisplayName: 'Watson',
            channels: [watsonSlackChannel],
            totalUnread: 1,
          },
        ],
        totalUnread: 1,
        pendingCount: 0,
      })
      .mockResolvedValueOnce({
        ok: true,
        agents: [
          {
            agentId: 'watson',
            agentDisplayName: 'Watson',
            channels: [watsonSlackChannel],
            totalUnread: 1,
          },
        ],
        totalUnread: 1,
        pendingCount: 0,
      })
      .mockResolvedValueOnce({
        ok: true,
        agents: [],
        totalUnread: 0,
        pendingCount: 0,
      });

    await simulateUtterance(pipeline, 'Tango, check inbox');
    await simulateUtterance(pipeline, 'go ahead Watson');

    expect((pipeline as any).ctx.lastSpokenText).toContain('summarize, read all, or next');

    await simulateUtterance(pipeline, 'read all');

    expect((pipeline as any).ctx.lastSpokenText).toContain('bat exclusion appointment is booked');
    expect((pipeline as any).ctx.lastSpokenText).not.toContain('friend-invite navigation');
    expect((pipeline as any).ctx.lastSpokenText).not.toContain('Summary.');
    expect(inboxClient.advanceWatermark).toHaveBeenCalledWith('watson-calendar', 'wc1', 'voice-playback');

    await simulateUtterance(pipeline, 'next');

    expect((pipeline as any).ctx.lastSpokenText).toContain('friend-invite navigation');
    expect(inboxClient.advanceWatermark).toHaveBeenCalledWith('watson-slack', 'ws1', 'voice-playback');
    pipeline.stop();
  });

  it('supports summarize as an explicit catch-up summary for the current agent', async () => {
    quickCompletionImpl = async (system: string) => {
      if (system.includes('Summarize the topics')) {
        return 'I have messages in watson, Slack Summary, and Youtube Setup.';
      }
      if (system.includes('spoken voice UX')) {
        return 'Watson has calendar, Slack, and YouTube updates. The blocker is the Mac Mini SSH access.';
      }
      return '';
    };

    const longA = 'Bat exclusion is booked for April 14th with an 8 to 10 AM arrival window. '.repeat(10);
    const longB = 'Slack digest covers Voyage launch timing, alpha navigation, and node infrastructure changes. '.repeat(10);
    const longC = 'YouTube audit is blocked because the worker SSH key is not yet authorized on the Mac Mini. '.repeat(10);

    const { pipeline, inboxClient } = makePipeline({
      ok: true,
      totalUnread: 3,
      pendingCount: 0,
      channels: [
        {
          channelId: 'watson-home',
          channelName: 'watson',
          displayName: 'watson',
          unreadCount: 1,
          messages: [
            {
              messageId: 'w1',
              channelId: 'watson-home',
              channelName: 'watson',
              agentDisplayName: 'Watson',
              agentId: 'watson',
              content: longA,
              timestamp: 123,
              isChunked: false,
              chunkGroupId: null,
            },
          ],
        },
        {
          channelId: 'watson-slack',
          channelName: 'Slack Summary',
          displayName: 'Slack Summary',
          unreadCount: 1,
          messages: [
            {
              messageId: 'w2',
              channelId: 'watson-slack',
              channelName: 'Slack Summary',
              agentDisplayName: 'Watson',
              agentId: 'watson',
              content: longB,
              timestamp: 124,
              isChunked: false,
              chunkGroupId: null,
            },
          ],
        },
        {
          channelId: 'watson-youtube',
          channelName: 'Youtube Setup',
          displayName: 'Youtube Setup',
          unreadCount: 1,
          messages: [
            {
              messageId: 'w3',
              channelId: 'watson-youtube',
              channelName: 'Youtube Setup',
              agentDisplayName: 'Watson',
              agentId: 'watson',
              content: longC,
              timestamp: 125,
              isChunked: false,
              chunkGroupId: null,
            },
          ],
        },
      ],
    });

    inboxClient.getAgentInbox.mockResolvedValueOnce({
      ok: true,
      agents: [
        {
          agentId: 'watson',
          agentDisplayName: 'Watson',
          channels: [
            {
              channelId: 'watson-home',
              channelName: 'watson',
              displayName: 'watson',
              unreadCount: 1,
              messages: [
                {
                  messageId: 'w1',
                  channelId: 'watson-home',
                  channelName: 'watson',
                  agentDisplayName: 'Watson',
                  agentId: 'watson',
                  content: longA,
                  timestamp: 123,
                  isChunked: false,
                  chunkGroupId: null,
                },
              ],
            },
            {
              channelId: 'watson-slack',
              channelName: 'Slack Summary',
              displayName: 'Slack Summary',
              unreadCount: 1,
              messages: [
                {
                  messageId: 'w2',
                  channelId: 'watson-slack',
                  channelName: 'Slack Summary',
                  agentDisplayName: 'Watson',
                  agentId: 'watson',
                  content: longB,
                  timestamp: 124,
                  isChunked: false,
                  chunkGroupId: null,
                },
              ],
            },
            {
              channelId: 'watson-youtube',
              channelName: 'Youtube Setup',
              displayName: 'Youtube Setup',
              unreadCount: 1,
              messages: [
                {
                  messageId: 'w3',
                  channelId: 'watson-youtube',
                  channelName: 'Youtube Setup',
                  agentDisplayName: 'Watson',
                  agentId: 'watson',
                  content: longC,
                  timestamp: 125,
                  isChunked: false,
                  chunkGroupId: null,
                },
              ],
            },
          ],
          totalUnread: 3,
        },
      ],
      totalUnread: 3,
      pendingCount: 0,
    });

    await simulateUtterance(pipeline, 'Tango, check inbox');
    await simulateUtterance(pipeline, 'go ahead Watson');
    await simulateUtterance(pipeline, 'summarize');

    expect((pipeline as any).ctx.lastSpokenText).toContain('Summary.');
    expect((pipeline as any).ctx.lastSpokenText).toContain('Watson has calendar, Slack, and YouTube updates.');
    expect((pipeline as any).ctx.lastSpokenText).not.toContain(longA.slice(0, 80));
    expect(inboxClient.advanceWatermark).toHaveBeenCalledWith('watson-home', 'w1', 'voice-playback');
    expect(inboxClient.advanceWatermark).toHaveBeenCalledWith('watson-slack', 'w2', 'voice-playback');
    expect(inboxClient.advanceWatermark).toHaveBeenCalledWith('watson-youtube', 'w3', 'voice-playback');
    pipeline.stop();
  });

  it('supports respond as an explicit reply handoff from the current inbox message', async () => {
    const victorChannel = {
      channelId: 'victor',
      channelName: 'victor',
      displayName: 'Victor',
      unreadCount: 1,
      messages: [
        {
          messageId: 'v1',
          channelId: 'victor',
          channelName: 'victor',
          agentDisplayName: 'Victor',
          agentId: 'victor',
          content: 'Can you send the updated numbers?',
          timestamp: 123,
          isChunked: false,
          chunkGroupId: null,
        },
      ],
    };

    const { pipeline, queueState, router } = makePipeline({
      ok: true,
      totalUnread: 1,
      pendingCount: 0,
      channels: [victorChannel],
    });

    await simulateUtterance(pipeline, 'Tango, check inbox');
    await simulateUtterance(pipeline, 'go ahead Victor');

    expect((pipeline as any).ctx.lastSpokenText).toContain('Can you send the updated numbers?');

    await simulateUtterance(pipeline, 'respond');

    expect(getState(pipeline)).toBe('IDLE');
    expect((pipeline as any).ctx.lastSpokenIsChannelMessage).toBe(true);
    expect(router.getActiveChannel().name).toBe('victor');

    await simulateUtterance(pipeline, 'send the updated numbers to finance');

    expect(queueState.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'victor',
        userMessage: 'send the updated numbers to finance',
      }),
    );

    pipeline.stop();
  });

  it('uses channel names for agent summaries when inbox display names collapse to the agent name', async () => {
    const { pipeline } = makePipeline({
      ok: true,
      totalUnread: 2,
      pendingCount: 0,
      channels: [
        {
          channelId: 'sierra-grid',
          channelName: 'openGrid and Underware',
          displayName: 'Sierra',
          unreadCount: 1,
          messages: [
            {
              messageId: 'sg1',
              channelId: 'sierra-grid',
              channelName: 'openGrid and Underware',
              agentDisplayName: 'Sierra',
              agentId: 'sierra',
              content: 'All three remaining pieces are plated and ready to queue.',
              timestamp: 123,
              isChunked: false,
              chunkGroupId: null,
            },
          ],
        },
        {
          channelId: 'sierra-hvac',
          channelName: 'HVAC',
          displayName: 'Sierra',
          unreadCount: 1,
          messages: [
            {
              messageId: 'sh1',
              channelId: 'sierra-hvac',
              channelName: 'HVAC',
              agentDisplayName: 'Sierra',
              agentId: 'sierra',
              content: 'The basement return is the correct fix.',
              timestamp: 124,
              isChunked: false,
              chunkGroupId: null,
            },
          ],
        },
      ],
    });

    await simulateUtterance(pipeline, 'Tango, check inbox');
    await simulateUtterance(pipeline, 'go ahead Sierra');

    expect((pipeline as any).ctx.lastSpokenText).toContain('openGrid and Underware');
    expect((pipeline as any).ctx.lastSpokenText).toContain('HVAC');
    expect((pipeline as any).ctx.lastSpokenText).not.toContain('I have messages about Sierra.');
    pipeline.stop();
  });

  it('matches exact topic labels without relying on the classifier', async () => {
    quickCompletionImpl = async () => '-1';

    const { pipeline, router, inboxClient } = makePipeline({
      ok: true,
      totalUnread: 2,
      pendingCount: 0,
      channels: [
        {
          channelId: 'sierra-grid',
          channelName: 'openGrid and Underware',
          displayName: 'Sierra',
          unreadCount: 1,
          messages: [
            {
              messageId: 'sg1',
              channelId: 'sierra-grid',
              channelName: 'openGrid and Underware',
              agentDisplayName: 'Sierra',
              agentId: 'sierra',
              content: 'All three remaining pieces are plated and ready to queue.',
              timestamp: 123,
              isChunked: false,
              chunkGroupId: null,
            },
          ],
        },
        {
          channelId: 'sierra-hvac',
          channelName: 'HVAC',
          displayName: 'Sierra',
          unreadCount: 1,
          messages: [
            {
              messageId: 'sh1',
              channelId: 'sierra-hvac',
              channelName: 'HVAC',
              agentDisplayName: 'Sierra',
              agentId: 'sierra',
              content: 'The basement return is the correct fix.',
              timestamp: 124,
              isChunked: false,
              chunkGroupId: null,
            },
          ],
        },
      ],
    });

    await simulateUtterance(pipeline, 'Tango, check inbox');
    await simulateUtterance(pipeline, 'go ahead Sierra');
    await simulateUtterance(pipeline, 'tell me about hvac');

    expect((pipeline as any).ctx.lastSpokenText).toContain('The basement return is the correct fix.');
    expect((pipeline as any).ctx.lastSpokenText).not.toContain('All three remaining pieces are plated');
    expect(router.switchTo).toHaveBeenCalledWith('HVAC');
    expect(inboxClient.advanceWatermark).toHaveBeenCalledWith('sierra-hvac', 'sh1', 'voice-playback');
    pipeline.stop();
  });

  it('reprompts instead of falling back to the first topic when topic selection is ambiguous', async () => {
    quickCompletionImpl = async () => '-1';

    const { pipeline, router, inboxClient } = makePipeline({
      ok: true,
      totalUnread: 2,
      pendingCount: 0,
      channels: [
        {
          channelId: 'sierra-grid',
          channelName: 'openGrid and Underware',
          displayName: 'Sierra',
          unreadCount: 1,
          messages: [
            {
              messageId: 'sg1',
              channelId: 'sierra-grid',
              channelName: 'openGrid and Underware',
              agentDisplayName: 'Sierra',
              agentId: 'sierra',
              content: 'All three remaining pieces are plated and ready to queue.',
              timestamp: 123,
              isChunked: false,
              chunkGroupId: null,
            },
          ],
        },
        {
          channelId: 'sierra-hvac',
          channelName: 'HVAC',
          displayName: 'Sierra',
          unreadCount: 1,
          messages: [
            {
              messageId: 'sh1',
              channelId: 'sierra-hvac',
              channelName: 'HVAC',
              agentDisplayName: 'Sierra',
              agentId: 'sierra',
              content: 'The basement return is the correct fix.',
              timestamp: 124,
              isChunked: false,
              chunkGroupId: null,
            },
          ],
        },
      ],
    });

    await simulateUtterance(pipeline, 'Tango, check inbox');
    await simulateUtterance(pipeline, 'go ahead Sierra');
    await simulateUtterance(pipeline, 'tell me about each fact');

    expect((pipeline as any).ctx.lastSpokenText).toContain('I didn\'t match "each fact"');
    expect((pipeline as any).ctx.lastSpokenText).toContain('openGrid and Underware or HVAC');
    expect((pipeline as any).ctx.lastSpokenText).not.toContain('All three remaining pieces are plated');
    expect(router.switchTo).not.toHaveBeenCalled();
    expect(inboxClient.advanceWatermark).not.toHaveBeenCalled();
    expect(getState(pipeline)).toBe('INBOX_FLOW');
    pipeline.stop();
  });

  it('keeps next scoped to the current agent until that agent is exhausted', async () => {
    quickCompletionImpl = async (system: string) => {
      if (system.includes('Summarize the topics')) {
        return 'Sierra has updates in Jar Labels and Machining Queue.';
      }
      if (system.includes('message classifier')) {
        return '0';
      }
      return '';
    };

    const sierraJarChannel = {
      channelId: 'sierra-jar',
      channelName: 'sierra-jar',
      displayName: 'Jar Labels',
      unreadCount: 1,
      messages: [
        {
          messageId: 'sj1',
          channelId: 'sierra-jar',
          channelName: 'sierra-jar',
          agentDisplayName: 'Sierra',
          agentId: 'sierra',
          content: "Blue painter's tape and a Sharpie work best on the jars.",
          timestamp: 123,
          isChunked: false,
          chunkGroupId: null,
        },
      ],
    };
    const sierraMachiningChannel = {
      channelId: 'sierra-machining',
      channelName: 'sierra-machining',
      displayName: 'Machining Queue',
      unreadCount: 1,
      messages: [
        {
          messageId: 'sm1',
          channelId: 'sierra-machining',
          channelName: 'sierra-machining',
          agentDisplayName: 'Sierra',
          agentId: 'sierra',
          content: 'Three parts are queued and ready for machining.',
          timestamp: 124,
          isChunked: false,
          chunkGroupId: null,
        },
      ],
    };
    const victorStrategyChannel = {
      channelId: 'victor-strategy',
      channelName: 'victor-strategy',
      displayName: 'Strategy',
      unreadCount: 1,
      messages: [
        {
          messageId: 'vs1',
          channelId: 'victor-strategy',
          channelName: 'victor-strategy',
          agentDisplayName: 'Victor',
          agentId: 'victor',
          content: 'The strategy memo is ready for review.',
          timestamp: 125,
          isChunked: false,
          chunkGroupId: null,
        },
      ],
    };

    const { pipeline, inboxClient } = makePipeline({
      ok: true,
      totalUnread: 3,
      pendingCount: 0,
      channels: [
        sierraJarChannel,
        sierraMachiningChannel,
        victorStrategyChannel,
      ],
    });

    inboxClient.getAgentInbox
      .mockResolvedValueOnce({
        ok: true,
        agents: [
          {
            agentId: 'sierra',
            agentDisplayName: 'Sierra',
            channels: [sierraJarChannel, sierraMachiningChannel],
            totalUnread: 2,
          },
          {
            agentId: 'victor',
            agentDisplayName: 'Victor',
            channels: [victorStrategyChannel],
            totalUnread: 1,
          },
        ],
        totalUnread: 3,
        pendingCount: 0,
      })
      .mockResolvedValueOnce({
        ok: true,
        agents: [
          {
            agentId: 'sierra',
            agentDisplayName: 'Sierra',
            channels: [sierraMachiningChannel],
            totalUnread: 1,
          },
          {
            agentId: 'victor',
            agentDisplayName: 'Victor',
            channels: [victorStrategyChannel],
            totalUnread: 1,
          },
        ],
        totalUnread: 2,
        pendingCount: 0,
      })
      .mockResolvedValueOnce({
        ok: true,
        agents: [
          {
            agentId: 'victor',
            agentDisplayName: 'Victor',
            channels: [victorStrategyChannel],
            totalUnread: 1,
          },
        ],
        totalUnread: 1,
        pendingCount: 0,
      });

    await simulateUtterance(pipeline, 'Tango, check inbox');
    await simulateUtterance(pipeline, 'go ahead Sierra');
    await simulateUtterance(pipeline, 'tell me about jar labels');

    expect((pipeline as any).ctx.lastSpokenText).toContain("Blue painter's tape and a Sharpie work best on the jars.");

    await simulateUtterance(pipeline, 'next');

    expect((pipeline as any).ctx.lastSpokenText).toContain('Three parts are queued and ready for machining.');
    expect((pipeline as any).ctx.lastSpokenText).not.toContain('The strategy memo is ready for review.');

    await simulateUtterance(pipeline, 'next');

    expect((pipeline as any).ctx.lastSpokenText).toContain('The strategy memo is ready for review.');
    pipeline.stop();
  });

  it('clears remaining unified inbox channels through dismiss watermarks', async () => {
    const { pipeline, inboxClient } = makePipeline({
      ok: true,
      totalUnread: 2,
      pendingCount: 0,
      channels: [
        {
          channelId: 'health',
          channelName: 'health',
          displayName: 'Health',
          unreadCount: 1,
          messages: [
            {
              messageId: 'h1',
              channelId: 'health',
              channelName: 'health',
              agentDisplayName: 'Watson',
              agentId: 'watson',
              content: 'Health item',
              timestamp: 1,
              isChunked: false,
              chunkGroupId: null,
            },
          ],
        },
        {
          channelId: 'nutrition',
          channelName: 'nutrition',
          displayName: 'Nutrition',
          unreadCount: 1,
          messages: [
            {
              messageId: 'n1',
              channelId: 'nutrition',
              channelName: 'nutrition',
              agentDisplayName: 'Malibu',
              agentId: 'malibu',
              content: 'Nutrition item',
              timestamp: 2,
              isChunked: false,
              chunkGroupId: null,
            },
          ],
        },
      ],
    });

    await simulateUtterance(pipeline, 'Tango, check inbox');
    await simulateUtterance(pipeline, 'Tango, clear inbox');

    expect(inboxClient.advanceWatermark).toHaveBeenCalledWith('health', 'h1', 'voice-dismiss');
    expect(inboxClient.advanceWatermark).toHaveBeenCalledWith('nutrition', 'n1', 'voice-dismiss');
    expect(getState(pipeline)).toBe('IDLE');
    pipeline.stop();
  });
});
