import type { AgentConfig } from "@tango/core";
import { describe, expect, it, vi } from "vitest";
import {
  DeliveryError,
  createReplyPresenter,
  resolveSpeakerAvatarURL,
  resolveSpeakerDisplayName,
  splitForDiscord,
  type ReplyChannelLike
} from "../src/reply-presentation.js";

function createAgent(overrides: Partial<AgentConfig> & Pick<AgentConfig, "id" | "type">): AgentConfig {
  return {
    provider: { default: "codex" },
    ...overrides
  };
}

function createWebhook(name = "Tango Replies") {
  return {
    id: "webhook-1",
    name,
    token: "token-1",
    send: vi.fn(async () => undefined)
  };
}

function createWebhookChannel(webhook = createWebhook()) {
  return {
    id: "channel-1",
    isSendable: () => true,
    send: vi.fn(async () => undefined),
    fetchWebhooks: vi.fn(async () => [webhook]),
    createWebhook: vi.fn(async () => webhook)
  };
}

describe("resolveSpeakerDisplayName", () => {
  it("uses configured display names for agents", () => {
    expect(
      resolveSpeakerDisplayName(
        createAgent({
          id: "watson",
          type: "personal",
          displayName: "Watson"
        }),
        "Tango"
      )
    ).toBe("Watson");
  });

  it("maps dispatch to the system display name", () => {
    expect(
      resolveSpeakerDisplayName(
        createAgent({
          id: "dispatch",
          type: "router",
          displayName: "Router"
        }),
        "Tango"
      )
    ).toBe("Tango");
  });
});

describe("resolveSpeakerAvatarURL", () => {
  it("uses the agent avatar when one is configured", () => {
    expect(
      resolveSpeakerAvatarURL(
        createAgent({
          id: "watson",
          type: "personal",
          avatarURL: "https://example.com/watson.webp"
        }),
        "https://example.com/fallback.webp"
      )
    ).toBe("https://example.com/watson.webp");
  });

  it("falls back when the speaker has no avatar", () => {
    expect(
      resolveSpeakerAvatarURL(
        createAgent({
          id: "voice-agent",
          type: "system"
        }),
        "https://example.com/fallback.webp"
      )
    ).toBe("https://example.com/fallback.webp");
  });
});

