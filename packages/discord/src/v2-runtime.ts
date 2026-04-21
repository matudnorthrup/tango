import type {
  AgentRuntimeConfig,
  ColdStartContextBuilder,
  RuntimeResponse,
  V2AgentConfig,
} from "@tango/core";
import {
  assembleV2SystemPrompt,
  isV2RuntimeEnabled,
} from "@tango/core";
import type { MemoryRecord, PinnedFactRecord } from "@tango/atlas-memory";
import type { AtlasMemoryClient } from "./atlas-memory-client.js";
import {
  extractAndStoreMemories,
  type MemoryCaptureConfig,
} from "./memory-capture.js";

export interface FeatureFlaggedRouteRequest {
  message: string;
  channelId: string;
  threadId?: string;
  agentId: string;
}

export interface FeatureFlaggedRouteResult {
  response: RuntimeResponse;
  agentId: string;
  conversationKey: string;
}

export interface FeatureFlaggedRouter {
  routeMessage(params: FeatureFlaggedRouteRequest): Promise<FeatureFlaggedRouteResult>;
  shutdown(): Promise<void>;
}

type ReasoningEffort = NonNullable<AgentRuntimeConfig["runtimePreferences"]["reasoningEffort"]>;

export function buildV2EnabledAgentSet(
  v2Configs: ReadonlyMap<string, V2AgentConfig>,
): Set<string> {
  return new Set(
    [...v2Configs.entries()]
      .filter(([, config]) => isV2RuntimeEnabled(config))
      .map(([agentId]) => agentId),
  );
}

export function buildV2RuntimeConfigs(
  v2Configs: ReadonlyMap<string, V2AgentConfig>,
  options: {
    repoRoot?: string;
  } = {},
): Map<string, AgentRuntimeConfig> {
  const runtimeConfigs = new Map<string, AgentRuntimeConfig>();

  for (const [agentId, v2Config] of v2Configs) {
    if (!isV2RuntimeEnabled(v2Config)) {
      continue;
    }

    runtimeConfigs.set(agentId, {
      agentId,
      systemPrompt: assembleV2SystemPrompt(v2Config, {
        repoRoot: options.repoRoot,
      }),
      mcpServers: v2Config.mcpServers,
      runtimePreferences: {
        model: v2Config.runtime.model,
        reasoningEffort: normalizeRuntimeReasoningEffort(v2Config.runtime.reasoningEffort),
        timeout: 120_000,
      },
    });
  }

  return runtimeConfigs;
}

export function createAtlasColdStartContextBuilder(
  atlasMemoryClient: Pick<AtlasMemoryClient, "pinnedFactGet" | "memorySearch">,
): ColdStartContextBuilder {
  return async (_conversationKey, agentId) => {
    const [pinnedFacts, agentFacts, relevantMemories] = await Promise.all([
      atlasMemoryClient.pinnedFactGet({ scope: "global" }),
      atlasMemoryClient.pinnedFactGet({ scope: "agent", scope_id: agentId }),
      atlasMemoryClient.memorySearch({
        query: "recent context",
        agent_id: agentId,
        limit: 5,
      }),
    ]);

    return {
      pinnedFacts: formatPinnedFacts([...pinnedFacts, ...agentFacts]),
      recentMessages: "",
      relevantMemories: formatMemories(relevantMemories),
    };
  };
}

export function createV2PostTurnHook(input: {
  v2Configs: ReadonlyMap<string, V2AgentConfig>;
  atlasMemoryClient: AtlasMemoryClient;
  extractAndStoreMemoriesImpl?: typeof extractAndStoreMemories;
}): (context: {
  conversationKey: string;
  agentId: string;
  userMessage: string;
  response: RuntimeResponse;
  channelId: string;
  threadId?: string;
}) => Promise<void> {
  return async (context) => {
    const agentV2Config = input.v2Configs.get(context.agentId);
    if (agentV2Config?.memory.postTurnExtraction !== "enabled") {
      return;
    }

    const captureConfig: MemoryCaptureConfig = {
      enabled: true,
      extractionModel: agentV2Config.memory.extractionModel,
      importanceThreshold: agentV2Config.memory.importanceThreshold,
    };
    const extractAndStore = input.extractAndStoreMemoriesImpl ?? extractAndStoreMemories;

    await extractAndStore(
      {
        conversationKey: context.conversationKey,
        agentId: context.agentId,
        userMessage: context.userMessage,
        agentResponse: context.response.text,
        channelId: context.channelId,
        ...(context.threadId ? { threadId: context.threadId } : {}),
      },
      captureConfig,
      input.atlasMemoryClient,
    );
  };
}

export async function routeV2MessageIfEnabled(
  params: FeatureFlaggedRouteRequest,
  input: {
    v2EnabledAgents: ReadonlySet<string>;
    tangoRouter: Pick<FeatureFlaggedRouter, "routeMessage">;
  },
): Promise<FeatureFlaggedRouteResult | null> {
  if (!input.v2EnabledAgents.has(params.agentId)) {
    return null;
  }

  return await input.tangoRouter.routeMessage(params);
}

export async function shutdownV2Runtime(input: {
  tangoRouter: Pick<FeatureFlaggedRouter, "shutdown">;
  atlasMemoryClient: Pick<AtlasMemoryClient, "close">;
}): Promise<void> {
  try {
    await input.tangoRouter.shutdown();
  } finally {
    input.atlasMemoryClient.close();
  }
}

export function formatPinnedFacts(facts: readonly PinnedFactRecord[]): string {
  if (facts.length === 0) {
    return "";
  }

  return facts.map((fact) => `- ${fact.key}: ${fact.value}`).join("\n");
}

export function formatMemories(memories: readonly MemoryRecord[]): string {
  if (memories.length === 0) {
    return "";
  }

  return memories
    .map((memory) => {
      const tags = memory.tags.length > 0 ? ` [${memory.tags.join(", ")}]` : "";
      return `- ${memory.content}${tags}`;
    })
    .join("\n");
}

function normalizeRuntimeReasoningEffort(
  value: V2AgentConfig["runtime"]["reasoningEffort"],
): ReasoningEffort {
  return value === "xhigh" ? "max" : value;
}
