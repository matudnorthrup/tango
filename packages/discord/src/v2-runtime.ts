import type {
  AgentRuntimeConfig,
  AttachmentStore,
  ChatProvider,
  ColdStartContextBuilder,
  RuntimeResponse,
  SendOptions,
  V2AgentConfig,
} from "@tango/core";
import {
  assembleV2SystemPrompt,
  buildAttachmentDirectoryContext,
  isV2RuntimeEnabled,
  resolveTangoProfileAgentPromptDirs,
  resolveV2MemoryScope,
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
  sendOptions?: SendOptions;
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

const DEFAULT_V2_RUNTIME_TIMEOUT_MS = 900_000;

function splitMcpServersForMountPolicy(
  config: V2AgentConfig,
  servers: AgentRuntimeConfig["mcpServers"],
): {
  defaultServers: AgentRuntimeConfig["mcpServers"];
  availableServers?: AgentRuntimeConfig["mcpServers"];
} {
  if (!config.mcp?.defaultServers && !config.mcp?.availableServers) {
    return { defaultServers: servers };
  }

  const serversByName = new Map(servers.map((server) => [server.name, server]));
  const defaultNames = new Set(config.mcp.defaultServers ?? []);
  const availableNames = new Set(
    config.mcp.availableServers
      ?? servers
        .map((server) => server.name)
        .filter((name) => !defaultNames.has(name)),
  );

  const defaultServers = [...defaultNames]
    .map((name) => serversByName.get(name))
    .filter((server): server is AgentRuntimeConfig["mcpServers"][number] => Boolean(server));
  const availableServers = [...availableNames]
    .filter((name) => !defaultNames.has(name))
    .map((name) => serversByName.get(name))
    .filter((server): server is AgentRuntimeConfig["mcpServers"][number] => Boolean(server));

  return {
    defaultServers,
    ...(availableServers.length > 0 ? { availableServers } : {}),
  };
}

/**
 * True when an agent's turns are served by the Ollama runtime adapter rather
 * than the Claude Code CLI, derived from its (legacy) provider intent. This is
 * the single source of truth for the backend decision; both
 * {@link buildV2RuntimeConfigs} and the warm-start continuity resolver in
 * main.ts consult it so the two never drift.
 */
export function isOllamaBackedAgent(v2Config: V2AgentConfig | undefined): boolean {
  return v2Config?.legacyProvider?.default === "ollama";
}

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

    const memoryScope = resolveV2MemoryScope(agentId, v2Config);
    const mcpServers = v2Config.mcpServers.map((server) => ({
      ...server,
      env: {
        ...(server.env ?? {}),
        WORKER_ID: agentId,
        TANGO_MEMORY_CANONICAL_AGENT_ID: memoryScope.canonicalAgentId,
        TANGO_MEMORY_ALIAS_AGENT_IDS: memoryScope.aliasAgentIds.join(","),
      },
    }));
    const mcpMounts = splitMcpServersForMountPolicy(v2Config, mcpServers);
    runtimeConfigs.set(agentId, {
      agentId,
      systemPrompt: assembleV2SystemPrompt(v2Config, {
        repoRoot: options.repoRoot,
        // Parity with the legacy loader: load per-agent profile-owned prompt
        // overlays (~/.tango/profiles/<p>/prompts/agents/<id>/*.md). Ollama
        // clones also inherit their base persona's overlay before any
        // clone-specific overlay, so private/user-specific knowledge can live in
        // one profile location without being copied into repo defaults.
        overlayDirs: resolveTangoProfileAgentPromptDirs(agentId),
      }),
      mcpServers: mcpMounts.defaultServers,
      ...(mcpMounts.availableServers ? { availableMcpServers: mcpMounts.availableServers } : {}),
      runtimePreferences: {
        model: v2Config.runtime.model,
        reasoningEffort: normalizeRuntimeReasoningEffort(v2Config.runtime.reasoningEffort),
        timeout: resolveV2RuntimeTimeoutMs(v2Config, DEFAULT_V2_RUNTIME_TIMEOUT_MS),
      },
      // Route this agent's turns through the Ollama runtime adapter when its
      // (legacy) provider intent is "ollama"; otherwise use the Claude Code CLI.
      backend: isOllamaBackedAgent(v2Config) ? "ollama" : "claude-code",
    });
  }

  return runtimeConfigs;
}

export function resolveV2RuntimeTimeoutMs(
  config: V2AgentConfig,
  defaultTimeoutMs: number,
): number {
  return config.runtime.timeoutSeconds ? config.runtime.timeoutSeconds * 1000 : defaultTimeoutMs;
}

