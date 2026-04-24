import { fileURLToPath } from "node:url";
import type { MemoryRecord, PinnedFactRecord } from "@tango/atlas-memory";
import type { V2AgentConfig } from "@tango/core";
import { describe, expect, it, vi } from "vitest";
import {
  buildV2EnabledAgentSet,
  buildV2RuntimeConfigs,
  createAtlasColdStartContextBuilder,
  createV2PostTurnHook,
  routeV2MessageIfEnabled,
  shutdownV2Runtime,
} from "../src/v2-runtime.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

function createV2Config(
  agentId: string,
  overrides: Partial<V2AgentConfig["runtime"]> = {},
  memoryOverrides: Partial<V2AgentConfig["memory"]> = {},
): V2AgentConfig {
  return {
    id: agentId,
    displayName: agentId,
    type: "test",
    systemPromptFile: "agents/assistants/malibu/soul.md",
    mcpServers: [
      {
        name: "memory",
        command: "node",
        args: ["packages/atlas-memory/dist/index.js"],
      },
    ],
    runtime: {
      mode: "persistent",
      provider: "legacy",
      model: "claude-sonnet-4-6",
      reasoningEffort: "medium",
      idleTimeoutHours: 24,
      contextResetThreshold: 0.8,
      ...overrides,
    },
    memory: {
      postTurnExtraction: "enabled",
      extractionModel: "claude-haiku-4-5",
      importanceThreshold: 0.4,
      scheduledReflection: "enabled",
      ...memoryOverrides,
    },
    discord: {
      defaultChannelId: "123",
    },
  };
}

function createMemory(id: string, content: string, tags: string[] = []): MemoryRecord {
  return {
    id,
    content,
    source: "conversation",
    agentId: "malibu",
    importance: 0.7,
    tags,
    embedding: null,
    embeddingModel: null,
    createdAt: "2026-04-20T00:00:00.000Z",
    lastAccessedAt: "2026-04-20T00:00:00.000Z",
    accessCount: 1,
    archivedAt: null,
    metadata: null,
  };
}

function createPinnedFact(id: string, key: string, value: string): PinnedFactRecord {
  return {
    id,
    scope: "global",
    scopeId: null,
    key,
    value,
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
  };
}

describe("routeV2MessageIfEnabled", () => {
  it("routes v2-enabled agents through TangoRouter", async () => {
    const routeMessage = vi.fn().mockResolvedValue({
      response: { text: "v2 reply", durationMs: 42 },
      agentId: "malibu",
      conversationKey: "thread:thread-1",
    });

    const result = await routeV2MessageIfEnabled(
      {
        message: "help",
        channelId: "channel-1",
        threadId: "thread-1",
        agentId: "malibu",
        sendOptions: {
          context: "warm-start context",
          timeout: 45_000,
        },
      },
      {
        v2EnabledAgents: new Set(["malibu"]),
        tangoRouter: { routeMessage },
      },
    );

    expect(result).toEqual({
      response: { text: "v2 reply", durationMs: 42 },
      agentId: "malibu",
      conversationKey: "thread:thread-1",
    });
    expect(routeMessage).toHaveBeenCalledWith({
      message: "help",
      channelId: "channel-1",
      threadId: "thread-1",
      agentId: "malibu",
      sendOptions: {
        context: "warm-start context",
        timeout: 45_000,
      },
    });
  });

  it("returns null for agents that remain on the legacy path", async () => {
    const routeMessage = vi.fn();

    const result = await routeV2MessageIfEnabled(
      {
        message: "help",
        channelId: "channel-1",
        agentId: "malibu",
      },
      {
        v2EnabledAgents: new Set(["sierra"]),
        tangoRouter: { routeMessage },
      },
    );

    expect(result).toBeNull();
    expect(routeMessage).not.toHaveBeenCalled();
  });
});

describe("buildV2RuntimeConfigs", () => {
  it("builds runtime configs only for v2-enabled agents and normalizes xhigh to max", () => {
    const configs = new Map<string, V2AgentConfig>([
      ["malibu", createV2Config("malibu", { provider: "claude-code-v2", reasoningEffort: "xhigh" })],
      ["victor", createV2Config("victor", { provider: "legacy" })],
    ]);

    const enabledAgents = buildV2EnabledAgentSet(configs);
    const runtimeConfigs = buildV2RuntimeConfigs(configs, { repoRoot });

    expect(enabledAgents).toEqual(new Set(["malibu"]));
    expect([...runtimeConfigs.keys()]).toEqual(["malibu"]);
    expect(runtimeConfigs.get("malibu")).toMatchObject({
      agentId: "malibu",
      runtimePreferences: {
        model: "claude-sonnet-4-6",
        reasoningEffort: "max",
        timeout: 120_000,
      },
    });
  });
});

