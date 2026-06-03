import {
  AttachmentBuilder,
  ChatInputCommandInteraction,
  Client,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  SlashCommandBuilder,
  MessageReferenceType,
  MessageType,
  type Message,
  type RESTPostAPIApplicationCommandsJSONBody
} from "discord.js";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fork, execFileSync, execSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { request as httpRequest, createServer as createHttpServer } from "node:http";
import {
  AgentRegistry,
  type AgentRuntimeConfig,
  assembleSessionMemoryPrompt,
  buildDeterministicConversationMemory,
  buildDeterministicConversationSummary,
  auditPromptSnapshotsWithProvider,
  collectPromptSnapshotAuditSamples,
  cleanupExpiredClaudeArtifacts,
  createVoyageEmbeddingProviderFromEnv,
  emptyToolTelemetry,
  type AgentConfig,
  buildContextPacket,
  type ContextPacket,
  type ChatProvider,
  type EmbeddingProvider,
  type DeadLetterInsertInput,
  estimateConversationImportance,
  estimateTokenCount,
  extractExecutionTrace,
  extractMemoryKeywords,
  extractToolTelemetry,
  DEFAULT_PROVIDER_TIMEOUT_MS,
  formatExecutionTraceForLog,
  indexObsidianVault,
  type ModelRunRecord,
  type MessageInsertInput,
  type ModelRunInsertInput,
  type OrchestratorContinuityMode,
  type PromptSnapshotInsertInput,
  type ProviderReasoningEffort,
  type ProviderSessionRecord,
  resolveSessionMemoryConfig,
  type SessionMemoryPromptTrace,
  type TopicRecord,
  createBuiltInProviderRegistry,
  resolveProviderCandidates,
  resolveAgentToolPolicy,
  serializeEmbedding,
  selectProviderByName,
  resolveProviderToolsForAgent,
  selectMemoriesToArchive,
  type SessionConfig,
  loadUnifiedAgentConfigs,
  loadMemoryEvalConfig,
  loadSessionConfigs,
  loadScheduleConfigs,
  renderMemoryEvalDiscordSummary,
  renderMemoryEvalMarkdownReport,
  buildRuntimePathEnv,
  buildCurrentTurnMetadataPrompt,
  buildTurnBriefingPrompt,
  resolveConfigDir,
  resolveConfiguredPath,
  resolveDatabasePath,
  loadLayeredV2AgentConfigs,
  renderContextPacket,
  planSessionCompaction,
  SessionManager,
  TangoStorage,
  SchedulerService,
  type ScheduleConfig,
  type SystemLogEntry,
  type V2ScheduledTurnExecuteFn,
  registerDeterministicHandler,
  registerPreCheckHandler,
  runMemoryEvalBenchmarks,
  assembleV2SystemPrompt,
  contactsSyncHandler,
  isV2RuntimeEnabled,
  type V2AgentConfig,
} from "@tango/core";
import { runAtlasScheduledReflections } from "./atlas-memory-reflection.js";
import { printerMonitorHandler } from "./printer-monitor.js";
import {
  createDailyNoteBootstrapHandler,
  createMorningFlowSentinelHandler,
} from "./morning-flow.js";
import { createDailyBriefAggregationHandler } from "./daily-brief-aggregator.js";
import { isChannelAllowed, parseAllowedChannels } from "./allowed-channels.js";
import { createActiveThreadsTracker } from "./active-threads-tracker.js";
import { z } from "zod";
import {
  buildDefaultAccessPolicy,
  evaluateAccess,
  extractConfiguredDiscordChannelIds,
  parseCsvIds,
  resolveAccessPolicy
} from "./access-control.js";
import {
  type ProviderRequestAttempt,
  type ProviderContinuityMap,
  type ProviderFailoverFailure,
  ProviderFailoverError,
  generateWithFailover
} from "./provider-failover.js";
import { applySessionProviderCommand, mergeProviderOrder } from "./session-provider-command.js";
import { applyThreadSessionRoute } from "./thread-route.js";
import {
  HttpVoiceBridge,
  ProjectDirectory,
  buildDefaultSessionKey,
  extractChannelIdFromSessionKey,
  buildProjectSessionId,
  parseProjectSessionId,
  buildTopicSessionId,
  formatCurrentTopicMessage,
  formatOpenedTopicMessage,
  normalizeTopicSlug,
  VoiceTargetDirectory,
  type VoiceCompletionInput,
  type VoiceCompletionResult,
  type VoiceTurnInput,
  type VoiceTurnResult,
  type VoiceInboxHandlers,
  type VoiceInboxResponse,
  type VoiceInboxChannel,
  type VoiceInboxMessage,
  type VoiceInboxAgentResponse,
  type VoiceInboxAgentGroup
} from "@tango/voice";
import { getSecret } from "./op-secret.js";
import {
  buildVoiceTurnResultFromReceipt,
  waitForVoiceTurnReceiptResolution
} from "./voice-turn-receipts.js";
import {
  createReplyPresenter,
  DeliveryError,
  resolveSpeakerAvatarPath,
  resolveSpeakerAvatarURL,
  resolveSpeakerDisplayName,
  type PresentedReplyResult,
} from "./reply-presentation.js";
import { resolveVoiceWatermarkTarget } from "./voice-watermarks.js";
import { IMessageListener, type IMessageInboundMessage } from "./imessage-listener.js";
import { parseNaturalTextRoute, type NaturalTextSystemCommand } from "./natural-routing.js";
import { resolveTargetAgent } from "./target-agent.js";
import { processAttachments, cleanupAttachments } from "./attachment-processor.js";
import {
  buildPromptWithReferent,
  buildReferentSystemMessage,
  shouldPreferReferentSession,
  type MessageReferent,
} from "./message-referents.js";
import { selectWarmStartMessages } from "./channel-surface-context.js";
import {
  buildReimbursementGapCandidates,
  buildMissingReceiptCandidates,
  collectLinkedReceiptTransactionIds,
  formatReimbursementGapCandidateDetails,
  formatReceiptCatalogCandidateDetails,
} from "./receipt-catalog-precheck.js";
import { resolveDefaultReceiptRoot } from "./receipt-paths.js";
import {
  applySlotNickname,
  initializeSlotMode,
  isSlotModeActive,
  resetBotNickname,
  shouldInitializeSlotMode,
} from "./slot-mode.js";
import { isSmokeTestThreadWebhookMessage } from "./smoke-test-webhook.js";
import { AtlasMemoryClient } from "./atlas-memory-client.js";
import { TangoRouter } from "./tango-router.js";
import {
  buildV2EnabledAgentSet,
  buildV2RuntimeConfigs,
  createAtlasColdStartContextBuilder,
  createV2PostTurnHook,
  formatMemories,
  formatPinnedFacts,
  resolveV2RuntimeTimeoutMs,
  routeV2MessageIfEnabled,
  shutdownV2Runtime,
} from "./v2-runtime.js";
import {
  buildStateFilePointer,
  conversationKeyFor,
  refreshProjectHeadOnTurn,
  renderProjectStateBlock,
  resolveStateVaultRoot,
} from "./project-state.js";
import {
  buildVoiceRouterErrorResult,
  buildVoiceRouterResult,
  dispatchVoiceTurnByRuntime,
  VOICE_RESPONSE_FORMATTING_SYSTEM_PROMPT,
  VOICE_V2_TTS_ERROR_MESSAGE,
} from "./voice-turn-runtime-routing.js";
import {
  isVictorManualConsoleBridgeActive,
  sendToVictorInbox,
  waitForVictorResponse,
  type VictorBridgeMessage,
} from "./victor-bridge.js";

export * from "./tango-router.js";

dotenv.config();

const slotModeActive = isSlotModeActive(process.env);
let allowedChannels = parseAllowedChannels(process.env.DISCORD_ALLOWED_CHANNELS);
const shouldProvisionSlotMode = shouldInitializeSlotMode(process.env, allowedChannels);
if (shouldProvisionSlotMode) {
  allowedChannels = new Set();
}

type ResponseMode = "concise" | "explain";

interface WarmStartContextDiagnostics {
  strategy: "session-memory-prompt" | "context-packet" | "none";
  orchestratorContinuityMode: OrchestratorContinuityMode;
  channelSurfaceSupplementalMessages?: number;
  error?: string;
  memoryPrompt?: {
    estimatedTokens: number;
    usedFullHistory: boolean;
    trace: SessionMemoryPromptTrace;
  };
  contextPacket?: ContextPacket;
}

interface WarmStartContextResult {
  prompt?: string;
  diagnostics: WarmStartContextDiagnostics;
}

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_TEST_GUILD_ID: z
    .string()
    .optional()
    .transform((value) => {
      const normalized = value?.trim();
      return normalized && normalized.length > 0 ? normalized : undefined;
    }),
  DISCORD_COMMAND_GUILD_ID: z
    .string()
    .optional()
    .transform((value) => {
      const normalized = value?.trim();
      return normalized && normalized.length > 0 ? normalized : undefined;
    }),
  DISCORD_LISTEN_ONLY: z.string().default("true"),
  DISCORD_ENABLE_MESSAGE_CONTENT: z.string().default("false"),
  CLAUDE_CLI_COMMAND: z.string().default("claude"),
  CLAUDE_SECONDARY_CLI_COMMAND: z
    .string()
    .optional()
    .transform((value) => {
      const normalized = value?.trim();
      return normalized && normalized.length > 0 ? normalized : undefined;
    }),
  CLAUDE_HARNESS_COMMAND: z.string().default("claude"),
  CODEX_CLI_COMMAND: z.string().default("codex"),
  CLAUDE_MODEL: z
    .string()
    .optional()
    .transform((value) => {
      const normalized = value?.trim();
      return normalized && normalized.length > 0 ? normalized : "claude-sonnet-4-6";
    }),
  CLAUDE_EFFORT: z.enum(["low", "medium", "high", "max", "xhigh"]).default("medium"),
  CLAUDE_SECONDARY_MODEL: z
    .string()
    .optional()
    .transform((value) => {
      const normalized = value?.trim();
      return normalized && normalized.length > 0 ? normalized : undefined;
    }),
  CLAUDE_SECONDARY_EFFORT: z.enum(["low", "medium", "high", "max", "xhigh"]).optional(),
  CLAUDE_HARNESS_MODEL: z
    .string()
    .optional()
    .transform((value) => {
      const normalized = value?.trim();
      return normalized && normalized.length > 0 ? normalized : undefined;
    }),
  CLAUDE_HARNESS_EFFORT: z.enum(["low", "medium", "high", "max", "xhigh"]).optional(),
  CODEX_MODEL: z
    .string()
    .optional()
    .transform((value) => {
      const normalized = value?.trim();
      return normalized && normalized.length > 0 ? normalized : "gpt-5.4";
    }),
  CODEX_REASONING_EFFORT: z.enum(["low", "medium", "high", "max", "xhigh"]).default("medium"),
  TANGO_PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  CLAUDE_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  CLAUDE_SECONDARY_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  CLAUDE_HARNESS_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  CODEX_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  CODEX_SANDBOX: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .default("read-only"),
  CODEX_APPROVAL_POLICY: z
    .enum(["untrusted", "on-failure", "on-request", "never"])
    .default("never"),
  TANGO_DB_PATH: z
    .string()
    .optional()
    .transform((value) => {
      const normalized = value?.trim();
      return normalized && normalized.length > 0 ? normalized : undefined;
    }),
  TANGO_CAPTURE_PROVIDER_RAW: z.string().default("false"),
  TANGO_PROVIDER_RETRY_LIMIT: z.coerce.number().int().min(0).max(3).default(1),
  TANGO_MEMORY_COMPACTION_TRIGGER_TURNS: z.coerce.number().int().min(8).max(200).default(24),
  TANGO_MEMORY_COMPACTION_RETAIN_RECENT_TURNS: z.coerce.number().int().min(2).max(100).default(8),
  TANGO_MEMORY_COMPACTION_SUMMARY_MAX_CHARS: z.coerce.number().int().min(400).max(4000).default(1800),
  TANGO_ACCESS_MODE: z.enum(["off", "allowlist", "mention", "both"]).default("allowlist"),
  TANGO_ALLOWLIST_CHANNEL_IDS: z.string().default(""),
  TANGO_ALLOWLIST_USER_IDS: z.string().default(""),
  TANGO_VOICE_BRIDGE_ENABLED: z.string().default("false"),
  TANGO_VOICE_BRIDGE_HOST: z.string().default("127.0.0.1"),
  TANGO_VOICE_BRIDGE_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  TANGO_VOICE_BRIDGE_PATH: z.string().default("/voice/turn"),
  TANGO_VOICE_BRIDGE_API_KEY: z
    .string()
    .optional()
    .transform((value) => {
      const normalized = value?.trim();
      return normalized && normalized.length > 0 ? normalized : undefined;
    }),
  TANGO_VOICE_DEFAULT_SESSION_ID: z
    .string()
    .optional()
    .transform((value) => {
      const normalized = value?.trim();
      return normalized && normalized.length > 0 ? normalized : undefined;
    }),
  TANGO_VOICE_DEFAULT_AGENT_ID: z
    .string()
    .optional()
    .transform((value) => {
      const normalized = value?.trim();
      return normalized && normalized.length > 0 ? normalized : undefined;
    }),
  TANGO_SCHEDULER_ALERTS_CHANNEL_ID: z
    .string()
    .optional()
    .transform((value) => {
      const normalized = value?.trim();
      return normalized && normalized.length > 0 ? normalized : undefined;
    }),
  TANGO_SCHEDULER_LOG_CHANNEL_ID: z
    .string()
    .optional()
    .transform((value) => {
      const normalized = value?.trim();
      return normalized && normalized.length > 0 ? normalized : undefined;
    }),
  IMESSAGE_ENABLED: z.string().default("false"),
  IMESSAGE_CLI_PATH: z.string().default("/opt/homebrew/bin/imsg"),
  IMESSAGE_CONTACTS_PATH: z
    .string()
    .optional()
    .transform((value) => {
      const normalized = value?.trim();
      return normalized && normalized.length > 0 ? normalized : undefined;
    }),
  IMESSAGE_DEFAULT_AGENT: z
    .string()
    .optional()
    .transform((value) => {
      const normalized = value?.trim();
      return normalized && normalized.length > 0 ? normalized : undefined;
    }),
  IMESSAGE_ALLOW_FROM: z.string().default(""),
  IMESSAGE_GROUP_POLICY: z.enum(["mention", "open", "disabled"]).default("mention"),
  IMESSAGE_TEXT_CHUNK_LIMIT: z.coerce.number().int().min(200).max(16000).default(4000),
  IMESSAGE_DISCORD_CHANNEL_ID: z
    .string()
    .optional()
    .transform((value) => {
      const normalized = value?.trim();
      return normalized && normalized.length > 0 ? normalized : undefined;
    })
});

const env = envSchema.parse(process.env);
const listenOnly = env.DISCORD_LISTEN_ONLY !== "false";
const enableMessageContent = env.DISCORD_ENABLE_MESSAGE_CONTENT === "true";
const captureProviderRaw = env.TANGO_CAPTURE_PROVIDER_RAW === "true";
const providerRetryLimit = env.TANGO_PROVIDER_RETRY_LIMIT;
const providerTimeoutMs = env.TANGO_PROVIDER_TIMEOUT_MS ?? DEFAULT_PROVIDER_TIMEOUT_MS;
const claudeTimeoutMs = env.CLAUDE_TIMEOUT_MS ?? providerTimeoutMs;
const claudeSecondaryTimeoutMs = env.CLAUDE_SECONDARY_TIMEOUT_MS ?? claudeTimeoutMs;
const claudeHarnessTimeoutMs = env.CLAUDE_HARNESS_TIMEOUT_MS ?? claudeTimeoutMs;
const codexTimeoutMs = env.CODEX_TIMEOUT_MS ?? providerTimeoutMs;
const claudeSecondaryEffort = env.CLAUDE_SECONDARY_EFFORT ?? env.CLAUDE_EFFORT;
const claudeHarnessEffort = env.CLAUDE_HARNESS_EFFORT ?? env.CLAUDE_EFFORT;
const maxProviderTimeoutMs = Math.max(
  claudeTimeoutMs,
  claudeSecondaryTimeoutMs,
  claudeHarnessTimeoutMs,
  codexTimeoutMs
);
const memoryCompactionTriggerTurns = env.TANGO_MEMORY_COMPACTION_TRIGGER_TURNS;
const memoryCompactionRetainRecentTurns = Math.min(
  env.TANGO_MEMORY_COMPACTION_RETAIN_RECENT_TURNS,
  Math.max(memoryCompactionTriggerTurns - 1, 1)
);
const memoryCompactionSummaryMaxChars = env.TANGO_MEMORY_COMPACTION_SUMMARY_MAX_CHARS;
const commandGuildId = env.DISCORD_COMMAND_GUILD_ID ?? env.DISCORD_TEST_GUILD_ID;
const defaultAccessMode = env.TANGO_ACCESS_MODE;
const voiceBridgeEnabled = env.TANGO_VOICE_BRIDGE_ENABLED === "true";
const voiceBridgeHost = env.TANGO_VOICE_BRIDGE_HOST;
const voiceBridgePort = env.TANGO_VOICE_BRIDGE_PORT;
const voiceBridgePath = env.TANGO_VOICE_BRIDGE_PATH;
const voiceBridgeApiKey = env.TANGO_VOICE_BRIDGE_API_KEY;
const voiceDefaultSessionId = env.TANGO_VOICE_DEFAULT_SESSION_ID;
const voiceDefaultAgentId = env.TANGO_VOICE_DEFAULT_AGENT_ID;
const imessageEnabled = env.IMESSAGE_ENABLED === "true";
const imessageCliPath = env.IMESSAGE_CLI_PATH;
const imessageContactsPath = env.IMESSAGE_CONTACTS_PATH;
const imessageDefaultAgent = env.IMESSAGE_DEFAULT_AGENT;
const imessageAllowFrom = parseCsvIds(env.IMESSAGE_ALLOW_FROM);
const imessageGroupPolicy = env.IMESSAGE_GROUP_POLICY;
const imessageTextChunkLimit = env.IMESSAGE_TEXT_CHUNK_LIMIT;
const imessageDiscordChannelId = env.IMESSAGE_DISCORD_CHANNEL_ID;

const configDir = resolveConfigDir();
const sessionConfigs = loadSessionConfigs(configDir);
const configuredDiscordChannelIds = extractConfiguredDiscordChannelIds(sessionConfigs);
const envAllowlistChannels = parseCsvIds(env.TANGO_ALLOWLIST_CHANNEL_IDS);
const envAllowlistUsers = parseCsvIds(env.TANGO_ALLOWLIST_USER_IDS);
const defaultAccessPolicy = buildDefaultAccessPolicy({
  mode: defaultAccessMode,
  allowlistChannelIds:
    envAllowlistChannels.length > 0 ? envAllowlistChannels : configuredDiscordChannelIds,
  allowlistUserIds: envAllowlistUsers
});
const sessionManager = new SessionManager(sessionConfigs);
const sessionConfigById = new Map(sessionConfigs.map((session) => [session.id, session]));
const agentConfigs = loadUnifiedAgentConfigs(configDir);
const dbPath = resolveDatabasePath(env.TANGO_DB_PATH);
const voiceV2AgentRuntimeConfigs = loadEnabledVoiceV2AgentRuntimeConfigs({
  dbPath,
  configDir,
  timeoutMs: maxProviderTimeoutMs,
});
const voiceTangoRouter = voiceV2AgentRuntimeConfigs.size > 0
  ? new TangoRouter({
      agentConfigs: new Map(
        [...voiceV2AgentRuntimeConfigs.entries()].map(([agentId, entry]) => [
          agentId,
          entry.runtimeConfig,
        ]),
      ),
    })
  : null;
const scheduleConfigs = loadScheduleConfigs(configDir);
const memoryEvalConfig = loadMemoryEvalConfig(configDir);
const agentRegistry = new AgentRegistry(agentConfigs);
const voiceTargets = new VoiceTargetDirectory(configDir);
const projectDirectory = new ProjectDirectory(configDir);
const systemAgent = agentRegistry.get("dispatch") ?? null;
const systemDisplayName = systemAgent?.displayName?.trim() || "Tango";
const smokeTestChannelIds = new Set(
  agentConfigs
    .map((agent) => agent.voice?.smokeTestChannelId?.trim())
    .filter((channelId): channelId is string => Boolean(channelId))
);
const slotModeAgentTestChannels = agentConfigs
  .filter((agent) => agent.voice?.smokeTestChannelId)
  .map((agent) => ({
    agentId: agent.id,
    channelId: agent.voice?.smokeTestChannelId ?? "",
  }));
const agentAccessOverrideCount = agentConfigs.filter((agent) => agent.access !== undefined).length;
const storage = new TangoStorage(dbPath);
// Manual enablement: flip config/v2/agents/<agent>.yaml runtime.provider to
// "claude-code-v2" and restart the bot. Keep committed configs on "legacy".
const v2Configs = loadLayeredV2AgentConfigs(configDir);
const v2EnabledAgents = buildV2EnabledAgentSet(v2Configs);
const atlasMemoryClient = new AtlasMemoryClient();
const tangoRouter = new TangoRouter({
  agentConfigs: buildV2RuntimeConfigs(v2Configs),
  lifecycleConfig: {
    idleTimeoutHours: 24,
    contextResetThreshold: 0.80,
  },
  buildColdStartContext: createAtlasColdStartContextBuilder(atlasMemoryClient, {
    projectStateProvider: (conversationKey) =>
      renderProjectStateBlock(storage, conversationKey, { vaultRoot: resolveStateVaultRoot() }),
  }),
  onPostTurn: createV2PostTurnHook({
    v2Configs,
    atlasMemoryClient,
  }),
});
let embeddingProvider: EmbeddingProvider | null | undefined;

function getEmbeddingProvider(): EmbeddingProvider | null {
  if (embeddingProvider !== undefined) {
    return embeddingProvider;
  }

  embeddingProvider = createVoyageEmbeddingProviderFromEnv();
  return embeddingProvider;
}
storage.bootstrapSessions(sessionConfigs);

const providers = createBuiltInProviderRegistry({
  claudeOauth: {
    command: env.CLAUDE_CLI_COMMAND,
    defaultModel: env.CLAUDE_MODEL,
    defaultReasoningEffort: env.CLAUDE_EFFORT,
    timeoutMs: claudeTimeoutMs
  },
  ...(env.CLAUDE_SECONDARY_CLI_COMMAND
    ? {
        claudeOauthSecondary: {
          command: env.CLAUDE_SECONDARY_CLI_COMMAND,
          defaultModel: env.CLAUDE_SECONDARY_MODEL ?? env.CLAUDE_MODEL,
          defaultReasoningEffort: claudeSecondaryEffort,
          timeoutMs: claudeSecondaryTimeoutMs
        }
      }
    : {}),
  claudeHarness: {
    command: env.CLAUDE_HARNESS_COMMAND,
    defaultModel: env.CLAUDE_HARNESS_MODEL ?? env.CLAUDE_MODEL,
    defaultReasoningEffort: claudeHarnessEffort,
    timeoutMs: claudeHarnessTimeoutMs
  },
  codex: {
    command: env.CODEX_CLI_COMMAND,
    defaultModel: env.CODEX_MODEL,
    defaultReasoningEffort: env.CODEX_REASONING_EFFORT,
    timeoutMs: codexTimeoutMs,
    sandbox: env.CODEX_SANDBOX,
    approvalPolicy: env.CODEX_APPROVAL_POLICY,
    skipGitRepoCheck: true
  }
});

const providerSessionByConversation = new Map<string, string>();
const channelQueues = new Map<string, Promise<void>>();
const focusedTextAgentByChannel = new Map<string, string>();

function resolveMemoryEvalAuditProvider(): ChatProvider {
  for (const providerName of ["claude-oauth", "claude-oauth-secondary", "claude-harness"]) {
    const provider = providers.get(providerName);
    if (provider) return provider;
  }

  const fallback = providers.values().next().value;
  if (fallback) return fallback;
  throw new Error("No provider available for memory-eval audit.");
}

