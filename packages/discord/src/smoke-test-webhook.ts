interface SmokeTestWebhookChannelLike {
  isThread?: () => boolean;
  parentId?: string | null;
}

interface SmokeTestWebhookMessageLike {
  webhookId?: string | null;
  channel?: SmokeTestWebhookChannelLike | null;
}

export function isSmokeTestThreadWebhookMessage(
  message: SmokeTestWebhookMessageLike,
  smokeTestChannelIds: ReadonlySet<string>,
): boolean {
  const webhookId = message.webhookId?.trim();
  if (!webhookId) {
    return false;
  }

  const channel = message.channel;
  if (!channel || typeof channel.isThread !== "function" || !channel.isThread()) {
    return false;
  }

  const parentId = channel.parentId?.trim();
  return Boolean(parentId && smokeTestChannelIds.has(parentId));
}