export function createAtlasColdStartContextBuilder(
  atlasMemoryClient: Pick<AtlasMemoryClient, "pinnedFactGet" | "memorySearch">,
  options: {
    /**
     * Project-arc reseed: given the conversationKey, returns the project state
     * block (status / quick read / open items) so a rotated session re-orients
     * on where the project stands. See project-state.ts.
     */
    projectStateProvider?: (conversationKey: string) => string | undefined;
    attachmentStore?: AttachmentStore;
    v2Configs?: ReadonlyMap<string, V2AgentConfig>;
  } = {},
): ColdStartContextBuilder {
  return async (conversationKey, agentId) => {
    const memoryScope = resolveV2MemoryScope(agentId, options.v2Configs?.get(agentId));
    const [pinnedFacts, agentFactGroups, relevantMemories] = await Promise.all([
      atlasMemoryClient.pinnedFactGet({ scope: "global" }),
      Promise.all(
        memoryScope.aliasAgentIds.map((memoryAgentId) =>
          atlasMemoryClient.pinnedFactGet({ scope: "agent", scope_id: memoryAgentId }),
        ),
      ),
      atlasMemoryClient.memorySearch({
        query: "recent context",
        agent_id: memoryScope.canonicalAgentId,
        agent_ids: memoryScope.aliasAgentIds,
        limit: 5,
      }),
    ]);
    const agentFacts = agentFactGroups.flat();
    const attachmentContext =
      options.attachmentStore
        ? buildAttachmentDirectoryContext({
            store: options.attachmentStore,
            conversationKey,
            agentId,
          })
        : null;

    const projectBlock = options.projectStateProvider?.(conversationKey);

    return {
      pinnedFacts: formatPinnedFacts([...pinnedFacts, ...agentFacts]),
      recentMessages: projectBlock ? `Project state:\n${projectBlock}` : "",
      relevantMemories: formatMemories(relevantMemories),
      ...(attachmentContext?.prompt ? { attachmentDirectories: attachmentContext.prompt } : {}),
    };
  };
}

export function createV2PostTurnHook(input: {
  v2Configs: ReadonlyMap<string, V2AgentConfig>;
  atlasMemoryClient: AtlasMemoryClient;
  /** Resolves a registered ChatProvider by name (e.g. "ollama", "claude-oauth"). */
  resolveProvider: (name: string) => ChatProvider | undefined;
  /**
   * Channels whose turns must never write Atlas memories (the -test smoke
   * channels: their context is deliberately isolated from the agents' real
   * memory scope). MEMORY extraction only — ACTIVE-TASK extraction is
   * scheduled separately via scheduleActiveTaskPostTurn and must keep running
   * in these channels (the live continuation smokes assert on it, TGO-743).
   */
  extractionSuppressedChannelIds?: ReadonlySet<string>;
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
    if (input.extractionSuppressedChannelIds?.has(context.channelId)) {
      return;
    }
    const agentV2Config = input.v2Configs.get(context.agentId);
    if (agentV2Config?.memory.postTurnExtraction !== "enabled") {
      return;
    }
    const memoryScope = resolveV2MemoryScope(context.agentId, agentV2Config);

    // Resolve the extraction provider. Explicit config wins; otherwise derive from
    // the agent backend so Ollama clones extract via the (cheap, off-Claude) Ollama
    // provider rather than billing the Claude CLI on every turn.
    const extractionProvider =
      agentV2Config.memory.extractionProvider ??
      (isOllamaBackedAgent(agentV2Config) ? "ollama" : "claude-oauth");
    const provider = input.resolveProvider(extractionProvider);
    if (!provider) {
      console.warn(
        `[memory-capture] no provider '${extractionProvider}' registered for agent ${context.agentId}; skipping post-turn extraction`,
      );
      return;
    }

    const captureConfig: MemoryCaptureConfig = {
      enabled: true,
      extractionProvider,
      extractionModel: agentV2Config.memory.extractionModel,
      importanceThreshold: agentV2Config.memory.importanceThreshold,
    };
    const extractAndStore = input.extractAndStoreMemoriesImpl ?? extractAndStoreMemories;

    await extractAndStore(
      {
        conversationKey: context.conversationKey,
        agentId: memoryScope.canonicalAgentId,
        runtimeAgentId: context.agentId,
        userMessage: context.userMessage,
        agentResponse: context.response.text,
        channelId: context.channelId,
        ...(context.threadId ? { threadId: context.threadId } : {}),
      },
      captureConfig,
      input.atlasMemoryClient,
      provider,
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

  return await input.tangoRouter.routeMessage({
    message: params.message,
    channelId: params.channelId,
    ...(params.threadId ? { threadId: params.threadId } : {}),
    agentId: params.agentId,
    sendOptions: params.sendOptions,
  });
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
