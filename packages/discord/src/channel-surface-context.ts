import type { StoredMessageRecord } from "@tango/core";

export interface ChannelSurfaceSelection {
  messages: StoredMessageRecord[];
  supplementalMessageCount: number;
}

export function selectWarmStartMessages(input: {
  sessionMessages: StoredMessageRecord[];
  recentChannelMessages: StoredMessageRecord[];
  channelId?: string | null;
  agentId: string;
}): ChannelSurfaceSelection {
  const channelId = input.channelId?.trim() || null;
  const sessionMessages = channelId
    ? input.sessionMessages.filter(
        (message) => !message.discordChannelId || message.discordChannelId === channelId
      )
    : input.sessionMessages;

  if (!channelId) {
    return {
      messages: sessionMessages,
      supplementalMessageCount: 0,
    };
  }

  const byId = new Map<number, StoredMessageRecord>();
  for (const message of sessionMessages) {
    byId.set(message.id, message);
  }

  let supplementalMessageCount = 0;
  for (const message of input.recentChannelMessages) {
    if (message.discordChannelId !== channelId) continue;
    if (message.visibility !== "public") continue;
    if (message.agentId !== input.agentId) continue;
    if (message.direction !== "inbound" && message.direction !== "outbound") continue;
    if (byId.has(message.id)) continue;
    byId.set(message.id, message);
    supplementalMessageCount += 1;
  }

  return {
    messages: [...byId.values()].sort((a, b) => a.id - b.id),
    supplementalMessageCount,
  };
}
