import type { StoredMessageRecord } from "@tango/core";
import { describe, expect, it } from "vitest";
import { selectWarmStartMessages } from "../src/channel-surface-context.js";

function makeMessage(overrides: Partial<StoredMessageRecord> & Pick<StoredMessageRecord, "id" | "sessionId" | "agentId" | "direction" | "source" | "visibility" | "content" | "createdAt">): StoredMessageRecord {
  return {
    providerName: null,
    discordMessageId: null,
    discordChannelId: null,
    discordUserId: null,
    discordUsername: null,
    metadata: null,
    ...overrides,
  };
}

describe("selectWarmStartMessages", () => {
  it("supplements the active session with recent visible channel messages from sibling sessions", () => {
    const sessionMessages = [
      makeMessage({
        id: 10,
        sessionId: "topic:lunch-money",
        agentId: "watson",
        direction: "inbound",
        source: "discord",
        visibility: "public",
        discordChannelId: "chan-1",
        content: "we need to categorize the last two transactions",
        createdAt: "2026-04-03 04:00:00",
      }),
    ];
    const recentChannelMessages = [
      makeMessage({
        id: 8,
        sessionId: "tango-default",
        agentId: "watson",
        direction: "outbound",
        source: "tango",
        visibility: "public",
        discordChannelId: "chan-1",
        content: "Thursday's a clean slate — all three primary tasks carry over.",
        createdAt: "2026-04-03 03:32:17",
      }),
      makeMessage({
        id: 9,
        sessionId: "topic:other",
        agentId: "malibu",
        direction: "outbound",
        source: "tango",
        visibility: "public",
        discordChannelId: "chan-1",
        content: "Different agent in same channel should not leak into Watson context.",
        createdAt: "2026-04-03 03:40:00",
      }),
      makeMessage({
        id: 11,
        sessionId: "tango-default",
        agentId: "watson",
        direction: "outbound",
        source: "tango",
        visibility: "public",
        discordChannelId: "chan-2",
        content: "Other channel should not be included.",
        createdAt: "2026-04-03 04:01:00",
      }),
    ];

    const result = selectWarmStartMessages({
      sessionMessages,
      recentChannelMessages,
      channelId: "chan-1",
      agentId: "watson",
    });

    expect(result.supplementalMessageCount).toBe(1);
    expect(result.messages.map((message) => message.id)).toEqual([8, 10]);
  });

  it("keeps system messages from the active session even when channel-scoping is enabled", () => {
    const sessionMessages = [
      makeMessage({
        id: 1,
        sessionId: "topic:lunch-money",
        agentId: "watson",
        direction: "system",
        source: "tango",
        visibility: "internal",
        content: "Reaction referent: the user reacted to the evening review.",
        createdAt: "2026-04-03 04:04:58",
      }),
    ];

    const result = selectWarmStartMessages({
      sessionMessages,
      recentChannelMessages: [],
      channelId: "chan-1",
      agentId: "watson",
    });

    expect(result.messages.map((message) => message.id)).toEqual([1]);
    expect(result.supplementalMessageCount).toBe(0);
  });
});
