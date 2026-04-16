import type { StoredMessageRecord } from "@tango/core";
import { describe, expect, it, vi, afterEach } from "vitest";
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

/** Return an ISO-ish timestamp N minutes in the past from "now". */
function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

describe("selectWarmStartMessages", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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
        createdAt: minutesAgo(5),
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
        createdAt: minutesAgo(10),
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
        createdAt: minutesAgo(8),
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
        createdAt: minutesAgo(3),
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
        createdAt: minutesAgo(2),
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

  it("skips supplemental inbound messages whose content duplicates a session message", () => {
    const duplicatedContent = "check the balance on the joint account";
    const sessionMessages = [
      makeMessage({
        id: 20,
        sessionId: "topic:banking",
        agentId: "malibu",
        direction: "inbound",
        source: "discord",
        visibility: "public",
        discordChannelId: "chan-1",
        content: duplicatedContent,
        createdAt: minutesAgo(3),
      }),
    ];
    const recentChannelMessages = [
      // Same content, different id/session — should be skipped
      makeMessage({
        id: 18,
        sessionId: "tango-default",
        agentId: "malibu",
        direction: "inbound",
        source: "discord",
        visibility: "public",
        discordChannelId: "chan-1",
        content: duplicatedContent,
        createdAt: minutesAgo(5),
      }),
      // Outbound with same content — outbound is NOT deduped on content
      makeMessage({
        id: 19,
        sessionId: "tango-default",
        agentId: "malibu",
        direction: "outbound",
        source: "tango",
        visibility: "public",
        discordChannelId: "chan-1",
        content: duplicatedContent,
        createdAt: minutesAgo(4),
      }),
    ];

    const result = selectWarmStartMessages({
      sessionMessages,
      recentChannelMessages,
      channelId: "chan-1",
      agentId: "malibu",
    });

    // id 18 is skipped (content dup), id 19 is included (outbound not deduped)
    expect(result.supplementalMessageCount).toBe(1);
    expect(result.messages.map((m) => m.id)).toEqual([19, 20]);
  });

  it("skips supplemental messages older than 15 minutes", () => {
    const sessionMessages = [
      makeMessage({
        id: 30,
        sessionId: "topic:recap",
        agentId: "watson",
        direction: "inbound",
        source: "discord",
        visibility: "public",
        discordChannelId: "chan-1",
        content: "how did yesterday go?",
        createdAt: minutesAgo(1),
      }),
    ];
    const recentChannelMessages = [
      // 20 minutes old — should be skipped
      makeMessage({
        id: 28,
        sessionId: "tango-default",
        agentId: "watson",
        direction: "outbound",
        source: "tango",
        visibility: "public",
        discordChannelId: "chan-1",
        content: "Here is the daily summary from this morning.",
        createdAt: minutesAgo(20),
      }),
      // 5 minutes old — should be included
      makeMessage({
        id: 29,
        sessionId: "tango-default",
        agentId: "watson",
        direction: "outbound",
        source: "tango",
        visibility: "public",
        discordChannelId: "chan-1",
        content: "Anything else you'd like to know?",
        createdAt: minutesAgo(5),
      }),
    ];

    const result = selectWarmStartMessages({
      sessionMessages,
      recentChannelMessages,
      channelId: "chan-1",
      agentId: "watson",
    });

    expect(result.supplementalMessageCount).toBe(1);
    expect(result.messages.map((m) => m.id)).toEqual([29, 30]);
  });

  it("caps supplemental messages at 10", () => {
    const sessionMessages = [
      makeMessage({
        id: 100,
        sessionId: "topic:bulk",
        agentId: "watson",
        direction: "inbound",
        source: "discord",
        visibility: "public",
        discordChannelId: "chan-1",
        content: "start",
        createdAt: minutesAgo(1),
      }),
    ];

    // Create 15 eligible supplemental messages
    const recentChannelMessages = Array.from({ length: 15 }, (_, i) =>
      makeMessage({
        id: 50 + i,
        sessionId: "tango-default",
        agentId: "watson",
        direction: "outbound",
        source: "tango",
        visibility: "public",
        discordChannelId: "chan-1",
        content: `supplemental message ${i}`,
        createdAt: minutesAgo(10 - i * 0.5),
      })
    );

    const result = selectWarmStartMessages({
      sessionMessages,
      recentChannelMessages,
      channelId: "chan-1",
      agentId: "watson",
    });

    expect(result.supplementalMessageCount).toBe(10);
    // 10 supplemental + 1 session = 11 total
    expect(result.messages.length).toBe(11);
  });
});
