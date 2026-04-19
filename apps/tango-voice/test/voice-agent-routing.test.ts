import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceTopicManager } from '../src/services/voice-topics.js';
import { VoiceProjectManager } from '../src/services/voice-projects.js';
import { textToSpeechStream } from '../src/services/tts.js';

const TEST_DEFAULT_SESSION_CHANNEL_ID = '100000000000010001';
const TEST_PROJECT_SESSION_CHANNEL_ID = '100000000000010002';

const { requestTangoVoiceTurn } = vi.hoisted(() => ({
  requestTangoVoiceTurn: vi.fn(async () => ({
    responseText: 'Added.',
    providerName: 'test-provider',
  })),
}));

vi.mock('../src/services/claude.js', () => ({
  getResponse: vi.fn(async () => ({ response: 'unused' })),
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
    indicateTimeoutMs: 20000,
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
  resolveNoiseLevel: vi.fn(() => 0.01),
  getNoisePresetNames: vi.fn(() => ['low', 'medium', 'high']),
}));

vi.mock('../src/services/tango-voice.js', () => ({
  shouldUseTangoVoiceBridge: vi.fn(() => true),
  requestTangoVoiceTurn,
}));

import { VoicePipeline } from '../src/pipeline/voice-pipeline.js';

describe('VoicePipeline agent routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makePipeline() {
    const topicStorage = {
      topicsById: new Map<string, any>(),
      topicsByKey: new Map<string, any>(),
      upsertTopic(input: {
        channelKey: string;
        slug: string;
        title: string;
        leadAgentId?: string | null;
        projectId?: string | null;
      }) {
        const key = `${input.channelKey}:${input.slug}`;
        const existing = this.topicsByKey.get(key);
        if (existing) {
          const updated = {
            ...existing,
            title: input.title,
            leadAgentId: input.leadAgentId ?? existing.leadAgentId,
            projectId: input.projectId ?? existing.projectId,
          };
          this.topicsByKey.set(key, updated);
          this.topicsById.set(updated.id, updated);
          return updated;
        }
        const created = {
          id: `topic-${input.slug}`,
          channelKey: input.channelKey,
          slug: input.slug,
          title: input.title,
          leadAgentId: input.leadAgentId ?? null,
          projectId: input.projectId ?? null,
          status: 'active',
          createdAt: 'now',
          updatedAt: 'now',
        };
        this.topicsByKey.set(key, created);
        this.topicsById.set(created.id, created);
        return created;
      },
      getTopicById(topicId: string) {
        return this.topicsById.get(topicId) ?? null;
      },
      close() {},
    };
    const pipeline = new VoicePipeline(
      {} as any,
      undefined,
      {
        topicManager: new VoiceTopicManager(() => topicStorage as any),
        projectManager: new VoiceProjectManager({
          storageFactory: () => ({
            getFocusedProjectIdForChannel() {
              return null;
            },
            setFocusedProjectForChannel() {},
            close() {},
          }),
          projectDirectory: {
            listProjects() {
              return [
                {
                  id: 'tango',
                  displayName: 'Tango MVP',
                  aliases: ['tango mvp'],
                  defaultAgentId: 'watson',
                  provider: { default: 'claude-harness', fallback: ['codex'] },
                },
              ];
            },
            getProject(projectId: string | null | undefined) {
              if (projectId !== 'tango') return null;
              return {
                id: 'tango',
                displayName: 'Tango MVP',
                aliases: ['tango mvp'],
                defaultAgentId: 'watson',
                provider: { default: 'claude-harness', fallback: ['codex'] },
              };
            },
            resolveProjectQuery(query: string) {
              return query.trim().toLowerCase() === 'tango mvp'
                ? {
                    id: 'tango',
                    displayName: 'Tango MVP',
                    aliases: ['tango mvp'],
                    defaultAgentId: 'watson',
                    provider: { default: 'claude-harness', fallback: ['codex'] },
                  }
                : null;
            },
          },
        }),
      },
    );
    vi.spyOn(pipeline as any, 'speakResponse').mockResolvedValue(undefined);
    vi.spyOn(pipeline as any, 'playReadyEarcon').mockResolvedValue(undefined);
    return pipeline;
  }

  it('accepts system commands through explicit addressing while preserving wake-only checks', () => {
    const pipeline = makePipeline();

    expect((pipeline as any).parseAddressedCommand('Tango, settings')).toEqual({ type: 'settings' });
    expect((pipeline as any).parseAddressedCommand('Watson, settings')).toEqual({ type: 'settings' });
    expect((pipeline as any).parseAddressedCommand('Watson')).toEqual({ type: 'wake-check' });

    pipeline.stop();
  });

  it('uses Malibu Kokoro voice overrides for Malibu speech playback', async () => {
    const pipeline = new VoicePipeline({} as any);
    const ttsMock = vi.mocked(textToSpeechStream);

    await (pipeline as any).speakResponse('Stay steady.', {
      speakerAgentId: 'malibu',
      isChannelMessage: true,
    });

    expect(ttsMock).toHaveBeenCalledWith('Stay steady.', {
      kokoroVoice: 'am_puck',
    });

    pipeline.stop();
  });

  it('stops active playback before requesting new TTS audio', async () => {
    const pipeline = new VoicePipeline({} as any);
    const order: string[] = [];
    const ttsMock = vi.mocked(textToSpeechStream);

    vi.spyOn((pipeline as any).player, 'stopPlayback').mockImplementation(() => {
      order.push('stop');
    });
    vi.spyOn((pipeline as any).player, 'playStream').mockImplementation(async () => {
      order.push('play');
    });
    ttsMock.mockImplementationOnce(async () => {
      order.push('tts');
      return Buffer.from('tts');
    });

    await (pipeline as any).speakResponse('Hold steady.');

    expect(order.slice(0, 3)).toEqual(['stop', 'tts', 'play']);

    pipeline.stop();
  });

  it('preserves dismiss-close background dispatch after route confirmation', async () => {
    const pipeline = makePipeline();
    const switchTo = vi.fn(async () => ({ success: true, displayName: 'Email' }));

    pipeline.setRouter({
      switchTo,
      getActiveChannel: vi.fn(() => ({ name: 'default', channelId: 'default-id' })),
    } as any);

    const dismissSpy = vi.spyOn(pipeline as any, 'handleDismissDispatch').mockResolvedValue(undefined);
    const waitSpy = vi.spyOn(pipeline as any, 'handleWaitMode').mockResolvedValue(undefined);
    const queueSpy = vi.spyOn(pipeline as any, 'handleQueueMode').mockResolvedValue(undefined);

    (pipeline as any).transitionAndResetWatchdog({
      type: 'ENTER_ROUTE_CONFIRMATION',
      userId: 'user-1',
      transcript: 'find those emails for me',
      targetId: 'thread-1',
      targetName: 'Email (in watson)',
      deliveryMode: 'wait',
      closeType: 'dismiss',
    });

    await (pipeline as any).handleRouteConfirmationResponse('yes', 'user-1');

    expect(switchTo).toHaveBeenCalledWith('thread-1');
    expect(dismissSpy).toHaveBeenCalledWith('user-1', 'find those emails for me');
    expect(waitSpy).not.toHaveBeenCalled();
    expect(queueSpy).not.toHaveBeenCalled();

    pipeline.stop();
  });

  it('formats route confirmation prompts as explicit questions', () => {
    const pipeline = makePipeline();

    expect((pipeline as any).formatRouteConfirmationQuestion('Email (in watson)')).toBe(
      'Should I route to Email in watson?',
    );
    expect((pipeline as any).formatRouteConfirmationQuestion('Budget Review')).toBe(
      'Should I route to Budget Review?',
    );

    pipeline.stop();
  });

  it('routes direct agent addressing to the named agent but keeps Tango prompts on the default routed agent', () => {
    const pipeline = makePipeline();
    pipeline.setRouter({
      getTangoRouteFor: vi.fn(() => ({
        sessionId: 'tango-default',
        agentId: 'dispatch',
        source: 'tango-config',
        channelKey: 'discord:default',
      })),
    } as any);

    expect((pipeline as any).resolvePromptDispatchContext('default', 'Watson, add that to my list')).toEqual({
      dispatchTranscript: 'add that to my list',
      targetAgentId: 'watson',
      targetAgentDisplayName: 'Watson',
      targetSessionId: 'tango-default',
      topicId: null,
      topicTitle: null,
      projectId: null,
      projectTitle: null,
    });

    expect((pipeline as any).resolvePromptDispatchContext('default', 'Tango, add that to my list')).toEqual({
      dispatchTranscript: 'add that to my list',
      targetAgentId: 'watson',
      targetAgentDisplayName: 'Watson',
      targetSessionId: 'tango-default',
      topicId: null,
      topicTitle: null,
      projectId: null,
      projectTitle: null,
    });

    pipeline.stop();
  });

  it('treats hello-comma-agent as an intentional wake even when context agent differs', () => {
    const pipeline = makePipeline();
    pipeline.setRouter({
      getActiveTangoRoute: vi.fn(() => ({
        sessionId: 'tango-default',
        agentId: 'watson',
        source: 'tango-config',
        channelKey: 'discord:default',
      })),
    } as any);

    const explicitAddress = (pipeline as any).resolveExplicitAddress('hello, malibu');
    const resolved = (pipeline as any).downgradeWeakAddress(explicitAddress, 'hello, malibu');

    expect(resolved?.kind).toBe('agent');
    expect(resolved?.agent.id).toBe('malibu');

    pipeline.stop();
  });

  it('still downgrades weak subject mentions when context agent differs', () => {
    const pipeline = makePipeline();
    pipeline.setRouter({
      getActiveTangoRoute: vi.fn(() => ({
        sessionId: 'tango-default',
        agentId: 'watson',
        source: 'tango-config',
        channelKey: 'discord:default',
      })),
    } as any);

    const explicitAddress = (pipeline as any).resolveExplicitAddress('malibu says i should stretch');
    const resolved = (pipeline as any).downgradeWeakAddress(explicitAddress, 'malibu says i should stretch');

    expect(resolved).toBeNull();

    pipeline.stop();
  });

  it('preserves the current channel for immediate follow-up prompts on the same agent', () => {
    const pipeline = makePipeline();
    pipeline.setRouter({
      getActiveChannel: vi.fn(() => ({ name: 'malibu-thread', channelId: 'thread-1' })),
      getTangoRouteFor: vi.fn(() => ({
        sessionId: 'malibu-thread-session',
        agentId: 'malibu',
        source: 'tango-config',
        channelKey: 'discord:malibu-thread',
      })),
    } as any);

    (pipeline as any).ctx.lastSpokenIsChannelMessage = true;
    (pipeline as any).ctx.followupPromptGraceUntil = Date.now() + 10_000;
    (pipeline as any).ctx.followupPromptChannelName = 'malibu-thread';

    const explicitAddress = (pipeline as any).resolveExplicitAddress('Malibu, add that too');

    expect((pipeline as any).shouldPreserveCurrentChannelForFollowupPrompt(explicitAddress)).toBe(true);

    pipeline.stop();
  });

  it('does not preserve the current channel when the follow-up explicitly targets a different agent', () => {
    const pipeline = makePipeline();
    pipeline.setRouter({
      getActiveChannel: vi.fn(() => ({ name: 'malibu-thread', channelId: 'thread-1' })),
      getTangoRouteFor: vi.fn(() => ({
        sessionId: 'malibu-thread-session',
        agentId: 'malibu',
        source: 'tango-config',
        channelKey: 'discord:malibu-thread',
      })),
    } as any);

    (pipeline as any).ctx.lastSpokenIsChannelMessage = true;
    (pipeline as any).ctx.followupPromptGraceUntil = Date.now() + 10_000;
    (pipeline as any).ctx.followupPromptChannelName = 'malibu-thread';

    const explicitAddress = (pipeline as any).resolveExplicitAddress('Watson, add that too');

    expect((pipeline as any).shouldPreserveCurrentChannelForFollowupPrompt(explicitAddress)).toBe(false);

    pipeline.stop();
  });

  it('preserves the current channel when the last spoken speaker matches the explicit follow-up agent', () => {
    const pipeline = makePipeline();
    pipeline.setRouter({
      getActiveChannel: vi.fn(() => ({ name: 'sierra-thread', channelId: 'thread-1' })),
      getTangoRouteFor: vi.fn(() => ({
        sessionId: 'sierra-thread-session',
        agentId: 'malibu',
        source: 'tango-config',
        channelKey: 'discord:sierra-thread',
      })),
    } as any);

    (pipeline as any).ctx.lastSpokenIsChannelMessage = true;
    (pipeline as any).ctx.lastSpokenSpeakerAgentId = 'sierra';
    (pipeline as any).ctx.followupPromptGraceUntil = Date.now() + 10_000;
    (pipeline as any).ctx.followupPromptChannelName = 'sierra-thread';

    const explicitAddress = (pipeline as any).resolveExplicitAddress('Sierra, add that too');

    expect((pipeline as any).shouldPreserveCurrentChannelForFollowupPrompt(explicitAddress)).toBe(true);

    pipeline.stop();
  });

  it('keeps unprefixed follow-ups on the focused agent', async () => {
    const pipeline = makePipeline();
    pipeline.setRouter({
      getTangoRouteFor: vi.fn(() => ({
        sessionId: 'tango-default',
        agentId: 'dispatch',
        source: 'tango-config',
        channelKey: 'discord:default',
      })),
    } as any);

    await (pipeline as any).handleVoiceCommand({ type: 'focus-agent', agent: 'watson' }, 'voice-user');

    expect((pipeline as any).ctx.focusedAgentId).toBe('watson');
    expect((pipeline as any).resolvePromptDispatchContext('default', 'add that to my list')).toEqual({
      dispatchTranscript: 'add that to my list',
      targetAgentId: 'watson',
      targetAgentDisplayName: 'Watson',
      targetSessionId: 'tango-default',
      topicId: null,
      topicTitle: null,
      projectId: null,
      projectTitle: null,
    });

    await (pipeline as any).handleVoiceCommand({ type: 'clear-focus' }, 'voice-user');
    expect((pipeline as any).ctx.focusedAgentId).toBeNull();

    pipeline.stop();
  });

  it('sends direct agent-addressed turns through the Tango bridge with the overridden agent id', async () => {
    const pipeline = makePipeline();
    const queueState = {
      markReady: vi.fn(),
      markHeard: vi.fn(),
      getReadyItems: vi.fn(() => []),
      getPendingItems: vi.fn(() => []),
    };
    const responsePoller = { check: vi.fn() };
    const router = {
      refreshHistory: vi.fn(async () => {}),
      getHistory: vi.fn(() => []),
      setHistory: vi.fn(() => {}),
      getLogChannelFor: vi.fn(async () => null),
      getSessionKeyFor: vi.fn(() => `agent:dispatch:discord:channel:${TEST_DEFAULT_SESSION_CHANNEL_ID}`),
      getTangoRouteFor: vi.fn(() => ({
        sessionId: 'tango-default',
        agentId: 'dispatch',
        source: 'tango-config',
        channelKey: 'discord:default',
      })),
    };

    pipeline.setQueueState(queueState as any);
    pipeline.setResponsePoller(responsePoller as any);
    pipeline.setRouter(router as any);

    const dispatch = (pipeline as any).resolvePromptDispatchContext('default', 'Watson, add that to my list');
    (pipeline as any).dispatchToLLMFireAndForget(
      'voice-user',
      'Watson, add that to my list',
      'qid-agent-1',
      {
        channelName: 'default',
        displayName: 'Default',
        sessionKey: `agent:dispatch:discord:channel:${TEST_DEFAULT_SESSION_CHANNEL_ID}`,
        systemPrompt: 'system',
        agentId: dispatch.targetAgentId,
        agentDisplayName: dispatch.targetAgentDisplayName,
        dispatchTranscript: dispatch.dispatchTranscript,
        sessionId: dispatch.targetSessionId,
        topicId: dispatch.topicId,
        topicTitle: dispatch.topicTitle,
        projectId: dispatch.projectId,
        projectTitle: dispatch.projectTitle,
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(requestTangoVoiceTurn).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'tango-default',
      agentId: 'watson',
      transcript: 'add that to my list',
      utteranceId: 'qid-agent-1',
    }));
    expect(queueState.markReady).toHaveBeenCalledWith('qid-agent-1', 'Added.', 'Added.', 'watson');
    expect(responsePoller.check).toHaveBeenCalled();

    pipeline.stop();
  });

  it('passes thread channel ids through the Tango bridge when the session key is channel-scoped', async () => {
    const pipeline = makePipeline();
    const queueState = {
      markReady: vi.fn(),
      markHeard: vi.fn(),
      getReadyItems: vi.fn(() => []),
      getPendingItems: vi.fn(() => []),
    };
    const responsePoller = { check: vi.fn() };
    const threadChannelId = '100000000000010099';
    const router = {
      refreshHistory: vi.fn(async () => {}),
      getHistory: vi.fn(() => []),
      setHistory: vi.fn(() => {}),
      getLogChannelFor: vi.fn(async () => null),
      getTangoRouteFor: vi.fn(() => ({
        sessionId: 'tango-thread',
        agentId: 'dispatch',
        source: 'tango-config',
        channelKey: `discord:${threadChannelId}`,
      })),
    };

    pipeline.setQueueState(queueState as any);
    pipeline.setResponsePoller(responsePoller as any);
    pipeline.setRouter(router as any);

    (pipeline as any).dispatchToLLMFireAndForget(
      'voice-user',
      'follow up in the thread',
      'qid-thread-1',
      {
        channelName: 'default',
        displayName: 'Default',
        sessionKey: `channel:${threadChannelId}`,
        systemPrompt: 'system',
        sessionId: 'tango-thread',
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(requestTangoVoiceTurn).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'tango-thread',
      transcript: 'follow up in the thread',
      utteranceId: 'qid-thread-1',
      channelId: threadChannelId,
    }));
    expect(queueState.markReady).toHaveBeenCalledWith('qid-thread-1', 'Added.', 'Added.', expect.any(String));
    expect(responsePoller.check).toHaveBeenCalled();

    pipeline.stop();
  });

  it('opens topics and routes follow-up prompts into topic sessions', async () => {
    const pipeline = makePipeline();
    pipeline.setRouter({
      getActiveChannel: vi.fn(() => ({ name: 'default', displayName: 'Default' })),
      getTangoRouteFor: vi.fn(() => ({
        sessionId: 'tango-default',
        agentId: 'dispatch',
        source: 'tango-config',
        channelKey: 'discord:default',
      })),
      getSessionKeyFor: vi.fn(() => `agent:dispatch:discord:channel:${TEST_DEFAULT_SESSION_CHANNEL_ID}`),
    } as any);

    await (pipeline as any).handleVoiceCommand({ type: 'open-topic', topicName: 'auth redesign' }, 'voice-user');

    expect((pipeline as any).resolvePromptDispatchContext('default', 'keep going')).toEqual({
      dispatchTranscript: 'keep going',
      targetAgentId: 'watson',
      targetAgentDisplayName: 'Watson',
      targetSessionId: 'topic:topic-auth-redesign',
      topicId: 'topic-auth-redesign',
      topicTitle: 'auth redesign',
      projectId: null,
      projectTitle: null,
    });

    pipeline.stop();
  });

  it('routes inline topic prompts through the Tango bridge using the topic session id', async () => {
    const pipeline = makePipeline();
    const queueState = {
      markReady: vi.fn(),
      markHeard: vi.fn(),
      getReadyItems: vi.fn(() => []),
      getPendingItems: vi.fn(() => []),
    };
    const responsePoller = { check: vi.fn() };
    const router = {
      refreshHistory: vi.fn(async () => {}),
      getHistory: vi.fn(() => []),
      setHistory: vi.fn(() => {}),
      getLogChannelFor: vi.fn(async () => null),
      getTangoRouteFor: vi.fn(() => ({
        sessionId: 'tango-default',
        agentId: 'dispatch',
        source: 'tango-config',
        channelKey: 'discord:default',
      })),
      getSessionKeyFor: vi.fn(() => `agent:dispatch:discord:channel:${TEST_DEFAULT_SESSION_CHANNEL_ID}`),
    };

    pipeline.setQueueState(queueState as any);
    pipeline.setResponsePoller(responsePoller as any);
    pipeline.setRouter(router as any);

    const dispatch = (pipeline as any).resolvePromptDispatchContext(
      'default',
      'Watson, in auth redesign, draft acceptance criteria',
    );

    (pipeline as any).dispatchToLLMFireAndForget(
      'voice-user',
      'Watson, in auth redesign, draft acceptance criteria',
      'qid-topic-1',
      {
        channelName: 'default',
        displayName: 'Default',
        sessionKey: `agent:dispatch:discord:channel:${TEST_DEFAULT_SESSION_CHANNEL_ID}`,
        systemPrompt: 'system',
        agentId: dispatch.targetAgentId,
        agentDisplayName: dispatch.targetAgentDisplayName,
        dispatchTranscript: dispatch.dispatchTranscript,
        sessionId: dispatch.targetSessionId,
        topicId: dispatch.topicId,
        topicTitle: dispatch.topicTitle,
        projectId: dispatch.projectId,
        projectTitle: dispatch.projectTitle,
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(requestTangoVoiceTurn).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'topic:topic-auth-redesign',
      agentId: 'watson',
      transcript: 'draft acceptance criteria',
      utteranceId: 'qid-topic-1',
    }));

    pipeline.stop();
  });

  it('opens projects and routes follow-up prompts into project sessions', async () => {
    const focusedProjectByChannel = new Map<string, string | null>();
    const pipeline = new VoicePipeline(
      {} as any,
      undefined,
      {
        topicManager: new VoiceTopicManager(() => ({
          upsertTopic(input: any) {
            return {
              id: `topic-${input.slug}`,
              channelKey: input.channelKey,
              slug: input.slug,
              title: input.title,
              leadAgentId: input.leadAgentId ?? null,
              projectId: input.projectId ?? null,
              status: 'active',
              createdAt: 'now',
              updatedAt: 'now',
            };
          },
          getTopicById() {
            return null;
          },
          getFocusedTopicForChannel() {
            return null;
          },
          setFocusedTopicForChannel() {},
          close() {},
        }) as any),
        projectManager: new VoiceProjectManager({
          storageFactory: () => ({
            getFocusedProjectIdForChannel(channelKey: string) {
              return focusedProjectByChannel.get(channelKey) ?? null;
            },
            setFocusedProjectForChannel(channelKey: string, projectId: string | null) {
              focusedProjectByChannel.set(channelKey, projectId);
            },
            close() {},
          }),
          projectDirectory: {
            listProjects() {
              return [
                {
                  id: 'tango',
                  displayName: 'Tango MVP',
                  aliases: ['tango mvp'],
                  defaultAgentId: 'watson',
                  provider: { default: 'claude-harness', fallback: ['codex'] },
                },
              ];
            },
            getProject(projectId: string | null | undefined) {
              if (projectId !== 'tango') return null;
              return {
                id: 'tango',
                displayName: 'Tango MVP',
                aliases: ['tango mvp'],
                defaultAgentId: 'watson',
                provider: { default: 'claude-harness', fallback: ['codex'] },
              };
            },
            resolveProjectQuery(query: string) {
              return query.trim().toLowerCase() === 'tango mvp'
                ? {
                    id: 'tango',
                    displayName: 'Tango MVP',
                    aliases: ['tango mvp'],
                    defaultAgentId: 'watson',
                    provider: { default: 'claude-harness', fallback: ['codex'] },
                  }
                : null;
            },
          },
        }),
      },
    );
    vi.spyOn(pipeline as any, 'speakResponse').mockResolvedValue(undefined);
    vi.spyOn(pipeline as any, 'playReadyEarcon').mockResolvedValue(undefined);

    pipeline.setRouter({
      getActiveChannel: vi.fn(() => ({ name: 'default', displayName: 'Default' })),
      getTangoRouteFor: vi.fn(() => ({
        sessionId: 'tango-default',
        agentId: 'dispatch',
        source: 'tango-config',
        channelKey: 'discord:default',
      })),
      getSessionKeyFor: vi.fn(() => `agent:dispatch:discord:channel:${TEST_DEFAULT_SESSION_CHANNEL_ID}`),
    } as any);

    await (pipeline as any).handleVoiceCommand({ type: 'open-project', projectName: 'tango mvp' }, 'voice-user');

    expect((pipeline as any).resolvePromptDispatchContext('default', 'keep going')).toEqual({
      dispatchTranscript: 'keep going',
      targetAgentId: 'watson',
      targetAgentDisplayName: 'Watson',
      targetSessionId: 'project:tango',
      topicId: null,
      topicTitle: null,
      projectId: 'tango',
      projectTitle: 'Tango MVP',
    });

    pipeline.stop();
  });

  it('switches the voice surface to the mapped project channel when opening a project', async () => {
    const focusedProjectByChannel = new Map<string, string | null>();
    const pipeline = new VoicePipeline(
      {} as any,
      undefined,
      {
        topicManager: new VoiceTopicManager(() => ({
          getTopicById() {
            return null;
          },
          getFocusedTopicForChannel() {
            return null;
          },
          clearFocusedTopicForChannel() {
            return null;
          },
          setFocusedTopicForChannel() {},
          close() {},
        }) as any),
        projectManager: new VoiceProjectManager({
          storageFactory: () => ({
            getFocusedProjectIdForChannel(channelKey: string) {
              return focusedProjectByChannel.get(channelKey) ?? null;
            },
            setFocusedProjectForChannel(channelKey: string, projectId: string | null) {
              focusedProjectByChannel.set(channelKey, projectId);
            },
            close() {},
          }),
          projectDirectory: {
            listProjects() {
              return [
                {
                  id: 'tango',
                  displayName: 'Tango MVP',
                  aliases: ['tango mvp'],
                  defaultAgentId: 'watson',
                  provider: { default: 'claude-harness', fallback: ['codex'] },
                },
              ];
            },
            getProject(projectId: string | null | undefined) {
              if (projectId !== 'tango') return null;
              return {
                id: 'tango',
                displayName: 'Tango MVP',
                aliases: ['tango mvp'],
                defaultAgentId: 'watson',
                provider: { default: 'claude-harness', fallback: ['codex'] },
              };
            },
            resolveProjectQuery(query: string) {
              return query.trim().toLowerCase() === 'tango mvp'
                ? {
                    id: 'tango',
                    displayName: 'Tango MVP',
                    aliases: ['tango mvp'],
                    defaultAgentId: 'watson',
                    provider: { default: 'claude-harness', fallback: ['codex'] },
                  }
                : null;
            },
          },
        }),
      },
    );

    let activeChannel = { name: 'default', displayName: 'Default' };
    const router = {
      getActiveChannel: vi.fn(() => activeChannel),
      getLogChannel: vi.fn(async () => null),
      getActiveSessionKey: vi.fn(() => `agent:dispatch:discord:channel:${TEST_DEFAULT_SESSION_CHANNEL_ID}`),
      getExplicitDiscordChannelIdForSession: vi.fn((sessionId: string) => (
        sessionId === 'project:tango' ? TEST_PROJECT_SESSION_CHANNEL_ID : null
      )),
      switchToSessionChannel: vi.fn(async (sessionId: string) => {
        if (sessionId !== 'project:tango') {
          return { success: false, historyCount: 0 };
        }
        activeChannel = {
          name: `id:${TEST_PROJECT_SESSION_CHANNEL_ID}`,
          displayName: '#wellness',
        };
        return {
          success: true,
          historyCount: 0,
          displayName: '#wellness',
          channelId: TEST_PROJECT_SESSION_CHANNEL_ID,
        };
      }),
      getTangoRouteFor: vi.fn((channelName: string) => {
        if (channelName === `id:${TEST_PROJECT_SESSION_CHANNEL_ID}`) {
          return {
            sessionId: 'project:tango',
            agentId: 'watson',
            source: 'tango-config',
            channelKey: `discord:${TEST_PROJECT_SESSION_CHANNEL_ID}`,
            matchedChannelKey: `discord:${TEST_PROJECT_SESSION_CHANNEL_ID}`,
            routeAgentId: 'watson',
          };
        }
        return {
          sessionId: 'tango-default',
          agentId: 'dispatch',
          source: 'tango-config',
          channelKey: 'discord:default',
          matchedChannelKey: 'discord:default',
          routeAgentId: 'dispatch',
        };
      }),
      getSessionKeyFor: vi.fn(() => `agent:dispatch:discord:channel:${TEST_DEFAULT_SESSION_CHANNEL_ID}`),
    };

    pipeline.setRouter(router as any);
    const speakResponse = vi.spyOn(pipeline as any, 'speakResponse').mockResolvedValue(undefined);
    vi.spyOn(pipeline as any, 'playReadyEarcon').mockResolvedValue(undefined);

    await (pipeline as any).handleVoiceCommand({ type: 'open-project', projectName: 'tango mvp' }, 'voice-user');

    expect(router.switchToSessionChannel).toHaveBeenCalledWith('project:tango');
    expect(speakResponse).toHaveBeenCalledWith('Opened Tango MVP.', { inbox: true });
    expect((pipeline as any).resolvePromptDispatchContext(`id:${TEST_PROJECT_SESSION_CHANNEL_ID}`, 'keep going')).toEqual({
      dispatchTranscript: 'keep going',
      targetAgentId: 'watson',
      targetAgentDisplayName: 'Watson',
      targetSessionId: 'project:tango',
      topicId: null,
      topicTitle: null,
      projectId: 'tango',
      projectTitle: 'Tango MVP',
    });

    pipeline.stop();
  });

  it('restores the mapped project channel surface when a focused project already exists', async () => {
    const focusedProjectByChannel = new Map<string, string | null>([
      ['discord:default', 'tango'],
    ]);
    const pipeline = new VoicePipeline(
      {} as any,
      undefined,
      {
        topicManager: new VoiceTopicManager(() => ({
          getTopicById() {
            return null;
          },
          getFocusedTopicForChannel() {
            return null;
          },
          setFocusedTopicForChannel() {},
          close() {},
        }) as any),
        projectManager: new VoiceProjectManager({
          storageFactory: () => ({
            getFocusedProjectIdForChannel(channelKey: string) {
              return focusedProjectByChannel.get(channelKey) ?? null;
            },
            setFocusedProjectForChannel(channelKey: string, projectId: string | null) {
              focusedProjectByChannel.set(channelKey, projectId);
            },
            close() {},
          }),
          projectDirectory: {
            listProjects() {
              return [
                {
                  id: 'tango',
                  displayName: 'Tango MVP',
                  aliases: ['tango mvp'],
                  defaultAgentId: 'watson',
                  provider: { default: 'claude-harness', fallback: ['codex'] },
                },
              ];
            },
            getProject(projectId: string | null | undefined) {
              if (projectId !== 'tango') return null;
              return {
                id: 'tango',
                displayName: 'Tango MVP',
                aliases: ['tango mvp'],
                defaultAgentId: 'watson',
                provider: { default: 'claude-harness', fallback: ['codex'] },
              };
            },
            resolveProjectQuery(query: string) {
              return query.trim().toLowerCase() === 'tango mvp'
                ? {
                    id: 'tango',
                    displayName: 'Tango MVP',
                    aliases: ['tango mvp'],
                    defaultAgentId: 'watson',
                    provider: { default: 'claude-harness', fallback: ['codex'] },
                  }
                : null;
            },
          },
        }),
      },
    );

    let activeChannel = { name: 'default', displayName: 'Default', channelId: TEST_DEFAULT_SESSION_CHANNEL_ID };
    const router = {
      getActiveChannel: vi.fn(() => activeChannel),
      getTangoRouteFor: vi.fn((channelName: string) => {
        if (channelName === `id:${TEST_PROJECT_SESSION_CHANNEL_ID}`) {
          return {
            sessionId: 'project:tango',
            agentId: 'watson',
            source: 'tango-config',
            channelKey: `discord:${TEST_PROJECT_SESSION_CHANNEL_ID}`,
            matchedChannelKey: `discord:${TEST_PROJECT_SESSION_CHANNEL_ID}`,
            routeAgentId: 'watson',
          };
        }
        return {
          sessionId: 'tango-default',
          agentId: 'dispatch',
          source: 'tango-config',
          channelKey: 'discord:default',
          matchedChannelKey: 'discord:default',
          routeAgentId: 'dispatch',
        };
      }),
      getExplicitDiscordChannelIdForSession: vi.fn((sessionId: string) => (
        sessionId === 'project:tango' ? TEST_PROJECT_SESSION_CHANNEL_ID : null
      )),
      switchToSessionChannel: vi.fn(async (sessionId: string) => {
        if (sessionId !== 'project:tango') {
          return { success: false, historyCount: 0 };
        }
        activeChannel = {
          name: `id:${TEST_PROJECT_SESSION_CHANNEL_ID}`,
          displayName: '#wellness',
          channelId: TEST_PROJECT_SESSION_CHANNEL_ID,
        };
        return {
          success: true,
          historyCount: 0,
          displayName: '#wellness',
          channelId: TEST_PROJECT_SESSION_CHANNEL_ID,
        };
      }),
      getLogChannel: vi.fn(async () => null),
      getActiveSessionKey: vi.fn(() => `agent:dispatch:discord:channel:${TEST_PROJECT_SESSION_CHANNEL_ID}`),
    };

    pipeline.setRouter(router as any);

    await pipeline.restoreProjectChannelSurface();

    expect(router.switchToSessionChannel).toHaveBeenCalledWith('project:tango');
    expect((pipeline as any).resolvePromptDispatchContext(`id:${TEST_PROJECT_SESSION_CHANNEL_ID}`, 'keep going')).toEqual({
      dispatchTranscript: 'keep going',
      targetAgentId: 'watson',
      targetAgentDisplayName: 'Watson',
      targetSessionId: 'project:tango',
      topicId: null,
      topicTitle: null,
      projectId: 'tango',
      projectTitle: 'Tango MVP',
    });

    pipeline.stop();
  });
});
