import { afterEach, describe, expect, it, vi } from 'vitest';
import { InboxClient } from '../src/services/inbox-client.js';

describe('InboxClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('marks a channel read by stable channel ID', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          totalUnread: 1,
          pendingCount: 0,
          channels: [
            {
              channelId: 'thread-1',
              channelName: 'thread-name',
              displayName: 'Watson',
              unreadCount: 1,
              messages: [
                {
                  messageId: 'm-1',
                  channelId: 'thread-1',
                  channelName: 'thread-name',
                  agentDisplayName: 'Watson',
                  agentId: 'watson',
                  content: 'reply',
                  timestamp: 1,
                  isChunked: false,
                  chunkGroupId: null,
                },
              ],
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, advanced: true }),
      });

    vi.stubGlobal('fetch', fetchMock);

    const client = new InboxClient({ baseUrl: 'http://localhost:8787' });
    await client.markChannelReadById('thread-1', 'voice-wait');

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost:8787/voice/inbox?channels=thread-1',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://localhost:8787/voice/inbox/watermark',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ channelId: 'thread-1', messageId: 'm-1', source: 'voice-wait' }),
      }),
    );
  });
});