function writeMemoryEvalReport(markdown: string, now: Date = new Date()): string {
  const reportsDir = path.resolve("data", "reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  const filename = `memory-eval-${now.toISOString().slice(0, 10)}.md`;
  const fullPath = path.join(reportsDir, filename);
  fs.writeFileSync(fullPath, markdown, "utf8");
  return path.relative(process.cwd(), fullPath);
}

function normalizeRuntimeReasoningEffort(
  value: ProviderReasoningEffort,
): AgentRuntimeConfig["runtimePreferences"]["reasoningEffort"] {
  return value === "xhigh" ? "max" : value;
}

function loadEnabledVoiceV2AgentRuntimeConfigs(input: {
  dbPath: string;
  configDir: string;
  timeoutMs: number;
}): Map<string, { config: V2AgentConfig; runtimeConfig: AgentRuntimeConfig }> {
  const configs = new Map<string, { config: V2AgentConfig; runtimeConfig: AgentRuntimeConfig }>();
  for (const config of loadLayeredV2AgentConfigs(input.configDir).values()) {
    try {
      if (!isV2RuntimeEnabled(config)) {
        continue;
      }

      const systemPrompt = assembleV2SystemPrompt(config, { repoRoot: process.cwd() }).trim();
      if (systemPrompt.length === 0) {
        throw new Error(`System prompt for agent '${config.id}' is empty.`);
      }

      configs.set(config.id, {
        config,
        runtimeConfig: {
          agentId: config.id,
          systemPrompt,
          mcpServers: config.mcpServers.map((server) => ({
            name: server.name,
            command: server.command,
            ...(server.args ? { args: [...server.args] } : {}),
            env: {
              ...buildRuntimePathEnv({
                dbPath: input.dbPath,
                configDir: input.configDir,
              }),
              ...(server.env ?? {}),
            },
          })),
          runtimePreferences: {
            model: config.runtime.model,
            reasoningEffort: normalizeRuntimeReasoningEffort(config.runtime.reasoningEffort),
            timeout: resolveV2RuntimeTimeoutMs(config, input.timeoutMs),
          },
        },
      });
    } catch (error) {
      console.warn(
        `[tango-voice] failed to load v2 agent runtime config for ${config.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return configs;
}

// ---------------------------------------------------------------------------
// Deterministic scheduler handlers — registered before scheduler starts
// ---------------------------------------------------------------------------

registerDeterministicHandler("contacts-sync", contactsSyncHandler);
registerDeterministicHandler("printer-monitor", printerMonitorHandler);
registerDeterministicHandler("daily-brief-aggregate", createDailyBriefAggregationHandler());
registerDeterministicHandler("daily-note-bootstrap", createDailyNoteBootstrapHandler());
registerDeterministicHandler("morning-flow-sentinel", createMorningFlowSentinelHandler());

let cachedLunchMoneyApiKey: string | null = null;
const RECEIPT_CATALOG_MAX_CANDIDATES_PER_RUN = 3;

async function getLunchMoneyApiKey(): Promise<string> {
  if (!cachedLunchMoneyApiKey) {
    const envKey = process.env.LUNCH_MONEY_ACCESS_TOKEN;
    if (envKey) {
      cachedLunchMoneyApiKey = envKey;
    } else {
      const opKey = await getSecret("Watson", "Lunch Money API Key");
      if (!opKey) {
        throw new Error(
          "Lunch Money API key not found. Set LUNCH_MONEY_ACCESS_TOKEN in .env or add 'Lunch Money API Key' to Watson vault in 1Password.",
        );
      }
      cachedLunchMoneyApiKey = opKey;
    }
  }
  return cachedLunchMoneyApiKey;
}

function formatDateInTimeZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

registerPreCheckHandler("foxtrot-unreviewed-transactions", async () => {
  const timeZone = "America/Los_Angeles";
  const endDate = formatDateInTimeZone(new Date(), timeZone);
  const startDate = formatDateInTimeZone(new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), timeZone);
  const response = await fetch(
    `https://dev.lunchmoney.app/v1/transactions?status=uncleared&start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${await getLunchMoneyApiKey()}`,
        "Content-Type": "application/json",
      },
    },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Lunch Money pre-check failed: HTTP ${response.status}: ${text}`);
  }
  const parsed = JSON.parse(text) as { transactions?: Array<Record<string, unknown>> };
  const transactions = Array.isArray(parsed.transactions) ? parsed.transactions : [];
  const unreviewedCount = transactions.filter(
    (transaction) => String(transaction.status ?? "") === "uncleared",
  ).length;
  if (unreviewedCount === 0) {
    return {
      action: "skip" as const,
      reason: "No uncleared transactions in the last 48 hours.",
    };
  }
  return {
    action: "proceed" as const,
    context: {
      startDate,
      endDate,
      unreviewedCount,
    },
  };
});

registerPreCheckHandler("foxtrot-receipt-catalog-candidates", async () => {
  const timeZone = "America/Los_Angeles";
  const endDate = formatDateInTimeZone(new Date(), timeZone);
  const startDate = formatDateInTimeZone(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), timeZone);
  const receiptsRoot = resolveDefaultReceiptRoot();
  const response = await fetch(
    `https://dev.lunchmoney.app/v1/transactions?start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${await getLunchMoneyApiKey()}`,
        "Content-Type": "application/json",
      },
    },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Lunch Money receipt pre-check failed: HTTP ${response.status}: ${text}`);
  }

  const parsed = JSON.parse(text) as { transactions?: Array<Record<string, unknown>> };
  const transactions = Array.isArray(parsed.transactions) ? parsed.transactions : [];
  const linkedTransactionIds = collectLinkedReceiptTransactionIds(receiptsRoot);
  const retailerCandidates = buildMissingReceiptCandidates(transactions, linkedTransactionIds);
  const reimbursementGapCandidates = buildReimbursementGapCandidates({
    receiptsRoot,
    since: startDate,
    until: endDate,
  });

  if (retailerCandidates.length === 0 && reimbursementGapCandidates.length === 0) {
    return {
      action: "skip" as const,
      reason:
        "No recent receipt candidates or reimbursement tracking gaps for Amazon/Walmart/Costco/Venmo/Maid in Newport/Factor in the last 7 days.",
    };
  }

  return {
    action: "proceed" as const,
    context: {
      startDate,
      endDate,
      retailerCandidateCount: Math.min(
        retailerCandidates.length,
        RECEIPT_CATALOG_MAX_CANDIDATES_PER_RUN,
      ),
      totalRetailerCandidateCount: retailerCandidates.length,
      remainingRetailerCandidateCount: Math.max(
        retailerCandidates.length - RECEIPT_CATALOG_MAX_CANDIDATES_PER_RUN,
        0,
      ),
      candidateDetails: formatReceiptCatalogCandidateDetails(
        retailerCandidates.slice(0, RECEIPT_CATALOG_MAX_CANDIDATES_PER_RUN),
      ),
      reimbursementGapCandidateCount: reimbursementGapCandidates.length,
      reimbursementGapDetails: formatReimbursementGapCandidateDetails(
        reimbursementGapCandidates,
      ),
    },
  };
});

registerPreCheckHandler("foxtrot-sinking-fund-reconciliation-context", async (ctx) => {
  const timeZone = "America/Los_Angeles";
  const runDate = formatDateInTimeZone(new Date(), timeZone);
  const cadence =
    ctx.scheduleId === "sinking-fund-reconciliation-month-end"
      ? "month-end pre-close"
      : "weekly checkpoint";

  return {
    action: "proceed" as const,
    context: {
      runDate,
      cadence,
    },
  };
});

// ---------------------------------------------------------------------------
// Persistent MCP server — eliminates 60-90s cold start per worker task
// ---------------------------------------------------------------------------

const MCP_HTTP_PORT = 9100;
let persistentMcpPort: number | undefined;
let persistentMcpProcess: ChildProcess | null = null;

/** Post a system alert to the configured alerts channel (best-effort, no-throw). */
async function postSystemAlert(message: string): Promise<void> {
  const channelId = env.TANGO_SCHEDULER_ALERTS_CHANNEL_ID;
  if (!channelId || !client.isReady()) return;
  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return;
    const speaker = agentRegistry.get("dispatch") ?? null;
    await sendPresentedReply(channel as Message["channel"], message, speaker);
  } catch { /* best-effort */ }
}

function checkMcpServerHealth(port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref();
    const req = httpRequest(
      { hostname: "127.0.0.1", port, path: "/health", method: "GET" },
      (res) => {
        clearTimeout(timer);
        let data = "";
        res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
        res.on("end", () => {
          try {
            const body = JSON.parse(data);
            resolve(body.status === "ok");
          } catch {
            resolve(false);
          }
        });
      },
    );
    req.on("error", () => { clearTimeout(timer); resolve(false); });
    req.end();
  });
}

function killStaleMcpServer(port: number): void {
  try {
    const lsofOutput = execSync(`lsof -ti :${port} 2>/dev/null`, { encoding: "utf8" }).trim();
    if (!lsofOutput) return;
    for (const pidStr of lsofOutput.split("\n")) {
      const pid = parseInt(pidStr, 10);
      if (isNaN(pid) || pid === process.pid) continue;
      try {
        const cmd = execSync(`ps -p ${pid} -o command=`, { encoding: "utf8" }).trim();
        if (cmd.includes("mcp-wellness-server")) {
          console.error(`[tango] Killing stale MCP server on port ${port} (pid=${pid})`);
          process.kill(pid, "SIGTERM");
        }
      } catch { /* process already gone */ }
    }
  } catch { /* lsof found nothing or not available */ }
}

async function startPersistentMcpServer(): Promise<number | undefined> {
  killStaleMcpServer(MCP_HTTP_PORT);
  const mcpServerScript = path.resolve("packages/discord/dist/mcp-wellness-server.js");
  try {
    const child = fork(mcpServerScript, ["--http", `--port=${MCP_HTTP_PORT}`], {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      env: { ...process.env, CLAUDECODE: "", TANGO_DB_PATH: dbPath },
      // Detach so it doesn't block tango shutdown
      detached: false,
    });

    persistentMcpProcess = child;

    // Forward stderr to console for debugging
    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });

    // Wait for the server to signal readiness (via IPC) or timeout
    const ready = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        console.error("[tango] Persistent MCP server startup timed out (10s), falling back to per-worker spawn");
        resolve(false);
      }, 10_000);
      timer.unref();

      child.on("message", (msg: unknown) => {
        if (msg && typeof msg === "object" && (msg as Record<string, unknown>).type === "ready") {
          clearTimeout(timer);
          resolve(true);
        }
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        console.error("[tango] Persistent MCP server failed to start:", err.message);
        resolve(false);
      });

      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          console.error(`[tango] Persistent MCP server exited with code ${code}`);
          resolve(false);
        }
      });
    });

    if (ready) {
      // Verify with a health check
      const healthy = await checkMcpServerHealth(MCP_HTTP_PORT);
      if (healthy) {
        console.error(`[tango] Persistent MCP server ready on port ${MCP_HTTP_PORT}`);

        // Monitor for unexpected crashes — reset port so workers fall back to direct spawn
        child.on("exit", (code) => {
          console.error(`[tango] Persistent MCP server exited unexpectedly (code=${code}), workers will fall back to direct spawn`);
          persistentMcpPort = undefined;
          persistentMcpProcess = null;
          postSystemAlert(`**MCP server crashed** (exit code ${code}). Worker tools are unavailable until restart.`);
        });

        return MCP_HTTP_PORT;
      }
      console.error("[tango] Persistent MCP server health check failed, falling back to per-worker spawn");
    }

    // Cleanup failed process
    child.kill();
    persistentMcpProcess = null;
    // Alert after Discord client is ready (startup failures happen early)
    client.once("clientReady" as any, () => {
      postSystemAlert("**MCP server failed to start.** Worker tools may be slow or unavailable (falling back to per-worker spawn).");
    });
    return undefined;
  } catch (err) {
    console.error("[tango] Failed to start persistent MCP server:", err instanceof Error ? err.message : String(err));
    client.once("clientReady" as any, () => {
      postSystemAlert(`**MCP server failed to start:** ${err instanceof Error ? err.message : String(err)}`);
    });
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Scheduler handler registrations
// ---------------------------------------------------------------------------

registerDeterministicHandler("health-daily-reset", async (_ctx) => {
  // Lightweight daily reset: ensures the health data pipeline date boundary
  // is clean. Future: could clear cached aggregates, reset daily counters, etc.
  return { status: "ok", summary: "Health daily reset completed" };
});

registerDeterministicHandler("memory-reflect", async (_ctx) => {
  const result = await runAtlasScheduledReflections({
    lookbackHours: 48,
  });

  if (result.discoveredTargets === 0) {
    return {
      status: "skipped",
      summary: result.enabledAgentIds.length > 0
        ? `No Atlas reflection targets needed updates for ${result.enabledAgentIds.length} configured agent(s)`
        : "No Atlas reflection targets found",
      data: {
        enabledAgents: result.enabledAgentIds,
      },
    };
  }

  const errorNote =
    result.errors.length > 0 ? `, ${result.errors.length} target(s) failed` : "";

  if (result.totalMemoriesCreated === 0 && result.errors.length === 0) {
    return {
      status: "skipped",
      summary: `Atlas reflections were already up to date across ${result.processedTargets} session(s)`,
      data: {
        enabledAgents: result.enabledAgentIds,
        processed: result.processed,
      },
    };
  }

  return {
    status: result.totalMemoriesCreated > 0 ? "ok" : "error",
    summary: `Created ${result.totalMemoriesCreated} Atlas reflection memories across ${result.processedTargets} session(s)${errorNote}`,
    data: {
      enabledAgents: result.enabledAgentIds,
      processed: result.processed,
      errors: result.errors,
    },
  };
});

registerDeterministicHandler("memory-index-obsidian", async (_ctx) => {
  const result = await indexObsidianVault({
    storage,
    embeddingProvider: getEmbeddingProvider(),
  });

  if (result.indexedFileCount === 0 && result.removedFileCount === 0) {
    return {
      status: "skipped",
      summary: `No Obsidian memory index changes across ${result.scannedFileCount} scanned files`,
    };
  }

  return {
    status: "ok",
    summary:
      `Indexed ${result.indexedFileCount} Obsidian files, removed ${result.removedFileCount}, ` +
      `left ${result.unchangedFileCount} unchanged`,
    data: {
      scannedFileCount: result.scannedFileCount,
      indexedFileCount: result.indexedFileCount,
      unchangedFileCount: result.unchangedFileCount,
      removedFileCount: result.removedFileCount,
      insertedMemoryCount: result.insertedMemoryCount,
      deletedMemoryCount: result.deletedMemoryCount,
    },
  };
});

registerDeterministicHandler("vault-daily-check", async (_ctx) => {
  const rawResult = execFileSync(
    "npm",
    ["run", "-s", "vault:daily-check", "--", "--db-path", dbPath, "--json"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, TANGO_DB_PATH: dbPath },
      maxBuffer: 10 * 1024 * 1024,
    },
  ).trim();
  const result = JSON.parse(rawResult) as {
    summary?: string;
    reportPath?: string | null;
    cleanupPlanPath?: string | null;
    logPath?: string | null;
    firstRun?: boolean;
    counts?: Record<string, unknown>;
    cleanup?: Record<string, unknown> | null;
  };

  return {
    status: "ok",
    summary: result.summary ?? "Vault daily check completed",
    data: {
      reportPath: result.reportPath,
      cleanupPlanPath: result.cleanupPlanPath,
      logPath: result.logPath,
      firstRun: result.firstRun,
      counts: result.counts,
      cleanup: result.cleanup,
    },
  };
});

registerDeterministicHandler("memory-archive-stale", async (_ctx) => {
  const KEEP_LIMIT = 800;
  const sources = ["conversation", "obsidian", "backfill", "reflection"] as const;
  let totalArchived = 0;

  for (const source of sources) {
    const memories = storage.listMemories({ source, limit: KEEP_LIMIT * 4 });
    const archiveIds = selectMemoriesToArchive(memories, KEEP_LIMIT);
    for (const memoryId of archiveIds) {
      storage.archiveMemory(memoryId);
    }
    totalArchived += archiveIds.length;
  }

  if (totalArchived === 0) {
    return {
      status: "skipped",
      summary: "No stale memories to archive",
    };
  }

  return {
    status: "ok",
    summary: `Archived ${totalArchived} low-retention memories`,
    data: { archivedCount: totalArchived },
  };
});

registerDeterministicHandler("memory-eval-report", async (_ctx) => {
  const now = new Date();
  const benchmarkRun = await runMemoryEvalBenchmarks({
    storage,
    config: memoryEvalConfig,
    embeddingProvider: getEmbeddingProvider(),
    now,
  });
  const snapshotSamples = collectPromptSnapshotAuditSamples({
    storage,
    config: memoryEvalConfig,
    now,
  });

  let auditReview = null;
  try {
    if (snapshotSamples.length > 0) {
      auditReview = await auditPromptSnapshotsWithProvider({
        provider: resolveMemoryEvalAuditProvider(),
        criteria: memoryEvalConfig.criteria,
        samples: snapshotSamples,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    auditReview = {
      overallHealth: "mixed" as const,
      summary: "LLM snapshot audit failed; benchmark results are still valid.",
      wins: [],
      issues: [`LLM audit error: ${message}`],
      audits: [],
    };
  }

  const markdown = renderMemoryEvalMarkdownReport({
    generatedAt: now.toISOString(),
    config: memoryEvalConfig,
    benchmarkRun,
    snapshotSamples,
    auditReview,
  });
  const reportPath = writeMemoryEvalReport(markdown, now);

  return {
    status: "ok",
    summary: renderMemoryEvalDiscordSummary({
      generatedAt: now.toISOString(),
      benchmarkRun,
      snapshotSamples,
      auditReview,
      reportPath,
    }),
    data: {
      benchmarkPassedCount: benchmarkRun.passedCount,
      benchmarkFailedCount: benchmarkRun.failedCount,
      snapshotSampleCount: snapshotSamples.length,
      auditHealth: auditReview?.overallHealth ?? null,
      reportPath,
    },
  };
});

registerDeterministicHandler("claude-artifact-cleanup", async (_ctx) => {
  const result = cleanupExpiredClaudeArtifacts({
    storage,
    retentionHours: 72,
  });

  if (result.candidateCount === 0) {
    return {
      status: "skipped",
      summary: `No expired Tango-owned Claude artifacts found in ${result.projectDir}`,
      data: { ...result },
    };
  }

  const status = result.errors.length > 0 ? "error" : "ok";
  return {
    status,
    summary:
      `Processed ${result.candidateCount} expired Claude session artifact(s): ` +
      `deleted ${result.deletedSessionCount} sessions ` +
      `(${result.deletedJsonlCount} transcripts, ${result.deletedDirectoryCount} directories)` +
      (result.errors.length > 0 ? `, errors=${result.errors.length}` : ""),
    data: { ...result },
  };
});

// Start the persistent server, then initialize the scheduler
let scheduler: SchedulerService | null = null;

startPersistentMcpServer().then((port) => {
  persistentMcpPort = port;

  // Initialize and start the scheduler once MCP is ready
  if (scheduleConfigs.length > 0) {
    const executeV2TurnForScheduler: V2ScheduledTurnExecuteFn = async (input) => {
      const v2Entry = v2Configs.get(input.agentId);
      if (!v2Entry) {
        throw new Error(
          `Schedule '${input.config.id}' requests v2 runtime but agent '${input.agentId}' has no v2 config.`,
        );
      }

      const systemPrompt = assembleV2SystemPrompt(v2Entry, { repoRoot: process.cwd() }).trim();
      if (systemPrompt.length === 0) {
        throw new Error(`System prompt file for agent '${input.agentId}' is empty.`);
      }

      const runtimeConfig: AgentRuntimeConfig = {
        agentId: input.agentId,
        systemPrompt,
        mcpServers: v2Entry.mcpServers.map((server) => ({
          name: server.name,
          command: server.command,
          ...(server.args ? { args: [...server.args] } : {}),
          env: {
            ...buildRuntimePathEnv({ dbPath, configDir }),
            ...(server.env ?? {}),
          },
        })),
        runtimePreferences: {
          model: input.config.provider?.model ?? v2Entry.runtime.model,
          reasoningEffort: normalizeRuntimeReasoningEffort(
            input.config.provider?.reasoningEffort ?? v2Entry.runtime.reasoningEffort,
          ),
          timeout: (input.config.execution.timeoutSeconds ?? 300) * 1000,
        },
      };

      let coldStartContext = "";
      try {
        const [pinnedFacts, agentFacts, relevantMemories] = await Promise.all([
          atlasMemoryClient.pinnedFactGet({ scope: "global" }),
          atlasMemoryClient.pinnedFactGet({ scope: "agent", scope_id: input.agentId }),
          atlasMemoryClient.memorySearch({
            query: input.task.slice(0, 200),
            agent_id: input.agentId,
            limit: 5,
          }),
        ]);
        const facts = formatPinnedFacts([...pinnedFacts, ...agentFacts]);
        const memories = formatMemories(relevantMemories);
        if (facts) coldStartContext += `Pinned facts:\n${facts}\n\n`;
        if (memories) coldStartContext += `Relevant memories:\n${memories}\n\n`;
      } catch (err) {
        console.warn(`[scheduler-v2] cold-start context failed for ${input.config.id}:`, err);
      }
      runtimeConfig.coldStartContext = coldStartContext || undefined;

      const { ClaudeCodeAdapter } = await import("@tango/core");
      const adapter = new ClaudeCodeAdapter();
      await adapter.initialize(runtimeConfig);

      try {
        const response = await adapter.send(input.task);
        const runtimeMetadata = asRecord(response.metadata);
        const providerMetadata = asRecord(runtimeMetadata?.providerMetadata);
        const providerUsage = asRecord(providerMetadata?.usage);
        const providerSessionId = metadataString(runtimeMetadata, "sessionId") ?? null;
        const runtimeModel =
          response.model
          ?? metadataString(providerMetadata, "model")
          ?? runtimeConfig.runtimePreferences.model
          ?? "unknown";
        const toolsUsed = response.toolsUsed ?? [];
        const runtimeError = metadataBoolean(runtimeMetadata, "error") ?? false;
        const rawRuntimeResponse = asRecord(runtimeMetadata?.raw);
        const sessionId = buildScheduleExecutionSessionId(input.config.id, input.agentId);
        const conversationKey = `schedule-v2:${input.config.id}`;

        upsertSessionForRoute({ sessionId, agentId: input.agentId }, conversationKey);

        writeModelRun({
          sessionId,
          agentId: input.agentId,
          providerName: "claude-code-v2",
          conversationKey,
          providerSessionId,
          model: runtimeModel,
          stopReason: metadataString(providerMetadata, "stopReason") ?? null,
          responseMode: "scheduled-v2",
          latencyMs: response.durationMs,
          providerDurationMs: metadataNumber(providerMetadata, "durationMs") ?? response.durationMs,
          providerApiDurationMs: metadataNumber(providerMetadata, "durationApiMs") ?? null,
          inputTokens: metadataNumber(providerUsage, "inputTokens") ?? null,
          outputTokens: metadataNumber(providerUsage, "outputTokens") ?? null,
          cacheReadInputTokens: metadataNumber(providerUsage, "cacheReadInputTokens") ?? null,
          cacheCreationInputTokens: metadataNumber(providerUsage, "cacheCreationInputTokens") ?? null,
          totalCostUsd: metadataNumber(providerMetadata, "totalCostUsd") ?? null,
          isError: runtimeError,
          errorMessage:
            runtimeError
              ? metadataString(runtimeMetadata, "stderr") ?? "Claude Code runtime returned an error response."
              : null,
          metadata: {
            phase: "scheduled-v2",
            scheduleId: input.config.id,
            runtime: "v2",
            runtimeMode: "fresh",
            toolsUsed,
            runtimeExitCode: metadataNumber(runtimeMetadata, "exitCode") ?? null,
            runtimeSignal: metadataString(runtimeMetadata, "signal") ?? null,
            runtimeStderr: metadataString(runtimeMetadata, "stderr") ?? null,
            coldStartContextChars: runtimeConfig.coldStartContext?.length ?? 0,
          },
          rawResponse:
            captureProviderRaw && rawRuntimeResponse
              ? rawRuntimeResponse
              : null,
        });

        return {
          text: response.text,
          durationMs: response.durationMs,
          model: runtimeModel,
          metadata: {
            ...(response.metadata ?? {}),
            runtime: "v2",
            sessionId: providerSessionId,
          },
        };
      } finally {
        await adapter.teardown();
      }
    };

    // --- Scheduler delivery: post job output to agent channels ---
    // Also writes to the session DB so the agent has conversation history when
    // the user replies (e.g., correcting a transaction categorization).
    const deliverToChannel = async (channelId: string, agentId: string, content: string) => {
      if (!client.isReady()) return;
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel || !channel.isTextBased()) return;
      const speaker = agentRegistry.get(agentId) ?? null;
      const delivery = await sendPresentedReply(channel as Message["channel"], content, speaker);

      // Resolve session for this channel/thread and persist the message.
      // When the delivery target is a thread with a registered session, write
      // to that session so the message appears in the thread's warm-start
      // context when the user replies (thread sessions override the parent
      // channel session in handleMessage).
      let routingChannelId = channelId;
      const isThread = "isThread" in channel && typeof channel.isThread === "function" && (channel as { isThread: () => boolean }).isThread();
      if (isThread) {
        const parentId = (channel as { parentId?: string | null }).parentId;
        if (parentId) routingChannelId = parentId;
      }
      const channelKey = `discord:${routingChannelId}`;
      const route = sessionManager.route(channelKey) ?? sessionManager.route("discord:default");
      if (route) {
        let effectiveSessionId = route.sessionId;
        if (isThread && channelId !== routingChannelId) {
          const threadSession = storage.getThreadSession(channelId);
          if (threadSession) {
            effectiveSessionId = threadSession.sessionId;
          }
        }
        writeMessage({
          sessionId: effectiveSessionId,
          agentId,
          direction: "outbound",
          source: "tango",
          visibility: "public",
          discordMessageId: delivery.lastMessageId ?? null,
          discordChannelId: channelId,
          content,
          metadata: { scheduledDelivery: true },
        });
      }
    };

    // --- Scheduler alerts: post failure alerts to #system-alerts ---
    const defaultAlertsChannelId = env.TANGO_SCHEDULER_ALERTS_CHANNEL_ID;
    const sendAlert = defaultAlertsChannelId
      ? async (channelId: string, content: string) => {
          if (!client.isReady()) return;
          // Use the per-schedule alert channel if provided, otherwise fall back to default
          const targetChannelId = channelId || defaultAlertsChannelId;
          const channel = await client.channels.fetch(targetChannelId).catch(() => null);
          if (!channel || !channel.isTextBased()) return;
          const systemSpeaker = agentRegistry.get("dispatch") ?? null;
          await sendPresentedReply(channel as Message["channel"], content, systemSpeaker);
        }
      : undefined;

    // --- Scheduler system log: post one-liner for every run to #system-log ---
    const logChannelId = env.TANGO_SCHEDULER_LOG_CHANNEL_ID;
    const sendSystemLog = logChannelId
      ? async (entry: SystemLogEntry) => {
          if (!client.isReady()) return;
          const channel = await client.channels.fetch(logChannelId).catch(() => null);
          if (!channel || !channel.isTextBased()) return;

          const statusIcon = entry.status === "ok" ? "ok" : entry.status === "skipped" ? "skip" : "error";
          const name = entry.displayName ?? entry.scheduleId;
          const duration = entry.durationMs > 0 ? ` — ${(entry.durationMs / 1000).toFixed(1)}s` : "";
          const worker = entry.workerId ? ` — ${entry.workerId}` : "";
          const model = entry.modelUsed ? `/${entry.modelUsed}` : "";
          const detail = entry.status === "error"
            ? ` — ${entry.error?.slice(0, 200) ?? "unknown error"}`
            : entry.summary
              ? ` — ${entry.summary.slice(0, 200)}`
              : "";

          const line = `\`[${statusIcon}]\` **${name}**${duration}${worker}${model}${detail}`;

          // Post as system identity, no webhook overhead needed for log lines
          const systemSpeaker = agentRegistry.get("dispatch") ?? null;
          await sendPresentedReply(channel as Message["channel"], line, systemSpeaker);
        }
      : undefined;

    scheduler = new SchedulerService(scheduleConfigs, {
      db: storage.getDatabase(),
      executeV2Turn: executeV2TurnForScheduler,
      deliver: deliverToChannel,
      alert: sendAlert,
      systemLog: sendSystemLog,
    });
    scheduler.start();

    // Lightweight HTTP trigger endpoint for scheduler jobs
    // Usage: curl http://localhost:9200/trigger/slack-summary
    const triggerServer = createHttpServer(async (req, res) => {
      const match = req.url?.match(/^\/trigger\/([a-z0-9_-]+)$/);
      if (!match || req.method !== "GET") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Use GET /trigger/<schedule-id>" }));
        return;
      }
      const scheduleId = match[1]!;
      console.error(`[scheduler] HTTP trigger: ${scheduleId}`);
      try {
        const result = await scheduler!.trigger(scheduleId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result ?? { error: "schedule not found" }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    });
    triggerServer.on("error", (err) => {
      if ((err as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
        console.error("[scheduler] trigger endpoint disabled: port 9200 already in use");
        return;
      }
      console.error("[scheduler] trigger endpoint error", err);
    });
    triggerServer.listen(9200, "127.0.0.1", () => {
      console.error("[scheduler] trigger endpoint listening on http://127.0.0.1:9200/trigger/<id>");
    });
  }
}).catch((err) => {
  console.error("[tango] Persistent MCP server startup error:", err);
});

// Clean up MCP server on exit or signal
function cleanupMcpServer() {
  if (persistentMcpProcess && !persistentMcpProcess.killed) {
    persistentMcpProcess.kill();
    persistentMcpProcess = null;
  }
}
process.on("exit", cleanupMcpServer);
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(sig, () => {
    cleanupMcpServer();
    process.exit(0);
  });
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    ...(enableMessageContent ? [GatewayIntentBits.MessageContent] : [])
  ],
  partials: [Partials.Reaction]
});

registerDeterministicHandler("active-threads-tracker", createActiveThreadsTracker(client));

const replyPresenter = createReplyPresenter({
  systemDisplayName,
  logger: {
    warn(message: string): void {
      console.warn(message);
    }
  }
});

/**
 * Resolve the effective channel ID for routing and access control.
 * For forum/thread messages, Discord sets message.channelId to the thread ID,
 * but our session configs and allowlists reference the parent forum/text channel ID.
 * This helper resolves through to the parent when the message is in a thread.
 */
function resolveRoutingChannelId(message: Message): string {
  const channel = message.channel;
  if ("isThread" in channel && typeof channel.isThread === "function" && channel.isThread()) {
    const parentId = (channel as { parentId?: string | null }).parentId;
    if (parentId) return parentId;
  }
  return message.channelId;
}

function resolveVoiceWatermarkChannelId(
  channelId: string,
  parentId?: string | null,
): string | null {
  return resolveVoiceWatermarkTarget({
    channelId,
    parentId,
    lookup: {
      hasConfiguredChannel(candidateId: string): boolean {
        return voiceInboxChannelMap.has(candidateId);
      },
      hasTrackedThread(threadId: string): boolean {
        return storage.getThreadSession(threadId) !== null;
      },
    },
  });
}

function advanceResolvedVoiceWatermark(
  channelId: string,
  parentId: string | null | undefined,
  messageId: string,
  source: string,
): boolean {
  const targetChannelId = resolveVoiceWatermarkChannelId(channelId, parentId);
  if (!targetChannelId) return false;
  const advanced = advanceVoiceWatermarkById(targetChannelId, messageId, source);
  return advanced;
}

function advanceVoiceWatermarkById(
  channelId: string,
  messageId: string,
  source: string,
): boolean {
  const advanced = storage.advanceVoiceWatermark(channelId, messageId, source);
  if (advanced) {
    inboxCache = null;
  }
  return advanced;
}

async function backfillThreadSessionAgents(): Promise<void> {
  const missing = storage.listThreadSessionsMissingAgent();
  if (missing.length === 0) {
    console.log("[tango-discord] thread-agent-backfill missing=0 updated=0 unresolved=0");
    return;
  }

  let updated = 0;
  let unresolved = 0;

  for (const thread of missing) {
    try {
      const channel = await client.channels.fetch(thread.threadId).catch(() => null);
      let agentId: string | null = null;

      if (channel?.isThread()) {
        const parentId = channel.parentId?.trim();
        if (parentId) {
          const route = sessionManager.route(`discord:${parentId}`) ?? sessionManager.route("discord:default");
          agentId = route?.agentId?.trim() ?? null;
        }
      }

      if (!agentId) {
        agentId = storage.getSessionDefaultAgentId(thread.sessionId)?.trim() ?? null;
      }

      if (!agentId) {
        unresolved++;
        continue;
      }

      storage.setThreadSession(thread.threadId, thread.sessionId, agentId);
      updated++;
    } catch {
      unresolved++;
    }
  }

  console.log(`[tango-discord] thread-agent-backfill missing=${missing.length} updated=${updated} unresolved=${unresolved}`);
}

function toChannelKey(message: Message): string {
  const channelId = resolveRoutingChannelId(message);
  return `discord:${channelId}`;
}

function getFocusedTextAgentId(channelKey: string): string | null {
  const focusedAgentId = focusedTextAgentByChannel.get(channelKey)?.trim();
  if (!focusedAgentId) return null;
  if (!agentRegistry.get(focusedAgentId)) {
    focusedTextAgentByChannel.delete(channelKey);
    return null;
  }
  return focusedAgentId;
}

function setFocusedTextAgentId(channelKey: string, agentId: string | null): void {
  const normalized = agentId?.trim();
  if (!normalized) {
    focusedTextAgentByChannel.delete(channelKey);
    return;
  }
  focusedTextAgentByChannel.set(channelKey, normalized);
}

function getFocusedTextTopic(channelKey: string): TopicRecord | null {
  try {
    return storage.getFocusedTopicForChannel(channelKey);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[tango-storage] failed to resolve focused topic", message);
    return null;
  }
}

function getActiveTextTopic(
  channelKey: string,
  route?: { sessionId: string } | null,
): TopicRecord | null {
  const routedTopic = route?.sessionId
    ? resolveTopicRecordForSession(route.sessionId)
    : null;
  return routedTopic ?? getFocusedTextTopic(channelKey);
}

function setFocusedTextTopicId(channelKey: string, topicId: string | null): void {
  try {
    storage.setFocusedTopicForChannel(channelKey, topicId?.trim() || null);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[tango-storage] failed to persist focused topic", message);
  }
}

function getFocusedTextProjectId(channelKey: string): string | null {
  try {
    const projectId = storage.getFocusedProjectIdForChannel(channelKey)?.trim() || null;
    if (!projectId) return null;
    if (!projectDirectory.getProject(projectId)) {
      storage.setFocusedProjectForChannel(channelKey, null);
      return null;
    }
    return projectId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[tango-storage] failed to resolve focused project", message);
    return null;
  }
}

function setFocusedTextProjectId(channelKey: string, projectId: string | null): void {
  try {
    storage.setFocusedProjectForChannel(channelKey, projectId?.trim() || null);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[tango-storage] failed to persist focused project", message);
  }
}

function getFocusedTextProject(channelKey: string): ReturnType<ProjectDirectory["getProject"]> {
  return projectDirectory.getProject(getFocusedTextProjectId(channelKey));
}

