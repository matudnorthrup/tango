import { describe, expect, it } from 'vitest';
import { VoiceTopicManager, type VoiceTopicStorage } from '../src/services/voice-topics.js';

function createStorage(): VoiceTopicStorage {
  const topicsById = new Map<string, any>();
  const topicsByKey = new Map<string, any>();
  const focusedTopicByChannel = new Map<string, string | null>();

  return {
    upsertTopic(input) {
      const key = `${input.channelKey}:${input.slug}`;
      const existing = topicsByKey.get(key);
      if (existing) {
        const nextProjectId =
          input.preserveProjectId === false
            ? (input.projectId ?? null)
            : (input.projectId ?? existing.projectId ?? null);
        const updated = {
          ...existing,
          title: input.title,
          leadAgentId: input.leadAgentId ?? existing.leadAgentId ?? null,
          projectId: nextProjectId,
          updatedAt: 'now',
        };
        topicsByKey.set(key, updated);
        topicsById.set(updated.id, updated);
        return updated;
      }

      const created = {
        id: `topic-${input.slug}`,
        channelKey: input.channelKey,
        slug: input.slug,
        title: input.title,
        leadAgentId: input.leadAgentId ?? null,
        projectId: input.projectId ?? null,
        status: input.status ?? 'active',
        createdAt: 'now',
        updatedAt: 'now',
      };
      topicsByKey.set(key, created);
      topicsById.set(created.id, created);
      return created;
    },
    getTopicById(topicId) {
      return topicsById.get(topicId) ?? null;
    },
    getTopicByChannelAndSlug(channelKey, slug) {
      return topicsByKey.get(`${channelKey}:${slug}`) ?? null;
    },
    getFocusedTopicForChannel(channelKey) {
      const topicId = focusedTopicByChannel.get(channelKey)?.trim();
      if (!topicId) return null;
      return topicsById.get(topicId) ?? null;
    },
    setFocusedTopicForChannel(channelKey, topicId) {
      focusedTopicByChannel.set(channelKey, topicId?.trim() || null);
    },
  };
}

describe('VoiceTopicManager', () => {
  it('persists focused topics through shared storage instead of process memory', () => {
    const storage = createStorage();
    const managerA = new VoiceTopicManager(() => storage);
    const topic = managerA.upsertTopic({
      channelKey: 'discord:general',
      topicName: 'auth redesign',
      leadAgent: {
        id: 'watson',
        type: 'assistant',
        displayName: 'Watson',
        callSigns: ['watson'],
        defaultProject: 'work',
      },
    });

    managerA.setFocusedTopicId('discord:general', topic.id);
    managerA.destroy();

    const managerB = new VoiceTopicManager(() => storage);
    expect(managerB.getFocusedTopic('discord:general')).toMatchObject({
      id: topic.id,
      title: 'auth redesign',
      leadAgentId: 'watson',
    });

    managerB.destroy();
  });

  it('clears persisted focused topics', () => {
    const storage = createStorage();
    const manager = new VoiceTopicManager(() => storage);
    const topic = manager.upsertTopic({
      channelKey: 'discord:general',
      topicName: 'auth redesign',
    });

    manager.setFocusedTopicId('discord:general', topic.id);

    expect(manager.clearFocusedTopic('discord:general')?.id).toBe(topic.id);
    expect(manager.getFocusedTopic('discord:general')).toBeNull();

    manager.destroy();
  });

  it('does not attach a topic to the lead agent default project unless one is explicitly provided', () => {
    const storage = createStorage();
    const manager = new VoiceTopicManager(() => storage);
    const topic = manager.upsertTopic({
      channelKey: 'discord:general',
      topicName: 'auth redesign',
      leadAgent: {
        id: 'watson',
        type: 'assistant',
        displayName: 'Watson',
        callSigns: ['watson'],
        defaultProject: 'tango',
      },
    });

    expect(topic.projectId).toBeNull();

    manager.destroy();
  });

  it('can explicitly detach an existing topic from its project', () => {
    const storage = createStorage();
    const manager = new VoiceTopicManager(() => storage);

    const created = manager.upsertTopic({
      channelKey: 'discord:general',
      topicName: 'auth redesign',
      projectId: 'tango',
    });

    const detached = manager.upsertTopic({
      channelKey: 'discord:general',
      topicName: 'auth redesign',
      projectId: null,
      preserveProjectId: false,
    });

    expect(detached.id).toBe(created.id);
    expect(detached.projectId).toBeNull();

    manager.destroy();
  });
});
