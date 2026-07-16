import { describe, expect, it } from "vitest";

import {
  buildContextPressureInThreadAlert,
  buildContextRotationInThreadAlert,
  buildContextSlashReply,
} from "../src/context-visibility.js";

describe("context-visibility", () => {
  it("builds an in-thread pressure alert with save guidance", () => {
    const message = buildContextPressureInThreadAlert("jules", {
      fraction: 0.73,
      totalTokens: 146_000,
      contextWindow: 200_000,
    });

    expect(message).toContain("Context 73% — jules");
    expect(message).toContain("/tango save");
    expect(message).toContain("rotates at 80%");
    expect(message).toContain("/tango new");
  });

  it("builds an in-thread rotation alert at 80%", () => {
    const message = buildContextRotationInThreadAlert("jules");

    expect(message).toContain("Session rotated at 80%");
    expect(message).toContain("rotation, not a save pass");
    expect(message).toContain("/tango save");
  });

  it("builds an ephemeral slash reply with idle-timeout notes", () => {
    const message = buildContextSlashReply({
      agentId: "jules",
      conversationKey: "thread:123",
      usage: {
        fraction: 0.42,
        totalTokens: 84_000,
        contextWindow: 200_000,
        recordedAt: new Date("2026-06-01T05:00:00.000Z"),
      },
      contextPressureAlertSent: false,
      idleTimeoutHours: 4,
      lifecycleIdleTimeoutHours: 24,
    });

    expect(message).toContain("Context: 42%");
    expect(message).toContain("agent config 4h");
    expect(message).toContain("lifecycle currently closes idle runtimes after 24h");
  });
});