function resolveProjectForRoute(
  route: { sessionId: string } | null | undefined
): ReturnType<ProjectDirectory["getProject"]> {
  return projectDirectory.getProject(parseProjectSessionId(route?.sessionId));
}

function resolveProjectForTopic(topic: TopicRecord | null): ReturnType<ProjectDirectory["getProject"]> {
  return projectDirectory.getProject(topic?.projectId);
}

function resolveActiveProject(
  channelKey: string,
  topic: TopicRecord | null,
  route?: { sessionId: string } | null
): ReturnType<ProjectDirectory["getProject"]> {
  if (topic) {
    return resolveProjectForTopic(topic);
  }
  return getFocusedTextProject(channelKey) ?? resolveProjectForRoute(route);
}

function resolveDefaultTopicLeadAgent(
  routeAgentId: string,
  channelKey: string,
  options?: { allowFocusedProject?: boolean }
): AgentConfig | null {
  const focusedAgentId = getFocusedTextAgentId(channelKey);
  if (focusedAgentId) {
    const focusedAgent = agentRegistry.get(focusedAgentId);
    if (focusedAgent) return focusedAgent;
  }

  const activeProject =
    options?.allowFocusedProject === false
      ? null
      : resolveActiveProject(channelKey, getFocusedTextTopic(channelKey));
  const projectDefaultAgentId = activeProject?.defaultAgentId?.trim();
  if (projectDefaultAgentId) {
    const projectDefaultAgent = agentRegistry.get(projectDefaultAgentId);
    if (projectDefaultAgent) return projectDefaultAgent;
  }

  const defaultPromptAgent = voiceTargets.resolveDefaultPromptAgent(routeAgentId);
  if (defaultPromptAgent) {
    const configuredAgent = agentRegistry.get(defaultPromptAgent.id);
    if (configuredAgent) return configuredAgent;
  }

  return agentRegistry.get(routeAgentId) ?? null;
}

function resolveContextualTargetAgent(input: {
  channelKey: string;
  routeSessionId: string;
  routeAgentId: string;
  explicitAgentId: string | null;
}): AgentConfig | null {
  const activeTopic = getActiveTextTopic(input.channelKey, {
    sessionId: input.routeSessionId,
  });
  const activeProject = resolveActiveProject(input.channelKey, activeTopic, {
    sessionId: input.routeSessionId
  });
  const topicLeadAgentId = activeTopic?.leadAgentId?.trim() || null;
  const projectDefaultAgentId = activeProject?.defaultAgentId?.trim() || null;

  return resolveTargetAgent(
    agentRegistry,
    input.routeAgentId,
    input.explicitAgentId ?? topicLeadAgentId ?? projectDefaultAgentId
  );
}

function upsertChannelTopic(
  channelKey: string,
  topicName: string,
  leadAgent: AgentConfig | null,
  projectId: string | null,
  preserveProjectId = true
): TopicRecord {
  const title = topicName.trim().replace(/\s+/g, " ");
  const slug = normalizeTopicSlug(title);
  if (!slug) {
    throw new Error("Topic name must include letters or numbers.");
  }

  return storage.upsertTopic({
    channelKey,
    slug,
    title,
    leadAgentId: leadAgent?.id ?? null,
    projectId: projectId ?? null,
    preserveProjectId
  });
}

function getChannelTopicByName(channelKey: string, topicName: string): TopicRecord | null {
  const slug = normalizeTopicSlug(topicName);
  if (!slug) return null;
  return storage.getTopicByChannelAndSlug(channelKey, slug);
}

function resolveActiveTextRoute(
  route: { sessionId: string; agentId: string },
  channelKey: string
): {
  sessionId: string;
  agentId: string;
  topic: TopicRecord | null;
  project: ReturnType<ProjectDirectory["getProject"]>;
} {
  const topic = getActiveTextTopic(channelKey, route);
  const project = resolveActiveProject(channelKey, topic, route);
  if (topic) {
    return {
      sessionId: buildTopicSessionId(topic.id),
      agentId: topic.leadAgentId ?? route.agentId,
      topic,
      project
    };
  }

  if (project) {
    return {
      sessionId: buildProjectSessionId(project.id),
      agentId: project.defaultAgentId ?? route.agentId,
      topic: null,
      project
    };
  }

  return {
    sessionId: route.sessionId,
    agentId: route.agentId,
    topic: null,
    project: null
  };
}

function resolvePromptTextRoute(input: {
  route: { sessionId: string; agentId: string };
  channelKey: string;
  targetAgent: AgentConfig;
  naturalRoute: ReturnType<typeof parseNaturalTextRoute> | null;
}): {
  sessionId: string;
  agentId: string;
  topic: TopicRecord | null;
  project: ReturnType<ProjectDirectory["getProject"]>;
} {
  const topicName = input.naturalRoute?.topicName?.trim();
  if (!topicName) {
    return resolveActiveTextRoute(input.route, input.channelKey);
  }

  const topic = upsertChannelTopic(
    input.channelKey,
    topicName,
    input.targetAgent,
    null,
    true
  );
  setFocusedTextTopicId(input.channelKey, topic.id);
  return {
    sessionId: buildTopicSessionId(topic.id),
    agentId: topic.leadAgentId ?? input.targetAgent.id,
    topic,
    project: resolveProjectForTopic(topic)
  };
}

function canRunAdminTextCommand(message: Message): boolean {
  return (
    message.member?.permissions.has(PermissionFlagsBits.Administrator) === true ||
    message.member?.permissions.has(PermissionFlagsBits.ManageGuild) === true
  );
}

async function handleNaturalTextSystemCommand(input: {
  message: Message;
  channelKey: string;
  route: { sessionId: string; agentId: string };
  command: NaturalTextSystemCommand;
}): Promise<void> {
  const { message, channelKey, route, command } = input;

  async function persistSystemReply(
    text: string,
    options?: {
      sessionId?: string;
      topic?: TopicRecord | null;
      project?: ReturnType<ProjectDirectory["getProject"]>;
      metadata?: Record<string, unknown>;
    }
  ): Promise<void> {
    const resolvedSessionId = options?.sessionId ?? resolveActiveTextRoute(route, channelKey).sessionId;
    writeMessage({
      sessionId: resolvedSessionId,
      agentId: systemAgent?.id ?? route.agentId,
      direction: "inbound",
      source: "discord",
      visibility: "public",
      discordMessageId: message.id,
      discordChannelId: message.channelId,
      discordUserId: message.author.id,
      discordUsername: message.author.username,
      content: message.content,
      metadata: {
        channelKey,
        localSystemCommand: true,
        commandType: command.type,
        topicId: options?.topic?.id ?? null,
        topicSlug: options?.topic?.slug ?? null,
        topicTitle: options?.topic?.title ?? null,
        projectId: options?.project?.id ?? null,
        projectTitle: options?.project?.displayName ?? null,
        ...options?.metadata
      }
    });

    const replyDelivery = await sendPresentedReply(message.channel, text, systemAgent);
    writeMessage({
      sessionId: resolvedSessionId,
      agentId: systemAgent?.id ?? route.agentId,
      direction: "system",
      source: "tango",
      visibility: "public",
      discordMessageId: replyDelivery.lastMessageId ?? null,
      discordChannelId: message.channelId,
      discordUserId: replyDelivery.delivery === "bot" ? client.user?.id ?? null : null,
      discordUsername: replyDelivery.actualDisplayName,
      content: text,
      metadata: {
        replyToDiscordMessageId: message.id,
        localSystemCommand: true,
        commandType: command.type,
        channelKey,
        topicId: options?.topic?.id ?? null,
        topicSlug: options?.topic?.slug ?? null,
        topicTitle: options?.topic?.title ?? null,
        projectId: options?.project?.id ?? null,
        projectTitle: options?.project?.displayName ?? null,
        senderIdentity: {
          intendedDisplayName: replyDelivery.intendedDisplayName,
          actualDisplayName: replyDelivery.actualDisplayName,
          delivery: replyDelivery.delivery
        },
        ...options?.metadata
      }
    });
  }

  switch (command.type) {
    case "status":
      if (!canRunAdminTextCommand(message)) {
        await persistSystemReply(
          "This command requires `Administrator` or `Manage Server` permission."
        );
        return;
      }
      await persistSystemReply(formatHealthStatus());
      return;
    case "focus-agent": {
      const agent = voiceTargets.resolveAgentQuery(command.agentQuery);
      if (!agent) {
        await persistSystemReply(`I couldn't find an agent named ${command.agentQuery}.`);
        return;
      }

      setFocusedTextAgentId(channelKey, agent.id);
      await persistSystemReply(`Focused on ${agent.displayName}. You can keep talking.`, {
        metadata: {
          focusedAgentId: agent.id
        }
      });
      return;
    }
    case "clear-focus": {
      const focusedAgent = voiceTargets.getAgent(getFocusedTextAgentId(channelKey));
      if (!focusedAgent) {
        await persistSystemReply("No agent focus is active right now.");
        return;
      }

      setFocusedTextAgentId(channelKey, null);
      await persistSystemReply(`Back to ${systemDisplayName}.`);
      return;
    }
    case "current-agent": {
      const focusedAgent = voiceTargets.getAgent(getFocusedTextAgentId(channelKey));
      if (focusedAgent) {
        await persistSystemReply(`You are focused on ${focusedAgent.displayName}.`, {
          metadata: {
            focusedAgentId: focusedAgent.id
          }
        });
      } else {
        await persistSystemReply(`No focused agent. Say ${systemDisplayName}, talk to an agent name.`);
      }
      return;
    }
    case "open-topic": {
      let topicProject: ReturnType<ProjectDirectory["getProject"]> = null;
      if (command.projectName) {
        topicProject = projectDirectory.resolveProjectQuery(command.projectName);
        if (!topicProject) {
          await persistSystemReply(`I couldn't find a project named ${command.projectName}.`);
          return;
        }
        setFocusedTextProjectId(channelKey, topicProject.id);
      }
      const leadAgent = topicProject?.defaultAgentId
        ? agentRegistry.get(topicProject.defaultAgentId) ?? resolveDefaultTopicLeadAgent(route.agentId, channelKey)
        : resolveDefaultTopicLeadAgent(route.agentId, channelKey, { allowFocusedProject: false });
      const topic = upsertChannelTopic(
        channelKey,
        command.topicName,
        leadAgent,
        topicProject?.id ?? null,
        false
      );
      setFocusedTextTopicId(channelKey, topic.id);
      const topicRoute = {
        sessionId: buildTopicSessionId(topic.id),
        agentId: topic.leadAgentId ?? route.agentId
      };
      upsertSessionForRoute(topicRoute, channelKey);
      const project = resolveProjectForTopic(topic);
      await persistSystemReply(formatOpenedTopicMessage(topic.title, project?.displayName), {
        sessionId: topicRoute.sessionId,
        topic,
        project,
        metadata: {
          leadAgentId: topic.leadAgentId,
          topicStandalone: project === null
        }
      });
      return;
    }
    case "move-topic-to-project": {
      const project = projectDirectory.resolveProjectQuery(command.projectName);
      if (!project) {
        await persistSystemReply(`I couldn't find a project named ${command.projectName}.`);
        return;
      }

      const existingTopic = command.topicName
        ? getChannelTopicByName(channelKey, command.topicName)
        : getFocusedTextTopic(channelKey);
      if (!existingTopic) {
        await persistSystemReply(
          command.topicName
            ? `I couldn't find a topic named ${command.topicName}.`
            : "No topic is active right now."
        );
        return;
      }

      setFocusedTextProjectId(channelKey, project.id);
      const leadAgent = existingTopic.leadAgentId
        ? agentRegistry.get(existingTopic.leadAgentId)
        : null;
      const resolvedLeadAgent = leadAgent
        ?? (project.defaultAgentId ? agentRegistry.get(project.defaultAgentId) : null)
        ?? resolveDefaultTopicLeadAgent(route.agentId, channelKey);
      const movedTopic = upsertChannelTopic(
        channelKey,
        existingTopic.title,
        resolvedLeadAgent,
        project.id,
        false
      );
      setFocusedTextTopicId(channelKey, movedTopic.id);
      const topicRoute = {
        sessionId: buildTopicSessionId(movedTopic.id),
        agentId: movedTopic.leadAgentId ?? route.agentId
      };
      upsertSessionForRoute(topicRoute, channelKey);
      await persistSystemReply(`Moved topic ${movedTopic.title} to project ${project.displayName}.`, {
        sessionId: topicRoute.sessionId,
        topic: movedTopic,
        project,
        metadata: {
          leadAgentId: movedTopic.leadAgentId,
          movedTopicId: movedTopic.id
        }
      });
      return;
    }
    case "detach-topic-from-project": {
      const existingTopic = command.topicName
        ? getChannelTopicByName(channelKey, command.topicName)
        : getFocusedTextTopic(channelKey);
      if (!existingTopic) {
        await persistSystemReply(
          command.topicName
            ? `I couldn't find a topic named ${command.topicName}.`
            : "No topic is active right now."
        );
        return;
      }

      const previousProject = resolveProjectForTopic(existingTopic);
      if (!previousProject && !existingTopic.projectId) {
        setFocusedTextTopicId(channelKey, existingTopic.id);
        await persistSystemReply(`Topic ${existingTopic.title} is already standalone.`, {
          sessionId: buildTopicSessionId(existingTopic.id),
          topic: existingTopic
        });
        return;
      }

      if (existingTopic.projectId) {
        setFocusedTextProjectId(channelKey, existingTopic.projectId);
      }
      const leadAgent = existingTopic.leadAgentId
        ? agentRegistry.get(existingTopic.leadAgentId)
        : null;
      const detachedTopic = upsertChannelTopic(
        channelKey,
        existingTopic.title,
        leadAgent ?? resolveDefaultTopicLeadAgent(route.agentId, channelKey, { allowFocusedProject: false }),
        null,
        false
      );
      setFocusedTextTopicId(channelKey, detachedTopic.id);
      const topicRoute = {
        sessionId: buildTopicSessionId(detachedTopic.id),
        agentId: detachedTopic.leadAgentId ?? route.agentId
      };
      upsertSessionForRoute(topicRoute, channelKey);
      await persistSystemReply(
        `Detached topic ${detachedTopic.title} from project ${previousProject?.displayName ?? existingTopic.projectId}. It is now standalone.`,
        {
          sessionId: topicRoute.sessionId,
          topic: detachedTopic,
          metadata: {
            detachedTopicId: detachedTopic.id,
            previousProjectId: existingTopic.projectId,
            previousProjectTitle: previousProject?.displayName ?? null
          }
        }
      );
      return;
    }
    case "current-topic": {
      const topic = getFocusedTextTopic(channelKey);
      if (topic) {
        await persistSystemReply(formatCurrentTopicMessage(topic.title, resolveProjectForTopic(topic)?.displayName), {
          sessionId: buildTopicSessionId(topic.id),
          topic,
          project: resolveProjectForTopic(topic)
        });
      } else {
        await persistSystemReply("No topic is active right now.");
      }
      return;
    }
    case "clear-topic": {
      const topic = getFocusedTextTopic(channelKey);
      if (!topic) {
        await persistSystemReply("No topic is active right now.");
        return;
      }

      setFocusedTextTopicId(channelKey, null);
      const project = resolveProjectForTopic(topic);
      const resumeProject = getFocusedTextProject(channelKey) ?? resolveProjectForRoute(route);
      const reply = resumeProject
        ? `Left ${project ? `topic ${topic.title}` : `standalone topic ${topic.title}`}. Project ${resumeProject.displayName} is still active.`
        : `Left ${project ? `topic ${topic.title}` : `standalone topic ${topic.title}`}.`;
      await persistSystemReply(reply, {
        sessionId: buildTopicSessionId(topic.id),
        topic,
        project
      });
      return;
    }
    case "open-project": {
      const project = projectDirectory.resolveProjectQuery(command.projectName);
      if (!project) {
        await persistSystemReply(`I couldn't find a project named ${command.projectName}.`);
        return;
      }

      const clearedTopic = getFocusedTextTopic(channelKey);
      setFocusedTextTopicId(channelKey, null);
      setFocusedTextProjectId(channelKey, project.id);
      const projectRoute = {
        sessionId: buildProjectSessionId(project.id),
        agentId: project.defaultAgentId ?? route.agentId
      };
      upsertSessionForRoute(projectRoute, channelKey);
      await persistSystemReply(
        clearedTopic
          ? `Opened project ${project.displayName}. Cleared topic ${clearedTopic.title}.`
          : `Opened project ${project.displayName}. You can keep talking.`,
        {
          sessionId: projectRoute.sessionId,
          project,
          metadata: {
            clearedTopicId: clearedTopic?.id ?? null,
            clearedTopicTitle: clearedTopic?.title ?? null
          }
        }
      );
      return;
    }
    case "current-project": {
      const topic = getFocusedTextTopic(channelKey);
      const topicProject = resolveProjectForTopic(topic);
      const focusedProject = getFocusedTextProject(channelKey);
      const routedProject = resolveProjectForRoute(route);
      const resumeProject = focusedProject ?? routedProject;
      const project = topic ? topicProject : resumeProject;
      if (!project) {
        if (topic && resumeProject) {
          await persistSystemReply(
            focusedProject
              ? `Current topic ${topic.title} is standalone. Focused project ${resumeProject.displayName} will resume when you leave this topic.`
              : `Current topic ${topic.title} is standalone. Project ${resumeProject.displayName} will resume when you leave this topic.`,
            {
              sessionId: buildTopicSessionId(topic.id),
              topic
            }
          );
        } else {
          await persistSystemReply("No project is active right now.");
        }
        return;
      }

      await persistSystemReply(`You are in project ${project.displayName}.`, {
        sessionId: topic ? buildTopicSessionId(topic.id) : buildProjectSessionId(project.id),
        topic,
        project
      });
      return;
    }
    case "clear-project": {
      const topic = getFocusedTextTopic(channelKey);
      const focusedProject = getFocusedTextProject(channelKey);
      const routedProject = resolveProjectForRoute(route);
      const topicProject = resolveProjectForTopic(topic);
      const activeProject = topicProject ?? focusedProject ?? routedProject;
      if (!activeProject) {
        await persistSystemReply("No project is active right now.");
        return;
      }

      if (!focusedProject && routedProject?.id === activeProject.id) {
        await persistSystemReply(
          topic
            ? `Channel is routed to project ${routedProject.displayName}. Clear the topic separately or open another project to override it.`
            : `Channel is routed to project ${routedProject.displayName}. Open another project to override it.`,
          {
            sessionId: topic ? buildTopicSessionId(topic.id) : buildProjectSessionId(routedProject.id),
            topic,
            project: routedProject
          }
        );
        return;
      }

      setFocusedTextProjectId(channelKey, null);
      let clearedTopic: TopicRecord | null = null;
      if (topic && topic.projectId === activeProject.id) {
        clearedTopic = topic;
        setFocusedTextTopicId(channelKey, null);
      }

      const resumedProject = routedProject && routedProject.id !== activeProject.id ? routedProject : null;
      await persistSystemReply(
        clearedTopic
          ? resumedProject
            ? `Left project ${activeProject.displayName}. Cleared topic ${clearedTopic.title}. Channel returned to project ${resumedProject.displayName}.`
            : `Left project ${activeProject.displayName}. Cleared topic ${clearedTopic.title}.`
          : topic
            ? resumedProject
              ? `Cleared focused project ${activeProject.displayName}. Current topic ${topic.title} remains ${topic.projectId ? "attached to that project until you move it" : "standalone"}. Channel returned to project ${resumedProject.displayName}.`
              : `Cleared focused project ${activeProject.displayName}. Current topic ${topic.title} remains ${topic.projectId ? "attached to that project until you move it" : "standalone"}.`
            : resumedProject
              ? `Left project ${activeProject.displayName}. Channel returned to project ${resumedProject.displayName}.`
              : `Left project ${activeProject.displayName}.`,
        {
          sessionId: clearedTopic ? buildTopicSessionId(clearedTopic.id) : buildProjectSessionId((resumedProject ?? activeProject).id),
          topic: clearedTopic,
          project: resumedProject ?? activeProject
        }
      );
      return;
    }
  }
}

function parseLeadingCommands(messageContent: string): {
  promptText: string;
  agentOverride: string | null;
  responseModeOverride: ResponseMode | null;
} {
  let remaining = messageContent.trim();
  let agentOverride: string | null = null;
  let responseModeOverride: ResponseMode | null = null;

  for (let i = 0; i < 6; i += 1) {
    const agentMatch = remaining.match(/^\/agent\s+([a-z0-9-]+)\s*/iu);
    if (agentMatch?.[0] && agentMatch[1]) {
      agentOverride = agentMatch[1];
      remaining = remaining.slice(agentMatch[0].length).trimStart();
      continue;
    }

    const modeMatch = remaining.match(/^\/(concise|explain)\s*/iu);
    if (modeMatch?.[0] && modeMatch[1]) {
      responseModeOverride = modeMatch[1].toLowerCase() as ResponseMode;
      remaining = remaining.slice(modeMatch[0].length).trimStart();
      continue;
    }

    break;
  }

  return {
    promptText: remaining,
    agentOverride,
    responseModeOverride
  };
}

/**
 * Extract forwarded message text from Discord message snapshots.
 * Forwarded messages have empty content — the original text lives in messageSnapshots.
 */
function extractForwardedContent(message: Message): string | null {
  if (message.reference?.type !== MessageReferenceType.Forward) return null;
  const snapshots = (message as unknown as { messageSnapshots?: Map<string, Message> }).messageSnapshots;
  if (!snapshots || typeof snapshots.values !== "function") return null;
  const parts: string[] = [];
  for (const snapshot of snapshots.values()) {
    if (snapshot.content?.trim()) {
      parts.push(snapshot.content.trim());
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

/**
 * Download text content from .txt file attachments (e.g. Discord's auto-converted long pastes).
 * Returns the inlined text, or null if no text attachments exist.
 */
async function downloadTextAttachments(message: Message): Promise<string | null> {
  const textAttachments = [...message.attachments.values()].filter(
    (a) => a.name?.endsWith(".txt") && a.size < 100_000
  );
  if (textAttachments.length === 0) return null;

  const results: string[] = [];
  for (const attachment of textAttachments) {
    try {
      const response = await fetch(attachment.url);
      if (!response.ok) continue;
      const text = await response.text();
      if (text.trim()) results.push(text.trim());
    } catch (err) {
      console.warn(`[tango-discord] failed to download text attachment ${attachment.name}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return results.length > 0 ? results.join("\n\n") : null;
}

/**
 * Resolve the effective text content of a Discord message, handling:
 * 1. Forwarded messages (content in messageSnapshots)
 * 2. Long pastes auto-converted to message.txt attachments
 * Falls back to message.content if neither edge case applies.
 */
async function resolveEffectiveContent(message: Message): Promise<string> {
  // Forwarded messages: content is in snapshots, not message.content
  const forwarded = extractForwardedContent(message);
  if (forwarded) {
    const prefix = message.content.trim();
    return prefix ? `${prefix}\n\n[Forwarded message]\n${forwarded}` : `[Forwarded message]\n${forwarded}`;
  }

  // Long paste → message.txt: Discord converts long text into a .txt attachment
  if (!message.content.trim() && message.attachments.size > 0) {
    const inlinedText = await downloadTextAttachments(message);
    if (inlinedText) return inlinedText;
  }

  return message.content;
}

function buildPrompt(text: string, message: Message): string {
  const normalized = text.trim();
  if (normalized.length > 0) return normalized;

  if (message.attachments.size === 0) return "";

  const attachmentList = [...message.attachments.values()]
    .map((attachment) => attachment.name ?? attachment.url)
    .join(", ");
  return `User sent ${message.attachments.size} attachment(s): ${attachmentList}`;
}

function normalizeMessageReferentText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function messageReferentContentMatches(candidateContent: string, targetContent: string): boolean {
  const normalizedCandidate = normalizeMessageReferentText(candidateContent);
  const normalizedTarget = normalizeMessageReferentText(targetContent);
  if (!normalizedCandidate || !normalizedTarget) return false;
  return (
    normalizedCandidate === normalizedTarget ||
    normalizedCandidate.includes(normalizedTarget) ||
    normalizedTarget.includes(normalizedCandidate)
  );
}

function findStoredMessageForDiscordTarget(input: {
  discordMessageId?: string | null;
  discordChannelId: string;
  fallbackContent?: string | null;
}) {
  const discordMessageId = input.discordMessageId?.trim() || null;
  if (discordMessageId) {
    const exact = storage.getMessageByDiscordMessageId(discordMessageId, {
      channelId: input.discordChannelId,
    });
    if (exact) return exact;
  }

  const fallbackContent = input.fallbackContent?.trim() || null;
  if (!fallbackContent) return null;

  const candidates = storage.listRecentMessagesForDiscordChannel(input.discordChannelId, 30);
  return (
    candidates.find(
      (candidate) =>
        candidate.visibility === "public" &&
        candidate.source === "tango" &&
        messageReferentContentMatches(candidate.content, fallbackContent)
    ) ?? null
  );
}

function resolveReplyReferent(message: Message): MessageReferent | null {
  const referencedMessageId = message.reference?.messageId?.trim();
  if (!referencedMessageId) return null;

  const stored = findStoredMessageForDiscordTarget({
    discordMessageId: referencedMessageId,
    discordChannelId: message.channelId,
  });
  if (!stored) return null;

  return {
    kind: "reply",
    targetMessageId: referencedMessageId,
    targetSessionId: stored.sessionId,
    targetAgentId: stored.agentId,
    targetContent: stored.content,
    metadata: {
      source: "stored-message",
      storedMessageId: stored.id,
    },
  };
}

function takeReactionReferent(message: Message): MessageReferent | null {
  const storedReferent = storage.getChannelReferent(message.channelId, message.author.id);
  if (!storedReferent) return null;
  storage.clearChannelReferent(message.channelId, message.author.id);
  return {
    kind: "reaction",
    targetMessageId: storedReferent.targetMessageId,
    targetSessionId: storedReferent.targetSessionId,
    targetAgentId: storedReferent.targetAgentId,
    targetContent: storedReferent.targetContent,
    metadata: storedReferent.metadata,
  };
}

function resolveSessionRouteFromSessionId(sessionId: string, agentId: string): {
  sessionId: string;
  agentId: string;
  topic: TopicRecord | null;
  project: ReturnType<ProjectDirectory["getProject"]>;
} {
  const topic = resolveTopicRecordForSession(sessionId);
  return {
    sessionId,
    agentId,
    topic,
    project: resolveProjectForSession(sessionId),
  };
}

function resolveResponseMode(
  agent: AgentConfig,
  responseModeOverride: ResponseMode | null
): ResponseMode {
  if (responseModeOverride) return responseModeOverride;
  if (agent.responseMode === "explain") return "explain";
  return "concise";
}

function resolveTopicRecordForSession(sessionId: string): TopicRecord | null {
  const normalized = sessionId.trim();
  if (!normalized.startsWith("topic:")) return null;

  const topicId = normalized.slice("topic:".length).trim();
  if (!topicId) return null;

  try {
    return storage.getTopicById(topicId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[tango-storage] failed to resolve topic for session", message);
    return null;
  }
}

function resolveProjectForSession(sessionId: string): ReturnType<ProjectDirectory["getProject"]> {
  const normalized = sessionId.trim();
  const projectId = parseProjectSessionId(normalized);
  if (projectId) {
    return projectDirectory.getProject(projectId);
  }

  const topic = resolveTopicRecordForSession(normalized);
  return resolveProjectForTopic(topic);
}

function resolveEffectiveSessionConfig(sessionId: string): SessionConfig | undefined {
  const direct = sessionConfigById.get(sessionId);
  if (direct) return direct;

  const project = resolveProjectForSession(sessionId);
  if (project) {
    const projectConfig = sessionConfigById.get(buildProjectSessionId(project.id));
    if (projectConfig) return projectConfig;
  }

  return sessionConfigById.get("tango-default");
}

function resolveOrchestratorContinuityMode(sessionId: string): OrchestratorContinuityMode {
  return resolveEffectiveSessionConfig(sessionId)?.orchestratorContinuity ?? "provider";
}

function getConversationKey(sessionId: string, agentId: string, threadChannelId?: string | null): string {
  if (threadChannelId) {
    return `${sessionId}:${agentId}:${threadChannelId}`;
  }
  return `${sessionId}:${agentId}`;
}

async function sendPresentedReply(
  channel: Message["channel"] | ChatInputCommandInteraction["channel"] | null,
  text: string,
  speaker: AgentConfig | null
) {
  return replyPresenter.sendChunked(channel, text, {
    speaker,
    botDisplayName: client.user?.username ?? systemDisplayName,
    avatarURL: resolveSpeakerAvatarURL(speaker, client.user?.displayAvatarURL()),
    avatarPath: resolveSpeakerAvatarPath(speaker)
  });
}

function buildFailedReplyDeliveryResult(speaker: AgentConfig | null): PresentedReplyResult {
  const intendedDisplayName = resolveSpeakerDisplayName(speaker, systemDisplayName);
  return {
    sentChunks: 0,
    delivery: "bot",
    intendedDisplayName,
    actualDisplayName: client.user?.username ?? systemDisplayName,
    failed: true
  };
}

function ensureReplyDeliverySucceeded(
  result: PresentedReplyResult,
  channelId: string | null | undefined
): void {
  if (!result.failed) {
    return;
  }

  throw new DeliveryError(
    `[tango-discord] reply delivery incomplete channel=${channelId ?? "unknown"} sentChunks=${result.sentChunks}`,
    {
      channelId: channelId ?? undefined,
      result
    }
  );
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function resolveIMessageRoute(
  channelKey: string
): {
  sessionId: string;
  agentId: string;
} | null {
  const configured = sessionManager.route(channelKey);
  if (configured) return configured;

  const fallback = sessionManager.route("imessage:default");
  if (fallback) {
    return {
      sessionId: channelKey,
      agentId: imessageDefaultAgent ?? fallback.agentId
    };
  }

  if (!imessageDefaultAgent) {
    return null;
  }

  return {
    sessionId: channelKey,
    agentId: imessageDefaultAgent
  };
}

function buildIMessageMetadata(
  message: IMessageInboundMessage,
  extra?: Record<string, unknown>
): Record<string, unknown> {
  return {
    channelKey: message.channelKey,
    imessage: {
      chatId: message.chatId,
      sender: message.sender,
      chatIdentifier: message.chatIdentifier,
      isGroup: message.isGroup,
      createdAt: message.createdAt,
      messageId: message.messageId
    },
    ...extra
  };
}

function resolveProviderByName(providerName: string): ChatProvider {
  return selectProviderByName(providerName, providers);
}

function resolveSessionProviderOverride(sessionId: string, agentId: string): string | undefined {
  try {
    const override = storage.getSessionProviderOverride(sessionId, agentId);
    return override?.providerName;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[tango-storage] failed to resolve session provider override", message);
    return undefined;
  }
}

function normalizeConfiguredModel(model: string | undefined): string | undefined {
  const normalized = model?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function resolveConfiguredReasoningEffort(
  input: {
    project?: { provider?: { reasoningEffort?: ProviderReasoningEffort } } | null;
    agent?: { provider: { reasoningEffort?: ProviderReasoningEffort } };
    worker?: { provider: { reasoningEffort?: ProviderReasoningEffort } };
  }
): ProviderReasoningEffort | undefined {
  return input.project?.provider?.reasoningEffort
    ?? input.worker?.provider.reasoningEffort
    ?? input.agent?.provider.reasoningEffort;
}

function resolveProviderNamesForTurn(input: { sessionId: string; agent: AgentConfig }): {
  providerNames: string[];
  configuredProviderNames: string[];
  project: ReturnType<ProjectDirectory["getProject"]>;
  overrideProviderName?: string;
  model?: string;
  reasoningEffort?: ProviderReasoningEffort;
} {
  const project = resolveProjectForSession(input.sessionId);
  const configuredProviderNames = [
    ...resolveProviderCandidates(project ?? {}),
    ...resolveProviderCandidates(input.agent)
  ].filter((value, index, all) => all.indexOf(value) === index);
  const overrideProviderName = resolveSessionProviderOverride(input.sessionId, input.agent.id);
  const configuredModel =
    normalizeConfiguredModel(project?.provider?.model)
    ?? normalizeConfiguredModel(input.agent.provider.model);
  return {
    providerNames: mergeProviderOrder(configuredProviderNames, overrideProviderName),
    configuredProviderNames,
    project,
    overrideProviderName,
    model: overrideProviderName ? undefined : configuredModel,
    reasoningEffort: resolveConfiguredReasoningEffort({ project, agent: input.agent }),
  };
}

function buildScheduleExecutionSessionId(scheduleId: string, agentId: string): string {
  return `schedule:${agentId}:${scheduleId}`;
}

function resolveProviderChain(providerNames: string[]): Array<{ providerName: string; provider: ChatProvider }> {
  const chain: Array<{ providerName: string; provider: ChatProvider }> = [];
  for (const providerName of providerNames) {
    try {
      const provider = resolveProviderByName(providerName);
      chain.push({ providerName, provider });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[tango-discord] skipping unsupported provider '${providerName}': ${message}`);
    }
  }

  if (chain.length === 0) {
    throw new Error("No supported providers available for this turn.");
  }

  return chain;
}

async function syncVoiceUserMessageToDiscord(
  channelId: string | null | undefined,
  transcript: string,
  discordUserId: string | null | undefined
): Promise<void> {
  if (!channelId) return;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) return;

    // Resolve user display name and avatar
    let userDisplayName = "You";
    let userAvatarURL: string | undefined;
    if (discordUserId) {
      try {
        const user = await client.users.fetch(discordUserId);
        userDisplayName = user.globalName ?? user.username;
        userAvatarURL = user.displayAvatarURL();
      } catch {
        // Non-fatal — fall back to defaults
      }
    }

    // Post user transcript with user avatar and (voice) label.
    // Prefix with zero-width space so getInbox can reliably filter out voice-user
    // messages (they should not appear as unread agent responses in the inbox).
    const userVoiceLabel = `${userDisplayName} (voice)`;
    const markedTranscript = `\u200B${transcript}`;
    const userResult = await replyPresenter.sendChunked(channel, markedTranscript, {
      speaker: { id: "voice-user", displayName: userVoiceLabel } as AgentConfig,
      botDisplayName: userVoiceLabel,
      avatarURL: userAvatarURL,
    });
    ensureReplyDeliverySucceeded(userResult, channelId);
    console.log(
      `[tango-voice] voice-discord-sync user-msg channel=${channelId} delivery=${userResult.delivery} displayName=${userResult.actualDisplayName} avatarURL=${userAvatarURL ?? "none"} resolvedUser=${userDisplayName}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[tango-voice] voice-discord-sync user-msg failed channel=${channelId}: ${message}`);
  }
}

async function syncVoiceAgentResponseToDiscord(
  channelId: string | null | undefined,
  responseText: string,
  speaker: AgentConfig
): Promise<void> {
  if (!channelId) return;
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) {
    throw new Error(`Discord channel ${channelId} unavailable for voice sync.`);
  }

  // Post agent response with agent avatar and (voice) label
  const agentDisplayName = speaker.displayName?.trim() || speaker.id;
  const agentVoiceLabel = `${agentDisplayName} (voice)`;
  const agentResult = await replyPresenter.sendChunked(channel, responseText, {
    speaker: { ...speaker, displayName: agentVoiceLabel },
    botDisplayName: agentVoiceLabel,
    avatarURL: resolveSpeakerAvatarURL(speaker, client.user?.displayAvatarURL()),
    avatarPath: resolveSpeakerAvatarPath(speaker),
  });
  ensureReplyDeliverySucceeded(agentResult, channelId);
  console.log(
    `[tango-voice] voice-discord-sync agent-msg channel=${channelId} delivery=${agentResult.delivery} displayName=${agentResult.actualDisplayName}`
  );

  // Advance watermark past the agent response — the user already heard it via voice TTS,
  // so it should not appear as "unread" in the inbox.
  if (agentResult.lastMessageId) {
    try {
      advanceVoiceWatermarkById(channelId, agentResult.lastMessageId, "voice-agent-sync");
    } catch (watermarkError) {
      console.warn(`[voice-inbox] voice-agent-sync watermark failed channel=${channelId}: ${watermarkError instanceof Error ? watermarkError.message : watermarkError}`);
    }
  }
}