describe("createReplyPresenter", () => {
  it("sends agent replies through a reusable webhook with the agent display name", async () => {
    const webhook = createWebhook();
    const channel = createWebhookChannel(webhook);
    const presenter = createReplyPresenter({ systemDisplayName: "Tango" });

    const result = await presenter.sendChunked(channel, "hello world", {
      speaker: createAgent({
        id: "watson",
        type: "personal",
        displayName: "Watson"
      }),
      botDisplayName: "Tango",
      avatarURL: "https://example.com/avatar.png"
    });

    expect(result).toEqual({
      sentChunks: 1,
      delivery: "webhook",
      intendedDisplayName: "Watson",
      actualDisplayName: "Watson",
      failed: false
    });
    expect(webhook.send).toHaveBeenCalledWith({
      content: "hello world",
      username: "Watson",
      avatarURL: "https://example.com/avatar.png"
    });
    expect(channel.send).not.toHaveBeenCalled();
  });

  it("uses the parent channel webhook when sending into a thread", async () => {
    const webhook = createWebhook();
    const parent = createWebhookChannel(webhook);
    const thread: ReplyChannelLike = {
      id: "thread-1",
      isSendable: () => true,
      isThread: () => true,
      parent,
      send: vi.fn(async () => undefined)
    };
    const presenter = createReplyPresenter({ systemDisplayName: "Tango" });

    await presenter.sendChunked(thread, "thread reply", {
      speaker: createAgent({
        id: "malibu",
        type: "fitness",
        displayName: "Malibu"
      }),
      botDisplayName: "Tango"
    });

    expect(webhook.send).toHaveBeenCalledWith({
      content: "thread reply",
      username: "Malibu",
      avatarURL: undefined,
      threadId: "thread-1"
    });
    expect(thread.send).not.toHaveBeenCalled();
  });

  it("falls back to bot sends when webhook access is unavailable", async () => {
    const logger = {
      warn: vi.fn()
    };
    const channel: ReplyChannelLike = {
      id: "channel-2",
      isSendable: () => true,
      send: vi.fn(async () => undefined),
      fetchWebhooks: vi.fn(async () => {
        throw new Error("Missing Permissions");
      }),
      createWebhook: vi.fn(async () => {
        throw new Error("unreachable");
      })
    };
    const presenter = createReplyPresenter({
      systemDisplayName: "Tango",
      logger
    });

    const result = await presenter.sendChunked(channel, "fallback path", {
      speaker: createAgent({
        id: "watson",
        type: "personal",
        displayName: "Watson"
      }),
      botDisplayName: "Tango"
    });

    expect(result).toEqual({
      sentChunks: 1,
      delivery: "bot",
      intendedDisplayName: "Watson",
      actualDisplayName: "Tango",
      failed: false
    });
    expect(channel.send).toHaveBeenCalledWith("fallback path");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("reply presentation falling back to bot send channel=channel-2")
    );
  });

  it("retries webhook discovery after a prior permission failure", async () => {
    const logger = {
      warn: vi.fn()
    };
    const webhook = createWebhook();
    let allowWebhookAccess = false;
    const channel: ReplyChannelLike = {
      id: "channel-3",
      isSendable: () => true,
      send: vi.fn(async () => undefined),
      fetchWebhooks: vi.fn(async () => {
        if (!allowWebhookAccess) {
          throw new Error("Missing Permissions");
        }
        return [webhook];
      }),
      createWebhook: vi.fn(async () => webhook)
    };
    const presenter = createReplyPresenter({
      systemDisplayName: "Tango",
      logger
    });

    const first = await presenter.sendChunked(channel, "first", {
      speaker: createAgent({
        id: "watson",
        type: "personal",
        displayName: "Watson"
      }),
      botDisplayName: "Tango"
    });
    allowWebhookAccess = true;
    const second = await presenter.sendChunked(channel, "second", {
      speaker: createAgent({
        id: "watson",
        type: "personal",
        displayName: "Watson"
      }),
      botDisplayName: "Tango"
    });

    expect(first.delivery).toBe("bot");
    expect(second.delivery).toBe("webhook");
    expect(webhook.send).toHaveBeenCalledWith({
      content: "second",
      username: "Watson",
      avatarURL: undefined
    });
  });

  it("returns the last Discord message ID when a webhook send succeeds", async () => {
    const webhook = createWebhook();
    webhook.send = vi.fn(async () => ({ id: "discord-msg-123" }));
    const channel = createWebhookChannel(webhook);
    const presenter = createReplyPresenter({ systemDisplayName: "Tango" });

    const result = await presenter.sendChunked(channel, "hello world", {
      speaker: createAgent({
        id: "watson",
        type: "personal",
        displayName: "Watson"
      }),
      botDisplayName: "Tango"
    });

    expect(result.lastMessageId).toBe("discord-msg-123");
  });

  it("throws a delivery error when the channel cannot send", async () => {
    const presenter = createReplyPresenter({ systemDisplayName: "Tango" });

    await expect(
      presenter.sendChunked(null, "hello world", {
        speaker: createAgent({
          id: "watson",
          type: "personal",
          displayName: "Watson"
        }),
        botDisplayName: "Tango"
      })
    ).rejects.toBeInstanceOf(DeliveryError);
  });

  it("tracks partial delivery when bot sends fail on a later chunk", async () => {
    const logger = {
      warn: vi.fn(),
      error: vi.fn()
    };
    const text = "x".repeat(4_200);
    const chunks = splitForDiscord(text);
    let sendAttempt = 0;
    const channel: ReplyChannelLike = {
      id: "channel-4",
      isSendable: () => true,
      send: vi.fn(async () => {
        sendAttempt += 1;
        if (sendAttempt === 2) {
          throw new Error("chunk send failed");
        }
        return { id: `bot-msg-${sendAttempt}` };
      })
    };
    const presenter = createReplyPresenter({
      systemDisplayName: "Tango",
      logger
    });

    const result = await presenter.sendChunked(channel, text, {
      speaker: createAgent({
        id: "watson",
        type: "personal",
        displayName: "Watson"
      }),
      botDisplayName: "Tango"
    });

    expect(channel.send).toHaveBeenCalledTimes(chunks.length);
    expect(result).toMatchObject({
      sentChunks: chunks.length - 1,
      delivery: "bot",
      intendedDisplayName: "Watson",
      actualDisplayName: "Tango",
      failed: true,
      lastMessageId: `bot-msg-${chunks.length}`
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(`channel=channel-4 chunk=2/${chunks.length}`)
    );
  });

  it("tracks partial delivery when webhook fallback bot sends fail", async () => {
    const logger = {
      warn: vi.fn(),
      error: vi.fn()
    };
    const text = "y".repeat(4_200);
    const chunks = splitForDiscord(text);
    const webhook = createWebhook();
    let webhookAttempt = 0;
    webhook.send = vi.fn(async () => {
      webhookAttempt += 1;
      if (webhookAttempt === 2) {
        throw new Error("webhook failed");
      }
      return { id: `webhook-msg-${webhookAttempt}` };
    });
    let botAttempt = 0;
    const channel = createWebhookChannel(webhook);
    channel.send = vi.fn(async () => {
      botAttempt += 1;
      if (botAttempt === 1) {
        throw new Error("bot fallback failed");
      }
      return { id: `bot-msg-${botAttempt}` };
    });
    const presenter = createReplyPresenter({
      systemDisplayName: "Tango",
      logger
    });

    const result = await presenter.sendChunked(channel, text, {
      speaker: createAgent({
        id: "watson",
        type: "personal",
        displayName: "Watson"
      }),
      botDisplayName: "Tango"
    });

    expect(webhook.send).toHaveBeenCalledTimes(2);
    expect(channel.send).toHaveBeenCalledTimes(chunks.length - 1);
    expect(result).toMatchObject({
      sentChunks: 2,
      delivery: "mixed",
      intendedDisplayName: "Watson",
      actualDisplayName: "Watson",
      failed: true,
      lastMessageId: "bot-msg-2"
    });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("webhook reply failed channel=channel-1 speaker=Watson")
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(`channel=channel-1 chunk=2/${chunks.length}`)
    );
  });
});
