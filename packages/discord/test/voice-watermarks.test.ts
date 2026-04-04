import { describe, expect, it } from "vitest";
import { resolveVoiceWatermarkTarget, type VoiceWatermarkTargetLookup } from "../src/voice-watermarks.js";

function makeLookup(params?: {
  configured?: string[];
  threads?: string[];
}): VoiceWatermarkTargetLookup {
  const configured = new Set(params?.configured ?? []);
  const threads = new Set(params?.threads ?? []);

  return {
    hasConfiguredChannel(channelId: string): boolean {
      return configured.has(channelId);
    },
    hasTrackedThread(threadId: string): boolean {
      return threads.has(threadId);
    },
  };
}

describe("resolveVoiceWatermarkTarget", () => {
  it("keeps tracked threads on the thread watermark", () => {
    expect(resolveVoiceWatermarkTarget({
      channelId: "thread-1",
      parentId: "parent-1",
      lookup: makeLookup({ configured: ["parent-1"], threads: ["thread-1"] }),
    })).toBe("thread-1");
  });

  it("uses the direct channel when it is configured", () => {
    expect(resolveVoiceWatermarkTarget({
      channelId: "channel-1",
      lookup: makeLookup({ configured: ["channel-1"] }),
    })).toBe("channel-1");
  });

  it("falls back to the parent channel for untracked threads in configured channels", () => {
    expect(resolveVoiceWatermarkTarget({
      channelId: "thread-1",
      parentId: "parent-1",
      lookup: makeLookup({ configured: ["parent-1"] }),
    })).toBe("parent-1");
  });

  it("returns null when the channel is not tracked by the voice inbox", () => {
    expect(resolveVoiceWatermarkTarget({
      channelId: "random-thread",
      parentId: "random-parent",
      lookup: makeLookup({ configured: ["different-parent"], threads: ["different-thread"] }),
    })).toBeNull();
  });
});
