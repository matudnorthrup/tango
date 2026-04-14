import { describe, expect, it } from "vitest";
import { isSmokeTestThreadWebhookMessage } from "../src/smoke-test-webhook.js";

describe("isSmokeTestThreadWebhookMessage", () => {
  const smokeTestChannelIds = new Set(["parent-smoke"]);

  it("accepts webhook messages in smoke-test threads", () => {
    expect(
      isSmokeTestThreadWebhookMessage(
        {
          webhookId: "webhook-123",
          channel: {
            isThread: () => true,
            parentId: "parent-smoke",
          },
        },
        smokeTestChannelIds,
      ),
    ).toBe(true);
  });

  it("rejects direct webhook messages in the smoke-test parent channel", () => {
    expect(
      isSmokeTestThreadWebhookMessage(
        {
          webhookId: "webhook-123",
          channel: {
            isThread: () => false,
            parentId: "parent-smoke",
          },
        },
        smokeTestChannelIds,
      ),
    ).toBe(false);
  });

  it("rejects webhook messages outside configured smoke-test parents", () => {
    expect(
      isSmokeTestThreadWebhookMessage(
        {
          webhookId: "webhook-123",
          channel: {
            isThread: () => true,
            parentId: "parent-other",
          },
        },
        smokeTestChannelIds,
      ),
    ).toBe(false);
  });

  it("rejects non-webhook messages", () => {
    expect(
      isSmokeTestThreadWebhookMessage(
        {
          webhookId: null,
          channel: {
            isThread: () => true,
            parentId: "parent-smoke",
          },
        },
        smokeTestChannelIds,
      ),
    ).toBe(false);
  });
});
