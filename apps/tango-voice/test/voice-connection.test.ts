import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function createMockConnection() {
  const connection = new EventEmitter() as EventEmitter & {
    state: Record<string, never>;
    destroy: ReturnType<typeof vi.fn>;
  };
  connection.state = {};
  connection.destroy = vi.fn();
  return connection;
}

describe('voice connection join', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('@discordjs/voice');
    vi.restoreAllMocks();
  });

  it('joins with audio receive enabled and waits for readiness', async () => {
    const connection = createMockConnection();
    const joinVoiceChannel = vi.fn(() => connection);
    const entersState = vi.fn(async () => undefined);

    vi.doMock('@discordjs/voice', () => ({
      joinVoiceChannel,
      entersState,
      VoiceConnection: class {},
      VoiceConnectionStatus: {
        Ready: 'ready',
      },
    }));

    const { joinChannel } = await import('../src/discord/voice-connection.js');

    await expect(joinChannel('voice-channel', 'guild-id', { adapter: true })).resolves.toBe(connection);
    expect(joinVoiceChannel).toHaveBeenCalledWith({
      channelId: 'voice-channel',
      guildId: 'guild-id',
      adapterCreator: { adapter: true },
      selfDeaf: false,
      selfMute: false,
    });
    expect(entersState).toHaveBeenCalledWith(connection, 'ready', 30_000);
  });
});
