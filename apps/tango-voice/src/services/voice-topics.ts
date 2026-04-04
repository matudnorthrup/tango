import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  TangoStorage,
  type TopicRecord,
  type TopicStatus,
} from '@tango/core';
import {
  buildTopicSessionId,
  normalizeTopicSlug,
  type VoiceAddressAgent,
} from '@tango/voice';
import { resolveSharedTangoDbPath } from './shared-storage.js';

export interface VoiceTopicStorage {
  upsertTopic(input: {
    channelKey: string;
    slug: string;
    title: string;
    leadAgentId?: string | null;
    projectId?: string | null;
    preserveProjectId?: boolean;
    status?: TopicStatus;
  }): TopicRecord;
  getTopicById(topicId: string): TopicRecord | null;
  getTopicByChannelAndSlug(channelKey: string, slug: string): TopicRecord | null;
  getFocusedTopicForChannel?(channelKey: string): TopicRecord | null;
  setFocusedTopicForChannel?(channelKey: string, topicId: string | null): void;
  close?(): void;
}

export interface VoiceTopicRoute {
  sessionId: string;
  agentId: string;
  topic: TopicRecord | null;
}

function isVitestRuntime(): boolean {
  return Boolean(
    process.env.VITEST ||
      process.env.VITEST_POOL_ID ||
      process.argv.some((arg) => arg.toLowerCase().includes('vitest')),
  );
}

function createDefaultStorage(): VoiceTopicStorage {
  if (isVitestRuntime()) {
    const testDbPath = path.join(
      os.tmpdir(),
      `tango-voice-topic-${process.pid}-${randomUUID()}.sqlite`,
    );
    return new TangoStorage(resolveSharedTangoDbPath(testDbPath));
  }

  return new TangoStorage(resolveSharedTangoDbPath());
}

export class VoiceTopicManager {
  private readonly fallbackFocusedTopicIdsByChannelKey = new Map<string, string>();
  private storage: VoiceTopicStorage | null = null;

  constructor(
    private readonly storageFactory: () => VoiceTopicStorage = createDefaultStorage,
  ) {}

  private getStorage(): VoiceTopicStorage {
    if (!this.storage) {
      this.storage = this.storageFactory();
    }
    return this.storage;
  }

  destroy(): void {
    this.storage?.close?.();
    this.storage = null;
  }

  reset(): void {
    this.fallbackFocusedTopicIdsByChannelKey.clear();
  }

  getFocusedTopic(channelKey: string): TopicRecord | null {
    const storage = this.getStorage();
    if (storage.getFocusedTopicForChannel) {
      return storage.getFocusedTopicForChannel(channelKey);
    }

    const topicId = this.fallbackFocusedTopicIdsByChannelKey.get(channelKey)?.trim();
    if (!topicId) return null;

    const topic = storage.getTopicById(topicId);
    if (!topic) {
      this.fallbackFocusedTopicIdsByChannelKey.delete(channelKey);
      return null;
    }

    return topic;
  }

  setFocusedTopicId(channelKey: string, topicId: string | null): void {
    const storage = this.getStorage();
    const normalized = topicId?.trim() || null;
    if (storage.setFocusedTopicForChannel) {
      storage.setFocusedTopicForChannel(channelKey, normalized);
      return;
    }

    if (!normalized) {
      this.fallbackFocusedTopicIdsByChannelKey.delete(channelKey);
      return;
    }

    this.fallbackFocusedTopicIdsByChannelKey.set(channelKey, normalized);
  }

  clearFocusedTopic(channelKey: string): TopicRecord | null {
    const topic = this.getFocusedTopic(channelKey);
    const storage = this.getStorage();
    if (storage.setFocusedTopicForChannel) {
      storage.setFocusedTopicForChannel(channelKey, null);
    } else {
      this.fallbackFocusedTopicIdsByChannelKey.delete(channelKey);
    }
    return topic;
  }

  upsertTopic(input: {
    channelKey: string;
    topicName: string;
    leadAgent?: VoiceAddressAgent | null;
    projectId?: string | null;
    preserveProjectId?: boolean;
  }): TopicRecord {
    const title = input.topicName.trim().replace(/\s+/g, ' ');
    const slug = normalizeTopicSlug(title);
    if (!slug) {
      throw new Error('Topic name must include letters or numbers.');
    }

    return this.getStorage().upsertTopic({
      channelKey: input.channelKey,
      slug,
      title,
      leadAgentId: input.leadAgent?.id ?? null,
      projectId: input.projectId ?? null,
      preserveProjectId: input.preserveProjectId,
    });
  }

  getTopicByName(channelKey: string, topicName: string): TopicRecord | null {
    const slug = normalizeTopicSlug(topicName);
    if (!slug) return null;
    return this.getStorage().getTopicByChannelAndSlug(channelKey, slug);
  }

  resolveActiveRoute(input: {
    baseSessionId: string;
    baseAgentId: string;
    channelKey: string;
  }): VoiceTopicRoute {
    const topic = this.getFocusedTopic(input.channelKey);
    if (!topic) {
      return {
        sessionId: input.baseSessionId,
        agentId: input.baseAgentId,
        topic: null,
      };
    }

    return {
      sessionId: buildTopicSessionId(topic.id),
      agentId: topic.leadAgentId ?? input.baseAgentId,
      topic,
    };
  }

  resolvePromptRoute(input: {
    baseSessionId: string;
    baseAgentId: string;
    channelKey: string;
    targetAgent?: VoiceAddressAgent | null;
    topicName?: string | null;
    projectId?: string | null;
    preserveProjectId?: boolean;
  }): VoiceTopicRoute {
    const topicName = input.topicName?.trim();
    if (!topicName) {
      return this.resolveActiveRoute({
        baseSessionId: input.baseSessionId,
        baseAgentId: input.baseAgentId,
        channelKey: input.channelKey,
      });
    }

    const topic = this.upsertTopic({
      channelKey: input.channelKey,
      topicName,
      leadAgent: input.targetAgent ?? null,
      projectId: input.projectId ?? null,
      preserveProjectId: input.preserveProjectId,
    });
    this.setFocusedTopicId(input.channelKey, topic.id);

    return {
      sessionId: buildTopicSessionId(topic.id),
      agentId: topic.leadAgentId ?? input.baseAgentId,
      topic,
    };
  }
}
