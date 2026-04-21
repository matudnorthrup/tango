import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  annotateTargetsWithRecency,
  buildRouteTargetInventory,
  inferRouteTarget,
  isHighConfidence,
  isMediumConfidence,
  invalidateRouteTargetCache,
  type RouteTarget,
  type RouteClassifierResult,
} from '../src/services/route-classifier.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock quickCompletion so we never hit a real LLM
vi.mock('../src/services/claude.js', () => ({
  quickCompletion: vi.fn(),
}));

import { quickCompletion } from '../src/services/claude.js';

const mockQuickCompletion = vi.mocked(quickCompletion);

function makeRouter(options?: {
  forumThreads?: { name: string; displayName: string; threadId: string }[];
  forumChannels?: { name: string; id: string }[];
  channels?: { name: string; displayName: string; active: boolean }[];
  activeChannel?: { name: string };
}) {
  return {
    getForumThreads: vi.fn().mockResolvedValue(options?.forumThreads ?? []),
    listForumChannels: vi.fn().mockReturnValue(options?.forumChannels ?? []),
    listChannels: vi.fn().mockReturnValue(options?.channels ?? []),
    getActiveChannel: vi.fn().mockReturnValue({ name: options?.activeChannel?.name ?? 'default' }),
    switchTo: vi.fn().mockResolvedValue({ success: true }),
  } as any;
}

function makeTopicManager(focusedTopic?: { title: string } | null) {
  return {
    getFocusedTopic: vi.fn().mockReturnValue(focusedTopic ?? null),
  } as any;
}

function makeProjectManager() {
  return {} as any;
}

function makeAgents(agents?: Array<{ id: string; defaultChannelId?: string }>) {
  return (agents ?? [
    { id: 'watson', defaultChannelId: 'ch-watson' },
    { id: 'malibu', defaultChannelId: 'ch-malibu' },
    { id: 'sierra', defaultChannelId: 'ch-sierra' },
  ]) as any[];
}