async function syncVoiceAgentResponseToDiscordWithRetry(
  channelId: string | null | undefined,
  responseText: string,
  speaker: AgentConfig
): Promise<void> {
  if (!channelId) return;

  try {
    await syncVoiceAgentResponseToDiscord(channelId, responseText, speaker);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[tango-voice] voice-discord-sync retrying channel=${channelId} agent=${speaker.id} error=${message}`
    );
    await waitMs(2_000);

    try {
      await syncVoiceAgentResponseToDiscord(channelId, responseText, speaker);
    } catch (retryError) {
      const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
      console.error(
        `[tango-voice] voice-discord-sync FAILED after retry channel=${channelId} agent=${speaker.id} error=${retryMessage}`
      );
      throw retryError;
    }
  }
}

function renderVoiceCompletionPrompt(
  messages: VoiceCompletionInput["messages"]
): string {
  const parts: string[] = [];

  for (const message of messages) {
    const content = message.content.trim();
    if (!content) continue;

    const roleLabel =
      message.role === "assistant"
        ? "Assistant"
        : message.role === "system"
          ? "System"
          : "User";
    parts.push(`${roleLabel}:\n${content}`);
  }

  if (parts.length === 0) {
    throw new Error("Voice completion request did not include any usable messages.");
  }

  if (messages[messages.length - 1]?.role !== "assistant") {
    parts.push("Assistant:");
  }

  return parts.join("\n\n");
}

async function executeVoiceCompletion(
  input: VoiceCompletionInput
): Promise<VoiceCompletionResult> {
  const requestedAgentId = input.agentId?.trim() || voiceDefaultAgentId || systemAgent?.id;
  if (!requestedAgentId) {
    throw new Error("Voice completion agent is not configured.");
  }

  const targetAgent = agentRegistry.get(requestedAgentId);
  if (!targetAgent) {
    throw new Error(`Agent '${requestedAgentId}' not found in config.`);
  }

  const sessionId =
    input.sessionId?.trim() ||
    voiceDefaultSessionId ||
    buildDefaultSessionKey(targetAgent.id);
  const providerSelection = resolveProviderNamesForTurn({
    sessionId,
    agent: targetAgent
  });
  const providerChain = resolveProviderChain(providerSelection.providerNames);
  const maxTokensInstruction =
    typeof input.maxTokens === "number" && input.maxTokens > 0
      ? `Keep the reply under approximately ${input.maxTokens} tokens.`
      : null;
  const systemPrompt = [input.systemPrompt?.trim(), maxTokensInstruction]
    .filter((value): value is string => !!value && value.length > 0)
    .join("\n\n") || undefined;
  const prompt = renderVoiceCompletionPrompt(input.messages);
  const startedAt = Date.now();

  const result = await generateWithFailover(
    providerChain,
    {
      prompt,
      systemPrompt,
      tools: { mode: "off" },
      model: input.model
    },
    providerRetryLimit
  );

  const text = result.retryResult.response.text.trim();
  if (!text) {
    throw new Error("Voice completion provider returned an empty response.");
  }

  console.log(
    `[tango-voice] utility completion session=${sessionId} agent=${targetAgent.id} provider=${result.providerName} failover=${result.usedFailover ? "yes" : "no"} ms=${Date.now() - startedAt}`
  );

  return {
    text,
    providerName: result.providerName
  };
}

async function executeVoiceTurn(turnInput: VoiceTurnInput): Promise<VoiceTurnResult> {
  const targetAgent = agentRegistry.get(turnInput.agentId);
  if (!targetAgent) {
    throw new Error(`Agent '${turnInput.agentId}' not found in config.`);
  }
  turnInput = {
    ...turnInput,
    messageTimestamp: turnInput.messageTimestamp?.trim() || new Date().toISOString(),
    messageTimestampSource: turnInput.messageTimestampSource ?? "voice-finalized",
  };

  const resolvedVoiceSyncChannelId =
    turnInput.channelId?.trim() ||
    extractChannelIdFromSessionKey(turnInput.sessionId) ||
    targetAgent.voice?.defaultChannelId?.trim() ||
    null;

  upsertSessionForRoute(
    {
      sessionId: turnInput.sessionId,
      agentId: targetAgent.id
    },
    `voice:${resolvedVoiceSyncChannelId ?? "default"}`
  );

  let turnId: string | undefined;
  if (turnInput.utteranceId && turnInput.utteranceId.trim().length > 0) {
    const utteranceId = turnInput.utteranceId.trim();
    const claim = storage.claimVoiceTurnReceipt({
      sessionId: turnInput.sessionId,
      agentId: targetAgent.id,
      utteranceId,
      metadata: {
        inputSource: "voice-bridge",
        guildId: turnInput.guildId ?? null,
        voiceChannelId: turnInput.voiceChannelId ?? null,
        channelId: resolvedVoiceSyncChannelId,
        discordUserId: turnInput.discordUserId ?? null
      }
    });
    turnId = claim.receipt.turnId;

    if (!claim.created) {
      const completedResult = buildVoiceTurnResultFromReceipt(turnId, claim.receipt);
      if (completedResult) {
        console.log(
          `[tango-voice] duplicate turn reused session=${turnInput.sessionId} utterance=${utteranceId} turn=${turnId}`
        );
        return completedResult;
      }

      if (claim.receipt.status === "processing") {
        console.log(
          `[tango-voice] duplicate turn awaiting completion session=${turnInput.sessionId} utterance=${utteranceId} turn=${turnId}`
        );
        const resolvedReceipt = await waitForVoiceTurnReceiptResolution({
          sessionId: turnInput.sessionId,
          utteranceId,
          lookupReceipt: (sessionId, currentUtteranceId) =>
            storage.getVoiceTurnReceipt(sessionId, currentUtteranceId)
        });
        if (resolvedReceipt) {
          const resolvedResult = buildVoiceTurnResultFromReceipt(turnId, resolvedReceipt);
          if (resolvedResult) {
            console.log(
              `[tango-voice] duplicate turn completed while waiting session=${turnInput.sessionId} utterance=${utteranceId} turn=${turnId}`
            );
            return resolvedResult;
          }

          if (resolvedReceipt.status === "failed") {
            throw new Error(
              `Voice turn '${utteranceId}' previously failed (turnId=${turnId}): ${resolvedReceipt.errorMessage ?? "unknown error"}`
            );
          }
        }

        throw new Error(
          `Voice turn '${utteranceId}' is already processing (turnId=${turnId}).`
        );
      }

      throw new Error(
        `Voice turn '${utteranceId}' previously failed (turnId=${turnId}): ${claim.receipt.errorMessage ?? "unknown error"}`
      );
    }
  }

  const responseMode = resolveResponseMode(targetAgent, null);
  const v2AgentConfig = voiceV2AgentRuntimeConfigs.get(targetAgent.id)?.config ?? null;
  const voiceDefaultChannelId = targetAgent.voice?.defaultChannelId?.trim() || null;
  const isVoiceThread =
    turnInput.channelId &&
    voiceDefaultChannelId &&
    turnInput.channelId !== voiceDefaultChannelId;
  const conversationKey = getConversationKey(
    turnInput.sessionId,
    targetAgent.id,
    isVoiceThread ? turnInput.channelId : null,
  );
  const voiceRouterChannelId = isVoiceThread
    ? (voiceDefaultChannelId ?? resolvedVoiceSyncChannelId ?? `voice:${turnInput.sessionId}`)
    : (resolvedVoiceSyncChannelId ?? voiceDefaultChannelId ?? `voice:${turnInput.sessionId}`);
  const voiceRouterThreadId = isVoiceThread ? turnInput.channelId ?? undefined : undefined;

  const inboundMessageId = writeMessage({
    sessionId: turnInput.sessionId,
    agentId: targetAgent.id,
    direction: "inbound",
    source: "tango",
    visibility: "public",
    discordChannelId: resolvedVoiceSyncChannelId,
    discordUserId: turnInput.discordUserId ?? null,
    content: turnInput.transcript,
    metadata: {
      inputSource: "voice-bridge",
      turnId: turnId ?? null,
      utteranceId: turnInput.utteranceId ?? null,
      messageTimestamp: turnInput.messageTimestamp ?? null,
      messageTimestampSource: turnInput.messageTimestampSource ?? null,
      guildId: turnInput.guildId ?? null,
      voiceChannelId: turnInput.voiceChannelId ?? null,
      responseMode,
      runtime: v2AgentConfig ? "v2" : "legacy",
      conversationKey,
    }
  });

  const startedAt = Date.now();

  // Post user transcript to Discord immediately (before LLM processing).
  // Prefer the turn's explicit channelId, then any discord channel encoded in
  // the session key, before falling back to the agent's default voice channel.
  void syncVoiceUserMessageToDiscord(
    resolvedVoiceSyncChannelId,
    turnInput.transcript,
    turnInput.discordUserId
  );

  // Show "typing..." in the Discord text channel while the voice turn processes.
  // Discord's indicator lasts ~10s, so we repeat every 8s.
  let voiceTypingInterval: ReturnType<typeof setInterval> | undefined;
  if (resolvedVoiceSyncChannelId) {
    void (async () => {
      try {
        const typingChannel = await client.channels.fetch(resolvedVoiceSyncChannelId);
        if (typingChannel && typingChannel.isTextBased()) {
          const tc = typingChannel as { sendTyping?: () => Promise<void> };
          if (typeof tc.sendTyping === "function") {
            await tc.sendTyping().catch(() => {/* typing indicator is best-effort */});
            voiceTypingInterval = setInterval(() => {
              tc.sendTyping?.().catch(() => {/* ignore */});
            }, 8_000);
          }
        }
      } catch {
        // Non-fatal — typing indicator is cosmetic
      }
    })();
  }

  const clearVoiceTyping = (): void => {
    if (voiceTypingInterval) {
      clearInterval(voiceTypingInterval);
      voiceTypingInterval = undefined;
    }
  };

  const syncVoiceAgentResponse = (responseText: string): void => {
    console.log(
      `[tango-voice] voice-discord-sync agent-response channel=${resolvedVoiceSyncChannelId} agent=${targetAgent.id}`
    );
    const syncPromise = syncVoiceAgentResponseToDiscordWithRetry(
      resolvedVoiceSyncChannelId,
      responseText,
      targetAgent
    );
    syncPromise.catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[tango-voice] voice-discord-sync PERMANENTLY FAILED channel=${resolvedVoiceSyncChannelId} agent=${targetAgent.id}: ${message}`
      );
    });
  };

  // Victor manual-console bridge: route voice to VICTOR-COS only when explicitly enabled.
  if (targetAgent.id === "victor" && isVictorManualConsoleBridgeActive()) {
    try {
      const bridgeMessage: VictorBridgeMessage = {
        id: randomUUID(),
        timestamp: turnInput.messageTimestamp ?? new Date().toISOString(),
        source: "discord-voice",
        user: turnInput.discordUserId
          ? { id: turnInput.discordUserId, username: "voice-user" }
          : null,
        channel: { id: resolvedVoiceSyncChannelId ?? `voice:${turnInput.sessionId}` },
        content: turnInput.transcript,
        sessionId: turnInput.sessionId,
        agentId: targetAgent.id,
      };

      const requestId = await sendToVictorInbox(bridgeMessage);
      clearVoiceTyping();
      const bridgeResponse = await waitForVictorResponse(requestId, 120_000);

      writeMessage({
        sessionId: turnInput.sessionId,
        agentId: targetAgent.id,
        providerName: "victor-bridge",
        direction: "outbound",
        source: "tango",
        visibility: "public",
        discordChannelId: resolvedVoiceSyncChannelId,
        content: bridgeResponse.text,
        metadata: {
          inputSource: "voice-bridge",
          runtimePath: "victor-bridge",
          bridgeRequestId: requestId,
          turnId: turnId ?? null,
        },
      });

      syncVoiceAgentResponse(bridgeResponse.text);

      return {
        deduplicated: false,
        responseText: bridgeResponse.text,
        providerName: "victor-bridge",
        providerUsedFailover: false,
        ...(turnId ? { turnId } : {}),
      };
    } catch (error) {
      console.error(
        `[tango-discord] victor-bridge voice failed, falling back to ephemeral:`,
        error instanceof Error ? error.message : error,
      );
      // Fall through to normal dispatch
    }
  }

  if (!v2AgentConfig || !isV2RuntimeEnabled(v2AgentConfig)) {
    clearVoiceTyping();
    const messageText = `Agent '${targetAgent.id}' is not configured for the v2 voice runtime.`;
    const errorMessageId = writeMessage({
      sessionId: turnInput.sessionId,
      agentId: targetAgent.id,
      providerName: "claude-code-v2",
      direction: "error",
      source: "tango",
      visibility: "debug",
      discordChannelId: resolvedVoiceSyncChannelId,
      discordUserId: null,
      discordUsername: "Tango Voice",
      content: messageText,
      metadata: {
        inputSource: "voice-bridge",
        turnId: turnId ?? null,
        utteranceId: turnInput.utteranceId ?? null,
        guildId: turnInput.guildId ?? null,
        voiceChannelId: turnInput.voiceChannelId ?? null,
        responseMode,
        runtime: "v2-required",
      },
    });

    if (turnId) {
      storage.failVoiceTurnReceipt({
        turnId,
        errorMessage: messageText,
        requestMessageId: inboundMessageId,
        responseMessageId: errorMessageId,
        modelRunId: null,
        metadata: {
          inputSource: "voice-bridge",
          utteranceId: turnInput.utteranceId ?? null,
          runtime: "v2-required",
        },
      });
    }

    throw new Error(messageText);
  }

  const voiceWarmStartPrompt =
    await buildWarmStartContextPrompt({
      sessionId: turnInput.sessionId,
      agentId: targetAgent.id,
      currentUserPrompt: turnInput.transcript,
      discordChannelId: voiceRouterThreadId ?? voiceRouterChannelId,
    });
  const voiceContext = [
    voiceWarmStartPrompt,
    VOICE_RESPONSE_FORMATTING_SYSTEM_PROMPT,
  ].filter(Boolean).join("\n\n");
  const currentTurnMetadataPrompt = buildCurrentTurnMetadataPrompt({
    timestamp: turnInput.messageTimestamp,
    timestampSource: turnInput.messageTimestampSource,
    config: v2AgentConfig.currentTurnMetadata,
  });
  const voiceConversationKey = conversationKeyFor(voiceRouterChannelId, voiceRouterThreadId);
  const voiceStateFilePointer = buildStateFilePointer(storage, voiceConversationKey, {
    vaultRoot: resolveStateVaultRoot(),
  });
  const voiceTurnBriefingPrompt = buildTurnBriefingPrompt({
    ...(voiceStateFilePointer ? { stateFile: voiceStateFilePointer } : {}),
    searchFirst: Boolean(voiceStateFilePointer) || process.env.TANGO_TURN_BRIEFING_SEARCH_FIRST === "1",
  });

  return dispatchVoiceTurnByRuntime({
    transcript: turnInput.transcript,
    agentId: targetAgent.id,
    channelId: voiceRouterChannelId,
    ...(voiceRouterThreadId ? { threadId: voiceRouterThreadId } : {}),
    conversationKey,
    v2AgentConfig,
    tangoRouter: voiceTangoRouter,
    sendOptions: {
      context: voiceContext || undefined,
      currentTurnMetadataPrompt,
      ...(voiceTurnBriefingPrompt ? { turnBriefingPrompt: voiceTurnBriefingPrompt } : {}),
    },
    mapRouterResult: async (routeResult): Promise<VoiceTurnResult> => {
      const baseTurnResult = buildVoiceRouterResult({
        routeResult,
        v2AgentConfig: v2AgentConfig!,
        turnId,
      });
      const turnResult = baseTurnResult.responseText.trim().length > 0
        ? baseTurnResult
        : buildVoiceRouterErrorResult({
            v2AgentConfig: v2AgentConfig!,
            turnId,
            responseText: VOICE_V2_TTS_ERROR_MESSAGE,
          });
      const latencyMs = Date.now() - startedAt;
      const response = routeResult.response;
      const runtimeMetadata = asRecord(response.metadata);

      const outboundMessageId = writeMessage({
        sessionId: turnInput.sessionId,
        agentId: targetAgent.id,
        providerName: turnResult.providerName,
        direction: "outbound",
        source: "tango",
        visibility: "public",
        discordChannelId: resolvedVoiceSyncChannelId,
        discordUserId: null,
        discordUsername: "Tango Voice",
        content: turnResult.responseText,
        metadata: {
          inputSource: "voice-bridge",
          turnId: turnId ?? null,
          utteranceId: turnInput.utteranceId ?? null,
          guildId: turnInput.guildId ?? null,
          voiceChannelId: turnInput.voiceChannelId ?? null,
          responseMode,
          runtime: "v2",
          latencyMs,
          providerSessionId: turnResult.providerSessionId ?? null,
          providerUsedFailover: false,
          conversationKey: routeResult.conversationKey,
          toolsUsed: response.toolsUsed ?? [],
          runtimeMetadata: response.metadata ?? null,
        }
      });

      const modelRunId = writeModelRun({
        sessionId: turnInput.sessionId,
        agentId: targetAgent.id,
        providerName: turnResult.providerName,
        conversationKey: routeResult.conversationKey,
        providerSessionId: turnResult.providerSessionId ?? null,
        model: response.model,
        responseMode,
        latencyMs,
        providerDurationMs: response.durationMs,
        requestMessageId: inboundMessageId,
        responseMessageId: outboundMessageId,
        metadata: {
          inputSource: "voice-bridge",
          turnId: turnId ?? null,
          utteranceId: turnInput.utteranceId ?? null,
          guildId: turnInput.guildId ?? null,
          voiceChannelId: turnInput.voiceChannelId ?? null,
          responseMode,
          runtime: "v2",
          toolsUsed: response.toolsUsed ?? [],
          runtimeExitCode: metadataNumber(runtimeMetadata, "exitCode") ?? null,
          runtimeSignal: metadataString(runtimeMetadata, "signal") ?? null,
          runtimeStderr: metadataString(runtimeMetadata, "stderr") ?? null,
          currentTurnMetadataIncluded: metadataBoolean(runtimeMetadata, "currentTurnMetadataIncluded") ?? false,
          currentTurnMetadataChars: metadataNumber(runtimeMetadata, "currentTurnMetadataChars") ?? null,
        },
        rawResponse: null,
      });

      if (turnId) {
        storage.completeVoiceTurnReceipt({
          turnId,
          providerName: turnResult.providerName,
          providerSessionId: turnResult.providerSessionId ?? null,
          responseText: turnResult.responseText,
          providerUsedFailover: false,
          requestMessageId: inboundMessageId,
          responseMessageId: outboundMessageId,
          modelRunId,
          metadata: {
            inputSource: "voice-bridge",
            utteranceId: turnInput.utteranceId ?? null,
            runtime: "v2",
          }
        });
      }

      maybeCompactSessionMemory({
        sessionId: turnInput.sessionId,
        agentId: targetAgent.id
      });

      console.log(
        `[tango-voice] reply session=${turnInput.sessionId} agent=${targetAgent.id} provider=${turnResult.providerName} runtime=v2 ms=${latencyMs} conversation=${routeResult.conversationKey}`
      );

      clearVoiceTyping();
      syncVoiceAgentResponse(turnResult.responseText);

      return turnResult;
    },
    onRouterError: async (error): Promise<VoiceTurnResult> => {
      const messageText = error instanceof Error ? error.message : String(error);
      const turnResult = buildVoiceRouterErrorResult({
        v2AgentConfig: v2AgentConfig!,
        turnId,
      });
      const latencyMs = Date.now() - startedAt;

      const errorMessageId = writeMessage({
        sessionId: turnInput.sessionId,
        agentId: targetAgent.id,
        providerName: turnResult.providerName,
        direction: "error",
        source: "tango",
        visibility: "debug",
        discordChannelId: resolvedVoiceSyncChannelId,
        discordUserId: null,
        discordUsername: "Tango Voice",
        content: messageText,
        metadata: {
          inputSource: "voice-bridge",
          turnId: turnId ?? null,
          utteranceId: turnInput.utteranceId ?? null,
          guildId: turnInput.guildId ?? null,
          voiceChannelId: turnInput.voiceChannelId ?? null,
          responseMode,
          runtime: "v2",
        }
      });

      const outboundMessageId = writeMessage({
        sessionId: turnInput.sessionId,
        agentId: targetAgent.id,
        providerName: turnResult.providerName,
        direction: "outbound",
        source: "tango",
        visibility: "public",
        discordChannelId: resolvedVoiceSyncChannelId,
        discordUserId: null,
        discordUsername: "Tango Voice",
        content: turnResult.responseText,
        metadata: {
          inputSource: "voice-bridge",
          turnId: turnId ?? null,
          utteranceId: turnInput.utteranceId ?? null,
          guildId: turnInput.guildId ?? null,
          voiceChannelId: turnInput.voiceChannelId ?? null,
          responseMode,
          runtime: "v2",
          latencyMs,
          failed: true,
        }
      });

      const errorModelRunId = writeModelRun({
        sessionId: turnInput.sessionId,
        agentId: targetAgent.id,
        providerName: turnResult.providerName,
        conversationKey,
        responseMode,
        latencyMs,
        isError: true,
        errorMessage: messageText,
        requestMessageId: inboundMessageId,
        responseMessageId: errorMessageId,
        metadata: {
          inputSource: "voice-bridge",
          turnId: turnId ?? null,
          utteranceId: turnInput.utteranceId ?? null,
          guildId: turnInput.guildId ?? null,
          voiceChannelId: turnInput.voiceChannelId ?? null,
          responseMode,
          runtime: "v2",
          toolTelemetry: emptyToolTelemetry(),
        },
        rawResponse: null
      });

      if (turnId) {
        storage.completeVoiceTurnReceipt({
          turnId,
          providerName: turnResult.providerName,
          responseText: turnResult.responseText,
          requestMessageId: inboundMessageId,
          responseMessageId: outboundMessageId,
          modelRunId: errorModelRunId,
          metadata: {
            inputSource: "voice-bridge",
            utteranceId: turnInput.utteranceId ?? null,
            runtime: "v2",
            errorMessage: messageText,
          }
        });
      }

      console.error(
        `[tango-voice] v2 turn failed session=${turnInput.sessionId} agent=${targetAgent.id} error=${messageText}`
      );

      clearVoiceTyping();
      syncVoiceAgentResponse(turnResult.responseText);

      return turnResult;
    },
  });
}

// --- Voice Inbox: Discord-anchored read watermarks ---

// Build a map of Discord channel ID → agent/session info for the inbox endpoint.
const voiceInboxChannelMap = new Map<string, {
  channelId: string;
  sessionId: string;
  agentId: string;
  displayName: string;
}>();

for (const session of sessionConfigs) {
  for (const channel of session.channels) {
    if (!channel.startsWith("discord:")) continue;
    const channelId = channel.slice("discord:".length).trim();
    if (!channelId || channelId === "default") continue;
    const agent = agentRegistry.get(session.agent);
    if (!agent) continue;
    voiceInboxChannelMap.set(channelId, {
      channelId,
      sessionId: session.id,
      agentId: agent.id,
      displayName: agent.displayName?.trim() || agent.id,
    });
  }
}

