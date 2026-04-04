export interface VoiceWatermarkTargetLookup {
  hasConfiguredChannel(channelId: string): boolean;
  hasTrackedThread(threadId: string): boolean;
}

export interface ResolveVoiceWatermarkTargetInput {
  channelId: string;
  parentId?: string | null;
  lookup: VoiceWatermarkTargetLookup;
}

/**
 * Resolve the exact Discord channel/thread ID that owns the watermark.
 * Tracked threads are distinct inbox targets and must not collapse to parent IDs.
 */
export function resolveVoiceWatermarkTarget(input: ResolveVoiceWatermarkTargetInput): string | null {
  const { channelId, parentId, lookup } = input;

  if (lookup.hasTrackedThread(channelId)) return channelId;
  if (lookup.hasConfiguredChannel(channelId)) return channelId;
  if (parentId && lookup.hasConfiguredChannel(parentId)) return parentId;
  return null;
}