describe("createAtlasColdStartContextBuilder", () => {
  it("assembles pinned facts and relevant memories from Atlas memory", async () => {
    const pinnedFactGet = vi
      .fn()
      .mockResolvedValueOnce([createPinnedFact("global-1", "product_name", "Atlas")])
      .mockResolvedValueOnce([createPinnedFact("agent-1", "tone", "concise")]);
    const memorySearch = vi.fn().mockResolvedValue([
      createMemory("memory-1", "User prefers shorter workout summaries", ["preference"]),
      createMemory("memory-2", "Recent ankle soreness affected training", ["injury", "recent"]),
    ]);

    const buildColdStartContext = createAtlasColdStartContextBuilder({
      pinnedFactGet,
      memorySearch,
    });
    const result = await buildColdStartContext("thread:thread-9", "malibu");

    expect(pinnedFactGet).toHaveBeenNthCalledWith(1, { scope: "global" });
    expect(pinnedFactGet).toHaveBeenNthCalledWith(2, { scope: "agent", scope_id: "malibu" });
    expect(memorySearch).toHaveBeenCalledWith({
      query: "recent context",
      agent_id: "malibu",
      limit: 5,
    });
    expect(result).toEqual({
      pinnedFacts: "- product_name: Atlas\n- tone: concise",
      recentMessages: "",
      relevantMemories: [
        "- User prefers shorter workout summaries [preference]",
        "- Recent ankle soreness affected training [injury, recent]",
      ].join("\n"),
    });
  });
});

describe("createV2PostTurnHook", () => {
  it("runs post-turn memory capture when the feature is enabled", async () => {
    const extractAndStoreMemoriesImpl = vi.fn().mockResolvedValue(undefined);
    const hook = createV2PostTurnHook({
      v2Configs: new Map([
        [
          "malibu",
          createV2Config("malibu", { provider: "claude-code-v2" }, { postTurnExtraction: "enabled" }),
        ],
      ]),
      atlasMemoryClient: {
        close: vi.fn(),
      } as never,
      extractAndStoreMemoriesImpl,
    });

    await hook({
      conversationKey: "thread:thread-1",
      agentId: "malibu",
      userMessage: "Log my workout",
      response: { text: "Logged it.", durationMs: 20 },
      channelId: "channel-1",
      threadId: "thread-1",
    });

    expect(extractAndStoreMemoriesImpl).toHaveBeenCalledWith(
      {
        conversationKey: "thread:thread-1",
        agentId: "malibu",
        userMessage: "Log my workout",
        agentResponse: "Logged it.",
        channelId: "channel-1",
        threadId: "thread-1",
      },
      {
        enabled: true,
        extractionModel: "claude-haiku-4-5",
        importanceThreshold: 0.4,
      },
      expect.any(Object),
    );
  });

  it("skips memory capture when the feature is disabled", async () => {
    const extractAndStoreMemoriesImpl = vi.fn().mockResolvedValue(undefined);
    const hook = createV2PostTurnHook({
      v2Configs: new Map([
        [
          "malibu",
          createV2Config("malibu", { provider: "claude-code-v2" }, { postTurnExtraction: "disabled" }),
        ],
      ]),
      atlasMemoryClient: {
        close: vi.fn(),
      } as never,
      extractAndStoreMemoriesImpl,
    });

    await hook({
      conversationKey: "thread:thread-1",
      agentId: "malibu",
      userMessage: "Log my workout",
      response: { text: "Logged it.", durationMs: 20 },
      channelId: "channel-1",
    });

    expect(extractAndStoreMemoriesImpl).not.toHaveBeenCalled();
  });
});

describe("shutdownV2Runtime", () => {
  it("shuts down the router and closes the Atlas memory client", async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn();

    await shutdownV2Runtime({
      tangoRouter: { shutdown },
      atlasMemoryClient: { close },
    });

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