// Inbox cache to avoid hammering Discord API (5-second TTL)
let inboxCache: { data: VoiceInboxResponse; ts: number } | null = null;
const INBOX_CACHE_TTL_MS = 5_000;
const INBOX_SCAN_BATCH_SIZE = 32;

/**
 * Scan a single Discord channel/thread for unread bot messages.
 * Returns a VoiceInboxChannel or null if no unread messages.
 */
async function scanChannelForInbox(
  channelId: string,
  fallbackAgentId: string,
  fallbackDisplayName: string,
): Promise<VoiceInboxChannel | null> {
  try {
    const discordChannel = await client.channels.fetch(channelId);
    if (!discordChannel || !discordChannel.isTextBased()) return null;
    if (!("messages" in discordChannel)) return null;

    const watermark = storage.getVoiceWatermark(channelId);
    const fetchOptions: { limit: number; after?: string } = { limit: 50 };
    if (watermark) {
      fetchOptions.after = watermark.messageId;
    }

    const messages = await discordChannel.messages.fetch(fetchOptions);
    const agentMessages = [...messages.values()]
      .filter((m) => {
        if (!(m.author.bot || m.webhookId)) return false;
        if (m.content.startsWith('\u200B')) return false;
        return true;
      })
      .sort((a, b) => {
        const aId = BigInt(a.id);
        const bId = BigInt(b.id);
        return aId < bId ? -1 : aId > bId ? 1 : 0;
      });

    if (agentMessages.length === 0) return null;

    const inboxMessages: VoiceInboxMessage[] = [];
    let currentGroupId: string | null = null;
    let lastAuthorId: string | null = null;
    let lastTimestamp = 0;

    for (const msg of agentMessages) {
      const msgTimestamp = msg.createdTimestamp;
      const sameAuthor = msg.author.id === lastAuthorId;
      const withinWindow = (msgTimestamp - lastTimestamp) < 30_000;
      const isChunked = sameAuthor && withinWindow;

      if (!isChunked) {
        currentGroupId = agentMessages.length > 1 ? msg.id : null;
      }

      const authorName = msg.author.displayName || msg.author.username;
      const cleanAuthor = authorName.replace(/\s*\(voice\)\s*$/i, "").trim().toLowerCase();
      const matchedAgent = agentRegistry.list().find(
        (a) => (a.displayName || a.id).toLowerCase() === cleanAuthor || a.id.toLowerCase() === cleanAuthor
      );
      const resolvedAgentId = matchedAgent?.id ?? fallbackAgentId;

      inboxMessages.push({
        messageId: msg.id,
        channelId,
        channelName: ("name" in discordChannel && typeof discordChannel.name === "string") ? discordChannel.name : channelId,
        agentDisplayName: authorName,
        agentId: resolvedAgentId,
        content: msg.content,
        timestamp: msgTimestamp,
        isChunked,
        chunkGroupId: isChunked ? currentGroupId : null,
      });

      lastAuthorId = msg.author.id;
      lastTimestamp = msgTimestamp;
    }

    const channelName = ("name" in discordChannel && typeof discordChannel.name === "string") ? discordChannel.name : channelId;
    const messageAuthorName = inboxMessages.length > 0
      ? (inboxMessages[0]!.agentDisplayName || "").replace(/\s*\(voice\)\s*$/i, "").trim()
      : "";
    return {
      channelId,
      channelName,
      displayName: messageAuthorName || fallbackDisplayName,
      unreadCount: inboxMessages.length,
      messages: inboxMessages,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!voiceInboxChannelMap.has(channelId) && /Unknown Channel/i.test(message)) {
      storage.deleteThreadSession(channelId);
      console.warn(`[voice-inbox] pruned stale thread session ${channelId} after Unknown Channel`);
    }
    console.warn(`[voice-inbox] failed to fetch channel ${channelId}: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

/**
 * Scan all inbox sources (parent channels + tracked threads) and return all channels with unread messages.
 */
async function scanAllInboxChannels(): Promise<VoiceInboxChannel[]> {
  const scanDescriptors: Array<{ channelId: string; agentId: string; displayName: string }> = [];

  // 1. Scan parent channels from session configs
  for (const [channelId, info] of voiceInboxChannelMap) {
    scanDescriptors.push({
      channelId,
      agentId: info.agentId,
      displayName: info.displayName,
    });
  }

  // 2. Scan threads from discord_thread_sessions (threads with assigned agents)
  const threadSessions = storage.listThreadSessionsWithAgent();
  const scannedParentIds = new Set(voiceInboxChannelMap.keys());

  for (const ts of threadSessions) {
    // Skip if already scanned as a parent channel
    if (scannedParentIds.has(ts.threadId)) continue;

    const agent = agentRegistry.get(ts.agentId);
    const displayName = agent?.displayName?.trim() || ts.agentId;
    scanDescriptors.push({
      channelId: ts.threadId,
      agentId: ts.agentId,
      displayName,
    });
  }

  const resultChannels: VoiceInboxChannel[] = [];
  for (let index = 0; index < scanDescriptors.length; index += INBOX_SCAN_BATCH_SIZE) {
    const batch = scanDescriptors.slice(index, index + INBOX_SCAN_BATCH_SIZE);
    const scannedBatch = await Promise.all(
      batch.map((descriptor) => scanChannelForInbox(descriptor.channelId, descriptor.agentId, descriptor.displayName)),
    );
    for (const channel of scannedBatch) {
      if (channel) {
        resultChannels.push(channel);
      }
    }
  }

  return resultChannels;
}

/**
 * Group inbox channels by agent ID, returning agent-centric inbox groups.
 */
function groupChannelsByAgent(channels: VoiceInboxChannel[]): VoiceInboxAgentGroup[] {
  const agentMap = new Map<string, VoiceInboxAgentGroup>();

  for (const ch of channels) {
    // Determine the agent ID — use per-message agentId, fallback to first message's
    const agentId = ch.messages[0]?.agentId ?? "unknown";
    const existing = agentMap.get(agentId);

    if (existing) {
      existing.channels.push(ch);
      existing.totalUnread += ch.unreadCount;
    } else {
      // Resolve display name from agent registry
      const agent = agentRegistry.get(agentId);
      const agentDisplayName = agent?.displayName?.trim() || ch.displayName;
      agentMap.set(agentId, {
        agentId,
        agentDisplayName,
        totalUnread: ch.unreadCount,
        channels: [ch],
      });
    }
  }

  return [...agentMap.values()];
}

function matchesInboxChannelQuery(channel: VoiceInboxChannel, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return false;
  return channel.channelId === query
    || channel.displayName.toLowerCase() === normalized
    || channel.channelName.toLowerCase() === normalized;
}

const voiceInboxHandlers: VoiceInboxHandlers = {
  async getInbox(channels?: string[]): Promise<VoiceInboxResponse> {
    // Check cache
    if (inboxCache && (Date.now() - inboxCache.ts) < INBOX_CACHE_TTL_MS) {
      if (!channels || channels.length === 0) return inboxCache.data;
      const filtered = inboxCache.data.channels.filter(
        (ch: VoiceInboxChannel) => channels.some((name: string) => matchesInboxChannelQuery(ch, name))
      );
      return { ok: true, channels: filtered, totalUnread: filtered.reduce((s: number, c: VoiceInboxChannel) => s + c.unreadCount, 0), pendingCount: inboxCache.data.pendingCount };
    }

    const resultChannels = await scanAllInboxChannels();

    const pendingCount = storage.getProcessingVoiceTurnCount();
    const response: VoiceInboxResponse = {
      ok: true,
      channels: resultChannels,
      totalUnread: resultChannels.reduce((sum, ch) => sum + ch.unreadCount, 0),
      pendingCount,
    };

    // Update cache
    inboxCache = { data: response, ts: Date.now() };

    // Filter by requested channels if specified
    if (channels && channels.length > 0) {
      const filtered = response.channels.filter(
        (ch: VoiceInboxChannel) => channels.some((name: string) => matchesInboxChannelQuery(ch, name))
      );
      return { ok: true, channels: filtered, totalUnread: filtered.reduce((s: number, c: VoiceInboxChannel) => s + c.unreadCount, 0), pendingCount };
    }

    return response;
  },

  async getAgentInbox(): Promise<VoiceInboxAgentResponse> {
    // Reuse the full channel scan (benefits from cache)
    const channelResponse = await this.getInbox();
    const agents = groupChannelsByAgent(channelResponse.channels);

    return {
      ok: true,
      agents,
      totalUnread: channelResponse.totalUnread,
      pendingCount: channelResponse.pendingCount,
    };
  },

  async advanceWatermark(channelId: string, messageId: string, source: string): Promise<boolean> {
    const advanced = advanceVoiceWatermarkById(channelId, messageId, source);
    if (advanced) {
      console.log(`[voice-inbox] watermark advanced channel=${channelId} message=${messageId} source=${source}`);
    }
    return advanced;
  }
};

const voiceBridge = voiceBridgeEnabled
  ? new HttpVoiceBridge(
      {
        executeTurn: (turnInput: VoiceTurnInput) => executeVoiceTurn(turnInput)
      },
      {
        host: voiceBridgeHost,
        port: voiceBridgePort,
        path: voiceBridgePath,
        apiKey: voiceBridgeApiKey,
        defaultSessionId: voiceDefaultSessionId,
        defaultAgentId: voiceDefaultAgentId,
        inboxHandlers: voiceInboxHandlers,
        completionHandler: (input: VoiceCompletionInput) => executeVoiceCompletion(input)
      }
    )
  : null;

const imessageMentionNames = [...new Set([systemDisplayName, ...voiceTargets.getAllCallSigns()])];
const imessageListener = imessageEnabled
  ? new IMessageListener({
      cliPath: imessageCliPath,
      contactsPath: imessageContactsPath,
      allowFrom: imessageAllowFrom,
      groupPolicy: imessageGroupPolicy,
      mentionNames: imessageMentionNames,
      textChunkLimit: imessageTextChunkLimit,
      logger: {
        info(message: string): void {
          console.log(message);
        },
        warn(message: string): void {
          console.warn(message);
        },
        error(message: string): void {
          console.error(message);
        }
      },
      onMessage: async (message) => {
        enqueueChannelWork(message.channelKey, "tango-imessage", async () => {
          await handleIMessageMessage(imessageListener!, message);
        });
      }
    })
  : null;

function truncate(input: string, maxLength: number): string {
  return input.length <= maxLength ? input : `${input.slice(0, maxLength - 3)}...`;
}

function formatHealthStatus(): string {
  const health = storage.getHealthSnapshot();
  const lines = [
    `status=${health.status}`,
    `db_version=${health.dbUserVersion}`,
    `sessions=${health.sessions}`,
    `messages=${health.messages}`,
    `model_runs=${health.modelRuns}`,
    `provider_sessions=${health.providerSessions}`,
    `dead_letters_pending=${health.deadLettersPending}`,
    `dead_letters_total=${health.deadLettersTotal}`,
    `last_message_at=${health.lastMessageAt ?? "-"}`,
    `listen_only=${listenOnly}`,
    `provider_retry_limit=${providerRetryLimit}`,
    `memory_compaction_trigger_turns=${memoryCompactionTriggerTurns}`,
    `memory_compaction_retain_recent_turns=${memoryCompactionRetainRecentTurns}`,
    `memory_compaction_summary_max_chars=${memoryCompactionSummaryMaxChars}`,
    `access_default_mode=${defaultAccessMode}`,
    `default_allowlist_channels=${defaultAccessPolicy.allowlistChannelIds.size}`,
    `default_allowlist_users=${defaultAccessPolicy.allowlistUserIds.size}`,
    `agent_access_overrides=${agentAccessOverrideCount}`
  ];
  return ["Tango status", "```", ...lines, "```"].join("\n");
}

function formatDeadLettersList(input: {
  status: "pending" | "resolved" | "all";
  sessionId?: string;
  limit: number;
}): string {
  const entries = storage.listDeadLetters({
    status: input.status,
    sessionId: input.sessionId,
    limit: input.limit
  });

  if (entries.length === 0) {
    return "No dead-letter entries found.";
  }

  const header = [
    "Dead letters",
    `status=${input.status}`,
    `count=${entries.length}`,
    input.sessionId ? `session=${input.sessionId}` : null
  ]
    .filter((item): item is string => item !== null)
    .join(" ");

  const lines = entries.map((entry) =>
    [
      `id=${entry.id}`,
      `status=${entry.status}`,
      `session=${entry.sessionId}`,
      `agent=${entry.agentId}`,
      `fail=${entry.failureCount}`,
      `replay=${entry.replayCount}`,
      `error=${JSON.stringify(truncate(entry.lastErrorMessage, 80))}`
    ].join(" ")
  );

  const visibleLines: string[] = [];
  for (const line of lines) {
    const candidate = [header, "```", ...visibleLines, line, "```"].join("\n");
    if (candidate.length > 1900) break;
    visibleLines.push(line);
  }

  const truncatedCount = lines.length - visibleLines.length;
  if (truncatedCount > 0) {
    visibleLines.push(`... truncated=${truncatedCount}`);
  }

  return [header, "```", ...visibleLines, "```"].join("\n");
}

function formatAccessPolicyReport(input: {
  channelId: string;
  userId: string;
  mentioned: boolean;
  agentFilter?: string;
}): string {
  const channelKey = `discord:${input.channelId}`;
  const route = sessionManager.route(channelKey) ?? sessionManager.route("discord:default");
  const routedTargetAgent = route ? resolveTargetAgent(agentRegistry, route.agentId, null) : null;

  const normalizedFilter = input.agentFilter?.trim().toLowerCase();
  const selectedAgents = normalizedFilter
    ? agentConfigs.filter((agent) => agent.id.toLowerCase() === normalizedFilter)
    : [...agentConfigs];
  selectedAgents.sort((a, b) => a.id.localeCompare(b.id));

  if (selectedAgents.length === 0) {
    return `No agent config found for filter '${input.agentFilter}'.`;
  }

  const headerLines = [
    "Access policy report",
    `channel=${input.channelId}`,
    `user=${input.userId}`,
    `mentioned=${input.mentioned ? "yes" : "no"}`,
    `route_session=${route?.sessionId ?? "-"}`,
    `route_agent=${route?.agentId ?? "-"}`,
    `route_target=${routedTargetAgent?.id ?? "-"}`
  ];

  const lines = selectedAgents.map((agent) => {
    const policy = resolveAccessPolicy(agent, defaultAccessPolicy);
    const evaluation = evaluateAccess(
      {
        channelId: input.channelId,
        userId: input.userId,
        mentioned: input.mentioned
      },
      policy
    );

    const modeSource = agent.access?.mode !== undefined ? "agent" : "default";
    const channelSource = agent.access?.allowlistChannelIds !== undefined ? "agent" : "default";
    const userSource = agent.access?.allowlistUserIds !== undefined ? "agent" : "default";

    return [
      `agent=${agent.id}`,
      `mode=${policy.mode}`,
      `mode_src=${modeSource}`,
      `channel_src=${channelSource}`,
      `user_src=${userSource}`,
      `channels=${policy.allowlistChannelIds.size}`,
      `users=${policy.allowlistUserIds.size}`,
      `mention_req=${evaluation.mentionRequired ? "yes" : "no"}`,
      `channel_ok=${evaluation.channelAllowed ? "yes" : "no"}`,
      `user_ok=${evaluation.userAllowed ? "yes" : "no"}`,
      `allowed=${evaluation.allowed ? "yes" : "no"}`,
      `reason=${evaluation.reason}`
    ].join(" ");
  });

  const visibleLines: string[] = [];
  for (const line of lines) {
    const candidate = [...headerLines, "```", ...visibleLines, line, "```"].join("\n");
    if (candidate.length > 1900) break;
    visibleLines.push(line);
  }

  const truncatedCount = lines.length - visibleLines.length;
  if (truncatedCount > 0) {
    visibleLines.push(`... truncated=${truncatedCount}`);
  }

  return [...headerLines, "```", ...visibleLines, "```"].join("\n");
}

function formatCapabilitiesReport(input: {
  channelId: string;
  userId: string;
  mentioned: boolean;
  agentFilter?: string;
}): string {
  const channelKey = `discord:${input.channelId}`;
  const route = sessionManager.route(channelKey) ?? sessionManager.route("discord:default");
  const routedTargetAgent = route ? resolveTargetAgent(agentRegistry, route.agentId, null) : null;

  const normalizedFilter = input.agentFilter?.trim().toLowerCase();
  const selectedAgents = normalizedFilter
    ? agentConfigs.filter((agent) => agent.id.toLowerCase() === normalizedFilter)
    : [...agentConfigs];
  selectedAgents.sort((a, b) => a.id.localeCompare(b.id));

  if (selectedAgents.length === 0) {
    return `No agent config found for filter '${input.agentFilter}'.`;
  }

  const headerLines = [
    "Capabilities report",
    `channel=${input.channelId}`,
    `user=${input.userId}`,
    `mentioned=${input.mentioned ? "yes" : "no"}`,
    `route_session=${route?.sessionId ?? "-"}`,
    `route_agent=${route?.agentId ?? "-"}`,
    `route_target=${routedTargetAgent?.id ?? "-"}`
  ];

  const lines = selectedAgents.map((agent) => {
    const policy = resolveAccessPolicy(agent, defaultAccessPolicy);
    const evaluation = evaluateAccess(
      {
        channelId: input.channelId,
        userId: input.userId,
        mentioned: input.mentioned
      },
      policy
    );
    const tools = resolveAgentToolPolicy(agent);
    const providerCandidates = resolveProviderCandidates(agent);
    const resolvedProviders = route
      ? resolveProviderNamesForTurn({
          sessionId: route.sessionId,
          agent
        })
      : {
          providerNames: providerCandidates,
          configuredProviderNames: providerCandidates,
          overrideProviderName: undefined
        };
    const toolsPreview =
      tools.mode === "allowlist"
        ? tools.allowlist.join("|")
        : tools.mode === "default"
          ? "default"
          : "(none)";

    return [
      `agent=${agent.id}`,
      `route_target=${routedTargetAgent?.id === agent.id ? "yes" : "no"}`,
      `provider_default=${agent.provider.default}`,
      `provider_candidates=${providerCandidates.join("|")}`,
      `provider_override=${resolvedProviders.overrideProviderName ?? "-"}`,
      `provider_effective=${resolvedProviders.providerNames.join("|")}`,
      `access_mode=${policy.mode}`,
      `allowed=${evaluation.allowed ? "yes" : "no"}`,
      `access_reason=${evaluation.reason}`,
      `tools_mode=${tools.mode}`,
      `tools_count=${tools.allowlist.length}`,
      `tools=${toolsPreview || "(none)"}`
    ].join(" ");
  });

  const visibleLines: string[] = [];
  for (const line of lines) {
    const candidate = [...headerLines, "```", ...visibleLines, line, "```"].join("\n");
    if (candidate.length > 1900) break;
    visibleLines.push(line);
  }

  const truncatedCount = lines.length - visibleLines.length;
  if (truncatedCount > 0) {
    visibleLines.push(`... truncated=${truncatedCount}`);
  }

  return [...headerLines, "```", ...visibleLines, "```"].join("\n");
}

function formatSessionProviderReport(input: {
  sessionId: string;
  agentId: string;
  configuredProviders: string[];
  effectiveProviders: string[];
  overrideProvider?: string;
}): string {
  const supportedProviders = input.effectiveProviders.filter((providerName) => {
    try {
      resolveProviderByName(providerName);
      return true;
    } catch {
      return false;
    }
  });

  return [
    "Session provider override",
    "```",
    `session=${input.sessionId}`,
    `agent=${input.agentId}`,
    `override=${input.overrideProvider ?? "-"}`,
    `configured=${input.configuredProviders.length > 0 ? input.configuredProviders.join("|") : "-"}`,
    `effective=${input.effectiveProviders.length > 0 ? input.effectiveProviders.join("|") : "-"}`,
    `supported=${supportedProviders.length > 0 ? supportedProviders.join("|") : "-"}`,
    "```"
  ].join("\n");
}

function metadataBoolean(
  metadata: Record<string, unknown> | null,
  key: string
): boolean | undefined {
  const value = metadata?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function metadataNumber(metadata: Record<string, unknown> | null, key: string): number | undefined {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function metadataString(metadata: Record<string, unknown> | null, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map((item) => asRecord(item)).filter((item): item is Record<string, unknown> => item !== null) : [];
}

function yesNo(value: boolean | undefined): string {
  return value === true ? "yes" : value === false ? "no" : "-";
}

function truncateDiagnosticText(input: string, maxChars: number): string {
  const normalized = input.replace(/\s+/gu, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(maxChars - 3, 1))}...`;
}

function formatPromptSnapshotSummary(snapshot: {
  modelRunId: number;
  sessionId: string;
  agentId: string;
  providerName: string;
  requestMessageId: number | null;
  responseMessageId: number | null;
  promptText: string;
  systemPrompt: string | null;
  warmStartPrompt: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  expiresAt: string;
}, modelRun: ModelRunRecord | null): string {
  const warmStartContext = asRecord(snapshot.metadata?.warmStartContext);
  const memoryPrompt = asRecord(warmStartContext?.memoryPrompt);
  const memoryTrace = asRecord(memoryPrompt?.trace);
  const traceMemories = asRecordArray(memoryTrace?.memories);
  const traceSummaries = asRecordArray(memoryTrace?.summaries);
  const tracePinnedFacts = asRecordArray(memoryTrace?.pinnedFacts);
  const traceRecentMessages = asRecordArray(memoryTrace?.recentMessages);
  const attemptedRequests = asRecordArray(snapshot.metadata?.attemptedRequests);
  const strategy = metadataString(warmStartContext, "strategy") ?? "none";
  const orchestratorContinuityMode =
    metadataString(snapshot.metadata, "orchestratorContinuityMode") ??
    metadataString(warmStartContext, "orchestratorContinuityMode") ??
    "-";
  const promptPreview = truncateDiagnosticText(snapshot.promptText, 480);
  const memoryLines = traceMemories.slice(0, 3).map((memory) => {
    const score = typeof memory.score === "number" ? memory.score.toFixed(3) : "-";
    const source = typeof memory.source === "string" ? memory.source : "-";
    const content = typeof memory.content === "string" ? truncateDiagnosticText(memory.content, 96) : "";
    return `  - [${source}] score=${score} ${content}`;
  });

  return [
    "Prompt snapshot",
    "```",
    `run=${snapshot.modelRunId}`,
    `session=${snapshot.sessionId}`,
    `agent=${snapshot.agentId}`,
    `provider=${snapshot.providerName}`,
    `model=${modelRun?.model ?? "-"}`,
    `request_message=${snapshot.requestMessageId ?? "-"}`,
    `response_message=${snapshot.responseMessageId ?? "-"}`,
    `created=${snapshot.createdAt}`,
    `expires=${snapshot.expiresAt}`,
    `prompt_chars=${snapshot.promptText.length}`,
    `system_chars=${snapshot.systemPrompt?.length ?? 0}`,
    `warm_start_chars=${snapshot.warmStartPrompt?.length ?? 0}`,
    `continuity_mode=${orchestratorContinuityMode}`,
    `strategy=${strategy}`,
    `turn_warm_start=${yesNo(metadataBoolean(snapshot.metadata, "turnWarmStartUsed"))}`,
    `request_warm_start=${yesNo(metadataBoolean(snapshot.metadata, "requestWarmStartUsed"))}`,
    `worker_synthesis=${yesNo(metadataBoolean(snapshot.metadata, "usedWorkerSynthesis"))}`,
    `attempted_requests=${attemptedRequests.length}`,
    `memory_trace=pinned:${tracePinnedFacts.length} summaries:${traceSummaries.length} memories:${traceMemories.length} recent:${traceRecentMessages.length}`,
    ...(memoryLines.length > 0 ? ["top_memories:", ...memoryLines] : []),
    "prompt_preview:",
    promptPreview,
    "```",
  ].join("\n");
}

function renderPromptSnapshotMarkdown(snapshot: {
  modelRunId: number;
  sessionId: string;
  agentId: string;
  providerName: string;
  requestMessageId: number | null;
  responseMessageId: number | null;
  promptText: string;
  systemPrompt: string | null;
  warmStartPrompt: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  expiresAt: string;
}, modelRun: ModelRunRecord | null): string {
  const warmStartContext = asRecord(snapshot.metadata?.warmStartContext);
  const memoryPrompt = asRecord(warmStartContext?.memoryPrompt);
  const memoryTrace = asRecord(memoryPrompt?.trace);
  const traceMemories = asRecordArray(memoryTrace?.memories);
  const traceSummaries = asRecordArray(memoryTrace?.summaries);
  const tracePinnedFacts = asRecordArray(memoryTrace?.pinnedFacts);
  const traceRecentMessages = asRecordArray(memoryTrace?.recentMessages);
  const contextPacket = asRecord(warmStartContext?.contextPacket);
  const attemptedRequests = asRecordArray(snapshot.metadata?.attemptedRequests);
  const initialRequestPrompt = metadataString(snapshot.metadata, "initialRequestPrompt");
  const orchestratorContinuityMode =
    metadataString(snapshot.metadata, "orchestratorContinuityMode") ??
    metadataString(warmStartContext, "orchestratorContinuityMode") ??
    "-";
  const lines = [
    "# Prompt Snapshot",
    "",
    "## Run",
    `- run_id: ${snapshot.modelRunId}`,
    `- session_id: ${snapshot.sessionId}`,
    `- agent_id: ${snapshot.agentId}`,
    `- provider_name: ${snapshot.providerName}`,
    `- model: ${modelRun?.model ?? "-"}`,
    `- request_message_id: ${snapshot.requestMessageId ?? "-"}`,
    `- response_message_id: ${snapshot.responseMessageId ?? "-"}`,
    `- created_at: ${snapshot.createdAt}`,
    `- expires_at: ${snapshot.expiresAt}`,
    `- orchestrator_continuity_mode: ${orchestratorContinuityMode}`,
    `- turn_warm_start_used: ${yesNo(metadataBoolean(snapshot.metadata, "turnWarmStartUsed"))}`,
    `- request_warm_start_used: ${yesNo(metadataBoolean(snapshot.metadata, "requestWarmStartUsed"))}`,
    `- used_worker_synthesis: ${yesNo(metadataBoolean(snapshot.metadata, "usedWorkerSynthesis"))}`,
    "",
  ];

  if (snapshot.systemPrompt) {
    lines.push("## System Prompt", "", "```text", snapshot.systemPrompt, "```", "");
  }

  if (snapshot.warmStartPrompt) {
    lines.push("## Warm Start Prompt", "", "```text", snapshot.warmStartPrompt, "```", "");
  }

  if (initialRequestPrompt && initialRequestPrompt !== snapshot.promptText) {
    lines.push("## Initial Request Prompt", "", "```text", initialRequestPrompt, "```", "");
  }

  lines.push("## Final Request Prompt", "", "```text", snapshot.promptText, "```", "");

  if (memoryPrompt) {
    lines.push(
      "## Memory Prompt Diagnostics",
      "",
      `- estimated_tokens: ${typeof memoryPrompt.estimatedTokens === "number" ? memoryPrompt.estimatedTokens : "-"}`,
      `- used_full_history: ${yesNo(typeof memoryPrompt.usedFullHistory === "boolean" ? memoryPrompt.usedFullHistory : undefined)}`,
      ""
    );
  } else if (contextPacket) {
    lines.push("## Context Packet Diagnostics", "", "```json", JSON.stringify(contextPacket, null, 2), "```", "");
  }

  if (tracePinnedFacts.length > 0) {
    lines.push("## Pinned Facts", "");
    for (const fact of tracePinnedFacts) {
      const key = typeof fact.key === "string" ? fact.key : "?";
      const value = typeof fact.value === "string" ? fact.value : "";
      const scope = typeof fact.scope === "string" ? fact.scope : "-";
      lines.push(`- [${scope}] ${key}: ${value}`);
    }
    lines.push("");
  }

  if (traceSummaries.length > 0) {
    lines.push("## Summaries", "");
    for (const summary of traceSummaries) {
      const through = typeof summary.coversThroughMessageId === "number" ? summary.coversThroughMessageId : "?";
      const text = typeof summary.summaryText === "string" ? summary.summaryText : "";
      lines.push(`- [through ${through}] ${text}`);
    }
    lines.push("");
  }

  if (traceMemories.length > 0) {
    lines.push("## Retrieved Memories", "");
    for (const memory of traceMemories) {
      const source = typeof memory.source === "string" ? memory.source : "-";
      const score = typeof memory.score === "number" ? memory.score.toFixed(3) : "-";
      const content = typeof memory.content === "string" ? memory.content : "";
      lines.push(`- [${source}] score=${score} ${content}`);
    }
    lines.push("");
  }

  if (traceRecentMessages.length > 0) {
    lines.push("## Recent Messages", "");
    for (const message of traceRecentMessages) {
      const direction = typeof message.direction === "string" ? message.direction : "-";
      const content = typeof message.content === "string" ? message.content : "";
      lines.push(`- [${direction}] ${content}`);
    }
    lines.push("");
  }

  if (attemptedRequests.length > 0) {
    lines.push("## Attempted Requests", "");
    for (const attempt of attemptedRequests) {
      const providerName = typeof attempt.providerName === "string" ? attempt.providerName : "-";
      const providerSessionId =
        typeof attempt.providerSessionId === "string" && attempt.providerSessionId.length > 0
          ? attempt.providerSessionId
          : "-";
      const promptText = typeof attempt.promptText === "string" ? attempt.promptText : "";
      lines.push(
        `### ${providerName}`,
        "",
        `- provider_session_id: ${providerSessionId}`,
        `- warm_start_used: ${yesNo(typeof attempt.warmStartUsed === "boolean" ? attempt.warmStartUsed : undefined)}`,
        "",
        "```text",
        promptText,
        "```",
        ""
      );
    }
  }

  return lines.join("\n").trim();
}

function formatSessionContinuityReport(input: {
  sessionId: string;
  agentId: string;
  conversationKey: string;
  configuredProviders: string[];
  effectiveProviders: string[];
  overrideProvider?: string;
  providerSessions: ProviderSessionRecord[];
  recentRuns: ModelRunRecord[];
  compactSummary?: string;
}): string {
  const providerSessionByName = new Map<string, ProviderSessionRecord>();
  for (const row of input.providerSessions) {
    if (!providerSessionByName.has(row.providerName)) {
      providerSessionByName.set(row.providerName, row);
    }
  }

  const continuityLines = input.effectiveProviders.map((providerName) => {
    const row = providerSessionByName.get(providerName);
    return [
      `provider=${providerName}`,
      `continuity=${row?.providerSessionId ?? "-"}`,
      `updated=${row?.updatedAt ?? "-"}`
    ].join(" ");
  });

  const extraRows = input.providerSessions.filter(
    (row) => !input.effectiveProviders.includes(row.providerName)
  );
  for (const row of extraRows) {
    continuityLines.push(
      [
        `provider=${row.providerName}`,
        `continuity=${row.providerSessionId}`,
        `updated=${row.updatedAt}`,
        "extra=yes"
      ].join(" ")
    );
  }

  if (continuityLines.length === 0) {
    continuityLines.push("provider=- continuity=- updated=-");
  }

  const runLines =
    input.recentRuns.length > 0
      ? input.recentRuns.map((run) => {
          const warmStartUsed = metadataBoolean(run.metadata, "warmStartUsed");
          const warmStartContextChars = metadataNumber(run.metadata, "warmStartContextChars");
          return [
            `run=${run.id}`,
            `provider=${run.providerName}`,
            `error=${run.isError ? "yes" : "no"}`,
            `warm_start=${warmStartUsed === true ? "yes" : warmStartUsed === false ? "no" : "-"}`,
            `context_chars=${warmStartContextChars ?? "-"}`,
            `at=${run.createdAt}`
          ].join(" ");
        })
      : ["(no recent model runs)"];
  const headerLines = [
    "Session continuity",
    `session=${input.sessionId}`,
    `agent=${input.agentId}`,
    `conversation=${input.conversationKey}`,
    `override=${input.overrideProvider ?? "-"}`,
    `configured=${input.configuredProviders.length > 0 ? input.configuredProviders.join("|") : "-"}`,
    `effective=${input.effectiveProviders.length > 0 ? input.effectiveProviders.join("|") : "-"}`,
    `compaction_summary_chars=${input.compactSummary?.length ?? 0}`,
    "continuity:",
    ...continuityLines.map((line) => `  ${line}`),
    "recent_runs:"
  ];

  const visibleRunLines: string[] = [];
  for (const line of runLines) {
    const candidate = ["Session continuity", "```", ...headerLines, ...visibleRunLines, `  ${line}`, "```"].join("\n");
    if (candidate.length > 1900) break;
    visibleRunLines.push(`  ${line}`);
  }
  const truncatedRuns = runLines.length - visibleRunLines.length;
  if (truncatedRuns > 0) {
    visibleRunLines.push(`  ... truncated_runs=${truncatedRuns}`);
  }

  return ["Session continuity", "```", ...headerLines, ...visibleRunLines, "```"].join("\n");
}

function canRunAdminCommand(interaction: ChatInputCommandInteraction): boolean {
  return (
    interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) === true ||
    interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) === true
  );
}

