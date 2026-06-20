import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MemoryRecord, PinnedFactRecord } from "@tango/atlas-memory";
import type { AttachmentStore, V2AgentConfig } from "@tango/core";
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
  configOverrides: Partial<V2AgentConfig> = {},
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
    ...configOverrides,
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
          currentTurnMetadataPrompt: "Current user message metadata:\n- timestamp_utc: 2026-05-31T04:08:18.000Z",
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
        currentTurnMetadataPrompt: "Current user message metadata:\n- timestamp_utc: 2026-05-31T04:08:18.000Z",
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
      ["watson", createV2Config("watson", { provider: "claude-code-v2" }, {}, { enabled: false })],
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
        timeout: 900_000,
      },
    });
  });

  it("uses a configured per-agent timeout when one is present", () => {
    const configs = new Map<string, V2AgentConfig>([
      ["porter", createV2Config("porter", { provider: "claude-code-v2", timeoutSeconds: 2700 })],
    ]);

    const runtimeConfigs = buildV2RuntimeConfigs(configs, { repoRoot });

    expect(runtimeConfigs.get("porter")).toMatchObject({
      agentId: "porter",
      runtimePreferences: {
        timeout: 2_700_000,
      },
    });
  });

  it("injects configured memory scope into MCP server environments", () => {
    const configs = new Map<string, V2AgentConfig>([
      [
        "sierra-ollama",
        createV2Config(
          "sierra-ollama",
          { provider: "claude-code-v2" },
          {
            canonicalAgentId: "sierra",
            aliasAgentIds: ["sierra", "sierra-ollama"],
          },
        ),
      ],
    ]);

    const runtimeConfig = buildV2RuntimeConfigs(configs, { repoRoot }).get("sierra-ollama");

    expect(runtimeConfig?.mcpServers[0]?.env).toMatchObject({
      WORKER_ID: "sierra-ollama",
      TANGO_MEMORY_CANONICAL_AGENT_ID: "sierra",
      TANGO_MEMORY_ALIAS_AGENT_IDS: "sierra,sierra-ollama",
    });
  });

  it("loads per-agent profile prompt overlays into the system prompt (profile parity)", () => {
    const homeBackup = process.env.TANGO_HOME;
    const profileBackup = process.env.TANGO_PROFILE;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tango-v2-overlay-"));
    try {
      process.env.TANGO_HOME = tmpHome;
      process.env.TANGO_PROFILE = "test";
      const overlayDir = path.join(tmpHome, "profiles", "test", "prompts", "agents", "malibu");
      fs.mkdirSync(overlayDir, { recursive: true });
      fs.writeFileSync(path.join(overlayDir, "extra.md"), "PROFILE_OVERLAY_MARKER_XYZ", "utf8");

      const configs = new Map<string, V2AgentConfig>([
        ["malibu", createV2Config("malibu", { provider: "claude-code-v2" })],
      ]);
      const runtimeConfigs = buildV2RuntimeConfigs(configs, { repoRoot });

      // The profile-owned overlay is appended to the agent's system prompt,
      // so private/user-specific knowledge can live in the profile, not the repo.
      expect(runtimeConfigs.get("malibu")?.systemPrompt).toContain("PROFILE_OVERLAY_MARKER_XYZ");
    } finally {
      if (homeBackup === undefined) delete process.env.TANGO_HOME;
      else process.env.TANGO_HOME = homeBackup;
      if (profileBackup === undefined) delete process.env.TANGO_PROFILE;
      else process.env.TANGO_PROFILE = profileBackup;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("lets ollama clones inherit their base persona profile overlays", () => {
    const homeBackup = process.env.TANGO_HOME;
    const profileBackup = process.env.TANGO_PROFILE;
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tango-v2-clone-overlay-"));
    try {
      process.env.TANGO_HOME = tmpHome;
      process.env.TANGO_PROFILE = "test";
      const baseOverlayDir = path.join(tmpHome, "profiles", "test", "prompts", "agents", "watson");
      const cloneOverlayDir = path.join(tmpHome, "profiles", "test", "prompts", "agents", "watson-ollama");
      fs.mkdirSync(baseOverlayDir, { recursive: true });
      fs.mkdirSync(cloneOverlayDir, { recursive: true });
      fs.writeFileSync(path.join(baseOverlayDir, "google-accounts.md"), "BASE_WATSON_ACCOUNT_MARKER", "utf8");
      fs.writeFileSync(path.join(cloneOverlayDir, "clone.md"), "CLONE_SPECIFIC_MARKER", "utf8");

      const configs = new Map<string, V2AgentConfig>([
        [
          "watson-ollama",
          createV2Config("watson-ollama", { provider: "claude-code-v2" }, {}, {
            systemPromptFile: "agents/assistants/watson/soul.md",
          }),
        ],
      ]);
      const prompt = buildV2RuntimeConfigs(configs, { repoRoot }).get("watson-ollama")?.systemPrompt ?? "";

      expect(prompt).toContain("BASE_WATSON_ACCOUNT_MARKER");
      expect(prompt).toContain("CLONE_SPECIFIC_MARKER");
      expect(prompt.indexOf("BASE_WATSON_ACCOUNT_MARKER")).toBeLessThan(prompt.indexOf("CLONE_SPECIFIC_MARKER"));
    } finally {
      if (homeBackup === undefined) delete process.env.TANGO_HOME;
      else process.env.TANGO_HOME = homeBackup;
      if (profileBackup === undefined) delete process.env.TANGO_PROFILE;
      else process.env.TANGO_PROFILE = profileBackup;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
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
      agent_ids: ["malibu"],
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

  it("expands cold-start Atlas memory reads across configured agent aliases", async () => {
    const pinnedFactGet = vi
      .fn()
      .mockResolvedValueOnce([createPinnedFact("global-1", "product_name", "Atlas")])
      .mockResolvedValueOnce([createPinnedFact("agent-1", "base", "canonical")])
      .mockResolvedValueOnce([createPinnedFact("agent-2", "clone", "ollama")]);
    const memorySearch = vi.fn().mockResolvedValue([
      createMemory("memory-1", "User is researching Fujifilm X100VI", ["camera"]),
    ]);
    const v2Configs = new Map<string, V2AgentConfig>([
      [
        "sierra-ollama",
        createV2Config(
          "sierra-ollama",
          { provider: "claude-code-v2" },
          {
            canonicalAgentId: "sierra",
            aliasAgentIds: ["sierra", "sierra-ollama"],
          },
        ),
      ],
    ]);

    const buildColdStartContext = createAtlasColdStartContextBuilder(
      {
        pinnedFactGet,
        memorySearch,
      },
      { v2Configs },
    );
    const result = await buildColdStartContext("thread:thread-9", "sierra-ollama");

    expect(pinnedFactGet).toHaveBeenNthCalledWith(1, { scope: "global" });
    expect(pinnedFactGet).toHaveBeenNthCalledWith(2, { scope: "agent", scope_id: "sierra" });
    expect(pinnedFactGet).toHaveBeenNthCalledWith(3, { scope: "agent", scope_id: "sierra-ollama" });
    expect(memorySearch).toHaveBeenCalledWith({
      query: "recent context",
      agent_id: "sierra",
      agent_ids: ["sierra", "sierra-ollama"],
      limit: 5,
    });
    expect(result.pinnedFacts).toContain("- base: canonical");
    expect(result.pinnedFacts).toContain("- clone: ollama");
    expect(result.relevantMemories).toContain("Fujifilm X100VI");
  });

  it("includes compact attachment directory context when an attachment store is provided", async () => {
    const pinnedFactGet = vi.fn().mockResolvedValue([]);
    const memorySearch = vi.fn().mockResolvedValue([]);
    const listDirectoriesForContext = vi.fn().mockReturnValue([
      {
        attachment: {
          id: 42,
          projectId: null,
          agentId: "watson",
          sessionId: "session-1",
          messageId: "message-1",
          channelId: "channel-1",
          threadId: "thread-9",
          userId: "user-1",
          discordAttachmentId: "discord-attachment-42",
          fileId: 7,
          title: "START HERE image",
          originalFilename: "start-here.png",
          contentType: "image/png",
          bytes: 1234,
          status: "ready",
          retentionPolicyId: null,
          metadata: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        directory: {
          id: 9,
          attachmentId: 42,
          schemaVersion: 1,
          projectId: null,
          agentId: "watson",
          sessionId: "session-1",
          messageId: "message-1",
          channelId: "channel-1",
          threadId: "thread-9",
          userId: "user-1",
          status: "ready",
          directory: {
            title: "START HERE image",
            summary: "One-page index for user image docs.",
            source: {
              message_ref: "discord:channel-1:message-1:discord-attachment-42",
              attachment_ref: "attachment:42",
            },
            available_reads: ["attachment_search", "attachment_read"],
          },
          metadata: null,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      },
    ]);

    const buildColdStartContext = createAtlasColdStartContextBuilder(
      {
        pinnedFactGet,
        memorySearch,
      },
      {
        attachmentStore: { listDirectoriesForContext } as unknown as AttachmentStore,
      },
    );

    const result = await buildColdStartContext("thread:thread-9", "watson");

    expect(listDirectoriesForContext).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-9",
        directoryStatus: ["ready", "failed"],
      }),
    );
    expect(result.attachmentDirectories).toContain("Relevant attachment directories:");
    expect(result.attachmentDirectories).toContain("START HERE image");
    expect(result.attachmentDirectories).toContain("Use attachment_search/attachment_read");
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
      resolveProvider: () => ({ generate: vi.fn() }) as never,
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
        runtimeAgentId: "malibu",
        userMessage: "Log my workout",
        agentResponse: "Logged it.",
        channelId: "channel-1",
        threadId: "thread-1",
      },
      {
        enabled: true,
        extractionProvider: "claude-oauth",
        extractionModel: "claude-haiku-4-5",
        importanceThreshold: 0.4,
      },
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("stores post-turn memories under the configured canonical agent id", async () => {
    const extractAndStoreMemoriesImpl = vi.fn().mockResolvedValue(undefined);
    const hook = createV2PostTurnHook({
      v2Configs: new Map([
        [
          "sierra-ollama",
          createV2Config(
            "sierra-ollama",
            { provider: "claude-code-v2" },
            {
              postTurnExtraction: "enabled",
              canonicalAgentId: "sierra",
              aliasAgentIds: ["sierra", "sierra-ollama"],
              extractionProvider: "ollama",
            },
          ),
        ],
      ]),
      atlasMemoryClient: {
        close: vi.fn(),
      } as never,
      resolveProvider: () => ({ generate: vi.fn() }) as never,
      extractAndStoreMemoriesImpl,
    });

    await hook({
      conversationKey: "thread:thread-1",
      agentId: "sierra-ollama",
      userMessage: "What camera was it?",
      response: { text: "The Fujifilm X100VI.", durationMs: 20 },
      channelId: "channel-1",
      threadId: "thread-1",
    });

    expect(extractAndStoreMemoriesImpl).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "sierra",
        runtimeAgentId: "sierra-ollama",
      }),
      expect.objectContaining({
        extractionProvider: "ollama",
      }),
      expect.any(Object),
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
      resolveProvider: () => ({ generate: vi.fn() }) as never,
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

  it("skips memory capture for extraction-suppressed channels even when extraction is enabled", async () => {
    const extractAndStoreMemoriesImpl = vi.fn().mockResolvedValue(undefined);
    const hook = createV2PostTurnHook({
      v2Configs: new Map([
        [
          "malibu-ollama",
          createV2Config("malibu-ollama", { provider: "claude-code-v2" }, { postTurnExtraction: "enabled" }),
        ],
      ]),
      atlasMemoryClient: {
        close: vi.fn(),
      } as never,
      resolveProvider: () => ({ generate: vi.fn() }) as never,
      extractionSuppressedChannelIds: new Set(["smoke-channel-1"]),
      extractAndStoreMemoriesImpl,
    });

    // Turn in the suppressed (smoke) channel — including via a thread, where
    // channelId is the parent channel id — must not extract.
    await hook({
      conversationKey: "thread:thread-9",
      agentId: "malibu-ollama",
      userMessage: "Test probe",
      response: { text: "Ack.", durationMs: 20 },
      channelId: "smoke-channel-1",
      threadId: "thread-9",
    });
    expect(extractAndStoreMemoriesImpl).not.toHaveBeenCalled();

    // Same agent in its regular (dogfood) channel still extracts.
    await hook({
      conversationKey: "channel:dogfood-channel-1",
      agentId: "malibu-ollama",
      userMessage: "Log my workout",
      response: { text: "Logged it.", durationMs: 20 },
      channelId: "dogfood-channel-1",
    });
    expect(extractAndStoreMemoriesImpl).toHaveBeenCalledTimes(1);
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
