import { afterEach, describe, expect, it, vi } from "vitest";

const mockProviderState = vi.hoisted(() => ({
  generate: vi.fn(),
}));

vi.mock("@tango/core", async () => {
  const actual = await vi.importActual<typeof import("@tango/core")>("@tango/core");

  class MockClaudeCliProvider {
    generate = mockProviderState.generate;
  }

  return {
    ...actual,
    ClaudeCliProvider: MockClaudeCliProvider,
  };
});

import type { AtlasMemoryClient } from "../src/atlas-memory-client.js";
import {
  extractAndStoreMemories,
  type MemoryCaptureConfig,
  type MemoryCaptureContext,
} from "../src/memory-capture.js";

const baseConfig: MemoryCaptureConfig = {
  enabled: true,
  extractionModel: "claude-haiku-4-5",
  importanceThreshold: 0.4,
};

const baseContext: MemoryCaptureContext = {
  conversationKey: "thread:thread-1",
  agentId: "malibu",
  userMessage: "I prefer short updates and want weekly reviews on Monday.",
  agentResponse: "Understood. I will keep updates brief and leave the weekly review on Monday.",
  channelId: "channel-1",
  threadId: "thread-1",
};

afterEach(() => {
  mockProviderState.generate.mockReset();
  vi.restoreAllMocks();
});

describe("extractAndStoreMemories", () => {
  it("extracts memories from the model response and stores them in Atlas", async () => {
    mockProviderState.generate.mockResolvedValue({
      text: [
        "```json",
        JSON.stringify([
          {
            content: "User prefers short updates.",
            importance: 0.8,
            tags: ["Preference", "Tone"],
          },
        ]),
        "```",
      ].join("\n"),
    });

    const memoryAdd = vi.fn().mockResolvedValue({ id: "memory-1" });

    await extractAndStoreMemories(
      baseContext,
      baseConfig,
      { memoryAdd } as unknown as AtlasMemoryClient,
    );

    expect(mockProviderState.generate).toHaveBeenCalledWith(expect.objectContaining({
      model: "claude-haiku-4-5",
      reasoningEffort: "low",
    }));
    expect(memoryAdd).toHaveBeenCalledWith({
      content: "User prefers short updates.",
      source: "conversation",
      agent_id: "malibu",
      session_id: "thread:thread-1",
      importance: 0.8,
      tags: ["preference", "tone"],
      metadata: {
        captured_by: "post_turn_extraction",
        conversation_key: "thread:thread-1",
        channel_id: "channel-1",
        thread_id: "thread-1",
        extraction_model: "claude-haiku-4-5",
      },
    });
  });

  it("filters out memories below the importance threshold", async () => {
    mockProviderState.generate.mockResolvedValue({
      text: JSON.stringify([
        {
          content: "User likes coffee.",
          importance: 0.2,
          tags: ["preference"],
        },
        {
          content: "Weekly review stays on Monday.",
          importance: 0.7,
          tags: ["decision"],
        },
      ]),
    });

    const memoryAdd = vi.fn().mockResolvedValue({ id: "memory-2" });

    await extractAndStoreMemories(
      baseContext,
      baseConfig,
      { memoryAdd } as unknown as AtlasMemoryClient,
    );

    expect(memoryAdd).toHaveBeenCalledTimes(1);
    expect(memoryAdd).toHaveBeenCalledWith(expect.objectContaining({
      content: "Weekly review stays on Monday.",
      importance: 0.7,
    }));
  });

  it("does nothing when the extraction model returns an empty array", async () => {
    mockProviderState.generate.mockResolvedValue({
      text: "[]",
    });

    const memoryAdd = vi.fn().mockResolvedValue({ id: "memory-3" });

    await extractAndStoreMemories(
      baseContext,
      baseConfig,
      { memoryAdd } as unknown as AtlasMemoryClient,
    );

    expect(memoryAdd).not.toHaveBeenCalled();
  });

  it("logs model errors without failing the turn", async () => {
    mockProviderState.generate.mockRejectedValue(new Error("model unavailable"));
    const memoryAdd = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(extractAndStoreMemories(
      baseContext,
      baseConfig,
      { memoryAdd } as unknown as AtlasMemoryClient,
    )).resolves.toBeUndefined();

    expect(memoryAdd).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[memory-capture] extraction failed for thread:thread-1: model unavailable"),
    );
  });

  it("skips extraction entirely when memory capture is disabled", async () => {
    const memoryAdd = vi.fn();

    await extractAndStoreMemories(
      baseContext,
      {
        ...baseConfig,
        enabled: false,
      },
      { memoryAdd } as unknown as AtlasMemoryClient,
    );

    expect(mockProviderState.generate).not.toHaveBeenCalled();
    expect(memoryAdd).not.toHaveBeenCalled();
  });
});