function resetOptionsFromMode(mode: "continuity" | "diagnostics" | "hard"): {
  clearHistory: boolean;
  clearDiagnostics: boolean;
} {
  if (mode === "hard") {
    return { clearHistory: true, clearDiagnostics: true };
  }
  if (mode === "diagnostics") {
    return { clearHistory: false, clearDiagnostics: true };
  }
  return { clearHistory: false, clearDiagnostics: false };
}

function hasMentionForBot(message: Message): boolean {
  const botId = client.user?.id;
  if (!botId) return false;
  return message.mentions.users.has(botId);
}

function writeMessage(input: MessageInsertInput): number | null {
  try {
    return storage.insertMessage(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[tango-storage] failed to write message", message);
    return null;
  }
}

function isSmokeTestChannelId(channelId: string | null | undefined): boolean {
  const normalized = channelId?.trim();
  return normalized ? smokeTestChannelIds.has(normalized) : false;
}

function writeModelRun(input: ModelRunInsertInput): number | null {
  try {
    return storage.insertModelRun(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[tango-storage] failed to write model run", message);
    return null;
  }
}

function writePromptSnapshot(input: PromptSnapshotInsertInput): number | null {
  try {
    return storage.insertPromptSnapshot(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[tango-storage] failed to write prompt snapshot", message);
    return null;
  }
}

function writeDeadLetter(input: DeadLetterInsertInput): number | null {
  try {
    return storage.insertDeadLetter(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[tango-storage] failed to write dead letter", message);
    return null;
  }
}

function upsertSessionForRoute(
  route: { sessionId: string; agentId: string },
  fallbackChannel = "discord:default"
): void {
  const sessionConfig: SessionConfig =
    sessionConfigById.get(route.sessionId) ?? {
      id: route.sessionId,
      type: route.sessionId.startsWith("project:") ? "project" : "persistent",
      agent: route.agentId,
      channels: [fallbackChannel]
    };

  try {
    storage.upsertSession(sessionConfig);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[tango-storage] failed to upsert session", message);
  }
}

function providerContinuityKey(conversationKey: string, providerName: string): string {
  return `${conversationKey}::${providerName}`;
}

function loadPersistedProviderSession(
  conversationKey: string,
  providerName: string
): string | undefined {
  const normalizedProviderName = providerName.trim();
  const cacheKey = providerContinuityKey(conversationKey, normalizedProviderName);
  const cached = providerSessionByConversation.get(cacheKey);
  if (cached) return cached;

  try {
    const providerSession = storage.getProviderSession(conversationKey, normalizedProviderName);
    if (!providerSession) return undefined;
    providerSessionByConversation.set(cacheKey, providerSession.providerSessionId);
    return providerSession.providerSessionId;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[tango-storage] failed to load provider session", message);
    return undefined;
  }
}

function loadProviderContinuityMap(
  conversationKey: string,
  providerNames: string[]
): ProviderContinuityMap {
  const continuity: ProviderContinuityMap = {};
  for (const providerName of providerNames) {
    const providerSessionId = loadPersistedProviderSession(conversationKey, providerName);
    if (providerSessionId) {
      continuity[providerName] = providerSessionId;
    }
  }
  return continuity;
}

function clearProviderContinuityCacheForSession(sessionId: string): void {
  const prefix = `${sessionId}:`;
  for (const key of providerSessionByConversation.keys()) {
    if (key.startsWith(prefix)) {
      providerSessionByConversation.delete(key);
    }
  }
}

function savePersistedProviderSession(input: {
  conversationKey: string;
  sessionId: string;
  agentId: string;
  providerName: string;
  providerSessionId: string;
}): void {
  const cacheKey = providerContinuityKey(input.conversationKey, input.providerName);
  providerSessionByConversation.set(cacheKey, input.providerSessionId);
  try {
    storage.upsertProviderSession(input);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[tango-storage] failed to save provider session", message);
  }
}

async function buildWarmStartContext(input: {
  sessionId: string;
  agentId: string;
  currentUserPrompt?: string;
  excludeMessageIds?: number[];
  orchestratorContinuityMode?: OrchestratorContinuityMode;
  discordChannelId?: string | null;
}): Promise<WarmStartContextResult> {
  try {
    const allMessages = storage.listMessagesForSession(input.sessionId, 5000);
    const recentChannelMessages =
      input.discordChannelId
        ? storage.listRecentMessagesForDiscordChannel(input.discordChannelId, 80)
        : [];
    const {
      messages,
      supplementalMessageCount,
    } = selectWarmStartMessages({
      sessionMessages: allMessages,
      recentChannelMessages,
      channelId: input.discordChannelId,
      agentId: input.agentId,
    });
    const sessionConfig = resolveEffectiveSessionConfig(input.sessionId);
    const memoryConfig = resolveSessionMemoryConfig(sessionConfig?.memory);
    const orchestratorContinuityMode = input.orchestratorContinuityMode ?? "provider";
    const memories = storage.listMemories({
      sessionId: input.sessionId,
      agentId: input.agentId,
      limit: Math.max(memoryConfig.memoryLimit * 25, 5000),
    });
    const queryEmbedding =
      input.currentUserPrompt &&
      memories.some((memory) => typeof memory.embeddingJson === "string" && memory.embeddingJson.length > 0)
        ? await maybeEmbedText(input.currentUserPrompt, "query", "warm-start query")
        : null;
    const memoryPrompt = assembleSessionMemoryPrompt({
      sessionId: input.sessionId,
      agentId: input.agentId,
      currentUserPrompt: input.currentUserPrompt,
      queryEmbedding,
      allowFullHistoryBypass: orchestratorContinuityMode !== "stateless",
      memoryConfig,
      messages,
      summaries: storage.listSessionMemorySummaries(input.sessionId, input.agentId, 24),
      memories,
      pinnedFacts: storage.listPinnedFactsForContext(input.sessionId, input.agentId),
      excludeMessageIds: input.excludeMessageIds,
    });

    if (memoryPrompt.accessedMemoryIds.length > 0) {
      storage.touchMemories(memoryPrompt.accessedMemoryIds);
    }

    const prompt = memoryPrompt.prompt.trim();
    if (prompt.length > 0) {
      return {
        prompt,
        diagnostics: {
          strategy: "session-memory-prompt",
          orchestratorContinuityMode,
          channelSurfaceSupplementalMessages: supplementalMessageCount,
          memoryPrompt: {
            estimatedTokens: memoryPrompt.estimatedTokens,
            usedFullHistory: memoryPrompt.usedFullHistory,
            trace: memoryPrompt.trace,
          },
        },
      };
    }

    const modelRuns = storage.listModelRunsForSession(input.sessionId, 5000);
    const compaction = storage.getSessionCompaction(input.sessionId, input.agentId);
    const packet = buildContextPacket({
      sessionId: input.sessionId,
      agentId: input.agentId,
      messages,
      modelRuns,
      compactSummary: compaction?.summaryText,
      excludeMessageIds: input.excludeMessageIds,
      maxTurns: compaction ? 6 : 8,
      maxToolOutcomes: 3,
      maxContentCharsPerTurn: 280
    });
    const fallbackPrompt = renderContextPacket(packet, { maxChars: 2400 }).trim();
    return fallbackPrompt.length > 0
        ? {
            prompt: fallbackPrompt,
            diagnostics: {
              strategy: "context-packet",
              orchestratorContinuityMode,
              channelSurfaceSupplementalMessages: supplementalMessageCount,
              contextPacket: packet,
            },
          }
        : {
            diagnostics: {
              strategy: "none",
              orchestratorContinuityMode,
              channelSurfaceSupplementalMessages: supplementalMessageCount,
            },
          };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[tango-discord] failed to build warm-start context packet", message);
    return {
      diagnostics: {
        strategy: "none",
        orchestratorContinuityMode: input.orchestratorContinuityMode ?? "provider",
        error: message,
      },
    };
  }
}

async function buildWarmStartContextPrompt(input: {
  sessionId: string;
  agentId: string;
  currentUserPrompt?: string;
  excludeMessageIds?: number[];
  discordChannelId?: string | null;
}): Promise<string | undefined> {
  const result = await buildWarmStartContext(input);
  return result.prompt;
}

async function maybeEmbedText(
  text: string,
  inputType: "query" | "document",
  context: string,
): Promise<number[] | null> {
  const provider = getEmbeddingProvider();
  if (!provider) return null;

  const normalized = text.trim();
  if (normalized.length === 0) return null;

  try {
    const [embedding] = await provider.embed([normalized], inputType);
    return embedding && embedding.length > 0 ? embedding : null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[tango-memory] failed to embed ${context}: ${message}`);
    return null;
  }
}

function embedMemoryInBackground(input: { memoryId: number; content: string }): void {
  const provider = getEmbeddingProvider();
  if (!provider) return;

  void maybeEmbedText(input.content, "document", `memory ${input.memoryId}`).then((embedding) => {
    if (!embedding) return;

    try {
      storage.updateMemoryEmbedding({
        memoryId: input.memoryId,
        embeddingJson: serializeEmbedding(embedding),
        embeddingModel: provider.model,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[tango-memory] failed to persist embedding for memory ${input.memoryId}: ${message}`);
    }
  });
}

function maybeCompactSessionMemory(input: { sessionId: string; agentId: string }): void {
  try {
    maybePersistConversationMemory(input);

    const messages = storage.listMessagesForSession(input.sessionId, 5000);
    const plan = planSessionCompaction({
      sessionId: input.sessionId,
      agentId: input.agentId,
      messages,
      triggerTurns: memoryCompactionTriggerTurns,
      retainRecentTurns: memoryCompactionRetainRecentTurns,
      maxSummaryTurns: 16,
      maxTurnChars: 180,
      maxSummaryChars: memoryCompactionSummaryMaxChars
    });

    if (!plan.shouldCompact || !plan.summaryText) return;

    const existing = storage.getSessionCompaction(input.sessionId, input.agentId);
    if (
      existing &&
      existing.summaryText === plan.summaryText &&
      existing.compactedTurns === plan.compactedTurns
    ) {
      return;
    }

    storage.upsertSessionCompaction({
      sessionId: input.sessionId,
      agentId: input.agentId,
      summaryText: plan.summaryText,
      compactedTurns: plan.compactedTurns
    });
    console.log(
      `[tango-discord] memory compacted session=${input.sessionId} agent=${input.agentId} compacted_turns=${plan.compactedTurns} total_turns=${plan.totalTurns}`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[tango-discord] failed to compact session memory", message);
  }
}

function maybePersistConversationMemory(input: { sessionId: string; agentId: string }): void {
  const sessionConfig = resolveEffectiveSessionConfig(input.sessionId);
  const memoryConfig = resolveSessionMemoryConfig(sessionConfig?.memory);
  const messages = storage
    .listMessagesForSession(input.sessionId, 5000)
    .filter((message) => message.agentId === input.agentId)
    .filter((message) => message.direction === "inbound" || message.direction === "outbound");

  const latestSummary = storage.getLatestSessionMemorySummary(input.sessionId, input.agentId);
  const lastCoveredMessageId = latestSummary?.coversThroughMessageId ?? 0;
  const pendingMessages = messages.filter((message) => message.id > lastCoveredMessageId);

  if (pendingMessages.length < memoryConfig.summarizeWindow) {
    return;
  }

  const batch = pendingMessages.slice(0, memoryConfig.summarizeWindow);
  const coversThroughMessageId = batch.at(-1)?.id;
  if (!coversThroughMessageId) return;

  const summaryText = buildDeterministicConversationSummary(batch);
  if (summaryText.trim().length > 0) {
    storage.upsertSessionMemorySummary({
      sessionId: input.sessionId,
      agentId: input.agentId,
      summaryText,
      tokenCount: estimateTokenCount(summaryText),
      coversThroughMessageId,
    });
  }

  const memoryText = buildDeterministicConversationMemory(batch);
  const importance = estimateConversationImportance(batch);
  if (memoryText.trim().length > 0 && importance >= memoryConfig.importanceThreshold) {
    const memoryId = storage.insertMemory({
      sessionId: input.sessionId,
      agentId: input.agentId,
      source: "conversation",
      content: memoryText,
      importance,
      sourceRef: `message:${batch[0]?.id ?? "?"}-${coversThroughMessageId}`,
      metadata: {
        messageIds: batch.map((message) => message.id),
        keywords: extractMemoryKeywords(memoryText),
        summaryText,
      }
    });
    embedMemoryInBackground({ memoryId, content: memoryText });

    const sessionMemories = storage.listMemories({
      sessionId: input.sessionId,
      agentId: input.agentId,
      source: "conversation",
      limit: Math.max(memoryConfig.memoryLimit * 4, memoryConfig.memoryLimit + 20),
    });
    const archiveIds = selectMemoriesToArchive(sessionMemories, memoryConfig.memoryLimit);
    for (const memoryId of archiveIds) {
      storage.archiveMemory(memoryId);
    }
  }
}

function attachmentsForMetadata(message: Message): Array<Record<string, unknown>> {
  return [...message.attachments.values()].map((attachment) => ({
    id: attachment.id,
    name: attachment.name,
    url: attachment.url,
    contentType: attachment.contentType,
    size: attachment.size
  }));
}

function tangoCommandPayload(): RESTPostAPIApplicationCommandsJSONBody {
  return new SlashCommandBuilder()
    .setName("tango")
    .setDescription("Tango operational commands")
    .setDMPermission(false)
    .addSubcommand((subcommand) => subcommand.setName("status").setDescription("Show Tango status"))
    .addSubcommand((subcommand) =>
      subcommand
        .setName("deadletters")
        .setDescription("List dead-letter entries")
        .addStringOption((option) =>
          option
            .setName("status")
            .setDescription("Entry status filter")
            .setRequired(false)
            .addChoices(
              { name: "pending", value: "pending" },
              { name: "resolved", value: "resolved" },
              { name: "all", value: "all" }
            )
        )
        .addStringOption((option) =>
          option.setName("session").setDescription("Filter by session ID").setRequired(false)
        )
        .addIntegerOption((option) =>
          option
            .setName("limit")
            .setDescription("Maximum entries (1-25)")
            .setRequired(false)
            .setMinValue(1)
            .setMaxValue(25)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("access")
        .setDescription("Show effective access policy for agents in this channel")
        .addStringOption((option) =>
          option
            .setName("agent")
            .setDescription("Optional agent ID filter")
            .setRequired(false)
        )
        .addStringOption((option) =>
          option
            .setName("user")
            .setDescription("Discord user ID to evaluate (defaults to invoking user)")
            .setRequired(false)
        )
        .addBooleanOption((option) =>
          option
            .setName("mentioned")
            .setDescription("Evaluate as if bot was mentioned")
            .setRequired(false)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("capabilities")
        .setDescription("Show effective access + tool capabilities for agents in this channel")
        .addStringOption((option) =>
          option
            .setName("agent")
            .setDescription("Optional agent ID filter")
            .setRequired(false)
        )
        .addStringOption((option) =>
          option
            .setName("user")
            .setDescription("Discord user ID to evaluate access against (defaults to invoking user)")
            .setRequired(false)
        )
        .addBooleanOption((option) =>
          option
            .setName("mentioned")
            .setDescription("Evaluate access as if bot was mentioned")
            .setRequired(false)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("replay")
        .setDescription("Replay a dead-letter entry")
        .addIntegerOption((option) =>
          option.setName("id").setDescription("Dead-letter ID").setRequired(true).setMinValue(1)
        )
        .addBooleanOption((option) =>
          option
            .setName("force")
            .setDescription("Replay even if the entry is already resolved")
            .setRequired(false)
        )
        .addBooleanOption((option) =>
          option
            .setName("post")
            .setDescription("Post the replayed response in this channel")
            .setRequired(false)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("trigger")
        .setDescription("Manually trigger a scheduled job")
        .addStringOption((option) =>
          option.setName("schedule").setDescription("Schedule ID to trigger").setRequired(true)
        )
    )
    .addSubcommandGroup((group) =>
      group
        .setName("session")
        .setDescription("Session operations")
        .addSubcommand((subcommand) =>
          subcommand
            .setName("reset")
            .setDescription("Reset session continuity and/or diagnostics")
            .addStringOption((option) =>
              option.setName("id").setDescription("Session ID").setRequired(true)
            )
            .addBooleanOption((option) =>
              option
                .setName("confirm")
                .setDescription("Set true to confirm reset")
                .setRequired(true)
            )
            .addStringOption((option) =>
              option
                .setName("mode")
                .setDescription("Reset mode")
                .setRequired(false)
                .addChoices(
                  { name: "continuity", value: "continuity" },
                  { name: "diagnostics", value: "diagnostics" },
                  { name: "hard", value: "hard" }
                )
            )
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("provider")
            .setDescription("Show or set session-level provider override")
            .addStringOption((option) =>
              option.setName("id").setDescription("Session ID").setRequired(true)
            )
            .addStringOption((option) =>
              option.setName("agent").setDescription("Agent ID").setRequired(true)
            )
            .addStringOption((option) =>
              option
                .setName("provider")
                .setDescription("Provider name to set as override")
                .setRequired(false)
            )
            .addBooleanOption((option) =>
              option
                .setName("clear")
                .setDescription("Clear existing override")
                .setRequired(false)
            )
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("continuity")
            .setDescription("Show provider continuity and warm-start diagnostics")
            .addStringOption((option) =>
              option.setName("id").setDescription("Session ID").setRequired(true)
            )
            .addStringOption((option) =>
              option.setName("agent").setDescription("Agent ID").setRequired(true)
            )
            .addIntegerOption((option) =>
              option
                .setName("runs")
                .setDescription("Recent model runs to include (1-20)")
                .setRequired(false)
                .setMinValue(1)
                .setMaxValue(20)
            )
        )
        .addSubcommand((subcommand) =>
          subcommand
            .setName("snapshot")
            .setDescription("Inspect a stored prompt snapshot by run or message id")
            .addIntegerOption((option) =>
              option
                .setName("run")
                .setDescription("Model run ID")
                .setRequired(false)
                .setMinValue(1)
            )
            .addIntegerOption((option) =>
              option
                .setName("request_message")
                .setDescription("Inbound request message ID")
                .setRequired(false)
                .setMinValue(1)
            )
            .addIntegerOption((option) =>
              option
                .setName("response_message")
                .setDescription("Outbound response message ID")
                .setRequired(false)
                .setMinValue(1)
            )
            .addBooleanOption((option) =>
              option
                .setName("full")
                .setDescription("Attach the full snapshot as markdown")
                .setRequired(false)
            )
        )
    )
    .toJSON();
}

async function registerSlashCommands(): Promise<void> {
  if (!client.application) {
    return;
  }

  const commands = [tangoCommandPayload()];
  if (commandGuildId) {
    await client.application.commands.set(commands, commandGuildId);
    console.log(`[tango-discord] registered slash commands in guild=${commandGuildId}`);
    return;
  }

  await client.application.commands.set(commands);
  console.log("[tango-discord] registered global slash commands");
}

async function handleStatusCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.reply({
    content: formatHealthStatus(),
    ephemeral: true
  });
}

async function handleDeadLettersCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const status = (interaction.options.getString("status") ?? "pending") as
    | "pending"
    | "resolved"
    | "all";
  const sessionId = interaction.options.getString("session") ?? undefined;
  const limit = interaction.options.getInteger("limit") ?? 10;

  await interaction.reply({
    content: formatDeadLettersList({ status, sessionId, limit }),
    ephemeral: true
  });
}

async function handleAccessCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const agentFilter = interaction.options.getString("agent") ?? undefined;
  const userId = interaction.options.getString("user")?.trim() || interaction.user.id;
  const mentioned = interaction.options.getBoolean("mentioned") === true;

  await interaction.reply({
    content: formatAccessPolicyReport({
      channelId: interaction.channelId,
      userId,
      mentioned,
      agentFilter
    }),
    ephemeral: true
  });
}

async function handleCapabilitiesCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const agentFilter = interaction.options.getString("agent") ?? undefined;
  const userId = interaction.options.getString("user")?.trim() || interaction.user.id;
  const mentioned = interaction.options.getBoolean("mentioned") === true;

  await interaction.reply({
    content: formatCapabilitiesReport({
      channelId: interaction.channelId,
      userId,
      mentioned,
      agentFilter
    }),
    ephemeral: true
  });
}

async function handleSessionProviderCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const sessionId = interaction.options.getString("id", true).trim();
  const agentId = interaction.options.getString("agent", true).trim();
  const clearOverride = interaction.options.getBoolean("clear") === true;
  const providerOverride = interaction.options.getString("provider")?.trim();

  const summary = storage.getSessionSummary(sessionId);
  if (!summary) {
    await interaction.reply({
      content: `Session '${sessionId}' not found in persistence store.`,
      ephemeral: true
    });
    return;
  }

  const agent = agentRegistry.get(agentId);
  if (!agent) {
    await interaction.reply({
      content: `Agent '${agentId}' not found in config.`,
      ephemeral: true
    });
    return;
  }

  let result;
  try {
    result = applySessionProviderCommand({
      sessionId,
      agent,
      clearOverride,
      providerOverride,
      isSupportedProvider: (providerName) => {
        try {
          resolveProviderByName(providerName);
          return true;
        } catch {
          return false;
        }
      },
      store: {
        getOverride: (targetSessionId, targetAgentId) =>
          storage.getSessionProviderOverride(targetSessionId, targetAgentId)?.providerName,
        setOverride: (input) => {
          storage.upsertSessionProviderOverride(input);
        },
        clearOverride: (targetSessionId, targetAgentId) =>
          storage.clearSessionProviderOverride(targetSessionId, targetAgentId)
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await interaction.reply({
      content: message,
      ephemeral: true
    });
    return;
  }

  const report = formatSessionProviderReport({
    sessionId: result.sessionId,
    agentId: result.agentId,
    configuredProviders: result.configuredProviders,
    effectiveProviders: result.effectiveProviders,
    overrideProvider: result.overrideProviderName
  });

  if (result.status === "set") {
    await interaction.reply({
      content: [`Set session provider override to '${result.overrideProviderName}'.`, report].join("\n"),
      ephemeral: true
    });
    return;
  }

  if (result.status === "cleared" || result.status === "no-override") {
    await interaction.reply({
      content: [
        result.status === "cleared"
          ? "Cleared session provider override."
          : "No session provider override was set.",
        report
      ].join("\n"),
      ephemeral: true
    });
    return;
  }

  await interaction.reply({
    content: report,
    ephemeral: true
  });
}

async function handleSessionContinuityCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const sessionId = interaction.options.getString("id", true).trim();
  const agentId = interaction.options.getString("agent", true).trim();
  const runLimit = interaction.options.getInteger("runs") ?? 8;

  const summary = storage.getSessionSummary(sessionId);
  if (!summary) {
    await interaction.reply({
      content: `Session '${sessionId}' not found in persistence store.`,
      ephemeral: true
    });
    return;
  }

  const agent = agentRegistry.get(agentId);
  if (!agent) {
    await interaction.reply({
      content: `Agent '${agentId}' not found in config.`,
      ephemeral: true
    });
    return;
  }

  const providerSelection = resolveProviderNamesForTurn({
    sessionId,
    agent
  });
  const conversationKey = getConversationKey(sessionId, agent.id);
  const providerSessions = storage.listProviderSessionsForConversation(conversationKey, 40);
  const recentRuns = storage.listModelRunsForConversation(
    conversationKey,
    Number.isFinite(runLimit) ? Math.max(runLimit, 1) : 8
  );
  const compaction = storage.getSessionCompaction(sessionId, agent.id);

  await interaction.reply({
    content: formatSessionContinuityReport({
      sessionId,
      agentId: agent.id,
      conversationKey,
      configuredProviders: providerSelection.configuredProviderNames,
      effectiveProviders: providerSelection.providerNames,
      overrideProvider: providerSelection.overrideProviderName,
      providerSessions,
      recentRuns,
      compactSummary: compaction?.summaryText
    }),
    ephemeral: true
  });
}

async function handleSessionSnapshotCommand(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const runId = interaction.options.getInteger("run");
  const requestMessageId = interaction.options.getInteger("request_message");
  const responseMessageId = interaction.options.getInteger("response_message");
  const full = interaction.options.getBoolean("full") === true;
  const providedLookups = [runId, requestMessageId, responseMessageId].filter((value) => value !== null);

  if (providedLookups.length !== 1) {
    await interaction.reply({
      content: "Provide exactly one of `run`, `request_message`, or `response_message`.",
      ephemeral: true
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const snapshot =
    runId !== null
      ? storage.getPromptSnapshotByModelRunId(runId)
      : requestMessageId !== null
        ? storage.findPromptSnapshotByRequestMessageId(requestMessageId)
        : storage.findPromptSnapshotByResponseMessageId(responseMessageId as number);

  if (!snapshot) {
    const lookupLabel =
      runId !== null
        ? `run '${runId}'`
        : requestMessageId !== null
          ? `request message '${requestMessageId}'`
          : `response message '${responseMessageId}'`;
    await interaction.editReply(`Prompt snapshot for ${lookupLabel} was not found or has expired.`);
    return;
  }

  const modelRun = storage.getModelRun(snapshot.modelRunId);
  const summary = formatPromptSnapshotSummary(snapshot, modelRun);

  if (!full) {
    await interaction.editReply(summary);
    return;
  }

  const markdown = renderPromptSnapshotMarkdown(snapshot, modelRun);
  const attachment = new AttachmentBuilder(Buffer.from(markdown, "utf8"), {
    name: `prompt-snapshot-run-${snapshot.modelRunId}.md`,
  });

  await interaction.editReply({
    content: summary,
    files: [attachment]
  });
}

async function handleReplayCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const deadLetterId = interaction.options.getInteger("id", true);
  const forceReplay = interaction.options.getBoolean("force") === true;
  const postToChannel = interaction.options.getBoolean("post") === true;

  await interaction.deferReply({ ephemeral: true });

  const deadLetter = storage.getDeadLetter(deadLetterId);
  if (!deadLetter) {
    await interaction.editReply(`Dead-letter entry '${deadLetterId}' not found.`);
    return;
  }

  if (deadLetter.status === "resolved" && !forceReplay) {
    await interaction.editReply(
      `Dead-letter entry '${deadLetterId}' is already resolved. Set \`force=true\` to replay again.`
    );
    return;
  }

  const configuredAgent = agentRegistry.get(deadLetter.agentId);
  const providerTools = resolveProviderToolsForAgent(configuredAgent);
  const providerSelection = configuredAgent
    ? resolveProviderNamesForTurn({
        sessionId: deadLetter.sessionId,
        agent: configuredAgent
      })
    : undefined;
  const configuredProviderNames = providerSelection?.providerNames ?? [];
  const replayProviderNames = [
    deadLetter.providerName,
    ...configuredProviderNames.filter((name) => name !== deadLetter.providerName)
  ];

  let providerChain: Array<{ providerName: string; provider: ChatProvider }>;
  try {
    providerChain = resolveProviderChain(replayProviderNames);
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    await interaction.editReply(messageText);
    return;
  }

  const continuityByProvider = loadProviderContinuityMap(deadLetter.conversationKey, replayProviderNames);
  if (deadLetter.providerSessionId && deadLetter.providerSessionId.length > 0) {
    continuityByProvider[deadLetter.providerName] = deadLetter.providerSessionId;
  }
  const warmStartContext = await buildWarmStartContext({
    sessionId: deadLetter.sessionId,
    agentId: deadLetter.agentId,
    currentUserPrompt: deadLetter.promptText,
    excludeMessageIds: deadLetter.requestMessageId !== null ? [deadLetter.requestMessageId] : undefined,
    discordChannelId: deadLetter.discordChannelId,
  });
  const warmStartPrompt = warmStartContext.prompt;
  const warmStartContextChars = warmStartPrompt?.length ?? 0;

  let selectedProviderName = providerChain[0]?.providerName ?? deadLetter.providerName;
  let providerResolution = "dead-letter";
  let providerSessionId: string | undefined =
    continuityByProvider[selectedProviderName] ?? deadLetter.providerSessionId ?? undefined;
  let failoverFailures: ProviderFailoverFailure[] = [];

  try {
    const failoverResult = await generateWithFailover(
      providerChain,
      {
        prompt: deadLetter.promptText,
        systemPrompt: deadLetter.systemPrompt ?? undefined,
        tools: providerTools,
        model: providerSelection?.model,
        reasoningEffort: providerSelection?.reasoningEffort,
      },
      providerRetryLimit,
      continuityByProvider,
      { warmStartPrompt }
    );
    const { providerName, failures, retryResult, requestPrompt, warmStartUsed } = failoverResult;
    selectedProviderName = providerName;
    failoverFailures = failures;
    const response = retryResult.response;
    const toolTelemetry = extractToolTelemetry(response.raw);

    if (warmStartUsed) {
      console.log(
        `[tango-discord] replay warm-start applied session=${deadLetter.sessionId} agent=${deadLetter.agentId} provider=${providerName}`
      );
    }

    if (selectedProviderName !== deadLetter.providerName) {
      if (configuredProviderNames[0] === selectedProviderName) {
        providerResolution = "agent-default";
      } else {
        providerResolution = "agent-fallback";
      }
    }

    providerSessionId = response.providerSessionId ?? continuityByProvider[selectedProviderName];
    if (response.providerSessionId) {
      savePersistedProviderSession({
        conversationKey: deadLetter.conversationKey,
        sessionId: deadLetter.sessionId,
        agentId: deadLetter.agentId,
        providerName: selectedProviderName,
        providerSessionId: response.providerSessionId
      });
    }

    let postedChunks = 0;
    let postedDiscordMessageId: string | null = null;
    if (postToChannel && interaction.channel?.isSendable()) {
      const replaySpeaker = agentRegistry.get(deadLetter.agentId) ?? systemAgent;
      const delivery = await sendPresentedReply(interaction.channel, response.text, replaySpeaker);
      postedChunks = delivery.sentChunks;
      postedDiscordMessageId = delivery.lastMessageId ?? null;
    }

    const replaySpeaker = agentRegistry.get(deadLetter.agentId) ?? systemAgent;
    const replaySpeakerDisplayName = resolveSpeakerDisplayName(replaySpeaker, systemDisplayName);
    const responseMessageId = writeMessage({
      sessionId: deadLetter.sessionId,
      agentId: deadLetter.agentId,
      providerName: selectedProviderName,
      direction: "outbound",
      source: "tango",
      visibility: "internal",
      discordMessageId: postedDiscordMessageId,
      discordChannelId: deadLetter.discordChannelId,
      discordUserId: postToChannel ? null : client.user?.id ?? null,
      discordUsername: replaySpeakerDisplayName,
      content: response.text,
      metadata: {
        replaySource: "discord-command",
        deadLetterId: deadLetter.id,
        forceReplay,
        postToChannel,
        providerResolution,
        selectedProvider: selectedProviderName,
        providerFailures: failoverFailures,
        warmStartUsed,
        warmStartContextChars,
        postedChunks,
        presentedAs: replaySpeakerDisplayName,
        attemptCount: retryResult.attempts,
        attemptErrors: retryResult.attemptErrors
      }
    });

    const modelRunId = writeModelRun({
      sessionId: deadLetter.sessionId,
      agentId: deadLetter.agentId,
      providerName: selectedProviderName,
      conversationKey: deadLetter.conversationKey,
      providerSessionId: providerSessionId ?? null,
      model: response.metadata?.model,
      stopReason: response.metadata?.stopReason,
      responseMode: deadLetter.responseMode,
      providerDurationMs: response.metadata?.durationMs,
      providerApiDurationMs: response.metadata?.durationApiMs,
      inputTokens: response.metadata?.usage?.inputTokens,
      outputTokens: response.metadata?.usage?.outputTokens,
      cacheReadInputTokens: response.metadata?.usage?.cacheReadInputTokens,
      cacheCreationInputTokens: response.metadata?.usage?.cacheCreationInputTokens,
      totalCostUsd: response.metadata?.totalCostUsd,
      isError: false,
      requestMessageId: deadLetter.requestMessageId,
      responseMessageId,
      metadata: {
        replaySource: "discord-command",
        deadLetterId: deadLetter.id,
        forceReplay,
        postToChannel,
        providerResolution,
        selectedProvider: selectedProviderName,
        providerFailures: failoverFailures,
        warmStartUsed,
        warmStartContextChars,
        postedChunks,
        attemptCount: retryResult.attempts,
        attemptErrors: retryResult.attemptErrors,
        toolTelemetry
      },
      rawResponse:
        captureProviderRaw && response.raw && typeof response.raw === "object"
          ? (response.raw as Record<string, unknown>)
          : null
    });
    if (modelRunId !== null) {
      writePromptSnapshot({
        modelRunId,
        sessionId: deadLetter.sessionId,
        agentId: deadLetter.agentId,
        providerName: selectedProviderName,
        requestMessageId: deadLetter.requestMessageId,
        responseMessageId,
        promptText: requestPrompt,
        systemPrompt: deadLetter.systemPrompt ?? null,
        warmStartPrompt: warmStartPrompt ?? null,
        metadata: {
          inputSource: "discord-replay",
          responseMode: deadLetter.responseMode,
          promptChars: requestPrompt.length,
          systemPromptChars: deadLetter.systemPrompt?.length ?? 0,
          warmStartPromptChars: warmStartPrompt?.length ?? 0,
          replaySource: "discord-command",
          deadLetterId: deadLetter.id,
          forceReplay,
          postToChannel,
          providerResolution,
          selectedProvider: selectedProviderName,
          providerFailures: failoverFailures,
          turnWarmStartUsed: warmStartUsed,
          requestWarmStartUsed: warmStartUsed,
          attemptedRequests: [
            {
              providerName: selectedProviderName,
              providerSessionId: providerSessionId ?? null,
              warmStartUsed,
              promptText: requestPrompt,
            },
          ],
          warmStartContext: warmStartContext.diagnostics,
        },
      });
    }

    storage.resolveDeadLetter({
      id: deadLetter.id,
      resolvedMessageId: responseMessageId,
      resolvedModelRunId: modelRunId,
      incrementReplayCount: true,
      metadata: {
        replaySource: "discord-command",
        forceReplay,
        postToChannel,
        warmStartUsed,
        warmStartContextChars
      }
    });
    maybeCompactSessionMemory({
      sessionId: deadLetter.sessionId,
      agentId: deadLetter.agentId
    });

    const preview = truncate(response.text.replace(/\s+/gu, " ").trim(), 240);
    await interaction.editReply(
      [
        `Replayed dead-letter \`${deadLetter.id}\` successfully.`,
        `provider=${selectedProviderName} resolution=${providerResolution} attempts=${retryResult.attempts} posted_chunks=${postedChunks} warm_start=${warmStartUsed ? "yes" : "no"}`,
        `preview=${JSON.stringify(preview)}`
      ].join("\n")
    );
  } catch (error) {
    const failoverError = error instanceof ProviderFailoverError ? error : null;
    failoverFailures = failoverError?.failures ?? failoverFailures;
    const attemptedRequests = failoverError?.attemptedRequests ?? [];
    const finalAttempt = attemptedRequests.at(-1);
    const messageText = error instanceof Error ? error.message : String(error);
    storage.recordDeadLetterReplayFailure({
      id: deadLetter.id,
      errorMessage: messageText,
      metadata: {
        replaySource: "discord-command",
        forceReplay,
        postToChannel,
        providerResolution,
        selectedProvider: selectedProviderName,
        providerFailures: failoverFailures,
        warmStartContextChars
      }
    });

    const errorModelRunId = writeModelRun({
      sessionId: deadLetter.sessionId,
      agentId: deadLetter.agentId,
      providerName: selectedProviderName,
      conversationKey: deadLetter.conversationKey,
      providerSessionId: providerSessionId ?? null,
      responseMode: deadLetter.responseMode,
      isError: true,
      errorMessage: messageText,
      requestMessageId: deadLetter.requestMessageId,
      metadata: {
        replaySource: "discord-command",
        deadLetterId: deadLetter.id,
        forceReplay,
        postToChannel,
        providerResolution,
        selectedProvider: selectedProviderName,
        providerFailures: failoverFailures,
        warmStartContextChars,
        toolTelemetry: emptyToolTelemetry()
      },
      rawResponse: null
    });
    if (errorModelRunId !== null) {
      writePromptSnapshot({
        modelRunId: errorModelRunId,
        sessionId: deadLetter.sessionId,
        agentId: deadLetter.agentId,
        providerName: selectedProviderName,
        requestMessageId: deadLetter.requestMessageId,
        responseMessageId: null,
        promptText: finalAttempt?.promptText ?? deadLetter.promptText,
        systemPrompt: deadLetter.systemPrompt ?? null,
        warmStartPrompt: warmStartPrompt ?? null,
        metadata: {
          inputSource: "discord-replay",
          responseMode: deadLetter.responseMode,
          promptChars: finalAttempt?.promptText.length ?? deadLetter.promptText.length,
          systemPromptChars: deadLetter.systemPrompt?.length ?? 0,
          warmStartPromptChars: warmStartPrompt?.length ?? 0,
          replaySource: "discord-command",
          deadLetterId: deadLetter.id,
          forceReplay,
          postToChannel,
          providerResolution,
          selectedProvider: selectedProviderName,
          providerFailures: failoverFailures,
          failed: true,
          turnWarmStartUsed: attemptedRequests.some((attempt) => attempt.warmStartUsed),
          requestWarmStartUsed: finalAttempt?.warmStartUsed ?? false,
          attemptedRequests,
          warmStartContext: warmStartContext.diagnostics,
        },
      });
    }

    await interaction.editReply(`Replay failed for dead-letter '${deadLetter.id}': ${messageText}`);
  }
}

async function handleSessionResetCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const sessionId = interaction.options.getString("id", true).trim();
  const mode = (interaction.options.getString("mode") ?? "continuity") as
    | "continuity"
    | "diagnostics"
    | "hard";
  const confirm = interaction.options.getBoolean("confirm", true);

  if (!confirm) {
    await interaction.reply({
      content: "Reset cancelled. Set `confirm=true` to execute reset.",
      ephemeral: true
    });
    return;
  }

  const summary = storage.getSessionSummary(sessionId);
  if (!summary) {
    await interaction.reply({
      content: `Session '${sessionId}' not found in persistence store.`,
      ephemeral: true
    });
    return;
  }

  const result = storage.resetSession(sessionId, resetOptionsFromMode(mode));
  clearProviderContinuityCacheForSession(sessionId);
  await interaction.reply({
    content: [
      `Reset complete for session \`${sessionId}\` mode=\`${mode}\``,
      "```",
      `deleted_provider_sessions=${result.deletedProviderSessions}`,
      `deleted_messages=${result.deletedMessages}`,
      `deleted_model_runs=${result.deletedModelRuns}`,
      `deleted_dead_letters=${result.deletedDeadLetters}`,
      `deleted_prompt_snapshots=${result.deletedPromptSnapshots}`,
      "```"
    ].join("\n"),
    ephemeral: true
  });
}

async function deliverIMessageToDiscord(
  message: IMessageInboundMessage,
  channelId: string
): Promise<void> {
  if (!client.isReady()) {
    console.warn("[tango-imessage] Discord client not ready, skipping delivery");
    return;
  }

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    console.warn(`[tango-imessage] Discord channel ${channelId} not found or not text-based`);
    return;
  }

  const sender = message.displayName !== message.sender
    ? `**${message.displayName}** (${message.sender})`
    : `**${message.sender}**`;
  const groupLabel = message.isGroup ? ` in group chat ${message.chatId}` : "";
  const header = `iMessage from ${sender}${groupLabel}:`;
  const body = `${header}\n>>> ${message.content}`;

  const speaker = agentRegistry.get("dispatch") ?? null;
  await sendPresentedReply(channel as Message["channel"], body, speaker);
}

async function handleIMessageMessage(
  _listener: IMessageListener,
  message: IMessageInboundMessage
): Promise<void> {
  const route = resolveIMessageRoute(message.channelKey);

  console.log(
    `[tango-imessage] msg channel=${message.channelKey} user=${message.displayName} routed=${route?.sessionId ?? "none"}`
  );

  if (!route) {
    return;
  }

  upsertSessionForRoute(route, message.channelKey);

  const targetAgent = agentRegistry.get(route.agentId) ?? null;

  // Persist the inbound message
  writeMessage({
    sessionId: route.sessionId,
    agentId: route.agentId,
    direction: "inbound",
    source: "imessage",
    visibility: "public",
    content: message.content,
    metadata: buildIMessageMetadata(message, {
      routedAgentId: route.agentId,
      resolvedSessionId: route.sessionId,
      targetAgentId: targetAgent?.id ?? route.agentId,
      displayName: message.displayName
    })
  });

  // Deliver to Discord (observe mode — never reply via iMessage)
  const deliveryChannelId = imessageDiscordChannelId;
  if (deliveryChannelId) {
    try {
      await deliverIMessageToDiscord(message, deliveryChannelId);
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      console.error(`[tango-imessage] Discord delivery failed: ${errorText}`);
    }
  }

  console.log(
    `[tango-imessage] observed session=${route.sessionId} agent=${route.agentId} from=${message.displayName} len=${message.content.length}${deliveryChannelId ? ` delivered=discord:${deliveryChannelId}` : " delivered=none"}`
  );
}

async function handleTangoCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!canRunAdminCommand(interaction)) {
    await interaction.reply({
      content: "This command requires `Administrator` or `Manage Server` permission.",
      ephemeral: true
    });
    return;
  }

  const group = interaction.options.getSubcommandGroup(false);
  const subcommand = interaction.options.getSubcommand(true);

  if (group === "session" && subcommand === "reset") {
    await handleSessionResetCommand(interaction);
    return;
  }

  if (group === "session" && subcommand === "provider") {
    await handleSessionProviderCommand(interaction);
    return;
  }

  if (group === "session" && subcommand === "continuity") {
    await handleSessionContinuityCommand(interaction);
    return;
  }

  if (group === "session" && subcommand === "snapshot") {
    await handleSessionSnapshotCommand(interaction);
    return;
  }

  if (subcommand === "status") {
    await handleStatusCommand(interaction);
    return;
  }

  if (subcommand === "deadletters") {
    await handleDeadLettersCommand(interaction);
    return;
  }

  if (subcommand === "access") {
    await handleAccessCommand(interaction);
    return;
  }

  if (subcommand === "capabilities") {
    await handleCapabilitiesCommand(interaction);
    return;
  }

  if (subcommand === "replay") {
    await handleReplayCommand(interaction);
    return;
  }

  if (subcommand === "trigger") {
    const scheduleId = interaction.options.getString("schedule", true);
    if (!scheduler) {
      await interaction.reply({ content: "Scheduler not initialized.", ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    try {
      const result = await scheduler.trigger(scheduleId);
      if (!result) {
        await interaction.editReply(`Schedule \`${scheduleId}\` not found.`);
      } else {
        const errDetail = result.error ? `\n${result.error.slice(0, 300)}` : "";
        await interaction.editReply(`Triggered \`${scheduleId}\` — status: ${result.status}, duration: ${Math.round((result.durationMs ?? 0) / 1000)}s${errDetail}`);
      }
    } catch (err) {
      await interaction.editReply(`Trigger failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  await interaction.reply({
    content: "Unsupported Tango command.",
    ephemeral: true
  });
}

async function handleMessage(
  message: Message,
  options?: {
    existingInboundMessageId?: number | null;
    recoverySource?: "startup-orphan-check";
  }
): Promise<void> {
  const channelKey = toChannelKey(message);
  let route = sessionManager.route(channelKey) ?? sessionManager.route("discord:default");

  // If this message came from a Discord thread, check for a registered session override.
  // When an agent creates a thread from session X, replies route to the parent channel's
  // session by default — not X. The mapping lets us resume the originating session.
  // For forum threads with no registered mapping, auto-create a topic session so each
  // thread gets its own isolated conversation context.
  if (route && `discord:${message.channelId}` !== channelKey) {
    try {
      const threadSession = storage.getThreadSession(message.channelId);
      if (threadSession) {
        route = applyThreadSessionRoute(route, threadSession);
        // Backfill agent_id for threads created before agent tracking was added
        if (!threadSession.agentId && route.agentId) {
          storage.setThreadSession(message.channelId, threadSession.sessionId, route.agentId);
        }
      } else {
        // Auto-register forum/thread sessions: create a topic from the thread name
        // so each Discord thread gets its own Claude session instead of sharing the parent's.
        const threadChannel = message.channel;
        const threadName =
          "name" in threadChannel && typeof threadChannel.name === "string"
            ? threadChannel.name.trim()
            : null;
        if (threadName) {
          // Inherit the parent channel's project so the topic stays in context.
          const parentProjectId = parseProjectSessionId(route.sessionId) ?? null;
          const topic = upsertChannelTopic(channelKey, threadName, null, parentProjectId, true);
          const topicSessionId = buildTopicSessionId(topic.id);
          storage.setThreadSession(message.channelId, topicSessionId, route.agentId);
          route = { ...route, sessionId: topicSessionId };
          console.log(
            `[tango-discord] auto-registered thread session thread=${message.channelId} topic="${topic.title}" session=${topicSessionId} agent=${route.agentId}`
          );
        }
      }
    } catch (e: unknown) {
      console.error("[tango-discord] Failed to resolve thread session mapping:", e instanceof Error ? e.message : e);
    }
  }

  console.log(
    `[tango-discord] msg channel=${channelKey} user=${message.author.username} routed=${route?.sessionId ?? "none"}`
  );

  if (!route) {
    return;
  }

  upsertSessionForRoute(route);

  const effectiveContent = await resolveEffectiveContent(message);
  if (effectiveContent !== message.content) {
    console.log(
      `[tango-discord] resolved edge-case content: originalLen=${message.content.length} effectiveLen=${effectiveContent.length} forwarded=${message.reference?.type === MessageReferenceType.Forward} txtAttachments=${[...message.attachments.values()].filter(a => a.name?.endsWith(".txt")).length}`
    );
  }
  const commandParse = parseLeadingCommands(effectiveContent);
  const naturalRoute =
    commandParse.agentOverride === null
      ? parseNaturalTextRoute({
          text: commandParse.promptText,
          voiceTargets,
          focusedAgentId: getFocusedTextAgentId(channelKey)
        })
      : null;
  const replyReferent = resolveReplyReferent(message);
  const reactionReferent = takeReactionReferent(message);
  const messageReferent = replyReferent ?? reactionReferent;

  const resolvedTargetAgent = resolveContextualTargetAgent({
    channelKey,
    routeSessionId: route.sessionId,
    routeAgentId: route.agentId,
    explicitAgentId:
      commandParse.agentOverride ??
      naturalRoute?.addressedAgentId ??
      messageReferent?.targetAgentId ??
      null
  });
  if (!resolvedTargetAgent) {
    await sendPresentedReply(message.channel, `No agent config found for '${route.agentId}'.`, systemAgent);
    return;
  }
  const targetAgent = resolvedTargetAgent;

  const accessAgent = naturalRoute?.systemCommand ? (systemAgent ?? targetAgent) : targetAgent;
  const accessPolicy = resolveAccessPolicy(accessAgent, defaultAccessPolicy);
  const routingChannelId = resolveRoutingChannelId(message);
  const access = evaluateAccess(
    {
      channelId: routingChannelId,
      userId: message.author.id,
      mentioned: hasMentionForBot(message)
    },
    accessPolicy
  );
  if (!access.allowed) {
    writeMessage({
      sessionId: route.sessionId,
      agentId: accessAgent.id,
      direction: "system",
      source: "tango",
      visibility: "debug",
      discordMessageId: message.id,
      discordChannelId: message.channelId,
      discordUserId: message.author.id,
      discordUsername: message.author.username,
      content: "message blocked by access control",
      metadata: {
        accessMode: access.mode,
        targetAgentId: accessAgent.id,
        reason: access.reason,
        mentionRequired: access.mentionRequired,
        mentioned: access.mentioned,
        channelAllowed: access.channelAllowed,
        userAllowed: access.userAllowed,
        allowlistChannelCount: accessPolicy.allowlistChannelIds.size,
        allowlistUserCount: accessPolicy.allowlistUserIds.size
      }
    });

    console.log(
      `[tango-discord] blocked mode=${access.mode} agent=${accessAgent.id} reason=${access.reason} channel=${message.channelId} user=${message.author.username}`
    );
    return;
  }

  if (naturalRoute?.systemCommand) {
    await handleNaturalTextSystemCommand({
      message,
      channelKey,
      route,
      command: naturalRoute.systemCommand
    });
    return;
  }

  let promptRoute = resolvePromptTextRoute({
    route,
    channelKey,
    targetAgent,
    naturalRoute
  });
  if (
    shouldPreferReferentSession({
      promptText: naturalRoute?.promptText ?? commandParse.promptText,
      referent: messageReferent,
      explicitTopicName: naturalRoute?.topicName ?? null,
      activeSessionId: promptRoute.sessionId,
    }) &&
    messageReferent?.targetSessionId
  ) {
    promptRoute = resolveSessionRouteFromSessionId(
      messageReferent.targetSessionId,
      messageReferent.targetAgentId ?? targetAgent.id
    );
  }
  upsertSessionForRoute(promptRoute, channelKey);

  const referentMessageId =
    messageReferent && messageReferent.targetContent.trim().length > 0
      ? writeMessage({
          sessionId: promptRoute.sessionId,
          agentId: targetAgent.id,
          direction: "system",
          source: "tango",
          visibility: "internal",
          discordChannelId: message.channelId,
          content: buildReferentSystemMessage(messageReferent),
          metadata: {
            kind: messageReferent.kind,
            targetMessageId: messageReferent.targetMessageId,
            targetSessionId: messageReferent.targetSessionId,
            targetAgentId: messageReferent.targetAgentId,
            ...messageReferent.metadata,
          },
        })
      : null;

  const inboundMessageId = options?.existingInboundMessageId ?? writeMessage({
    sessionId: promptRoute.sessionId,
    agentId: targetAgent.id,
    direction: "inbound",
    source: "discord",
    visibility: "public",
    discordMessageId: message.id,
    discordChannelId: message.channelId,
    discordUserId: message.author.id,
    discordUsername: message.author.username,
    content: effectiveContent,
    metadata: {
      channelKey,
      routedAgentId: route.agentId,
      resolvedSessionId: promptRoute.sessionId,
      targetAgentId: targetAgent.id,
      topicId: promptRoute.topic?.id ?? null,
      topicSlug: promptRoute.topic?.slug ?? null,
      topicTitle: promptRoute.topic?.title ?? null,
      projectId: promptRoute.project?.id ?? null,
      projectTitle: promptRoute.project?.displayName ?? null,
      listenOnly,
      commandParse,
      naturalRoute,
      messageTimestamp: message.createdAt.toISOString(),
      messageTimestampSource: "discord-sent",
      discordReplyToMessageId: message.reference?.messageId?.trim() || null,
      messageReferent,
      referentSystemMessageId: referentMessageId,
      recoverySource: options?.recoverySource ?? null,
      attachments: attachmentsForMetadata(message)
    }
  });

  if (listenOnly) {
    return;
  }

  const responseMode = resolveResponseMode(targetAgent, commandParse.responseModeOverride);
  const attachmentResult = await processAttachments(message.attachments, promptRoute.sessionId);
  const prompt = buildPromptWithReferent(
    buildPrompt(naturalRoute?.promptText ?? commandParse.promptText, message) + attachmentResult.promptSuffix,
    messageReferent
  );
  if (prompt.length === 0) {
    // Diagnostic: capture what we actually saw so we can tell whether raw content
    // was empty (Discord Message Content Intent cold-start, thread membership
    // timing, etc.) or whether the parser stripped real content. Kept as a warn
    // log so it shows up in normal tmux captures.
    const rawContent = typeof message.content === "string" ? message.content : "";
    const rawTrimmed = rawContent.trim();
    console.warn(
      `[tango-discord] empty-prompt rawLen=${rawContent.length} rawTrimmedLen=${rawTrimmed.length} commandParseLen=${commandParse.promptText.length} naturalRouteLen=${naturalRoute?.promptText?.length ?? -1} hasAttachments=${message.attachments.size} agentOverride=${commandParse.agentOverride ?? "-"} author=${message.author.username} channel=${message.channelId}`
    );
    await sendPresentedReply(
      message.channel,
      "I received an empty message. Send text, or include `/agent <id> your message`.",
      systemAgent
    );
    return;
  }

  // Victor manual-console bridge: route to VICTOR-COS only when explicitly enabled.
  if (targetAgent.id === "victor" && isVictorManualConsoleBridgeActive()) {
    const threadId = message.channelId !== routingChannelId ? message.channelId : undefined;
    const maybeTypingChannel = message.channel as { sendTyping?: () => Promise<void> };
    let typingInterval: ReturnType<typeof setInterval> | undefined;
    if (typeof maybeTypingChannel.sendTyping === "function") {
      await maybeTypingChannel.sendTyping().catch(() => {/* typing indicator is best-effort */});
      typingInterval = setInterval(() => {
        maybeTypingChannel.sendTyping?.().catch(() => {});
      }, 8_000);
    }

    try {
      const bridgeMessage: VictorBridgeMessage = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        source: "discord-text",
        user: { id: message.author.id, username: message.author.username },
        channel: { id: routingChannelId, ...(threadId ? { threadId } : {}) },
        content: prompt,
        sessionId: promptRoute.sessionId,
        agentId: targetAgent.id,
      };

      const requestId = await sendToVictorInbox(bridgeMessage);
      const bridgeResponse = await waitForVictorResponse(requestId, 120_000);

      const replyDelivery = await sendPresentedReply(message.channel, bridgeResponse.text, targetAgent);
      ensureReplyDeliverySucceeded(replyDelivery, message.channelId);

      writeMessage({
        sessionId: promptRoute.sessionId,
        agentId: targetAgent.id,
        providerName: "victor-bridge",
        direction: "outbound",
        source: "tango",
        visibility: "public",
        discordMessageId: replyDelivery.lastMessageId ?? null,
        discordChannelId: message.channelId,
        discordUserId: null,
        discordUsername: replyDelivery.actualDisplayName,
        content: bridgeResponse.text,
        metadata: {
          replyToDiscordMessageId: message.id,
          sentChunks: replyDelivery.sentChunks,
          runtimePath: "victor-bridge",
          bridgeRequestId: requestId,
        },
      });

      console.log(
        `[tango-discord] victor-bridge reply session=${promptRoute.sessionId} delivery=${replyDelivery.delivery} chunks=${replyDelivery.sentChunks}`,
      );
      cleanupAttachments(attachmentResult.tempDir);
      return;
    } catch (error) {
      console.error(
        `[tango-discord] victor-bridge failed, falling back to ephemeral v2:`,
        error instanceof Error ? error.message : error,
      );
      // Fall through to normal v2 path
    } finally {
      if (typingInterval) {
        clearInterval(typingInterval);
      }
    }
  }

  if (v2EnabledAgents.has(targetAgent.id)) {
    const threadId = message.channelId !== routingChannelId ? message.channelId : undefined;
    const v2AgentConfig = v2Configs.get(targetAgent.id);
    const maybeTypingChannel = message.channel as { sendTyping?: () => Promise<void> };
    let typingInterval: ReturnType<typeof setInterval> | undefined;
    if (typeof maybeTypingChannel.sendTyping === "function") {
      await maybeTypingChannel.sendTyping().catch(() => {/* typing indicator is best-effort */});
      typingInterval = setInterval(() => {
        maybeTypingChannel.sendTyping?.().catch(() => {/* ignore */});
      }, 8_000);
    }

    try {
      const warmStartPrompt = await buildWarmStartContextPrompt({
        sessionId: promptRoute.sessionId,
        agentId: targetAgent.id,
        currentUserPrompt: prompt,
        discordChannelId: threadId ?? routingChannelId,
      });
      const currentTurnMetadataPrompt = buildCurrentTurnMetadataPrompt({
        timestamp: message.createdAt,
        timestampSource: "discord-sent",
        config: v2AgentConfig?.currentTurnMetadata,
      });
      // Per-turn briefing ("whisper") survives provider-session resume. It emits
      // the project state-file pointer when this conversation is bound to a
      // project arc; otherwise it stays silent unless search-first is flag-on,
      // so non-project conversations are behavior-unchanged.
      const briefingConversationKey = conversationKeyFor(routingChannelId, threadId);
      const stateFilePointer = buildStateFilePointer(storage, briefingConversationKey, {
        vaultRoot: resolveStateVaultRoot(),
      });
      const turnBriefingPrompt = buildTurnBriefingPrompt({
        ...(stateFilePointer ? { stateFile: stateFilePointer } : {}),
        searchFirst: Boolean(stateFilePointer) || process.env.TANGO_TURN_BRIEFING_SEARCH_FIRST === "1",
      });
      const v2Result = await routeV2MessageIfEnabled(
        {
          message: prompt,
          channelId: routingChannelId,
          ...(threadId ? { threadId } : {}),
          agentId: targetAgent.id,
          sendOptions: {
            ...(warmStartPrompt ? { context: warmStartPrompt } : {}),
            currentTurnMetadataPrompt,
            ...(turnBriefingPrompt ? { turnBriefingPrompt } : {}),
          },
        },
        {
          v2EnabledAgents,
          tangoRouter,
        },
      );

      if (!v2Result) {
        throw new Error(`Expected v2 routing to be enabled for agent '${targetAgent.id}'.`);
      }

      const runtimeMetadata = asRecord(v2Result.response.metadata);
      const providerMetadata = asRecord(runtimeMetadata?.providerMetadata);
      const providerUsage = asRecord(providerMetadata?.usage);
      const providerSessionId = metadataString(runtimeMetadata, "sessionId") ?? null;
      // Save bookkeeping: keep the project head's session chain current (no-op
      // unless this conversation is bound to a project arc).
      refreshProjectHeadOnTurn(storage, briefingConversationKey, providerSessionId);
      const runtimeModel =
        v2Result.response.model
        ?? metadataString(providerMetadata, "model")
        ?? null;
      const toolsUsed = v2Result.response.toolsUsed ?? [];
      const runtimeError = metadataBoolean(runtimeMetadata, "error") ?? false;
      const rawRuntimeResponse = asRecord(runtimeMetadata?.raw);
      const replyDelivery = await sendPresentedReply(message.channel, v2Result.response.text, targetAgent);
      ensureReplyDeliverySucceeded(replyDelivery, message.channelId);

      const outboundMessageId = writeMessage({
        sessionId: promptRoute.sessionId,
        agentId: targetAgent.id,
        providerName: "claude-code-v2",
        direction: "outbound",
        source: "tango",
        visibility: "public",
        discordMessageId: replyDelivery.lastMessageId ?? null,
        discordChannelId: message.channelId,
        discordUserId: replyDelivery.delivery === "bot" ? client.user?.id ?? null : null,
        discordUsername: replyDelivery.actualDisplayName,
        content: v2Result.response.text,
        metadata: {
          replyToDiscordMessageId: message.id,
          sentChunks: replyDelivery.sentChunks,
          senderIdentity: {
            intendedDisplayName: replyDelivery.intendedDisplayName,
            actualDisplayName: replyDelivery.actualDisplayName,
            delivery: replyDelivery.delivery,
          },
          runtimePath: "v2",
          conversationKey: v2Result.conversationKey,
          runtimeDurationMs: v2Result.response.durationMs,
          runtimeModel,
          runtimeToolsUsed: toolsUsed,
          runtimeMetadata: v2Result.response.metadata ?? null,
        },
      });

      writeModelRun({
        sessionId: promptRoute.sessionId,
        agentId: targetAgent.id,
        providerName: "claude-code-v2",
        conversationKey: v2Result.conversationKey,
        providerSessionId,
        model: runtimeModel,
        stopReason: metadataString(providerMetadata, "stopReason") ?? null,
        responseMode,
        latencyMs: v2Result.response.durationMs,
        providerDurationMs: metadataNumber(providerMetadata, "durationMs") ?? null,
        providerApiDurationMs: metadataNumber(providerMetadata, "durationApiMs") ?? null,
        inputTokens: metadataNumber(providerUsage, "inputTokens") ?? null,
        outputTokens: metadataNumber(providerUsage, "outputTokens") ?? null,
        cacheReadInputTokens: metadataNumber(providerUsage, "cacheReadInputTokens") ?? null,
        cacheCreationInputTokens: metadataNumber(providerUsage, "cacheCreationInputTokens") ?? null,
        totalCostUsd: metadataNumber(providerMetadata, "totalCostUsd") ?? null,
        isError: runtimeError,
        errorMessage:
          runtimeError
            ? metadataString(runtimeMetadata, "stderr") ?? "Claude Code runtime returned an error response."
            : null,
        requestMessageId: inboundMessageId,
        responseMessageId: outboundMessageId,
        metadata: {
          replyToDiscordMessageId: message.id,
          sentChunks: replyDelivery.sentChunks,
          senderIdentity: {
            intendedDisplayName: replyDelivery.intendedDisplayName,
            actualDisplayName: replyDelivery.actualDisplayName,
            delivery: replyDelivery.delivery,
          },
          responseMode,
          runtimePath: "v2",
          toolsUsed,
          runtimeExitCode: metadataNumber(runtimeMetadata, "exitCode") ?? null,
          runtimeSignal: metadataString(runtimeMetadata, "signal") ?? null,
          runtimeStderr: metadataString(runtimeMetadata, "stderr") ?? null,
        },
        rawResponse:
          captureProviderRaw && rawRuntimeResponse
            ? rawRuntimeResponse
            : null,
      });

      console.log(
        `[tango-discord] v2 reply session=${promptRoute.sessionId} agent=${targetAgent.id} conversation=${v2Result.conversationKey} ms=${v2Result.response.durationMs} delivery=${replyDelivery.delivery} chunks=${replyDelivery.sentChunks}`,
      );
      return;
    } finally {
      if (typingInterval) clearInterval(typingInterval);
      cleanupAttachments(attachmentResult.tempDir);
    }
  }

  const retiredRuntimeMessage = `Agent '${targetAgent.id}' is not configured for the v2 runtime. Legacy Discord turn execution has been retired.`;
  console.error(`[tango-discord] ${retiredRuntimeMessage}`);
  writeMessage({
    sessionId: promptRoute.sessionId,
    agentId: targetAgent.id,
    providerName: "claude-code-v2",
    direction: "error",
    source: "tango",
    visibility: "debug",
    discordChannelId: message.channelId,
    discordUserId: client.user?.id ?? null,
    discordUsername: systemDisplayName,
    content: retiredRuntimeMessage,
    metadata: {
      replyToDiscordMessageId: message.id,
      responseMode,
      runtimePath: "v2-required",
    },
  });
  await sendPresentedReply(
    message.channel,
    "That agent has not been migrated to the v2 runtime yet, so I can't safely run it.",
    systemAgent,
  );
  cleanupAttachments(attachmentResult.tempDir);
  return;
}


function rememberProcessedMessageId(messageId: string): void {
  if (recentlyProcessedMessageIds.has(messageId)) {
    return;
  }
  recentlyProcessedMessageIds.add(messageId);
  if (recentlyProcessedMessageIds.size > MESSAGE_DEDUP_MAX_SIZE) {
    const oldest = recentlyProcessedMessageIds.values().next().value;
    if (oldest) recentlyProcessedMessageIds.delete(oldest);
  }
}

async function detectOrphanedDiscordMessagesAfterStartup(): Promise<void> {
  const candidates = storage.listRecoverableDiscordInboundMessages({
    maxAgeMinutes: 240,
    limit: 25,
  });
  if (candidates.length === 0) {
    return;
  }

  let flagged = 0;
  let notified = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    const metadata = candidate.metadata && typeof candidate.metadata === "object"
      ? candidate.metadata as Record<string, unknown>
      : null;
    if (metadata?.["listenOnly"] === true) {
      skipped += 1;
      continue;
    }
    if (!candidate.agentId || !candidate.discordChannelId || !candidate.discordMessageId) {
      skipped += 1;
      continue;
    }

    const conversationKey = getConversationKey(candidate.sessionId, candidate.agentId);
    const providerName =
      agentRegistry.get(candidate.agentId)?.provider.default ??
      "codex";
    const deadLetterId = writeDeadLetter({
      sessionId: candidate.sessionId,
      agentId: candidate.agentId,
      providerName,
      conversationKey,
      requestMessageId: candidate.id,
      discordChannelId: candidate.discordChannelId,
      discordUserId: candidate.discordUserId,
      discordUsername: candidate.discordUsername,
      promptText: candidate.content,
      lastErrorMessage: "Message was interrupted by a bot restart before execution began.",
      metadata: {
        recoverySource: "startup-orphan-check",
        originalCreatedAt: candidate.createdAt,
      },
    });
    flagged += 1;

    if (isSmokeTestChannelId(candidate.discordChannelId)) {
      continue;
    }

    const channel = await client.channels.fetch(candidate.discordChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      continue;
    }

    const delivery = await sendPresentedReply(
      channel,
      "I restarted before I could finish your last message. Please send it again.",
      systemAgent
    ).catch(() => null);
    if (!delivery) {
      continue;
    }

    writeMessage({
      sessionId: candidate.sessionId,
      agentId: candidate.agentId,
      providerName,
      direction: "error",
      source: "tango",
      visibility: "public",
      discordMessageId: delivery.lastMessageId ?? null,
      discordChannelId: candidate.discordChannelId,
      discordUserId: client.user?.id ?? null,
      discordUsername: delivery.actualDisplayName,
      content: "I restarted before I could finish your last message. Please send it again.",
      metadata: {
        replyToDiscordMessageId: candidate.discordMessageId,
        recoverySource: "startup-orphan-check",
        deadLetterId,
      },
    });
    notified += 1;
  }

  console.warn(
    `[tango-discord] startup orphan scan flagged=${flagged} notified=${notified} skipped=${skipped}`
  );
}

client.once("clientReady", async () => {
  const cwdRelativeConfigDir = path.relative(process.cwd(), configDir) || ".";
  console.log(`[tango-discord] connected as ${client.user?.tag}`);
  console.log(`[tango-discord] listen-only=${listenOnly}`);
  console.log(`[tango-discord] message-content-intent=${enableMessageContent}`);
  console.log(`[tango-discord] claude-command=${env.CLAUDE_CLI_COMMAND}`);
  console.log(`[tango-discord] claude-secondary-command=${env.CLAUDE_SECONDARY_CLI_COMMAND ?? "(unset)"}`);
  console.log(`[tango-discord] claude-harness-command=${env.CLAUDE_HARNESS_COMMAND}`);
  console.log(`[tango-discord] codex-command=${env.CODEX_CLI_COMMAND}`);
  console.log(`[tango-discord] codex-sandbox=${env.CODEX_SANDBOX}`);
  console.log(`[tango-discord] codex-approval-policy=${env.CODEX_APPROVAL_POLICY}`);
  console.log(`[tango-discord] capture-provider-raw=${captureProviderRaw}`);
  console.log(`[tango-discord] provider-timeout-default-ms=${providerTimeoutMs}`);
  console.log(
    `[tango-discord] provider-timeouts-ms=claude:${claudeTimeoutMs},claude-secondary:${claudeSecondaryTimeoutMs},claude-harness:${claudeHarnessTimeoutMs},codex:${codexTimeoutMs}`
  );
  console.log(
    `[tango-discord] provider-default-models=claude:${env.CLAUDE_MODEL},claude-secondary:${env.CLAUDE_SECONDARY_MODEL ?? env.CLAUDE_MODEL},claude-harness:${env.CLAUDE_HARNESS_MODEL ?? env.CLAUDE_MODEL},codex:${env.CODEX_MODEL}`
  );
  console.log(
    `[tango-discord] provider-reasoning-efforts=claude:${env.CLAUDE_EFFORT},claude-secondary:${claudeSecondaryEffort},claude-harness:${claudeHarnessEffort},codex:${env.CODEX_REASONING_EFFORT}`
  );
  console.log(`[tango-discord] provider-retry-limit=${providerRetryLimit}`);
  console.log(`[tango-discord] memory-compaction-trigger-turns=${memoryCompactionTriggerTurns}`);
  console.log(`[tango-discord] memory-compaction-retain-recent-turns=${memoryCompactionRetainRecentTurns}`);
  console.log(`[tango-discord] memory-compaction-summary-max-chars=${memoryCompactionSummaryMaxChars}`);
  console.log(`[tango-discord] providers=${[...providers.keys()].sort().join(",")}`);
  console.log(`[tango-discord] access-default-mode=${defaultAccessMode}`);
  console.log(`[tango-discord] reply-presentation=webhook-preferred system=${systemDisplayName}`);
  console.log(
    `[tango-discord] default-allowlist-channels=${
      defaultAccessPolicy.allowlistChannelIds.size > 0
        ? [...defaultAccessPolicy.allowlistChannelIds].join(",")
        : "(none)"
    }`
  );
  console.log(
    `[tango-discord] default-allowlist-users=${
      defaultAccessPolicy.allowlistUserIds.size > 0
        ? [...defaultAccessPolicy.allowlistUserIds].join(",")
        : "(none)"
    }`
  );
  console.log(`[tango-discord] agent-access-overrides=${agentAccessOverrideCount}`);
  for (const agent of agentConfigs) {
    if (!agent.access) continue;
    const mode = agent.access.mode ?? defaultAccessPolicy.mode;
    const channels =
      agent.access.allowlistChannelIds !== undefined
        ? agent.access.allowlistChannelIds.length
        : defaultAccessPolicy.allowlistChannelIds.size;
    const users =
      agent.access.allowlistUserIds !== undefined
        ? agent.access.allowlistUserIds.length
        : defaultAccessPolicy.allowlistUserIds.size;
    console.log(
      `[tango-discord] agent-access agent=${agent.id} mode=${mode} channels=${channels} users=${users}`
    );
  }
  for (const agent of agentConfigs) {
    const tools = resolveAgentToolPolicy(agent);
    const toolsMode = tools.mode;
    const allowlistCount = tools.allowlist.length;
    console.log(
      `[tango-discord] agent-tools agent=${agent.id} mode=${toolsMode} allowlist=${allowlistCount}`
    );
  }
  const providerOverrides = storage.listSessionProviderOverrides(undefined, 200);
  console.log(`[tango-discord] session-provider-overrides=${providerOverrides.length}`);
  for (const override of providerOverrides) {
    console.log(
      `[tango-discord] session-provider-override session=${override.sessionId} agent=${override.agentId} provider=${override.providerName}`
    );
  }
  console.log(`[tango-discord] command-guild-id=${commandGuildId ?? "global"}`);
  console.log(`[tango-discord] db-path=${dbPath}`);
  console.log(`[tango-discord] config=${cwdRelativeConfigDir}`);
  console.log(`[tango-voice] bridge-enabled=${voiceBridgeEnabled}`);
  console.log(
    `[tango-voice] v2-router-agents=${
      voiceV2AgentRuntimeConfigs.size > 0
        ? [...voiceV2AgentRuntimeConfigs.keys()].sort().join(",")
        : "(none)"
    }`
  );
  if (voiceBridgeEnabled) {
    console.log(`[tango-voice] bridge-host=${voiceBridgeHost}`);
    console.log(`[tango-voice] bridge-port=${voiceBridgePort}`);
    console.log(`[tango-voice] bridge-path=${voiceBridgePath}`);
    console.log(`[tango-voice] default-session=${voiceDefaultSessionId ?? "-"}`);
    console.log(`[tango-voice] default-agent=${voiceDefaultAgentId ?? "-"}`);
    console.log(`[tango-voice] api-key=${voiceBridgeApiKey ? "set" : "not-set"}`);
  }
  console.log(`[tango-imessage] enabled=${imessageEnabled}`);
  if (imessageEnabled) {
    console.log(`[tango-imessage] mode=observe (output to Discord, no iMessage replies)`);
    console.log(`[tango-imessage] cli-path=${imessageCliPath}`);
    console.log(`[tango-imessage] contacts-path=${imessageContactsPath ?? "-"}`);
    console.log(`[tango-imessage] discord-channel=${imessageDiscordChannelId ?? "(none — messages logged only)"}`);
    console.log(`[tango-imessage] allow-from=${imessageAllowFrom.length > 0 ? imessageAllowFrom.join(",") : "(all)"}`);
    console.log(`[tango-imessage] group-policy=${imessageGroupPolicy}`);
  }

  try {
    await registerSlashCommands();
  } catch (error) {
    console.error("[tango-discord] failed to register slash commands", error);
  }

  if (shouldProvisionSlotMode) {
    const slot = process.env.TANGO_SLOT!;
    const result = await initializeSlotMode({
      client,
      slot,
      agentTestChannels: slotModeAgentTestChannels,
      logger: (line) => console.log(`[slot-mode] ${line}`),
    });
    allowedChannels = result.threadIds;
    for (const createdThread of result.created) {
      // Set the focused agent for each test thread so messages route to the
      // correct agent (e.g., Malibu's thread → Malibu, not Watson/dispatch).
      const threadChannelKey = `discord:${createdThread.threadId}`;
      focusedTextAgentByChannel.set(threadChannelKey, createdThread.agentId);
      // Pre-register the thread session with the correct agent BEFORE any
      // messages arrive. Without this, the first message triggers auto-registration
      // with agent=dispatch, which overrides the focused agent and routes to
      // Watson/personal-assistant instead of the intended agent's worker.
      const slotSessionId = `slot-test-${slot}-${createdThread.agentId}`;
      try {
        storage.setThreadSession(createdThread.threadId, slotSessionId, createdThread.agentId);
      } catch (err) {
        console.warn(`[slot-mode] failed to pre-register thread session for ${createdThread.agentId}: ${err instanceof Error ? err.message : err}`);
      }
      console.log(
        `[slot-mode] thread ready: agent=${createdThread.agentId} threadId=${createdThread.threadId} url=${createdThread.url}`,
      );
    }
    for (const failure of result.failures) {
      console.warn(`[slot-mode] failed for agent=${failure.agentId}: ${failure.reason}`);
    }
    console.log(
      `[slot-mode] initialization complete created=${result.created.length} failures=${result.failures.length}`,
    );
    if (result.threadIds.size === 0) {
      console.error("[slot-mode] FATAL: no test threads were created; bot would accept nothing. Shutting down.");
      process.exit(1);
    }
    // Grant per-agent access control access to the smoke-test parent channels so
    // thread-resolved routing (resolveRoutingChannelId returns the parent) passes
    // the default allowlist check. Agents without access overrides share this Set
    // by reference via resolveAccessPolicy, so the mutation propagates immediately.
    for (const agentChannel of slotModeAgentTestChannels) {
      defaultAccessPolicy.allowlistChannelIds.add(agentChannel.channelId);
    }
    console.log(
      `[slot-mode] granted default access allowlist to ${slotModeAgentTestChannels.length} smoke-test parent channels`,
    );
    if (agentAccessOverrideCount > 0) {
      console.warn(
        `[slot-mode] WARNING: ${agentAccessOverrideCount} agents have explicit access overrides; their allowlists will NOT auto-include slot-mode thread parents and may block messages`,
      );
    }
  }

  if (slotModeActive) {
    await applySlotNickname({
      client,
      slot: process.env.TANGO_SLOT!,
      logger: (line) => console.log(`[slot-mode] ${line}`),
    });
  } else {
    await resetBotNickname({
      client,
      nickname: process.env.TANGO_BOT_NICKNAME?.trim() || null,
      logger: (line) => console.log(`[tango-discord] ${line}`),
    });
  }

  // Join active threads so the bot receives messageCreate events for them.
  // Discord.js only caches threads the bot is a member of; after a restart
  // the bot loses thread membership and silently drops thread messages.
  //
  // Two sources of threads to rejoin:
  // 1. Guild active threads (from Discord API — only recently active threads)
  // 2. Registered thread sessions (from our DB — includes threads that may
  //    have gone idle but still have open conversations)
  try {
    let joinedThreads = 0;
    let alreadyJoined = 0;
    let totalThreads = 0;
    const joinedIds = new Set<string>();

    // Phase 1: Guild active threads
    for (const guild of client.guilds.cache.values()) {
      const activeThreads = await guild.channels.fetchActiveThreads();
      totalThreads += activeThreads.threads.size;
      for (const thread of activeThreads.threads.values()) {
        joinedIds.add(thread.id);
        if (thread.joined) {
          alreadyJoined++;
          continue;
        }
        try {
          await thread.join();
          joinedThreads++;
        } catch (threadError) {
          console.warn(`[tango-discord] failed to join thread ${thread.id}: ${threadError instanceof Error ? threadError.message : threadError}`);
        }
      }
    }

    // Phase 2: DB-registered thread sessions (covers idle/inactive threads)
    const registeredThreadIds = storage.listDiscordThreadSessionIds();
    let dbThreadsJoined = 0;
    for (const threadId of registeredThreadIds) {
      if (joinedIds.has(threadId)) continue;
      try {
        const channel = await client.channels.fetch(threadId).catch(() => null);
        if (channel?.isThread() && !channel.joined) {
          await channel.join();
          dbThreadsJoined++;
        }
      } catch {
        // Thread may be archived or deleted — skip silently
      }
    }

    console.log(
      `[tango-discord] thread-rejoin active=${totalThreads} joined=${joinedThreads} alreadyJoined=${alreadyJoined} dbThreads=${registeredThreadIds.length} dbJoined=${dbThreadsJoined}`
    );
  } catch (error) {
    console.error("[tango-discord] failed to rejoin active threads", error instanceof Error ? error.message : error);
  }

  try {
    await backfillThreadSessionAgents();
  } catch (error) {
    console.error("[tango-discord] thread-agent-backfill failed", error instanceof Error ? error.message : error);
  }

  try {
    await detectOrphanedDiscordMessagesAfterStartup();
  } catch (error) {
    console.error("[tango-discord] startup orphan scan failed", error instanceof Error ? error.message : error);
  }

  if (voiceBridge) {
    try {
      await voiceBridge.start();
      console.log(
        `[tango-voice] bridge listening http://${voiceBridgeHost}:${voiceBridgePort}${voiceBridgePath}`
      );
    } catch (error) {
      console.error("[tango-voice] failed to start bridge", error);
    }
  }

  if (imessageListener) {
    try {
      await imessageListener.start();
    } catch (error) {
      console.error("[tango-imessage] failed to start listener", error);
    }
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "tango") return;

  try {
    await handleTangoCommand(interaction);
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    console.error("[tango-discord] slash command failed", messageText);

    if (interaction.deferred || interaction.replied) {
      await interaction
        .editReply("I hit an error while executing that command.")
        .catch(() => undefined);
      return;
    }

    await interaction
      .reply({
        content: "I hit an error while executing that command.",
        ephemeral: true
      })
      .catch(() => undefined);
  }
});

function enqueueChannelWork(
  channelKey: string,
  logPrefix: string,
  work: () => Promise<void>,
): void {
  const queuedWork = channelQueues.get(channelKey) ?? Promise.resolve();
  const nextWork = queuedWork
    .then(async () => {
      await work();
    })
    .catch((error) => {
      console.error(`[${logPrefix}] unhandled channel work error`, error);
    })
    .finally(() => {
      if (channelQueues.get(channelKey) === nextWork) {
        channelQueues.delete(channelKey);
      }
    });
  channelQueues.set(channelKey, nextWork);
}

// Guard against duplicate messageCreate events for the same Discord message.
// Discord.js can fire the event twice (~3-4% of messages), causing double processing
// that corrupts --resume sessions and leaks raw <worker-dispatch> tags to Discord.
const recentlyProcessedMessageIds = new Set<string>();
const MESSAGE_DEDUP_MAX_SIZE = 200;

client.on("messageCreate", async (message) => {
  if (!isChannelAllowed(message.channelId, allowedChannels)) return;

  // Voice-synced user messages are posted via webhook (bot=true) but prefixed with ZWS.
  // Advance the watermark for these before the bot early-return so the inbox stays current.
  // NOTE: We advance unconditionally (not gated on voiceInboxChannelMap) because voice
  // turns often route to threads tracked via discord_thread_sessions, not just parent channels.
  const isVoiceUserSync = (message.author.bot || !!message.webhookId) && message.content.startsWith('\u200B');
  if (isVoiceUserSync) {
    const syncChannelId = message.channelId;
    try {
      advanceVoiceWatermarkById(syncChannelId, message.id, "voice-user-sync");
    } catch (error) {
      console.warn(`[voice-inbox] watermark advance failed on voice-user-sync: ${error instanceof Error ? error.message : error}`);
    }
    return; // Voice-user-synced transcripts don't need further processing
  }

  const isSmokeTestWebhookInput = isSmokeTestThreadWebhookMessage(message, smokeTestChannelIds);
  if (message.author.bot && !isSmokeTestWebhookInput) return;
  // Ignore system messages (thread created, pin, member join, etc.)
  if (message.type !== MessageType.Default && message.type !== MessageType.Reply) return;

  if (recentlyProcessedMessageIds.has(message.id)) {
    console.warn(`[tango-discord] duplicate messageCreate suppressed id=${message.id}`);
    return;
  }
  rememberProcessedMessageId(message.id);

  // Advance voice watermark — user sending a message means they've seen everything before it
  const parentId = "parentId" in message.channel ? message.channel.parentId : null;
  try {
    advanceResolvedVoiceWatermark(message.channelId, parentId, message.id, "user-message");
  } catch (error) {
    console.warn(`[voice-inbox] watermark advance failed on messageCreate: ${error instanceof Error ? error.message : error}`);
  }

  // Use message.channelId (thread ID for threads) as queue key so forum threads
  // process concurrently. handleMessage computes its own routing channelKey internally.
  const queueKey = `discord:${message.channelId}`;
  enqueueChannelWork(queueKey, "tango-discord", async () => {
    try {
      await handleMessage(message);
    } catch (error) {
      const errorText = error instanceof Error ? error.message : String(error);
      console.error(`[tango-discord] handleMessage failed for ${message.author.username} in ${message.channelId}: ${errorText}`);
      try {
        await sendPresentedReply(message.channel, `Something went wrong processing your message. Please try again.`, systemAgent);
      } catch (replyError) {
        console.error(`[tango-discord] failed to send error reply:`, replyError instanceof Error ? replyError.message : replyError);
      }
    }
  });
});

// Voice inbox: advance watermark when user reacts to any message in a monitored channel
client.on("messageReactionAdd", async (reaction, user) => {
  try {
    if (user.bot) return;
    // Ensure reaction is fully fetched (partials)
    if (reaction.partial) await reaction.fetch();

    const channelId = reaction.message.channelId;
    const reactionChannel = reaction.message.channel;
    const parentId = reactionChannel && "isThread" in reactionChannel && typeof reactionChannel.isThread === "function" && reactionChannel.isThread()
      ? ((reactionChannel as { parentId?: string | null }).parentId ?? null)
      : null;
    const messageId = reaction.message.id;
    const advanced = advanceResolvedVoiceWatermark(channelId, parentId, messageId, "reaction");
    if (advanced) {
      console.log(`[voice-inbox] watermark advanced via reaction channel=${channelId} message=${messageId} user=${user.id}`);
    }

    const storedTarget = findStoredMessageForDiscordTarget({
      discordMessageId: messageId,
      discordChannelId: channelId,
      fallbackContent: reaction.message.content ?? "",
    });
    const isTangoAuthoredMessage =
      Boolean(reaction.message.webhookId) ||
      reaction.message.author?.id === client.user?.id ||
      storedTarget?.source === "tango";
    const referentContent = storedTarget?.content?.trim() || (reaction.message.content ?? "").trim();
    if (isTangoAuthoredMessage && referentContent.length > 0) {
      storage.upsertChannelReferent({
        channelId,
        discordUserId: user.id,
        kind: "reaction",
        targetMessageId: messageId,
        targetSessionId: storedTarget?.sessionId ?? null,
        targetAgentId: storedTarget?.agentId ?? null,
        targetDirection: storedTarget?.direction ?? null,
        targetSource: storedTarget?.source ?? "tango",
        targetContent: referentContent,
        metadata: {
          emoji: reaction.emoji.name ?? null,
          storedMessageId: storedTarget?.id ?? null,
          webhookId: reaction.message.webhookId ?? null,
        },
      });
    }
  } catch (error) {
    console.warn(`[voice-inbox] reaction watermark failed: ${error instanceof Error ? error.message : error}`);
  }
});

client.login(env.DISCORD_TOKEN).catch((error) => {
  console.error("[tango-discord] login failed", error);
  process.exit(1);
});

let isShuttingDown = false;
function shutdown(signal: "SIGINT" | "SIGTERM"): void {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`[tango] shutting down signal=${signal}`);
  void (async () => {
    try {
      if (scheduler) {
        scheduler.stop();
      }
    } catch (error) {
      console.error("[tango] scheduler shutdown failed", error);
    }
    try {
      if (voiceBridge) {
        await voiceBridge.stop();
      }
    } catch (error) {
      console.error("[tango-voice] bridge shutdown failed", error);
    }
    try {
      if (voiceTangoRouter) {
        await voiceTangoRouter.shutdown();
      }
    } catch (error) {
      console.error("[tango-voice] router shutdown failed", error);
    }
    try {
      if (imessageListener) {
        await imessageListener.stop();
      }
    } catch (error) {
      console.error("[tango-imessage] listener shutdown failed", error);
    }
    try {
      await shutdownV2Runtime({
        tangoRouter,
        atlasMemoryClient,
      });
    } catch (error) {
      console.error("[tango] v2 runtime shutdown failed", error);
    } finally {
      storage.close();
      process.exit(0);
    }
  })();
}

process.on("SIGINT", () => {
  shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});