function makeRecencyDb(rows: Array<{ discordChannelId: string; lastActive: string | null }>) {
  const all = vi.fn(() => rows);
  return {
    db: {
      prepare: vi.fn(() => ({ all })),
    } as any,
    all,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('isHighConfidence', () => {
  it('returns true for route action above 0.85', () => {
    expect(isHighConfidence({ action: 'route', confidence: 0.91, target: 'x' })).toBe(true);
  });

  it('returns false at exactly 0.85', () => {
    expect(isHighConfidence({ action: 'route', confidence: 0.85, target: 'x' })).toBe(false);
  });

  it('returns false for none action even with high confidence', () => {
    expect(isHighConfidence({ action: 'none', confidence: 0.95 })).toBe(false);
  });
});

describe('isMediumConfidence', () => {
  it('returns true for route action between 0.60 and 0.85', () => {
    expect(isMediumConfidence({ action: 'route', confidence: 0.72, target: 'x' })).toBe(true);
  });

  it('returns true at exactly 0.60', () => {
    expect(isMediumConfidence({ action: 'route', confidence: 0.60, target: 'x' })).toBe(true);
  });

  it('returns true at exactly 0.85', () => {
    expect(isMediumConfidence({ action: 'route', confidence: 0.85, target: 'x' })).toBe(true);
  });

  it('returns false above 0.85', () => {
    expect(isMediumConfidence({ action: 'route', confidence: 0.86, target: 'x' })).toBe(false);
  });

  it('returns false below 0.60', () => {
    expect(isMediumConfidence({ action: 'route', confidence: 0.59, target: 'x' })).toBe(false);
  });

  it('returns false for none action', () => {
    expect(isMediumConfidence({ action: 'none', confidence: 0.72 })).toBe(false);
  });
});

describe('buildRouteTargetInventory', () => {
  beforeEach(() => {
    invalidateRouteTargetCache();
  });

  it('includes forum threads', async () => {
    const router = makeRouter({
      forumThreads: [
        { name: 'id:thread-1', displayName: 'Messaging Principles (in latitude)', threadId: 'thread-1' },
      ],
    });
    const targets = await buildRouteTargetInventory(
      router, makeTopicManager(), makeProjectManager(), makeAgents(),
    );
    expect(targets).toContainEqual(expect.objectContaining({
      id: 'thread-1',
      type: 'thread',
      name: 'Messaging Principles (in latitude)',
    }));
  });

  it('excludes agent default channels from thread results', async () => {
    const router = makeRouter({
      forumThreads: [
        { name: 'id:ch-watson', displayName: 'Watson Home', threadId: 'ch-watson' },
        { name: 'id:thread-2', displayName: 'Real Thread', threadId: 'thread-2' },
      ],
    });
    const targets = await buildRouteTargetInventory(
      router, makeTopicManager(), makeProjectManager(), makeAgents(),
    );
    // ch-watson should not appear as a thread (it's excluded from routing targets)
    // It may appear as a channel creation container — that's fine
    expect(targets.find((t) => t.id === 'ch-watson' && t.type === 'thread')).toBeUndefined();
    expect(targets.find((t) => t.id === 'thread-2')).toBeDefined();
  });

  it('excludes agent-named channels from static list', async () => {
    const router = makeRouter({
      channels: [
        { name: 'default', displayName: 'Default', active: true },
        { name: 'watson', displayName: 'Watson', active: false },
        { name: 'malibu', displayName: 'Malibu', active: false },
        { name: 'sierra', displayName: 'Sierra', active: false },
        { name: 'custom', displayName: 'Custom Channel', active: false },
      ],
    });
    const targets = await buildRouteTargetInventory(
      router, makeTopicManager(), makeProjectManager(), makeAgents(),
    );
    const names = targets.map((t) => t.name);
    expect(names).not.toContain('Default');
    expect(names).not.toContain('Watson');
    expect(names).not.toContain('Malibu');
    expect(names).not.toContain('Sierra');
    expect(names).toContain('Custom Channel');
  });

  it('returns empty array when no targets are available', async () => {
    const router = makeRouter();
    const targets = await buildRouteTargetInventory(
      router, makeTopicManager(), makeProjectManager(), makeAgents([]),
    );
    expect(targets).toEqual([]);
  });

  it('caches results for 1 minute', async () => {
    const router = makeRouter({
      forumThreads: [
        { name: 'id:t1', displayName: 'Thread 1', threadId: 't1' },
      ],
    });

    const first = await buildRouteTargetInventory(
      router, makeTopicManager(), makeProjectManager(), makeAgents([]),
    );
    expect(first.length).toBe(1);

    // Second call should use cache (getForumThreads not called again)
    const second = await buildRouteTargetInventory(
      router, makeTopicManager(), makeProjectManager(), makeAgents(),
    );
    expect(second).toBe(first); // same reference = cached
    expect(router.getForumThreads).toHaveBeenCalledTimes(1);
  });

  it('invalidateRouteTargetCache forces refresh', async () => {
    const router = makeRouter({
      forumThreads: [
        { name: 'id:t1', displayName: 'Thread 1', threadId: 't1' },
      ],
    });

    await buildRouteTargetInventory(
      router, makeTopicManager(), makeProjectManager(), makeAgents(),
    );
    invalidateRouteTargetCache();
    await buildRouteTargetInventory(
      router, makeTopicManager(), makeProjectManager(), makeAgents(),
    );
    expect(router.getForumThreads).toHaveBeenCalledTimes(2);
  });

  it('handles forum thread fetch failure gracefully', async () => {
    const router = makeRouter();
    router.getForumThreads.mockRejectedValue(new Error('Discord API error'));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const targets = await buildRouteTargetInventory(
      router, makeTopicManager(), makeProjectManager(), makeAgents(),
    );
    // Forum threads fail, but agent channel + forum creation targets still appear
    const threadTargets = targets.filter((t: RouteTarget) => t.type === 'thread');
    expect(threadTargets).toEqual([]);
    warnSpy.mockRestore();
  });
});

describe('annotateTargetsWithRecency', () => {
  it('labels routable targets by recent inbound activity', async () => {
    const { db, all } = makeRecencyDb([
      { discordChannelId: 'thread-today', lastActive: '2026-04-20 15:00:00' },
      { discordChannelId: 'thread-recent', lastActive: '2026-04-18 18:00:00' },
      { discordChannelId: 'thread-stale', lastActive: '2026-04-15 18:00:00' },
      { discordChannelId: 'thread-very-stale', lastActive: '2026-04-10 18:00:00' },
    ]);

    const annotated = await annotateTargetsWithRecency([
      { id: 'thread-today', type: 'thread', name: 'Today Thread' },
      { id: 'thread-recent', type: 'thread', name: 'Recent Thread' },
      { id: 'thread-stale', type: 'thread', name: 'Stale Thread' },
      { id: 'thread-very-stale', type: 'thread', name: 'Very Stale Thread' },
      { id: 'thread-never', type: 'thread', name: 'Never Active' },
      { id: 'forum-1', type: 'forum', name: 'General Forum' },
    ], db, new Date('2026-04-20T18:00:00Z'));

    expect(all).toHaveBeenCalledWith(
      'thread-today',
      'thread-recent',
      'thread-stale',
      'thread-very-stale',
      'thread-never',
    );
    expect(annotated.find((target) => target.id === 'thread-today')?.recencyLabel).toBe('active-today');
    expect(annotated.find((target) => target.id === 'thread-recent')?.recencyLabel).toBe('recent');
    expect(annotated.find((target) => target.id === 'thread-stale')?.recencyLabel).toBe('stale');
    expect(annotated.find((target) => target.id === 'thread-very-stale')?.recencyLabel).toBe('very-stale');
    expect(annotated.find((target) => target.id === 'thread-never')?.recencyLabel).toBe('very-stale');
    expect(annotated.find((target) => target.id === 'forum-1')?.recencyLabel).toBeUndefined();
  });
});

describe('inferRouteTarget', () => {
  beforeEach(() => {
    invalidateRouteTargetCache();
    mockQuickCompletion.mockReset();
  });

  it('returns none for short prompts (< 3 words)', async () => {
    const result = await inferRouteTarget(
      'log eggs',
      makeRouter({ forumThreads: [{ name: 'id:t1', displayName: 'T1', threadId: 't1' }] }),
      makeTopicManager(),
      makeProjectManager(),
      makeAgents(),
    );
    expect(result.action).toBe('none');
    expect(mockQuickCompletion).not.toHaveBeenCalled();
  });

  it('returns none when no targets available', async () => {
    const result = await inferRouteTarget(
      'let us continue working on messaging principles',
      makeRouter(),
      makeTopicManager(),
      makeProjectManager(),
      makeAgents([]),
    );
    expect(result.action).toBe('none');
    expect(mockQuickCompletion).not.toHaveBeenCalled();
  });

  it('returns route with high confidence when LLM matches a target', async () => {
    mockQuickCompletion.mockResolvedValue(
      '{"action":"route","target":"thread-1","confidence":0.92}',
    );

    const router = makeRouter({
      forumThreads: [
        { name: 'id:thread-1', displayName: 'Messaging Principles (in latitude)', threadId: 'thread-1' },
      ],
    });

    const result = await inferRouteTarget(
      'let us continue the messaging principles discussion',
      router,
      makeTopicManager(),
      makeProjectManager(),
      makeAgents(),
    );
    expect(result.action).toBe('route');
    expect(result.target).toBe('thread-1');
    expect(result.targetName).toBe('Messaging Principles (in latitude)');
    expect(result.confidence).toBe(0.92);
  });

  it('returns none when LLM returns none action', async () => {
    mockQuickCompletion.mockResolvedValue(
      '{"action":"none","confidence":0.3}',
    );

    const router = makeRouter({
      forumThreads: [
        { name: 'id:t1', displayName: 'Some Thread', threadId: 't1' },
      ],
    });

    const result = await inferRouteTarget(
      'what is the weather today',
      router,
      makeTopicManager(),
      makeProjectManager(),
      makeAgents(),
    );
    expect(result.action).toBe('none');
    expect(result.confidence).toBe(0.3);
  });

  it('rejects unknown target IDs from LLM', async () => {
    mockQuickCompletion.mockResolvedValue(
      '{"action":"route","target":"nonexistent-thread","confidence":0.95}',
    );

    const router = makeRouter({
      forumThreads: [
        { name: 'id:t1', displayName: 'Thread 1', threadId: 't1' },
      ],
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await inferRouteTarget(
      'let us work on the nonexistent thing',
      router,
      makeTopicManager(),
      makeProjectManager(),
      makeAgents(),
    );
    expect(result.action).toBe('none');
    warnSpy.mockRestore();
  });

  it('treats create action as none (Phase 4 deferred)', async () => {
    mockQuickCompletion.mockResolvedValue(
      '{"action":"create","target":"new-thread","confidence":0.88}',
    );

    const router = makeRouter({
      forumThreads: [
        { name: 'id:t1', displayName: 'Thread 1', threadId: 't1' },
      ],
    });

    const result = await inferRouteTarget(
      'let us create a new discussion about architecture',
      router,
      makeTopicManager(),
      makeProjectManager(),
      makeAgents(),
    );
    expect(result.action).toBe('none');
  });

  it('handles LLM timeout gracefully', async () => {
    mockQuickCompletion.mockRejectedValue(
      Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' }),
    );

    const router = makeRouter({
      forumThreads: [
        { name: 'id:t1', displayName: 'Thread 1', threadId: 't1' },
      ],
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await inferRouteTarget(
      'let us continue the messaging principles discussion',
      router,
      makeTopicManager(),
      makeProjectManager(),
      makeAgents(),
    );
    expect(result.action).toBe('none');
    expect(result.confidence).toBe(0);
    warnSpy.mockRestore();
  });

  it('handles LLM error gracefully', async () => {
    mockQuickCompletion.mockRejectedValue(new Error('Network error'));

    const router = makeRouter({
      forumThreads: [
        { name: 'id:t1', displayName: 'Thread 1', threadId: 't1' },
      ],
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await inferRouteTarget(
      'let us continue the messaging discussion',
      router,
      makeTopicManager(),
      makeProjectManager(),
      makeAgents(),
    );
    expect(result.action).toBe('none');
    warnSpy.mockRestore();
  });

  it('handles unparseable LLM response', async () => {
    mockQuickCompletion.mockResolvedValue('I cannot determine the routing target.');

    const router = makeRouter({
      forumThreads: [
        { name: 'id:t1', displayName: 'Thread 1', threadId: 't1' },
      ],
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await inferRouteTarget(
      'let us continue the messaging discussion',
      router,
      makeTopicManager(),
      makeProjectManager(),
      makeAgents(),
    );
    expect(result.action).toBe('none');
    warnSpy.mockRestore();
  });

  it('extracts JSON from LLM response with surrounding prose', async () => {
    mockQuickCompletion.mockResolvedValue(
      'Here is the result: {"action":"route","target":"t1","confidence":0.88} based on analysis.',
    );

    const router = makeRouter({
      forumThreads: [
        { name: 'id:t1', displayName: 'Thread 1', threadId: 't1' },
      ],
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await inferRouteTarget(
      'let us continue working on thread one stuff',
      router,
      makeTopicManager(),
      makeProjectManager(),
      makeAgents(),
    );
    expect(result.action).toBe('route');
    expect(result.target).toBe('t1');
    expect(result.confidence).toBe(0.88);
    logSpy.mockRestore();
  });

  it('rejects invalid confidence values', async () => {
    mockQuickCompletion.mockResolvedValue(
      '{"action":"route","target":"t1","confidence":"high"}',
    );

    const router = makeRouter({
      forumThreads: [
        { name: 'id:t1', displayName: 'Thread 1', threadId: 't1' },
      ],
    });

    const result = await inferRouteTarget(
      'let us continue the messaging discussion',
      router,
      makeTopicManager(),
      makeProjectManager(),
      makeAgents(),
    );
    expect(result.action).toBe('none');
  });

  it('rejects confidence outside 0-1 range', async () => {
    mockQuickCompletion.mockResolvedValue(
      '{"action":"route","target":"t1","confidence":1.5}',
    );

    const router = makeRouter({
      forumThreads: [
        { name: 'id:t1', displayName: 'Thread 1', threadId: 't1' },
      ],
    });

    const result = await inferRouteTarget(
      'let us continue the messaging discussion',
      router,
      makeTopicManager(),
      makeProjectManager(),
      makeAgents(),
    );
    expect(result.action).toBe('none');
  });

  it('passes current topic context to the classifier prompt', async () => {
    mockQuickCompletion.mockResolvedValue('{"action":"none","confidence":0.2}');

    const router = makeRouter({
      forumThreads: [
        { name: 'id:t1', displayName: 'Thread 1', threadId: 't1' },
      ],
    });

    await inferRouteTarget(
      'let us talk about something interesting',
      router,
      makeTopicManager({ title: 'Active Topic' }),
      makeProjectManager(),
      makeAgents(),
    );

    expect(mockQuickCompletion).toHaveBeenCalledTimes(1);
    const systemPrompt = mockQuickCompletion.mock.calls[0][0];
    expect(systemPrompt).toContain('topic: Active Topic');
  });

  it('includes forum thread targets in the classifier prompt', async () => {
    mockQuickCompletion.mockResolvedValue('{"action":"none","confidence":0.1}');

    const router = makeRouter({
      forumThreads: [
        { name: 'id:t1', displayName: 'Messaging Principles (in latitude)', threadId: 't1' },
        { name: 'id:t2', displayName: 'API Design (in latitude)', threadId: 't2' },
      ],
    });

    await inferRouteTarget(
      'let us discuss the API design decisions',
      router,
      makeTopicManager(),
      makeProjectManager(),
      makeAgents(),
    );

    const systemPrompt = mockQuickCompletion.mock.calls[0][0];
    expect(systemPrompt).toContain('Messaging Principles (in latitude)');
    expect(systemPrompt).toContain('API Design (in latitude)');
    expect(systemPrompt).toContain('[thread]');
  });

  it('includes recency metadata in the classifier prompt', async () => {
    mockQuickCompletion.mockResolvedValue('{"action":"none","confidence":0.1}');

    const router = makeRouter({
      forumThreads: [
        { name: 'id:t1', displayName: 'Lunch Money (in watson)', threadId: 't1' },
      ],
    });
    const { db } = makeRecencyDb([
      { discordChannelId: 't1', lastActive: '2026-04-15 18:00:00' },
    ]);

    await inferRouteTarget(
      'check the lunch money thread',
      router,
      makeTopicManager(),
      makeProjectManager(),
      makeAgents(),
      { db, now: new Date('2026-04-20T18:00:00Z') },
    );

    const systemPrompt = mockQuickCompletion.mock.calls[0][0];
    expect(systemPrompt).toContain('stale - 5 days inactive');
    expect(systemPrompt).toContain('Stale targets (>3 days inactive)');
    expect(systemPrompt).toContain('Very stale targets (>7 days inactive)');
  });

  it('adds short-input bias instructions when no target names are mentioned', async () => {
    mockQuickCompletion.mockResolvedValue('{"action":"none","confidence":0.1}');

    const router = makeRouter({
      forumThreads: [
        { name: 'id:t1', displayName: 'Lunch Money (in watson)', threadId: 't1' },
      ],
    });
    const { db } = makeRecencyDb([
      { discordChannelId: 't1', lastActive: '2026-04-20 17:00:00' },
    ]);

    await inferRouteTarget(
      'check on it',
      router,
      makeTopicManager(),
      makeProjectManager(),
      makeAgents(),
      { db, now: new Date('2026-04-20T18:00:00Z') },
    );

    const systemPrompt = mockQuickCompletion.mock.calls[0][0];
    expect(systemPrompt).toContain(
      'IMPORTANT: The user\'s input is short/generic and does not mention any specific thread or topic by name.',
    );
  });
});
