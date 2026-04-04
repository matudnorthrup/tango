import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Collection, ChannelType } from 'discord.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let config: typeof import('../src/config.js').config;
let ChannelRouter: typeof import('../src/services/channel-router.js').ChannelRouter;

const originalTangoHome = process.env['TANGO_HOME'];
const originalTangoProfile = process.env['TANGO_PROFILE'];
const originalTangoDbPath = process.env['TANGO_DB_PATH'];
const isolatedTangoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tango-voice-route-test-'));

function makeRouter(channelDefs: Array<{ id: string; name: string }> = []): InstanceType<typeof ChannelRouter> {
  const cache = new Collection<string, any>();
  for (const channelDef of channelDefs) {
    cache.set(channelDef.id, {
      id: channelDef.id,
      name: channelDef.name,
      type: ChannelType.GuildText,
      messages: {
        fetch: async () => new Collection<string, any>(),
      },
    });
  }

  const guild = {
    channels: {
      cache,
      fetch: async (channelId?: string) => {
        if (typeof channelId === 'string') {
          return cache.get(channelId) ?? null;
        }
        return new Collection<string, any>(cache);
      },
      fetchActiveThreads: async () => ({ threads: new Collection<string, any>() }),
    },
    client: {
      channels: {
        fetch: async () => null,
      },
    },
  } as any;

  return new ChannelRouter(guild);
}

describe('ChannelRouter Tango route alignment', () => {
  beforeAll(async () => {
    process.env['TANGO_HOME'] = isolatedTangoHome;
    process.env['TANGO_PROFILE'] = 'test';
    process.env['TANGO_DB_PATH'] = path.join(
      isolatedTangoHome,
      'profiles',
      'test',
      'data',
      'tango.sqlite',
    );
    vi.resetModules();
    ({ config } = await import('../src/config.js'));
    ({ ChannelRouter } = await import('../src/services/channel-router.js'));
  });

  afterAll(() => {
    if (originalTangoHome === undefined) {
      delete process.env['TANGO_HOME'];
    } else {
      process.env['TANGO_HOME'] = originalTangoHome;
    }
    if (originalTangoProfile === undefined) {
      delete process.env['TANGO_PROFILE'];
    } else {
      process.env['TANGO_PROFILE'] = originalTangoProfile;
    }
    if (originalTangoDbPath === undefined) {
      delete process.env['TANGO_DB_PATH'];
    } else {
      process.env['TANGO_DB_PATH'] = originalTangoDbPath;
    }
    vi.resetModules();
    fs.rmSync(isolatedTangoHome, { recursive: true, force: true });
  });

  it('hydrates the default voice channel from Tango session config', () => {
    const router = makeRouter();
    const defaultChannelId = router.getActiveChannel().channelId;

    expect(defaultChannelId).toMatch(/^\d+$/);
    expect(router.getActiveSessionKey()).toBe(
      `agent:${config.tangoVoiceAgentId}:discord:channel:${defaultChannelId}`,
    );
  });

  it('routes the default voice surface through Tango default session config', () => {
    const router = makeRouter();
    const defaultChannelId = router.getActiveChannel().channelId;

    expect(router.getActiveTangoRoute()).toEqual({
      sessionId: 'tango-default',
      agentId: config.tangoVoiceAgentId,
      source: 'tango-config',
      channelKey: `discord:${defaultChannelId}`,
      matchedChannelKey: `discord:${defaultChannelId}`,
      routeAgentId: 'dispatch',
    });
  });

  it('finds the explicit Discord channel mapped to a project session', () => {
    const router = makeRouter();

    expect(router.getExplicitDiscordChannelIdForSession('project:wellness')).toMatch(/^\d+$/);
  });

  it('switches to the Discord channel mapped to a Tango project session', async () => {
    const channelId = makeRouter().getExplicitDiscordChannelIdForSession('project:wellness');
    expect(channelId).toMatch(/^\d+$/);

    const router = makeRouter([
      { id: channelId!, name: 'wellness' },
    ]);

    const result = await router.switchToSessionChannel('project:wellness');

    expect(result).toMatchObject({
      success: true,
      displayName: '#wellness',
      channelId,
    });
    expect(router.getActiveChannel()).toMatchObject({
      name: `id:${channelId}`,
      displayName: '#wellness',
      channelId,
    });
    expect(router.getActiveTangoRoute()).toEqual({
      sessionId: 'project:wellness',
      agentId: 'malibu',
      source: 'tango-config',
      channelKey: `discord:${channelId}`,
      matchedChannelKey: `discord:${channelId}`,
      routeAgentId: 'malibu',
    });
  });

  it('routes an ad-hoc mapped Discord text channel through Tango session config', async () => {
    const channelId = makeRouter().getExplicitDiscordChannelIdForSession('project:wellness');
    expect(channelId).toMatch(/^\d+$/);

    const router = makeRouter([
      { id: channelId!, name: 'wellness' },
    ]);

    const result = await router.switchTo(channelId!);

    expect(result).toMatchObject({
      success: true,
      displayName: '#wellness',
    });
    expect(router.getTangoRouteFor(`id:${channelId}`)).toEqual({
      sessionId: 'project:wellness',
      agentId: 'malibu',
      source: 'tango-config',
      channelKey: `discord:${channelId}`,
      matchedChannelKey: `discord:${channelId}`,
      routeAgentId: 'malibu',
    });
  });

  it('enumerates Tango session keys for the configured channels', () => {
    const router = makeRouter();

    expect(router.getAllChannelSessionKeys().some((entry) => entry.name === 'default')).toBe(true);
  });
});
