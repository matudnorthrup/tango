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
  // Build a set of existing inbound content strings for deduplication
  const existingContent = new Set<string>();
  for (const message of sessionMessages) {
    byId.set(message.id, message);
    if (message.content && message.direction === "inbound") {
      existingContent.add(message.content.trim());
    }
  }

  let supplementalMessageCount = 0;
  const MAX_SUPPLEMENTAL = 10;
  const RECENCY_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
  const now = Date.now();

  for (const message of input.recentChannelMessages) {
    if (supplementalMessageCount >= MAX_SUPPLEMENTAL) break;
    if (message.discordChannelId !== channelId) continue;
    if (message.visibility !== "public") continue;
    if (message.agentId !== input.agentId) continue;
    if (message.direction !== "inbound" && message.direction !== "outbound") continue;
    if (byId.has(message.id)) continue;

    // Skip supplemental messages whose content duplicates an existing session message
    if (message.content && message.direction === "inbound" && existingContent.has(message.content.trim())) {
      continue;
    }

    // Skip supplemental messages older than the recency window
    const messageTime = new Date(message.createdAt).getTime();
    if (messageTime > 0 && now - messageTime > RECENCY_WINDOW_MS) {
      continue;
    }

    byId.set(message.id, message);
    supplementalMessageCount += 1;
  }

  return {
    messages: [...byId.values()].sort((a, b) => a.id - b.id),
    supplementalMessageCount,
  };
}
