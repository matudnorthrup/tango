import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceInboxChannel } from '@tango/voice';

const quickCompletionMock = vi.fn();

vi.mock('../src/services/claude.js', () => ({
  quickCompletion: (...args: unknown[]) => quickCompletionMock(...args),
}));

import { generateAgentSummary, getInboxChannelVoiceLabel } from '../src/services/inbox-summary.js';

function makeChannel(overrides: Partial<VoiceInboxChannel>): VoiceInboxChannel {
  return {
    channelId: 'channel-1',
    channelName: 'general',
    displayName: 'General',
    unreadCount: 1,
    messages: [
      {
        messageId: 'message-1',
        channelId: 'channel-1',
        channelName: 'general',
        agentDisplayName: 'Watson',
        agentId: 'watson',
        content: 'Message content',
        timestamp: Date.now(),
        isChunked: false,
        chunkGroupId: null,
      },
    ],
    ...overrides,
  };
}

describe('inbox summary helpers', () => {
  beforeEach(() => {
    quickCompletionMock.mockReset();
  });

  it('prefers the channel name when displayName collapses to the agent name', () => {
    const label = getInboxChannelVoiceLabel(
      makeChannel({
        channelName: 'openGrid and Underware',
        displayName: 'Sierra',
      }),
      'Sierra',
    );

    expect(label).toBe('openGrid and Underware');
  });

  it('uses a deterministic channel summary for small multi-channel inbox groups', async () => {
    const summary = await generateAgentSummary('Sierra', [
      makeChannel({
        channelId: 'channel-1',
        channelName: 'openGrid and Underware',
        displayName: 'Sierra',
      }),
      makeChannel({
        channelId: 'channel-2',
        channelName: 'HVAC',
        displayName: 'Sierra',
      }),
    ]);

    expect(summary).toBe('I have messages in openGrid and Underware and HVAC.');
    expect(quickCompletionMock).not.toHaveBeenCalled();
  });
});
