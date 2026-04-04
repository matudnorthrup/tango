import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { ActiveTaskStatus, MemorySource, PinnedFactScope, SessionConfig } from "./types.js";
import type { SubAgentStatus } from "./sub-agent-runner.js";
import { GOVERNANCE_DDL, GOVERNANCE_SEED } from "./governance-schema.js";

export interface ProviderSessionRecord {
  conversationKey: string;
  sessionId: string;
  agentId: string;
  providerName: string;
  providerSessionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionProviderOverrideRecord {
  sessionId: string;
  agentId: string;
  providerName: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionCompactionRecord {
  sessionId: string;
  agentId: string;
  summaryText: string;
  compactedTurns: number;
  createdAt: string;
  updatedAt: string;
}

export type StoredMessageDirection = "inbound" | "outbound" | "system" | "error";
export type StoredMessageSource = "discord" | "imessage" | "tango";
export type StoredMessageVisibility = "public" | "internal" | "debug";

export interface StoredMessageRecord {
  id: number;
  sessionId: string;
  agentId: string | null;
  providerName: string | null;
  direction: StoredMessageDirection;
  source: StoredMessageSource;
  visibility: StoredMessageVisibility;
  discordMessageId: string | null;
  discordChannelId: string | null;
  discordUserId: string | null;
  discordUsername: string | null;
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface MessageInsertInput {
  sessionId: string;
  agentId?: string | null;
  providerName?: string | null;
  direction: StoredMessageDirection;
  source: StoredMessageSource;
  visibility?: StoredMessageVisibility;
  discordMessageId?: string | null;
  discordChannelId?: string | null;
  discordUserId?: string | null;
  discordUsername?: string | null;
  content: string;
  metadata?: Record<string, unknown> | null;
}

export type ChannelReferentKind = "reaction";

export interface ChannelReferentRecord {
  channelId: string;
  discordUserId: string;
  kind: ChannelReferentKind;
  targetMessageId: string;
  targetSessionId: string | null;
  targetAgentId: string | null;
  targetDirection: StoredMessageDirection | null;
  targetSource: StoredMessageSource | null;
  targetContent: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface ChannelReferentUpsertInput {
  channelId: string;
  discordUserId: string;
  kind: ChannelReferentKind;
  targetMessageId: string;
  targetSessionId?: string | null;
  targetAgentId?: string | null;
  targetDirection?: StoredMessageDirection | null;
  targetSource?: StoredMessageSource | null;
  targetContent: string;
  metadata?: Record<string, unknown> | null;
  expiresAt?: string | null;
}

export interface ModelRunRecord {
  id: number;
  sessionId: string;
  agentId: string;
  providerName: string;
  conversationKey: string;
  providerSessionId: string | null;
  model: string | null;
  stopReason: string | null;
  responseMode: string | null;
  latencyMs: number | null;
  providerDurationMs: number | null;
  providerApiDurationMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  totalCostUsd: number | null;
  isError: number;
  errorMessage: string | null;
  requestMessageId: number | null;
  responseMessageId: number | null;
  metadata: Record<string, unknown> | null;
  rawResponse: Record<string, unknown> | null;
  createdAt: string;
}

export interface ModelRunInsertInput {
  sessionId: string;
  agentId: string;
  providerName: string;
  conversationKey: string;
  providerSessionId?: string | null;
  model?: string | null;
  stopReason?: string | null;
  responseMode?: string | null;
  latencyMs?: number | null;
  providerDurationMs?: number | null;
  providerApiDurationMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  totalCostUsd?: number | null;
  isError?: boolean;
  errorMessage?: string | null;
  requestMessageId?: number | null;
  responseMessageId?: number | null;
  metadata?: Record<string, unknown> | null;
  rawResponse?: Record<string, unknown> | null;
}

export type DeterministicRouteOutcome = "executed" | "clarification" | "fallback";

export interface DeterministicTurnRecord {
  id: string;
  sessionId: string;
  agentId: string;
  conversationKey: string;
  initiatingPrincipalId: string;
  leadAgentPrincipalId: string;
  projectId: string | null;
  topicId: string | null;
  intentCount: number;
  intentIds: string[];
  intentJson: unknown;
  intentModelRunId: number | null;
  routeOutcome: DeterministicRouteOutcome;
  fallbackReason: string | null;
  executionPlanJson: unknown;
  stepCount: number;
  completedStepCount: number;
  failedStepCount: number;
  hasWriteOperations: boolean;
  workerIds: string[];
  delegationChain: string[];
  receiptsJson: unknown;
  narrationProvider: string | null;
  narrationModel: string | null;
  narrationLatencyMs: number | null;
  narrationRetried: boolean;
  narrationModelRunId: number | null;
  intentLatencyMs: number | null;
  routeLatencyMs: number | null;
  executionLatencyMs: number | null;
  totalLatencyMs: number | null;
  requestMessageId: number | null;
  responseMessageId: number | null;
  createdAt: string;
}

export interface DeterministicTurnInsertInput {
  id?: string;
  sessionId: string;
  agentId: string;
  conversationKey: string;
  initiatingPrincipalId: string;
  leadAgentPrincipalId: string;
  projectId?: string | null;
  topicId?: string | null;
  intentIds?: string[];
  intentJson: unknown;
  intentModelRunId?: number | null;
  routeOutcome: DeterministicRouteOutcome;
  fallbackReason?: string | null;
  executionPlanJson?: unknown;
  completedStepCount?: number;
  failedStepCount?: number;
  hasWriteOperations?: boolean;
  workerIds?: string[];
  delegationChain?: string[];
  receiptsJson?: unknown;
  narrationProvider?: string | null;
  narrationModel?: string | null;
  narrationLatencyMs?: number | null;
  narrationRetried?: boolean;
  narrationModelRunId?: number | null;
  intentLatencyMs?: number | null;
  routeLatencyMs?: number | null;
  executionLatencyMs?: number | null;
  totalLatencyMs?: number | null;
  requestMessageId?: number | null;
  responseMessageId?: number | null;
}

export interface SubAgentRunRecord {
  id: string;
  batchId: string;
  parentSessionId: string | null;
  parentAgentId: string | null;
  conversationKey: string | null;
  coordinatorWorkerId: string;
  roundIndex: number;
  subTaskId: string;
  providerName: string | null;
  model: string | null;
  reasoningEffort: string | null;
  toolIds: string[];
  dependencyIds: string[];
  status: SubAgentStatus;
  durationMs: number;
  costEstimateUsd: number | null;
  error: string | null;
  outputText: string | null;
  toolCallsJson: unknown;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

export interface SubAgentRunInsertInput {
  id?: string;
  batchId: string;
  parentSessionId?: string | null;
  parentAgentId?: string | null;
  conversationKey?: string | null;
  coordinatorWorkerId: string;
  roundIndex: number;
  subTaskId: string;
  providerName?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  toolIds?: string[];
  dependencyIds?: string[];
  status: SubAgentStatus;
  durationMs?: number;
  costEstimateUsd?: number | null;
  error?: string | null;
  outputText?: string | null;
  toolCallsJson?: unknown;
  metadata?: Record<string, unknown> | null;
}

export interface ActiveTaskRecord {
  id: string;
  sessionId: string;
  agentId: string;
  status: ActiveTaskStatus;
  title: string;
  objective: string;
  ownerWorkerId: string | null;
  intentIds: string[];
  missingSlots: string[];
  clarificationQuestion: string | null;
  suggestedNextAction: string | null;
  structuredContext: Record<string, unknown> | null;
  sourceKind: string;
  createdByMessageId: number | null;
  updatedByMessageId: number | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  expiresAt: string | null;
}

export interface ActiveTaskUpsertInput {
  id?: string;
  sessionId: string;
  agentId: string;
  status: ActiveTaskStatus;
  title: string;
  objective: string;
  ownerWorkerId?: string | null;
  intentIds?: string[];
  missingSlots?: string[];
  clarificationQuestion?: string | null;
  suggestedNextAction?: string | null;
  structuredContext?: Record<string, unknown> | null;
  sourceKind?: string;
  createdByMessageId?: number | null;
  updatedByMessageId?: number | null;
  resolvedAt?: string | null;
  expiresAt?: string | null;
}

export interface ActiveTaskStatusUpdateInput {
  id: string;
  status: ActiveTaskStatus;
  updatedByMessageId?: number | null;
  structuredContext?: Record<string, unknown> | null;
  missingSlots?: string[];
  clarificationQuestion?: string | null;
  suggestedNextAction?: string | null;
  resolvedAt?: string | null;
  expiresAt?: string | null;
}

export interface ListActiveTasksOptions {
  sessionId: string;
  agentId: string;
  includeResolved?: boolean;
  limit?: number;
}

export interface ProviderArtifactCandidateRecord {
  providerName: string;
  providerSessionId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  runCount: number;
}

export interface PromptSnapshotRecord {
  id: number;
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
}

export interface PromptSnapshotInsertInput {
  modelRunId: number;
  sessionId: string;
  agentId: string;
  providerName: string;
  requestMessageId?: number | null;
  responseMessageId?: number | null;
  promptText: string;
  systemPrompt?: string | null;
  warmStartPrompt?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt?: string | null;
  expiresAt?: string | null;
}

export interface ListRecentPromptSnapshotsOptions {
  limit?: number;
  since?: string;
  sessionId?: string;
  agentId?: string;
}

export type DeadLetterStatus = "pending" | "resolved";

export interface DeadLetterRecord {
  id: number;
  sessionId: string;
  agentId: string;
  providerName: string;
  conversationKey: string;
  providerSessionId: string | null;
  requestMessageId: number | null;
  discordChannelId: string | null;
  discordUserId: string | null;
  discordUsername: string | null;
  promptText: string;
  systemPrompt: string | null;
  responseMode: string | null;
  failureCount: number;
  replayCount: number;
  lastErrorMessage: string;
  status: DeadLetterStatus;
  metadata: Record<string, unknown> | null;
  resolvedMessageId: number | null;
  resolvedModelRunId: number | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface DeadLetterInsertInput {
  sessionId: string;
  agentId: string;
  providerName: string;
  conversationKey: string;
  providerSessionId?: string | null;
  requestMessageId?: number | null;
  discordChannelId?: string | null;
  discordUserId?: string | null;
  discordUsername?: string | null;
  promptText: string;
  systemPrompt?: string | null;
  responseMode?: string | null;
  lastErrorMessage: string;
  failureCount?: number;
  metadata?: Record<string, unknown> | null;
}

export interface DeadLetterListOptions {
  status?: DeadLetterStatus | "all";
  sessionId?: string;
  limit?: number;
}

export interface DeadLetterResolveInput {
  id: number;
  resolvedMessageId?: number | null;
  resolvedModelRunId?: number | null;
  metadata?: Record<string, unknown> | null;
  incrementReplayCount?: boolean;
}

export interface DeadLetterReplayFailureInput {
  id: number;
  errorMessage: string;
  metadata?: Record<string, unknown> | null;
}

export interface SessionSummary {
  sessionId: string;
  sessionType: string;
  defaultAgentId: string;
  messageCount: number;
  modelRunCount: number;
  providerSessionCount: number;
  lastMessageAt: string | null;
  lastModelRunAt: string | null;
  updatedAt: string;
}

export interface HealthSnapshot {
  status: "healthy";
  dbUserVersion: number;
  sessions: number;
  messages: number;
  modelRuns: number;
  providerSessions: number;
  deadLettersTotal: number;
  deadLettersPending: number;
  lastMessageAt: string | null;
}

export interface ResetSessionOptions {
  clearHistory?: boolean;
  clearDiagnostics?: boolean;
}

export interface ResetSessionResult {
  deletedProviderSessions: number;
  deletedMessages: number;
  deletedModelRuns: number;
  deletedDeadLetters: number;
  deletedPromptSnapshots: number;
}

export type VoiceTurnReceiptStatus = "processing" | "completed" | "failed";

export interface VoiceTurnReceiptRecord {
  turnId: string;
  sessionId: string;
  agentId: string;
  utteranceId: string;
  status: VoiceTurnReceiptStatus;
  providerName: string | null;
  providerSessionId: string | null;
  responseText: string | null;
  providerUsedFailover: boolean | null;
  warmStartUsed: boolean | null;
  requestMessageId: number | null;
  responseMessageId: number | null;
  modelRunId: number | null;
  errorMessage: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export type TopicStatus = "active" | "archived";

export interface TopicRecord {
  id: string;
  channelKey: string;
  slug: string;
  title: string;
  leadAgentId: string | null;
  projectId: string | null;
  status: TopicStatus;
  createdAt: string;
  updatedAt: string;
}

export interface TopicFocusRecord {
  channelKey: string;
  topicId: string | null;
  updatedAt: string;
}

export interface ProjectFocusRecord {
  channelKey: string;
  projectId: string | null;
  updatedAt: string;
}

export interface StoredMemoryRecord {
  id: number;
  sessionId: string | null;
  agentId: string | null;
  source: MemorySource;
  content: string;
  importance: number;
  sourceRef: string | null;
  embeddingJson: string | null;
  embeddingModel: string | null;
  createdAt: string;
  lastAccessedAt: string;
  accessCount: number;
  archivedAt: string | null;
  metadata: Record<string, unknown> | null;
}

export interface MemoryInsertInput {
  sessionId?: string | null;
  agentId?: string | null;
  source: MemorySource;
  content: string;
  importance?: number;
  sourceRef?: string | null;
  embeddingJson?: string | null;
  embeddingModel?: string | null;
  createdAt?: string | null;
  lastAccessedAt?: string | null;
  archivedAt?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface MemoryEmbeddingUpdateInput {
  memoryId: number;
  embeddingJson: string;
  embeddingModel: string;
}

export interface ListMemoriesOptions {
  sessionId?: string | null;
  agentId?: string | null;
  source?: MemorySource | "all";
  includeArchived?: boolean;
  limit?: number;
}

export interface SessionSummaryRecord {
  id: number;
  sessionId: string;
  agentId: string;
  summaryText: string;
  tokenCount: number;
  coversThroughMessageId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionSummaryUpsertInput {
  sessionId: string;
  agentId: string;
  summaryText: string;
  tokenCount: number;
  coversThroughMessageId?: number | null;
}

export interface PinnedFactRecord {
  id: number;
  scope: PinnedFactScope;
  scopeId: string | null;
  key: string;
  value: string;
  createdAt: string;
  updatedAt: string;
}

export interface ObsidianIndexRecord {
  id: number;
  filePath: string;
  fileHash: string;
  lastIndexedAt: string;
  chunkCount: number;
}

export interface ObsidianIndexUpsertInput {
  filePath: string;
  fileHash: string;
  chunkCount: number;
  lastIndexedAt?: string | null;
}

export interface PinnedFactUpsertInput {
  scope: PinnedFactScope;
  scopeId?: string | null;
  key: string;
  value: string;
}

interface Migration {
  version: number;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        session_type TEXT NOT NULL,
        default_agent_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS provider_sessions (
        conversation_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        provider_session_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_provider_sessions_session_agent
        ON provider_sessions(session_id, agent_id);

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        agent_id TEXT,
        provider_name TEXT,
        direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound', 'system', 'error')),
        source TEXT NOT NULL CHECK(source IN ('discord', 'tango')),
        discord_message_id TEXT,
        discord_channel_id TEXT,
        discord_user_id TEXT,
        discord_username TEXT,
        content TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session_created
        ON messages(session_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_messages_channel_created
        ON messages(discord_channel_id, created_at);
    `
  },
  {
    version: 2,
    sql: `
      ALTER TABLE messages ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';

      CREATE TABLE IF NOT EXISTS model_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        conversation_key TEXT NOT NULL,
        provider_session_id TEXT,
        model TEXT,
        stop_reason TEXT,
        response_mode TEXT,
        latency_ms INTEGER,
        provider_duration_ms INTEGER,
        provider_api_duration_ms INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_input_tokens INTEGER,
        cache_creation_input_tokens INTEGER,
        total_cost_usd REAL,
        is_error INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        request_message_id INTEGER,
        response_message_id INTEGER,
        metadata_json TEXT,
        raw_response_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (request_message_id) REFERENCES messages(id) ON DELETE SET NULL,
        FOREIGN KEY (response_message_id) REFERENCES messages(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_model_runs_session_created
        ON model_runs(session_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_model_runs_conversation_created
        ON model_runs(conversation_key, created_at);
    `
  },
  {
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS dead_letters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        conversation_key TEXT NOT NULL,
        provider_session_id TEXT,
        request_message_id INTEGER,
        discord_channel_id TEXT,
        discord_user_id TEXT,
        discord_username TEXT,
        prompt_text TEXT NOT NULL,
        system_prompt TEXT,
        response_mode TEXT,
        failure_count INTEGER NOT NULL DEFAULT 1,
        replay_count INTEGER NOT NULL DEFAULT 0,
        last_error_message TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'resolved')),
        metadata_json TEXT,
        resolved_message_id INTEGER,
        resolved_model_run_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (request_message_id) REFERENCES messages(id) ON DELETE SET NULL,
        FOREIGN KEY (resolved_message_id) REFERENCES messages(id) ON DELETE SET NULL,
        FOREIGN KEY (resolved_model_run_id) REFERENCES model_runs(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_dead_letters_status_created
        ON dead_letters(status, created_at);

      CREATE INDEX IF NOT EXISTS idx_dead_letters_session_created
        ON dead_letters(session_id, created_at);
    `
  },
  {
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS session_provider_overrides (
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (session_id, agent_id),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_session_provider_overrides_session
        ON session_provider_overrides(session_id, updated_at);
    `
  },
  {
    version: 5,
    sql: `
      DROP INDEX IF EXISTS idx_provider_sessions_session_agent;

      ALTER TABLE provider_sessions RENAME TO provider_sessions_legacy;

      CREATE TABLE provider_sessions (
        conversation_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        provider_session_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (conversation_key, provider_name),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      INSERT INTO provider_sessions (
        conversation_key,
        session_id,
        agent_id,
        provider_name,
        provider_session_id,
        created_at,
        updated_at
      )
      SELECT
        conversation_key,
        session_id,
        agent_id,
        provider_name,
        provider_session_id,
        created_at,
        updated_at
      FROM provider_sessions_legacy;

      DROP TABLE provider_sessions_legacy;

      CREATE INDEX IF NOT EXISTS idx_provider_sessions_session_agent
        ON provider_sessions(session_id, agent_id);

      CREATE INDEX IF NOT EXISTS idx_provider_sessions_conversation
        ON provider_sessions(conversation_key, updated_at);
    `
  },
  {
    version: 6,
    sql: `
      CREATE TABLE IF NOT EXISTS session_compactions (
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        summary_text TEXT NOT NULL,
        compacted_turns INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (session_id, agent_id),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_session_compactions_updated
        ON session_compactions(session_id, updated_at);
    `
  },
  {
    version: 7,
    sql: `
      CREATE TABLE IF NOT EXISTS voice_turn_receipts (
        turn_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        utterance_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'processing' CHECK(status IN ('processing', 'completed', 'failed')),
        provider_name TEXT,
        provider_session_id TEXT,
        response_text TEXT,
        provider_used_failover INTEGER,
        warm_start_used INTEGER,
        request_message_id INTEGER,
        response_message_id INTEGER,
        model_run_id INTEGER,
        error_message TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (session_id, utterance_id),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (request_message_id) REFERENCES messages(id) ON DELETE SET NULL,
        FOREIGN KEY (response_message_id) REFERENCES messages(id) ON DELETE SET NULL,
        FOREIGN KEY (model_run_id) REFERENCES model_runs(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_voice_turn_receipts_session_created
        ON voice_turn_receipts(session_id, created_at);
    `
  },
  {
    version: 8,
    sql: `
      CREATE TABLE IF NOT EXISTS topics (
        id TEXT PRIMARY KEY,
        channel_key TEXT NOT NULL,
        slug TEXT NOT NULL,
        title TEXT NOT NULL,
        lead_agent_id TEXT,
        project_id TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (channel_key, slug)
      );

      CREATE INDEX IF NOT EXISTS idx_topics_channel_updated
        ON topics(channel_key, updated_at);
    `
  },
  {
    version: 9,
    sql: `
      CREATE TABLE IF NOT EXISTS topic_focus (
        channel_key TEXT PRIMARY KEY,
        topic_id TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (topic_id) REFERENCES topics(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_topic_focus_updated
        ON topic_focus(updated_at);
    `
  },
  {
    version: 10,
    sql: `
      CREATE TABLE IF NOT EXISTS project_focus (
        channel_key TEXT PRIMARY KEY,
        project_id TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_project_focus_updated
        ON project_focus(updated_at);
    `
  },
  {
    version: 11,
    sql: GOVERNANCE_DDL + GOVERNANCE_SEED,
  },
  {
    version: 12,
    sql: `
      -- Remove narrow tools replaced by universal ones
      DELETE FROM permissions WHERE tool_id IN ('atlas_ingredient_lookup', 'recipe_lookup');
      DELETE FROM governance_tools WHERE id IN ('atlas_ingredient_lookup', 'recipe_lookup');

      -- Grant nutrition-logger access to the universal replacements
      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason) VALUES
        ('worker:nutrition-logger', 'atlas_sql', 'write', 'replaced atlas_ingredient_lookup'),
        ('worker:nutrition-logger', 'recipe_read', 'read', 'replaced recipe_lookup');
    `,
  },
  {
    version: 13,
    sql: `
      CREATE TABLE IF NOT EXISTS discord_thread_sessions (
        thread_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    version: 14,
    sql: `
      CREATE TABLE IF NOT EXISTS discord_thread_sessions_new (
        thread_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT OR IGNORE INTO discord_thread_sessions_new SELECT * FROM discord_thread_sessions;
      DROP TABLE IF EXISTS discord_thread_sessions;
      ALTER TABLE discord_thread_sessions_new RENAME TO discord_thread_sessions;
    `,
  },
  {
    version: 15,
    sql: `
      -- SCHEDULE_RUNS: execution history for every scheduled job run.
      CREATE TABLE IF NOT EXISTS schedule_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schedule_id TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT (datetime('now')),
        finished_at TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        execution_mode TEXT NOT NULL,
        pre_check_result TEXT,
        duration_ms INTEGER,
        error TEXT,
        summary TEXT,
        model_used TEXT,
        worker_id TEXT,
        delivery_status TEXT,
        delivery_error TEXT,
        metadata TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_schedule_runs_schedule_id ON schedule_runs(schedule_id);
      CREATE INDEX IF NOT EXISTS idx_schedule_runs_started_at ON schedule_runs(started_at);
      CREATE INDEX IF NOT EXISTS idx_schedule_runs_status ON schedule_runs(status);

      -- SCHEDULE_STATE: runtime state persisted across restarts.
      CREATE TABLE IF NOT EXISTS schedule_state (
        schedule_id TEXT PRIMARY KEY,
        last_run_at TEXT,
        last_status TEXT,
        last_duration_ms INTEGER,
        last_error TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        backoff_until TEXT,
        total_runs INTEGER NOT NULL DEFAULT 0,
        total_ok INTEGER NOT NULL DEFAULT 0,
        total_errors INTEGER NOT NULL DEFAULT 0,
        total_skipped INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- SCHEDULE_COMPLETIONS: workflow-level idempotency tracking.
      CREATE TABLE IF NOT EXISTS schedule_completions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_id TEXT NOT NULL,
        completed_date TEXT NOT NULL,
        completed_by TEXT NOT NULL,
        schedule_run_id INTEGER,
        completed_at TEXT NOT NULL DEFAULT (datetime('now')),
        metadata TEXT,
        UNIQUE(workflow_id, completed_date)
      );

      CREATE INDEX IF NOT EXISTS idx_schedule_completions_workflow ON schedule_completions(workflow_id);
      CREATE INDEX IF NOT EXISTS idx_schedule_completions_date ON schedule_completions(completed_date);
    `,
  }
  ,
  {
    version: 16,
    sql: `
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        agent_id TEXT,
        source TEXT NOT NULL CHECK(source IN ('conversation', 'obsidian', 'reflection', 'manual', 'backfill')),
        content TEXT NOT NULL,
        importance REAL NOT NULL DEFAULT 0.5,
        source_ref TEXT,
        embedding_json TEXT,
        embedding_model TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_accessed_at TEXT NOT NULL DEFAULT (datetime('now')),
        access_count INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT,
        metadata_json TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_memories_agent ON memories(agent_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source, created_at);
      CREATE INDEX IF NOT EXISTS idx_memories_archived ON memories(archived_at, created_at);

      CREATE TABLE IF NOT EXISTS session_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        summary_text TEXT NOT NULL,
        token_count INTEGER NOT NULL DEFAULT 0,
        covers_through_message_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_session_summaries_scope
        ON session_summaries(session_id, agent_id, covers_through_message_id);
      CREATE INDEX IF NOT EXISTS idx_session_summaries_updated
        ON session_summaries(session_id, agent_id, updated_at);

      CREATE TABLE IF NOT EXISTS pinned_facts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL CHECK(scope IN ('global', 'agent', 'session')),
        scope_id TEXT,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_pinned_facts_scope_key
        ON pinned_facts(scope, scope_id, key);
      CREATE INDEX IF NOT EXISTS idx_pinned_facts_updated
        ON pinned_facts(updated_at);

      CREATE TABLE IF NOT EXISTS obsidian_index (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL UNIQUE,
        file_hash TEXT NOT NULL,
        last_indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
        chunk_count INTEGER NOT NULL DEFAULT 0
      );
    `,
  },
  {
    version: 17,
    sql: `
      INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type) VALUES
        ('memory_search', 'shared', 'Memory Search', 'read'),
        ('memory_add', 'shared', 'Memory Add', 'write');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason) VALUES
        ('user:owner', 'memory_search', 'read', 'universal memory retrieval'),
        ('user:owner', 'memory_add', 'write', 'universal memory storage');
    `,
  },
  {
    version: 18,
    sql: `
      INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type) VALUES
        ('memory_reflect', 'shared', 'Memory Reflect', 'write');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason) VALUES
        ('user:owner', 'memory_reflect', 'write', 'universal memory reflection');
    `,
  },
  {
    version: 19,
    sql: `
      CREATE TABLE IF NOT EXISTS prompt_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_run_id INTEGER NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        provider_name TEXT NOT NULL,
        request_message_id INTEGER,
        response_message_id INTEGER,
        prompt_text TEXT NOT NULL,
        system_prompt TEXT,
        warm_start_prompt TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL DEFAULT (datetime('now', '+72 hours')),
        FOREIGN KEY (model_run_id) REFERENCES model_runs(id) ON DELETE CASCADE,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (request_message_id) REFERENCES messages(id) ON DELETE SET NULL,
        FOREIGN KEY (response_message_id) REFERENCES messages(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_prompt_snapshots_session_created
        ON prompt_snapshots(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_prompt_snapshots_expires
        ON prompt_snapshots(expires_at);
      CREATE INDEX IF NOT EXISTS idx_prompt_snapshots_request_message
        ON prompt_snapshots(request_message_id);
      CREATE INDEX IF NOT EXISTS idx_prompt_snapshots_response_message
        ON prompt_snapshots(response_message_id);
    `,
  },
  {
    version: 20,
    sql: `
      CREATE TABLE IF NOT EXISTS voice_read_watermarks (
        channel_id TEXT PRIMARY KEY,
        watermark_message_id TEXT NOT NULL,
        watermark_source TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    version: 21,
    sql: `
      UPDATE permissions
      SET access_level = 'write',
          reason = 'sync fatsecret_api access with recipe-librarian config',
          updated_at = datetime('now')
      WHERE principal_id = 'worker:recipe-librarian'
        AND tool_id = 'fatsecret_api'
        AND access_level != 'write';

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      VALUES (
        'worker:recipe-librarian',
        'fatsecret_api',
        'write',
        'sync fatsecret_api access with recipe-librarian config'
      );
    `,
  },
  {
    version: 22,
    sql: `
      CREATE TABLE IF NOT EXISTS deterministic_turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        conversation_key TEXT NOT NULL,
        initiating_principal_id TEXT NOT NULL,
        lead_agent_principal_id TEXT NOT NULL,
        project_id TEXT,
        topic_id TEXT,
        intent_count INTEGER NOT NULL DEFAULT 0,
        intent_ids TEXT,
        intent_json TEXT NOT NULL,
        intent_model_run_id INTEGER,
        route_outcome TEXT NOT NULL
          CHECK(route_outcome IN ('executed', 'clarification', 'fallback')),
        execution_plan_json TEXT,
        step_count INTEGER NOT NULL DEFAULT 0,
        completed_step_count INTEGER NOT NULL DEFAULT 0,
        failed_step_count INTEGER NOT NULL DEFAULT 0,
        has_write_operations INTEGER NOT NULL DEFAULT 0,
        worker_ids TEXT,
        delegation_chain TEXT,
        receipts_json TEXT,
        narration_provider TEXT,
        narration_model TEXT,
        narration_latency_ms INTEGER,
        narration_retried INTEGER NOT NULL DEFAULT 0,
        narration_model_run_id INTEGER,
        intent_latency_ms INTEGER,
        route_latency_ms INTEGER,
        execution_latency_ms INTEGER,
        total_latency_ms INTEGER,
        request_message_id INTEGER,
        response_message_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (intent_model_run_id) REFERENCES model_runs(id) ON DELETE SET NULL,
        FOREIGN KEY (narration_model_run_id) REFERENCES model_runs(id) ON DELETE SET NULL,
        FOREIGN KEY (request_message_id) REFERENCES messages(id) ON DELETE SET NULL,
        FOREIGN KEY (response_message_id) REFERENCES messages(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_deterministic_turns_session
        ON deterministic_turns(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_deterministic_turns_conversation
        ON deterministic_turns(conversation_key, created_at);
      CREATE INDEX IF NOT EXISTS idx_deterministic_turns_outcome
        ON deterministic_turns(route_outcome, created_at);
      CREATE INDEX IF NOT EXISTS idx_deterministic_turns_principal
        ON deterministic_turns(initiating_principal_id, created_at);
    `,
  },
  {
    version: 23,
    sql: `
      ALTER TABLE deterministic_turns ADD COLUMN fallback_reason TEXT;
    `,
  },
  {
    version: 24,
    sql: `
      CREATE TABLE IF NOT EXISTS active_tasks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK(status IN ('proposed', 'awaiting_user', 'ready', 'running', 'blocked', 'completed', 'canceled', 'superseded', 'expired')),
        title TEXT NOT NULL,
        objective TEXT NOT NULL,
        owner_worker_id TEXT,
        intent_ids TEXT,
        missing_slots TEXT,
        clarification_question TEXT,
        suggested_next_action TEXT,
        structured_context_json TEXT,
        source_kind TEXT NOT NULL DEFAULT 'assistant-offer',
        created_by_message_id INTEGER,
        updated_by_message_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        resolved_at TEXT,
        expires_at TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by_message_id) REFERENCES messages(id) ON DELETE SET NULL,
        FOREIGN KEY (updated_by_message_id) REFERENCES messages(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_active_tasks_session_updated
        ON active_tasks(session_id, agent_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_active_tasks_open
        ON active_tasks(session_id, agent_id, status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_active_tasks_expires
        ON active_tasks(expires_at, status);
    `,
  },
  {
    version: 25,
    sql: `
      CREATE TABLE IF NOT EXISTS sub_agent_runs (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL,
        parent_session_id TEXT,
        parent_agent_id TEXT,
        conversation_key TEXT,
        coordinator_worker_id TEXT NOT NULL,
        round_index INTEGER NOT NULL DEFAULT 1,
        sub_task_id TEXT NOT NULL,
        provider_name TEXT,
        model TEXT,
        reasoning_effort TEXT,
        tool_ids TEXT,
        dependency_ids TEXT,
        status TEXT NOT NULL CHECK(status IN ('completed', 'failed', 'timeout')),
        duration_ms INTEGER NOT NULL DEFAULT 0,
        cost_estimate_usd REAL,
        error TEXT,
        output_text TEXT,
        tool_calls_json TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (parent_session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_sub_agent_runs_session
        ON sub_agent_runs(parent_session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_sub_agent_runs_conversation
        ON sub_agent_runs(conversation_key, created_at);
      CREATE INDEX IF NOT EXISTS idx_sub_agent_runs_batch
        ON sub_agent_runs(batch_id, created_at);

      INSERT OR IGNORE INTO principals (id, type, parent_id, display_name)
      SELECT 'worker:research-coordinator', 'worker', 'agent:sierra', 'Research Coordinator'
      WHERE EXISTS (
        SELECT 1 FROM principals WHERE id = 'agent:sierra'
      );

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:research-coordinator', 'exa_search', 'read', 'seed for sub-agent research coordination'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:research-coordinator')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'exa_search');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:research-coordinator', 'exa_answer', 'read', 'seed for sub-agent research coordination'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:research-coordinator')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'exa_answer');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:research-coordinator', 'printer_command', 'write', 'seed for sub-agent research coordination'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:research-coordinator')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'printer_command');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:research-coordinator', 'openscad_render', 'write', 'seed for sub-agent research coordination'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:research-coordinator')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'openscad_render');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:research-coordinator', 'prusa_slice', 'write', 'seed for sub-agent research coordination'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:research-coordinator')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'prusa_slice');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:research-coordinator', 'obsidian', 'write', 'seed for sub-agent research coordination'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:research-coordinator')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'obsidian');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:research-coordinator', 'location_read', 'read', 'seed for sub-agent research coordination'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:research-coordinator')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'location_read');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:research-coordinator', 'find_diesel', 'read', 'seed for sub-agent research coordination'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:research-coordinator')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'find_diesel');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:research-coordinator', 'walmart', 'write', 'seed for sub-agent research coordination'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:research-coordinator')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'walmart');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:research-coordinator', 'browser', 'write', 'seed for sub-agent research coordination'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:research-coordinator')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'browser');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:research-coordinator', 'file_ops', 'write', 'seed for sub-agent research coordination'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:research-coordinator')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'file_ops');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:research-coordinator', 'youtube_transcript', 'read', 'seed for sub-agent research coordination'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:research-coordinator')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'youtube_transcript');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:research-coordinator', 'youtube_analyze', 'read', 'seed for sub-agent research coordination'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:research-coordinator')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'youtube_analyze');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:research-coordinator', 'onepassword', 'read', 'seed for sub-agent research coordination'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:research-coordinator')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'onepassword');
    `,
  },
  {
    version: 26,
    sql: `
      INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type) VALUES
        ('slack', 'shared', 'Slack Workspace Read', 'read');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:personal-assistant', 'slack', 'read', 'seed from config'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:personal-assistant')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'slack');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:research-assistant', 'slack', 'read', 'seed from config'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:research-assistant')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'slack');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:research-coordinator', 'slack', 'read', 'seed for sub-agent research coordination'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:research-coordinator')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'slack');
    `,
  },
  {
    version: 27,
    sql: `
      INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type) VALUES
        ('receipt_registry', 'personal', 'Receipt Registry', 'write');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:personal-assistant', 'receipt_registry', 'write', 'seed from config'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:personal-assistant')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'receipt_registry');
    `,
  },
  {
    version: 28,
    sql: `
      INSERT OR IGNORE INTO governance_tools (id, domain, display_name, access_type) VALUES
        ('ramp_reimbursement', 'personal', 'Ramp Reimbursement Automation', 'write');

      INSERT OR IGNORE INTO permissions (principal_id, tool_id, access_level, reason)
      SELECT 'worker:personal-assistant', 'ramp_reimbursement', 'write', 'seed from config'
      WHERE EXISTS (SELECT 1 FROM principals WHERE id = 'worker:personal-assistant')
        AND EXISTS (SELECT 1 FROM governance_tools WHERE id = 'ramp_reimbursement');
    `,
  },
  {
    version: 29,
    sql: `
      CREATE INDEX IF NOT EXISTS idx_messages_discord_message
        ON messages(discord_message_id, created_at);

      CREATE TABLE IF NOT EXISTS channel_referents (
        channel_id TEXT NOT NULL,
        discord_user_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('reaction')),
        target_message_id TEXT NOT NULL,
        target_session_id TEXT,
        target_agent_id TEXT,
        target_direction TEXT CHECK(target_direction IN ('inbound', 'outbound', 'system', 'error')),
        target_source TEXT CHECK(target_source IN ('discord', 'imessage', 'tango')),
        target_content TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        expires_at TEXT NOT NULL,
        PRIMARY KEY (channel_id, discord_user_id)
      );

      CREATE INDEX IF NOT EXISTS idx_channel_referents_expires
        ON channel_referents(expires_at);
    `,
  }
];

export { resolveDatabasePath } from "./runtime-paths.js";

export class TangoStorage {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    const resolvedPath = path.resolve(dbPath);
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
    this.db = new DatabaseSync(resolvedPath);
    this.configure();
    this.migrate();
    if (this.getUserVersion() >= 19) {
      this.deleteExpiredPromptSnapshots();
    }
    if (this.getUserVersion() >= 24) {
      this.expireStaleActiveTasks();
    }
  }

  close(): void {
    this.db.close();
  }

  /** Expose database for governance and other modules that share this connection. */
  getDatabase(): DatabaseSync {
    return this.db;
  }

  configure(): void {
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
  }

  migrate(): void {
    const currentVersion = this.getUserVersion();

    for (const migration of MIGRATIONS) {
      if (migration.version <= currentVersion) continue;

      this.db.exec("BEGIN IMMEDIATE;");
      try {
        this.db.exec(migration.sql);
        this.db.exec(`PRAGMA user_version = ${migration.version};`);
        this.db.exec("COMMIT;");
      } catch (error) {
        this.db.exec("ROLLBACK;");
        throw error;
      }
    }
  }

  bootstrapSessions(sessions: SessionConfig[]): void {
    for (const session of sessions) {
      this.upsertSession(session);
    }
  }

  upsertSession(session: SessionConfig): void {
    this.db
      .prepare(
        `
          INSERT INTO sessions (id, session_type, default_agent_id, updated_at)
          VALUES (?, ?, ?, datetime('now'))
          ON CONFLICT(id) DO UPDATE SET
            session_type = excluded.session_type,
            default_agent_id = excluded.default_agent_id,
            updated_at = datetime('now')
        `
      )
      .run(session.id, session.type, session.agent);
  }

  upsertProviderSession(record: {
    conversationKey: string;
    sessionId: string;
    agentId: string;
    providerName: string;
    providerSessionId: string;
  }): void {
    this.db
      .prepare(
        `
          INSERT INTO provider_sessions (
            conversation_key,
            session_id,
            agent_id,
            provider_name,
            provider_session_id,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(conversation_key, provider_name) DO UPDATE SET
            session_id = excluded.session_id,
            agent_id = excluded.agent_id,
            provider_name = excluded.provider_name,
            provider_session_id = excluded.provider_session_id,
            updated_at = datetime('now')
        `
      )
      .run(
        record.conversationKey,
        record.sessionId,
        record.agentId,
        record.providerName,
        record.providerSessionId
      );
  }

  getProviderSession(conversationKey: string, providerName?: string): ProviderSessionRecord | null {
    if (providerName && providerName.trim().length > 0) {
      const row = this.db
        .prepare(
          `
            SELECT
              conversation_key AS conversationKey,
              session_id AS sessionId,
              agent_id AS agentId,
              provider_name AS providerName,
              provider_session_id AS providerSessionId,
              created_at AS createdAt,
              updated_at AS updatedAt
            FROM provider_sessions
            WHERE conversation_key = ? AND provider_name = ?
          `
        )
        .get(conversationKey, providerName.trim()) as ProviderSessionRecord | undefined;

      return row ?? null;
    }

    const row = this.db
      .prepare(
        `
          SELECT
            conversation_key AS conversationKey,
            session_id AS sessionId,
            agent_id AS agentId,
            provider_name AS providerName,
            provider_session_id AS providerSessionId,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM provider_sessions
          WHERE conversation_key = ?
          ORDER BY updated_at DESC
          LIMIT 1
        `
      )
      .get(conversationKey) as ProviderSessionRecord | undefined;

    return row ?? null;
  }

  clearProviderSession(conversationKey: string, providerName?: string): boolean {
    const normalizedProviderName = providerName?.trim();
    const result =
      normalizedProviderName && normalizedProviderName.length > 0
        ? this.db
            .prepare(
              `
                DELETE FROM provider_sessions
                WHERE conversation_key = ? AND provider_name = ?
              `
            )
            .run(conversationKey, normalizedProviderName)
        : this.db
            .prepare(
              `
                DELETE FROM provider_sessions
                WHERE conversation_key = ?
              `
            )
            .run(conversationKey);

    return toSafeNumber(result.changes) > 0;
  }

  listProviderSessionsForConversation(conversationKey: string, limit = 50): ProviderSessionRecord[] {
    const resolvedLimit = Number.isFinite(limit) ? Math.max(limit, 1) : 50;
    const rows = this.db
      .prepare(
        `
          SELECT
            conversation_key AS conversationKey,
            session_id AS sessionId,
            agent_id AS agentId,
            provider_name AS providerName,
            provider_session_id AS providerSessionId,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM provider_sessions
          WHERE conversation_key = ?
          ORDER BY updated_at DESC
          LIMIT ?
        `
      )
      .all(conversationKey, resolvedLimit) as Array<{
      conversationKey: string;
      sessionId: string;
      agentId: string;
      providerName: string;
      providerSessionId: string;
      createdAt: string;
      updatedAt: string;
    }>;

    return rows.map((row) => ({
      conversationKey: row.conversationKey,
      sessionId: row.sessionId,
      agentId: row.agentId,
      providerName: row.providerName,
      providerSessionId: row.providerSessionId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }));
  }

  upsertSessionCompaction(input: {
    sessionId: string;
    agentId: string;
    summaryText: string;
    compactedTurns: number;
  }): void {
    this.db
      .prepare(
        `
          INSERT INTO session_compactions (
            session_id,
            agent_id,
            summary_text,
            compacted_turns,
            updated_at
          )
          VALUES (?, ?, ?, ?, datetime('now'))
          ON CONFLICT(session_id, agent_id) DO UPDATE SET
            summary_text = excluded.summary_text,
            compacted_turns = excluded.compacted_turns,
            updated_at = datetime('now')
        `
      )
      .run(input.sessionId, input.agentId, input.summaryText, Math.max(0, input.compactedTurns));
  }

  getSessionCompaction(sessionId: string, agentId: string): SessionCompactionRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
            session_id AS sessionId,
            agent_id AS agentId,
            summary_text AS summaryText,
            compacted_turns AS compactedTurns,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM session_compactions
          WHERE session_id = ? AND agent_id = ?
        `
      )
      .get(sessionId, agentId) as SessionCompactionRecord | undefined;

    return row ?? null;
  }

  clearSessionCompaction(sessionId: string, agentId: string): boolean {
    const result = this.db
      .prepare(
        `
          DELETE FROM session_compactions
          WHERE session_id = ? AND agent_id = ?
        `
      )
      .run(sessionId, agentId);

    return toSafeNumber(result.changes) > 0;
  }

  insertMemory(input: MemoryInsertInput): number {
    const metadataJson = toJsonOrNull(input.metadata);
    const normalizedImportance = Math.min(Math.max(input.importance ?? 0.5, 0), 1);
    const result = this.db
      .prepare(
        `
          INSERT INTO memories (
            session_id,
            agent_id,
            source,
            content,
            importance,
            source_ref,
            embedding_json,
            embedding_model,
            created_at,
            last_accessed_at,
            archived_at,
            metadata_json
          )
          VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?,
            COALESCE(?, datetime('now')),
            COALESCE(?, COALESCE(?, datetime('now'))),
            ?,
            ?
          )
        `
      )
      .run(
        input.sessionId ?? null,
        input.agentId ?? null,
        input.source,
        input.content,
        normalizedImportance,
        input.sourceRef ?? null,
        input.embeddingJson ?? null,
        input.embeddingModel ?? null,
        input.createdAt ?? null,
        input.lastAccessedAt ?? null,
        input.createdAt ?? null,
        input.archivedAt ?? null,
        metadataJson
      );

    const rowId = result.lastInsertRowid;
    return typeof rowId === "bigint" ? Number(rowId) : rowId;
  }

  getMemory(memoryId: number): StoredMemoryRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            session_id AS sessionId,
            agent_id AS agentId,
            source,
            content,
            importance,
            source_ref AS sourceRef,
            embedding_json AS embeddingJson,
            embedding_model AS embeddingModel,
            created_at AS createdAt,
            last_accessed_at AS lastAccessedAt,
            access_count AS accessCount,
            archived_at AS archivedAt,
            metadata_json AS metadataJson
          FROM memories
          WHERE id = ?
        `
      )
      .get(memoryId) as
      | (Omit<StoredMemoryRecord, "metadata"> & { metadataJson: string | null })
      | undefined;

    if (!row) return null;
    return toStoredMemoryRecord(row);
  }

  findMemoryBySourceRef(sourceRef: string, source?: MemorySource): StoredMemoryRecord | null {
    const row = (source
      ? this.db
          .prepare(
            `
              SELECT
                id,
                session_id AS sessionId,
                agent_id AS agentId,
                source,
                content,
                importance,
                source_ref AS sourceRef,
                embedding_json AS embeddingJson,
                embedding_model AS embeddingModel,
                created_at AS createdAt,
                last_accessed_at AS lastAccessedAt,
                access_count AS accessCount,
                archived_at AS archivedAt,
                metadata_json AS metadataJson
              FROM memories
              WHERE source_ref = ? AND source = ?
              ORDER BY id DESC
              LIMIT 1
            `
          )
          .get(sourceRef, source)
      : this.db
          .prepare(
            `
              SELECT
                id,
                session_id AS sessionId,
                agent_id AS agentId,
                source,
                content,
                importance,
                source_ref AS sourceRef,
                embedding_json AS embeddingJson,
                embedding_model AS embeddingModel,
                created_at AS createdAt,
                last_accessed_at AS lastAccessedAt,
                access_count AS accessCount,
                archived_at AS archivedAt,
                metadata_json AS metadataJson
              FROM memories
              WHERE source_ref = ?
              ORDER BY id DESC
              LIMIT 1
            `
          )
          .get(sourceRef)) as
      | (Omit<StoredMemoryRecord, "metadata"> & { metadataJson: string | null })
      | undefined;

    if (!row) return null;
    return toStoredMemoryRecord(row);
  }

  listMemories(options: ListMemoriesOptions = {}): StoredMemoryRecord[] {
    const conditions: string[] = [];
    const values: Array<string | number | null> = [];

    if (options.sessionId !== undefined) {
      if (options.sessionId === null) {
        conditions.push("session_id IS NULL");
      } else {
        conditions.push("(session_id = ? OR session_id IS NULL)");
        values.push(options.sessionId);
      }
    }

    if (options.agentId !== undefined) {
      if (options.agentId === null) {
        conditions.push("agent_id IS NULL");
      } else {
        conditions.push("(agent_id = ? OR agent_id IS NULL)");
        values.push(options.agentId);
      }
    }

    if (options.source && options.source !== "all") {
      conditions.push("source = ?");
      values.push(options.source);
    }

    if (options.includeArchived !== true) {
      conditions.push("archived_at IS NULL");
    }

    const limit = Number.isFinite(options.limit) ? Math.max(options.limit ?? 100, 1) : 100;
    values.push(limit);

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `
          SELECT
            id,
            session_id AS sessionId,
            agent_id AS agentId,
            source,
            content,
            importance,
            source_ref AS sourceRef,
            embedding_json AS embeddingJson,
            embedding_model AS embeddingModel,
            created_at AS createdAt,
            last_accessed_at AS lastAccessedAt,
            access_count AS accessCount,
            archived_at AS archivedAt,
            metadata_json AS metadataJson
          FROM memories
          ${whereClause}
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `
      )
      .all(...values) as Array<Omit<StoredMemoryRecord, "metadata"> & { metadataJson: string | null }>;

    return rows.map((row) => toStoredMemoryRecord(row));
  }

  touchMemories(memoryIds: number[]): void {
    const ids = [...new Set(memoryIds.filter((value) => Number.isInteger(value) && value > 0))];
    if (ids.length === 0) return;

    const statement = this.db.prepare(
      `
        UPDATE memories
        SET
          last_accessed_at = datetime('now'),
          access_count = access_count + 1
        WHERE id = ?
      `
    );

    this.db.exec("BEGIN IMMEDIATE;");
    try {
      for (const memoryId of ids) {
        statement.run(memoryId);
      }
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  archiveMemory(memoryId: number): boolean {
    const result = this.db
      .prepare(
        `
          UPDATE memories
          SET archived_at = COALESCE(archived_at, datetime('now'))
          WHERE id = ?
        `
      )
      .run(memoryId);

    return toSafeNumber(result.changes) > 0;
  }

  updateMemoryEmbedding(input: MemoryEmbeddingUpdateInput): boolean {
    const result = this.db
      .prepare(
        `
          UPDATE memories
          SET
            embedding_json = ?,
            embedding_model = ?
          WHERE id = ?
        `
      )
      .run(input.embeddingJson, input.embeddingModel, input.memoryId);

    return toSafeNumber(result.changes) > 0;
  }

  deleteMemoriesBySourceRefPrefix(source: MemorySource, sourceRefPrefix: string): number {
    const result = this.db
      .prepare(
        `
          DELETE FROM memories
          WHERE source = ? AND source_ref LIKE ?
        `
      )
      .run(source, `${sourceRefPrefix}%`);

    return toSafeNumber(result.changes);
  }

  upsertSessionMemorySummary(input: SessionSummaryUpsertInput): void {
    this.db
      .prepare(
        `
          INSERT INTO session_summaries (
            session_id,
            agent_id,
            summary_text,
            token_count,
            covers_through_message_id,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(session_id, agent_id, covers_through_message_id) DO UPDATE SET
            summary_text = excluded.summary_text,
            token_count = excluded.token_count,
            updated_at = datetime('now')
        `
      )
      .run(
        input.sessionId,
        input.agentId,
        input.summaryText,
        Math.max(0, input.tokenCount),
        input.coversThroughMessageId ?? null
      );
  }

  getLatestSessionMemorySummary(sessionId: string, agentId: string): SessionSummaryRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            session_id AS sessionId,
            agent_id AS agentId,
            summary_text AS summaryText,
            token_count AS tokenCount,
            covers_through_message_id AS coversThroughMessageId,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM session_summaries
          WHERE session_id = ? AND agent_id = ?
          ORDER BY COALESCE(covers_through_message_id, 0) DESC, id DESC
          LIMIT 1
        `
      )
      .get(sessionId, agentId) as SessionSummaryRecord | undefined;

    return row ?? null;
  }

  listSessionMemorySummaries(sessionId: string, agentId: string, limit = 20): SessionSummaryRecord[] {
    const resolvedLimit = Number.isFinite(limit) ? Math.max(limit, 1) : 20;
    const rows = this.db
      .prepare(
        `
          SELECT
            id,
            session_id AS sessionId,
            agent_id AS agentId,
            summary_text AS summaryText,
            token_count AS tokenCount,
            covers_through_message_id AS coversThroughMessageId,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM session_summaries
          WHERE session_id = ? AND agent_id = ?
          ORDER BY COALESCE(covers_through_message_id, 0) DESC, id DESC
          LIMIT ?
        `
      )
      .all(sessionId, agentId, resolvedLimit) as Array<{
      id: number;
      sessionId: string;
      agentId: string;
      summaryText: string;
      tokenCount: number;
      coversThroughMessageId: number | null;
      createdAt: string;
      updatedAt: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.sessionId,
      agentId: row.agentId,
      summaryText: row.summaryText,
      tokenCount: row.tokenCount,
      coversThroughMessageId: row.coversThroughMessageId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  upsertPinnedFact(input: PinnedFactUpsertInput): void {
    this.db
      .prepare(
        `
          INSERT INTO pinned_facts (
            scope,
            scope_id,
            key,
            value,
            updated_at
          )
          VALUES (?, ?, ?, ?, datetime('now'))
          ON CONFLICT(scope, scope_id, key) DO UPDATE SET
            value = excluded.value,
            updated_at = datetime('now')
        `
      )
      .run(input.scope, input.scopeId ?? null, input.key, input.value);
  }

  listPinnedFactsForContext(sessionId: string, agentId: string): PinnedFactRecord[] {
    const rows = this.db
      .prepare(
        `
          SELECT
            id,
            scope,
            scope_id AS scopeId,
            key,
            value,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM pinned_facts
          WHERE
            (scope = 'global' AND scope_id IS NULL) OR
            (scope = 'agent' AND scope_id = ?) OR
            (scope = 'session' AND scope_id = ?)
          ORDER BY
            CASE scope
              WHEN 'session' THEN 0
              WHEN 'agent' THEN 1
              ELSE 2
            END,
            key ASC
        `
      )
      .all(agentId, sessionId) as Array<{
      id: number;
      scope: PinnedFactScope;
      scopeId: string | null;
      key: string;
      value: string;
      createdAt: string;
      updatedAt: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      scope: row.scope,
      scopeId: row.scopeId,
      key: row.key,
      value: row.value,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  deletePinnedFact(scope: PinnedFactScope, scopeId: string | null, key: string): boolean {
    const result = this.db
      .prepare(
        `
          DELETE FROM pinned_facts
          WHERE scope = ? AND scope_id IS ? AND key = ?
        `
      )
      .run(scope, scopeId, key);

    return toSafeNumber(result.changes) > 0;
  }

  getObsidianIndexEntry(filePath: string): ObsidianIndexRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            file_path AS filePath,
            file_hash AS fileHash,
            last_indexed_at AS lastIndexedAt,
            chunk_count AS chunkCount
          FROM obsidian_index
          WHERE file_path = ?
        `
      )
      .get(filePath) as ObsidianIndexRecord | undefined;

    return row ?? null;
  }

  listObsidianIndexEntries(limit = 10_000): ObsidianIndexRecord[] {
    const resolvedLimit = Number.isFinite(limit) ? Math.max(limit, 1) : 10_000;
    return this.db
      .prepare(
        `
          SELECT
            id,
            file_path AS filePath,
            file_hash AS fileHash,
            last_indexed_at AS lastIndexedAt,
            chunk_count AS chunkCount
          FROM obsidian_index
          ORDER BY file_path ASC
          LIMIT ?
        `
      )
      .all(resolvedLimit) as unknown as ObsidianIndexRecord[];
  }

  upsertObsidianIndexEntry(input: ObsidianIndexUpsertInput): void {
    this.db
      .prepare(
        `
          INSERT INTO obsidian_index (
            file_path,
            file_hash,
            last_indexed_at,
            chunk_count
          )
          VALUES (?, ?, COALESCE(?, datetime('now')), ?)
          ON CONFLICT(file_path) DO UPDATE SET
            file_hash = excluded.file_hash,
            last_indexed_at = excluded.last_indexed_at,
            chunk_count = excluded.chunk_count
        `
      )
      .run(
        input.filePath,
        input.fileHash,
        input.lastIndexedAt ?? null,
        Math.max(0, Math.floor(input.chunkCount))
      );
  }

  deleteObsidianIndexEntry(filePath: string): boolean {
    const result = this.db
      .prepare(
        `
          DELETE FROM obsidian_index
          WHERE file_path = ?
        `
      )
      .run(filePath);

    return toSafeNumber(result.changes) > 0;
  }

  upsertSessionProviderOverride(input: {
    sessionId: string;
    agentId: string;
    providerName: string;
  }): void {
    this.db
      .prepare(
        `
          INSERT INTO session_provider_overrides (
            session_id,
            agent_id,
            provider_name,
            updated_at
          )
          VALUES (?, ?, ?, datetime('now'))
          ON CONFLICT(session_id, agent_id) DO UPDATE SET
            provider_name = excluded.provider_name,
            updated_at = datetime('now')
        `
      )
      .run(input.sessionId, input.agentId, input.providerName);
  }

  getSessionProviderOverride(
    sessionId: string,
    agentId: string
  ): SessionProviderOverrideRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
            session_id AS sessionId,
            agent_id AS agentId,
            provider_name AS providerName,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM session_provider_overrides
          WHERE session_id = ? AND agent_id = ?
        `
      )
      .get(sessionId, agentId) as SessionProviderOverrideRecord | undefined;

    return row ?? null;
  }

  clearSessionProviderOverride(sessionId: string, agentId: string): boolean {
    const result = this.db
      .prepare(
        `
          DELETE FROM session_provider_overrides
          WHERE session_id = ? AND agent_id = ?
        `
      )
      .run(sessionId, agentId);

    return toSafeNumber(result.changes) > 0;
  }

  listSessionProviderOverrides(sessionId?: string, limit = 200): SessionProviderOverrideRecord[] {
    const resolvedLimit = Number.isFinite(limit) ? Math.max(limit, 1) : 200;
    if (sessionId) {
      const rows = this.db
        .prepare(
          `
            SELECT
              session_id AS sessionId,
              agent_id AS agentId,
              provider_name AS providerName,
              created_at AS createdAt,
              updated_at AS updatedAt
            FROM session_provider_overrides
            WHERE session_id = ?
            ORDER BY updated_at DESC
            LIMIT ?
          `
        )
        .all(sessionId, resolvedLimit) as Array<{
        sessionId: string;
        agentId: string;
        providerName: string;
        createdAt: string;
        updatedAt: string;
      }>;

      return rows.map((row) => ({
        sessionId: row.sessionId,
        agentId: row.agentId,
        providerName: row.providerName,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
      }));
    }

    const rows = this.db
      .prepare(
        `
          SELECT
            session_id AS sessionId,
            agent_id AS agentId,
            provider_name AS providerName,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM session_provider_overrides
          ORDER BY updated_at DESC
          LIMIT ?
        `
      )
      .all(resolvedLimit) as Array<{
      sessionId: string;
      agentId: string;
      providerName: string;
      createdAt: string;
      updatedAt: string;
    }>;

    return rows.map((row) => ({
      sessionId: row.sessionId,
      agentId: row.agentId,
      providerName: row.providerName,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }));
  }

  insertMessage(input: MessageInsertInput): number {
    const metadataJson = toJsonOrNull(input.metadata);

    const result = this.db
      .prepare(
        `
          INSERT INTO messages (
            session_id,
            agent_id,
            provider_name,
            direction,
            source,
            visibility,
            discord_message_id,
            discord_channel_id,
            discord_user_id,
            discord_username,
            content,
            metadata_json
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        input.sessionId,
        input.agentId ?? null,
        input.providerName ?? null,
        input.direction,
        input.source,
        input.visibility ?? "public",
        input.discordMessageId ?? null,
        input.discordChannelId ?? null,
        input.discordUserId ?? null,
        input.discordUsername ?? null,
        input.content,
        metadataJson
      );

    const rowId = result.lastInsertRowid;
    return typeof rowId === "bigint" ? Number(rowId) : rowId;
  }

  upsertTopic(input: {
    channelKey: string;
    slug: string;
    title: string;
    leadAgentId?: string | null;
    projectId?: string | null;
    preserveProjectId?: boolean;
    status?: TopicStatus;
  }): TopicRecord {
    const existing = this.getTopicByChannelAndSlug(input.channelKey, input.slug);
    if (existing) {
      const nextProjectId =
        input.preserveProjectId === false
          ? (input.projectId ?? null)
          : (input.projectId ?? existing.projectId);
      this.db
        .prepare(
          `
            UPDATE topics
            SET
              title = ?,
              lead_agent_id = ?,
              project_id = ?,
              status = ?,
              updated_at = datetime('now')
            WHERE id = ?
          `
        )
        .run(
          input.title,
          input.leadAgentId ?? existing.leadAgentId,
          nextProjectId,
          input.status ?? existing.status,
          existing.id
        );

      return this.getTopicById(existing.id)!;
    }

    const topicId = randomUUID();
    this.db
      .prepare(
        `
          INSERT INTO topics (
            id,
            channel_key,
            slug,
            title,
            lead_agent_id,
            project_id,
            status
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        topicId,
        input.channelKey,
        input.slug,
        input.title,
        input.leadAgentId ?? null,
        input.projectId ?? null,
        input.status ?? "active"
      );

    return this.getTopicById(topicId)!;
  }

  getTopicById(topicId: string): TopicRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            channel_key AS channelKey,
            slug,
            title,
            lead_agent_id AS leadAgentId,
            project_id AS projectId,
            status,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM topics
          WHERE id = ?
        `
      )
      .get(topicId) as
      | {
          id: string;
          channelKey: string;
          slug: string;
          title: string;
          leadAgentId: string | null;
          projectId: string | null;
          status: TopicStatus;
          createdAt: string;
          updatedAt: string;
        }
      | undefined;

    if (!row) return null;
    return row;
  }

  getTopicByChannelAndSlug(channelKey: string, slug: string): TopicRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            channel_key AS channelKey,
            slug,
            title,
            lead_agent_id AS leadAgentId,
            project_id AS projectId,
            status,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM topics
          WHERE channel_key = ? AND slug = ?
        `
      )
      .get(channelKey, slug) as
      | {
          id: string;
          channelKey: string;
          slug: string;
          title: string;
          leadAgentId: string | null;
          projectId: string | null;
          status: TopicStatus;
          createdAt: string;
          updatedAt: string;
        }
      | undefined;

    if (!row) return null;
    return row;
  }

  listTopicsForChannel(channelKey: string, limit = 50): TopicRecord[] {
    const rows = this.db
      .prepare(
        `
          SELECT
            id,
            channel_key AS channelKey,
            slug,
            title,
            lead_agent_id AS leadAgentId,
            project_id AS projectId,
            status,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM topics
          WHERE channel_key = ?
          ORDER BY updated_at DESC
          LIMIT ?
        `
      )
      .all(channelKey, limit) as Array<{
      id: string;
      channelKey: string;
      slug: string;
      title: string;
      leadAgentId: string | null;
      projectId: string | null;
      status: TopicStatus;
      createdAt: string;
      updatedAt: string;
    }>;

    return rows;
  }

  setFocusedTopicForChannel(channelKey: string, topicId: string | null): void {
    this.db
      .prepare(
        `
          INSERT INTO topic_focus (
            channel_key,
            topic_id,
            updated_at
          )
          VALUES (?, ?, datetime('now'))
          ON CONFLICT(channel_key) DO UPDATE SET
            topic_id = excluded.topic_id,
            updated_at = datetime('now')
        `
      )
      .run(channelKey, topicId);
  }

  getFocusedTopicRecordForChannel(channelKey: string): TopicFocusRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
            channel_key AS channelKey,
            topic_id AS topicId,
            updated_at AS updatedAt
          FROM topic_focus
          WHERE channel_key = ?
        `
      )
      .get(channelKey) as
      | {
          channelKey: string;
          topicId: string | null;
          updatedAt: string;
        }
      | undefined;

    if (!row) return null;
    return row;
  }

  getFocusedTopicForChannel(channelKey: string): TopicRecord | null {
    const focused = this.getFocusedTopicRecordForChannel(channelKey);
    if (!focused?.topicId) return null;
    return this.getTopicById(focused.topicId);
  }

  setFocusedProjectForChannel(channelKey: string, projectId: string | null): void {
    this.db
      .prepare(
        `
          INSERT INTO project_focus (
            channel_key,
            project_id,
            updated_at
          )
          VALUES (?, ?, datetime('now'))
          ON CONFLICT(channel_key) DO UPDATE SET
            project_id = excluded.project_id,
            updated_at = datetime('now')
        `
      )
      .run(channelKey, projectId);
  }

  getFocusedProjectRecordForChannel(channelKey: string): ProjectFocusRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
            channel_key AS channelKey,
            project_id AS projectId,
            updated_at AS updatedAt
          FROM project_focus
          WHERE channel_key = ?
        `
      )
      .get(channelKey) as
      | {
          channelKey: string;
          projectId: string | null;
          updatedAt: string;
        }
      | undefined;

    if (!row) return null;
    return row;
  }

  getFocusedProjectIdForChannel(channelKey: string): string | null {
    return this.getFocusedProjectRecordForChannel(channelKey)?.projectId ?? null;
  }

  setThreadSession(threadId: string, sessionId: string, agentId?: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO discord_thread_sessions (thread_id, session_id, agent_id)
         VALUES (?, ?, ?)`
      )
      .run(threadId, sessionId, agentId ?? null);
  }

  getThreadSession(threadId: string): { sessionId: string; agentId: string | null } | null {
    const row = this.db
      .prepare(`SELECT session_id, agent_id FROM discord_thread_sessions WHERE thread_id = ?`)
      .get(threadId) as { session_id: string; agent_id: string | null } | undefined;
    if (!row) return null;
    return { sessionId: row.session_id, agentId: row.agent_id };
  }

  deleteThreadSession(threadId: string): void {
    this.db
      .prepare(`DELETE FROM discord_thread_sessions WHERE thread_id = ?`)
      .run(threadId);
  }

  listDiscordThreadSessionIds(): string[] {
    const rows = this.db
      .prepare(`SELECT thread_id FROM discord_thread_sessions`)
      .all() as { thread_id: string }[];
    return rows.map((row) => row.thread_id);
  }

  listThreadSessionsWithAgent(): { threadId: string; sessionId: string; agentId: string }[] {
    const rows = this.db
      .prepare(`SELECT thread_id, session_id, agent_id FROM discord_thread_sessions WHERE agent_id IS NOT NULL`)
      .all() as { thread_id: string; session_id: string; agent_id: string }[];
    return rows.map((row) => ({ threadId: row.thread_id, sessionId: row.session_id, agentId: row.agent_id }));
  }

  listThreadSessionsMissingAgent(): { threadId: string; sessionId: string }[] {
    const rows = this.db
      .prepare(`SELECT thread_id, session_id FROM discord_thread_sessions WHERE agent_id IS NULL`)
      .all() as { thread_id: string; session_id: string }[];
    return rows.map((row) => ({ threadId: row.thread_id, sessionId: row.session_id }));
  }

  getSessionDefaultAgentId(sessionId: string): string | null {
    const row = this.db
      .prepare(`SELECT default_agent_id FROM sessions WHERE id = ?`)
      .get(sessionId) as { default_agent_id: string } | undefined;
    return row?.default_agent_id ?? null;
  }

  insertModelRun(input: ModelRunInsertInput): number {
    const metadataJson = toJsonOrNull(input.metadata);
    const rawResponseJson = toJsonOrNull(input.rawResponse);

    const result = this.db
      .prepare(
        `
          INSERT INTO model_runs (
            session_id,
            agent_id,
            provider_name,
            conversation_key,
            provider_session_id,
            model,
            stop_reason,
            response_mode,
            latency_ms,
            provider_duration_ms,
            provider_api_duration_ms,
            input_tokens,
            output_tokens,
            cache_read_input_tokens,
            cache_creation_input_tokens,
            total_cost_usd,
            is_error,
            error_message,
            request_message_id,
            response_message_id,
            metadata_json,
            raw_response_json
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        input.sessionId,
        input.agentId,
        input.providerName,
        input.conversationKey,
        input.providerSessionId ?? null,
        input.model ?? null,
        input.stopReason ?? null,
        input.responseMode ?? null,
        input.latencyMs ?? null,
        input.providerDurationMs ?? null,
        input.providerApiDurationMs ?? null,
        input.inputTokens ?? null,
        input.outputTokens ?? null,
        input.cacheReadInputTokens ?? null,
        input.cacheCreationInputTokens ?? null,
        input.totalCostUsd ?? null,
        input.isError ? 1 : 0,
        input.errorMessage ?? null,
        input.requestMessageId ?? null,
        input.responseMessageId ?? null,
        metadataJson,
        rawResponseJson
      );

    const rowId = result.lastInsertRowid;
    return typeof rowId === "bigint" ? Number(rowId) : rowId;
  }

  getModelRun(id: number): ModelRunRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            session_id AS sessionId,
            agent_id AS agentId,
            provider_name AS providerName,
            conversation_key AS conversationKey,
            provider_session_id AS providerSessionId,
            model,
            stop_reason AS stopReason,
            response_mode AS responseMode,
            latency_ms AS latencyMs,
            provider_duration_ms AS providerDurationMs,
            provider_api_duration_ms AS providerApiDurationMs,
            input_tokens AS inputTokens,
            output_tokens AS outputTokens,
            cache_read_input_tokens AS cacheReadInputTokens,
            cache_creation_input_tokens AS cacheCreationInputTokens,
            total_cost_usd AS totalCostUsd,
            is_error AS isError,
            error_message AS errorMessage,
            request_message_id AS requestMessageId,
            response_message_id AS responseMessageId,
            metadata_json AS metadataJson,
            raw_response_json AS rawResponseJson,
            created_at AS createdAt
          FROM model_runs
          WHERE id = ?
        `
      )
      .get(id) as
      | (Omit<ModelRunRecord, "metadata" | "rawResponse"> & {
          metadataJson: string | null;
          rawResponseJson: string | null;
        })
      | undefined;

    if (!row) return null;

    return {
      id: row.id,
      sessionId: row.sessionId,
      agentId: row.agentId,
      providerName: row.providerName,
      conversationKey: row.conversationKey,
      providerSessionId: row.providerSessionId,
      model: row.model,
      stopReason: row.stopReason,
      responseMode: row.responseMode,
      latencyMs: row.latencyMs,
      providerDurationMs: row.providerDurationMs,
      providerApiDurationMs: row.providerApiDurationMs,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadInputTokens: row.cacheReadInputTokens,
      cacheCreationInputTokens: row.cacheCreationInputTokens,
      totalCostUsd: row.totalCostUsd,
      isError: row.isError,
      errorMessage: row.errorMessage,
      requestMessageId: row.requestMessageId,
      responseMessageId: row.responseMessageId,
      metadata: row.metadataJson ? safeJsonParse(row.metadataJson) : null,
      rawResponse: row.rawResponseJson ? safeJsonParse(row.rawResponseJson) : null,
      createdAt: row.createdAt
    };
  }

  insertDeterministicTurn(input: DeterministicTurnInsertInput): string {
    const id = input.id?.trim() || randomUUID();
    const intentIds = input.intentIds ?? [];
    const workerIds = input.workerIds ?? [];
    const delegationChain = input.delegationChain ?? [];
    const intentJson = JSON.stringify(input.intentJson);
    const executionPlanJson = JSON.stringify(input.executionPlanJson ?? null);
    const receiptsJson = JSON.stringify(input.receiptsJson ?? null);
    const stepCount =
      Array.isArray(input.receiptsJson)
        ? input.receiptsJson.length
        : Array.isArray((input.executionPlanJson as { steps?: unknown } | null | undefined)?.steps)
          ? ((input.executionPlanJson as { steps: unknown[] }).steps.length)
          : 0;

    this.db
      .prepare(
        `
          INSERT INTO deterministic_turns (
            id,
            session_id,
            agent_id,
            conversation_key,
            initiating_principal_id,
            lead_agent_principal_id,
            project_id,
            topic_id,
            intent_count,
            intent_ids,
            intent_json,
            intent_model_run_id,
            route_outcome,
            fallback_reason,
            execution_plan_json,
            step_count,
            completed_step_count,
            failed_step_count,
            has_write_operations,
            worker_ids,
            delegation_chain,
            receipts_json,
            narration_provider,
            narration_model,
            narration_latency_ms,
            narration_retried,
            narration_model_run_id,
            intent_latency_ms,
            route_latency_ms,
            execution_latency_ms,
            total_latency_ms,
            request_message_id,
            response_message_id
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        id,
        input.sessionId,
        input.agentId,
        input.conversationKey,
        input.initiatingPrincipalId,
        input.leadAgentPrincipalId,
        input.projectId ?? null,
        input.topicId ?? null,
        intentIds.length,
        JSON.stringify(intentIds),
        intentJson,
        input.intentModelRunId ?? null,
        input.routeOutcome,
        input.fallbackReason ?? null,
        executionPlanJson,
        stepCount,
        input.completedStepCount ?? 0,
        input.failedStepCount ?? 0,
        input.hasWriteOperations ? 1 : 0,
        JSON.stringify(workerIds),
        JSON.stringify(delegationChain),
        receiptsJson,
        input.narrationProvider ?? null,
        input.narrationModel ?? null,
        input.narrationLatencyMs ?? null,
        input.narrationRetried ? 1 : 0,
        input.narrationModelRunId ?? null,
        input.intentLatencyMs ?? null,
        input.routeLatencyMs ?? null,
        input.executionLatencyMs ?? null,
        input.totalLatencyMs ?? null,
        input.requestMessageId ?? null,
        input.responseMessageId ?? null,
      );

    return id;
  }

  insertSubAgentRun(input: SubAgentRunInsertInput): string {
    const id = input.id?.trim() || randomUUID();
    this.db
      .prepare(
        `
          INSERT INTO sub_agent_runs (
            id,
            batch_id,
            parent_session_id,
            parent_agent_id,
            conversation_key,
            coordinator_worker_id,
            round_index,
            sub_task_id,
            provider_name,
            model,
            reasoning_effort,
            tool_ids,
            dependency_ids,
            status,
            duration_ms,
            cost_estimate_usd,
            error,
            output_text,
            tool_calls_json,
            metadata_json
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        id,
        input.batchId,
        input.parentSessionId ?? null,
        input.parentAgentId ?? null,
        input.conversationKey ?? null,
        input.coordinatorWorkerId,
        input.roundIndex,
        input.subTaskId,
        input.providerName ?? null,
        input.model ?? null,
        input.reasoningEffort ?? null,
        JSON.stringify(input.toolIds ?? []),
        JSON.stringify(input.dependencyIds ?? []),
        input.status,
        input.durationMs ?? 0,
        input.costEstimateUsd ?? null,
        input.error ?? null,
        input.outputText ?? null,
        JSON.stringify(input.toolCallsJson ?? null),
        toJsonOrNull(input.metadata),
      );

    return id;
  }

  upsertActiveTask(input: ActiveTaskUpsertInput): string {
    const id = input.id?.trim() || randomUUID();
    this.db
      .prepare(
        `
          INSERT INTO active_tasks (
            id,
            session_id,
            agent_id,
            status,
            title,
            objective,
            owner_worker_id,
            intent_ids,
            missing_slots,
            clarification_question,
            suggested_next_action,
            structured_context_json,
            source_kind,
            created_by_message_id,
            updated_by_message_id,
            resolved_at,
            expires_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(id) DO UPDATE SET
            status = excluded.status,
            title = excluded.title,
            objective = excluded.objective,
            owner_worker_id = excluded.owner_worker_id,
            intent_ids = excluded.intent_ids,
            missing_slots = excluded.missing_slots,
            clarification_question = excluded.clarification_question,
            suggested_next_action = excluded.suggested_next_action,
            structured_context_json = excluded.structured_context_json,
            source_kind = excluded.source_kind,
            updated_by_message_id = excluded.updated_by_message_id,
            resolved_at = excluded.resolved_at,
            expires_at = excluded.expires_at,
            updated_at = datetime('now')
        `,
      )
      .run(
        id,
        input.sessionId,
        input.agentId,
        input.status,
        input.title,
        input.objective,
        input.ownerWorkerId ?? null,
        JSON.stringify(input.intentIds ?? []),
        JSON.stringify(input.missingSlots ?? []),
        input.clarificationQuestion ?? null,
        input.suggestedNextAction ?? null,
        toJsonOrNull(input.structuredContext),
        input.sourceKind ?? "assistant-offer",
        input.createdByMessageId ?? null,
        input.updatedByMessageId ?? null,
        input.resolvedAt ?? null,
        input.expiresAt ?? null,
      );

    return id;
  }

  updateActiveTaskStatus(input: ActiveTaskStatusUpdateInput): boolean {
    const result = this.db
      .prepare(
        `
          UPDATE active_tasks
          SET
            status = ?,
            updated_by_message_id = COALESCE(?, updated_by_message_id),
            structured_context_json = COALESCE(?, structured_context_json),
            missing_slots = COALESCE(?, missing_slots),
            clarification_question = COALESCE(?, clarification_question),
            suggested_next_action = COALESCE(?, suggested_next_action),
            resolved_at = ?,
            expires_at = COALESCE(?, expires_at),
            updated_at = datetime('now')
          WHERE id = ?
        `,
      )
      .run(
        input.status,
        input.updatedByMessageId ?? null,
        input.structuredContext === undefined ? null : toJsonOrNull(input.structuredContext),
        input.missingSlots === undefined ? null : JSON.stringify(input.missingSlots),
        input.clarificationQuestion === undefined ? null : input.clarificationQuestion,
        input.suggestedNextAction === undefined ? null : input.suggestedNextAction,
        input.resolvedAt ?? (
          input.status === "completed" ||
          input.status === "canceled" ||
          input.status === "superseded" ||
          input.status === "expired"
            ? new Date().toISOString()
            : null
        ),
        input.expiresAt ?? null,
        input.id,
      );

    return toSafeNumber(result.changes) > 0;
  }

  getActiveTask(id: string): ActiveTaskRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            session_id AS sessionId,
            agent_id AS agentId,
            status,
            title,
            objective,
            owner_worker_id AS ownerWorkerId,
            intent_ids AS intentIdsJson,
            missing_slots AS missingSlotsJson,
            clarification_question AS clarificationQuestion,
            suggested_next_action AS suggestedNextAction,
            structured_context_json AS structuredContextJson,
            source_kind AS sourceKind,
            created_by_message_id AS createdByMessageId,
            updated_by_message_id AS updatedByMessageId,
            created_at AS createdAt,
            updated_at AS updatedAt,
            resolved_at AS resolvedAt,
            expires_at AS expiresAt
          FROM active_tasks
          WHERE id = ?
        `,
      )
      .get(id) as
      | (Omit<ActiveTaskRecord, "intentIds" | "missingSlots" | "structuredContext"> & {
          intentIdsJson: string | null;
          missingSlotsJson: string | null;
          structuredContextJson: string | null;
        })
      | undefined;

    return row ? mapActiveTaskRow(row) : null;
  }

  listActiveTasks(options: ListActiveTasksOptions): ActiveTaskRecord[] {
    const resolvedLimit = Number.isFinite(options.limit) ? Math.max(options.limit ?? 20, 1) : 20;
    const rows = this.db
      .prepare(
        `
          SELECT
            id,
            session_id AS sessionId,
            agent_id AS agentId,
            status,
            title,
            objective,
            owner_worker_id AS ownerWorkerId,
            intent_ids AS intentIdsJson,
            missing_slots AS missingSlotsJson,
            clarification_question AS clarificationQuestion,
            suggested_next_action AS suggestedNextAction,
            structured_context_json AS structuredContextJson,
            source_kind AS sourceKind,
            created_by_message_id AS createdByMessageId,
            updated_by_message_id AS updatedByMessageId,
            created_at AS createdAt,
            updated_at AS updatedAt,
            resolved_at AS resolvedAt,
            expires_at AS expiresAt
          FROM active_tasks
          WHERE session_id = ?
            AND agent_id = ?
            AND (
              ? = 1 OR status IN ('proposed', 'awaiting_user', 'ready', 'running', 'blocked')
            )
            AND (
              ? = 1 OR expires_at IS NULL OR expires_at > datetime('now')
            )
          ORDER BY updated_at DESC, created_at DESC
          LIMIT ?
        `,
      )
      .all(
        options.sessionId,
        options.agentId,
        options.includeResolved ? 1 : 0,
        options.includeResolved ? 1 : 0,
        resolvedLimit,
      ) as Array<
      Omit<ActiveTaskRecord, "intentIds" | "missingSlots" | "structuredContext"> & {
        intentIdsJson: string | null;
        missingSlotsJson: string | null;
        structuredContextJson: string | null;
      }
    >;

    return rows.map((row) => mapActiveTaskRow(row));
  }

  listSubAgentRunsForConversation(conversationKey: string, limit = 100): SubAgentRunRecord[] {
    const resolvedLimit = Number.isFinite(limit) ? Math.max(Math.trunc(limit), 1) : 100;
    const rows = this.db
      .prepare(
        `
          SELECT
            id,
            batch_id AS batchId,
            parent_session_id AS parentSessionId,
            parent_agent_id AS parentAgentId,
            conversation_key AS conversationKey,
            coordinator_worker_id AS coordinatorWorkerId,
            round_index AS roundIndex,
            sub_task_id AS subTaskId,
            provider_name AS providerName,
            model,
            reasoning_effort AS reasoningEffort,
            tool_ids AS toolIdsJson,
            dependency_ids AS dependencyIdsJson,
            status,
            duration_ms AS durationMs,
            cost_estimate_usd AS costEstimateUsd,
            error,
            output_text AS outputText,
            tool_calls_json AS toolCallsJson,
            metadata_json AS metadataJson,
            created_at AS createdAt
          FROM sub_agent_runs
          WHERE conversation_key = ?
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `,
      )
      .all(conversationKey, resolvedLimit) as Array<{
        id: string;
        batchId: string;
        parentSessionId: string | null;
        parentAgentId: string | null;
        conversationKey: string | null;
        coordinatorWorkerId: string;
        roundIndex: number;
        subTaskId: string;
        providerName: string | null;
        model: string | null;
        reasoningEffort: string | null;
        toolIdsJson: string | null;
        dependencyIdsJson: string | null;
        status: SubAgentStatus;
        durationMs: number;
        costEstimateUsd: number | null;
        error: string | null;
        outputText: string | null;
        toolCallsJson: string | null;
        metadataJson: string | null;
        createdAt: string;
      }>;

    return rows.map((row) => ({
      id: row.id,
      batchId: row.batchId,
      parentSessionId: row.parentSessionId,
      parentAgentId: row.parentAgentId,
      conversationKey: row.conversationKey,
      coordinatorWorkerId: row.coordinatorWorkerId,
      roundIndex: row.roundIndex,
      subTaskId: row.subTaskId,
      providerName: row.providerName,
      model: row.model,
      reasoningEffort: row.reasoningEffort,
      toolIds: parseJsonArray(row.toolIdsJson),
      dependencyIds: parseJsonArray(row.dependencyIdsJson),
      status: row.status,
      durationMs: row.durationMs,
      costEstimateUsd: row.costEstimateUsd,
      error: row.error,
      outputText: row.outputText,
      toolCallsJson: parseJsonValue(row.toolCallsJson),
      metadata: row.metadataJson ? safeJsonParse(row.metadataJson) : null,
      createdAt: row.createdAt,
    }));
  }

  expireStaleActiveTasks(): number {
    const result = this.db
      .prepare(
        `
          UPDATE active_tasks
          SET
            status = 'expired',
            resolved_at = COALESCE(resolved_at, datetime('now')),
            updated_at = datetime('now')
          WHERE status IN ('proposed', 'awaiting_user', 'ready', 'running', 'blocked')
            AND expires_at IS NOT NULL
            AND expires_at <= datetime('now')
        `,
      )
      .run();

    return toSafeNumber(result.changes);
  }

  getDeterministicTurn(id: string): DeterministicTurnRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            session_id AS sessionId,
            agent_id AS agentId,
            conversation_key AS conversationKey,
            initiating_principal_id AS initiatingPrincipalId,
            lead_agent_principal_id AS leadAgentPrincipalId,
            project_id AS projectId,
            topic_id AS topicId,
            intent_count AS intentCount,
            intent_ids AS intentIdsJson,
            intent_json AS intentJson,
            intent_model_run_id AS intentModelRunId,
            route_outcome AS routeOutcome,
            fallback_reason AS fallbackReason,
            execution_plan_json AS executionPlanJson,
            step_count AS stepCount,
            completed_step_count AS completedStepCount,
            failed_step_count AS failedStepCount,
            has_write_operations AS hasWriteOperations,
            worker_ids AS workerIdsJson,
            delegation_chain AS delegationChainJson,
            receipts_json AS receiptsJson,
            narration_provider AS narrationProvider,
            narration_model AS narrationModel,
            narration_latency_ms AS narrationLatencyMs,
            narration_retried AS narrationRetried,
            narration_model_run_id AS narrationModelRunId,
            intent_latency_ms AS intentLatencyMs,
            route_latency_ms AS routeLatencyMs,
            execution_latency_ms AS executionLatencyMs,
            total_latency_ms AS totalLatencyMs,
            request_message_id AS requestMessageId,
            response_message_id AS responseMessageId,
            created_at AS createdAt
          FROM deterministic_turns
          WHERE id = ?
        `
      )
      .get(id) as
      | {
          id: string;
          sessionId: string;
          agentId: string;
          conversationKey: string;
          initiatingPrincipalId: string;
          leadAgentPrincipalId: string;
          projectId: string | null;
          topicId: string | null;
          intentCount: number;
          intentIdsJson: string | null;
          intentJson: string;
          intentModelRunId: number | null;
          routeOutcome: DeterministicRouteOutcome;
          fallbackReason: string | null;
          executionPlanJson: string | null;
          stepCount: number;
          completedStepCount: number;
          failedStepCount: number;
          hasWriteOperations: number;
          workerIdsJson: string | null;
          delegationChainJson: string | null;
          receiptsJson: string | null;
          narrationProvider: string | null;
          narrationModel: string | null;
          narrationLatencyMs: number | null;
          narrationRetried: number;
          narrationModelRunId: number | null;
          intentLatencyMs: number | null;
          routeLatencyMs: number | null;
          executionLatencyMs: number | null;
          totalLatencyMs: number | null;
          requestMessageId: number | null;
          responseMessageId: number | null;
          createdAt: string;
        }
      | undefined;

    if (!row) return null;

    return {
      id: row.id,
      sessionId: row.sessionId,
      agentId: row.agentId,
      conversationKey: row.conversationKey,
      initiatingPrincipalId: row.initiatingPrincipalId,
      leadAgentPrincipalId: row.leadAgentPrincipalId,
      projectId: row.projectId,
      topicId: row.topicId,
      intentCount: row.intentCount,
      intentIds: parseJsonArray(row.intentIdsJson),
      intentJson: parseJsonValue(row.intentJson),
      intentModelRunId: row.intentModelRunId,
      routeOutcome: row.routeOutcome,
      fallbackReason: row.fallbackReason,
      executionPlanJson: parseJsonValue(row.executionPlanJson),
      stepCount: row.stepCount,
      completedStepCount: row.completedStepCount,
      failedStepCount: row.failedStepCount,
      hasWriteOperations: row.hasWriteOperations === 1,
      workerIds: parseJsonArray(row.workerIdsJson),
      delegationChain: parseJsonArray(row.delegationChainJson),
      receiptsJson: parseJsonValue(row.receiptsJson),
      narrationProvider: row.narrationProvider,
      narrationModel: row.narrationModel,
      narrationLatencyMs: row.narrationLatencyMs,
      narrationRetried: row.narrationRetried === 1,
      narrationModelRunId: row.narrationModelRunId,
      intentLatencyMs: row.intentLatencyMs,
      routeLatencyMs: row.routeLatencyMs,
      executionLatencyMs: row.executionLatencyMs,
      totalLatencyMs: row.totalLatencyMs,
      requestMessageId: row.requestMessageId,
      responseMessageId: row.responseMessageId,
      createdAt: row.createdAt,
    };
  }

  insertPromptSnapshot(input: PromptSnapshotInsertInput): number {
    this.deleteExpiredPromptSnapshots();

    const metadataJson = toJsonOrNull(input.metadata);
    const result = this.db
      .prepare(
        `
          INSERT INTO prompt_snapshots (
            model_run_id,
            session_id,
            agent_id,
            provider_name,
            request_message_id,
            response_message_id,
            prompt_text,
            system_prompt,
            warm_start_prompt,
            metadata_json,
            created_at,
            expires_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now', '+72 hours')))
          ON CONFLICT(model_run_id) DO UPDATE SET
            session_id = excluded.session_id,
            agent_id = excluded.agent_id,
            provider_name = excluded.provider_name,
            request_message_id = excluded.request_message_id,
            response_message_id = excluded.response_message_id,
            prompt_text = excluded.prompt_text,
            system_prompt = excluded.system_prompt,
            warm_start_prompt = excluded.warm_start_prompt,
            metadata_json = excluded.metadata_json,
            created_at = excluded.created_at,
            expires_at = excluded.expires_at
        `
      )
      .run(
        input.modelRunId,
        input.sessionId,
        input.agentId,
        input.providerName,
        input.requestMessageId ?? null,
        input.responseMessageId ?? null,
        input.promptText,
        input.systemPrompt ?? null,
        input.warmStartPrompt ?? null,
        metadataJson,
        input.createdAt ?? null,
        input.expiresAt ?? null
      );

    const rowId = result.lastInsertRowid;
    return typeof rowId === "bigint" ? Number(rowId) : rowId;
  }

  getPromptSnapshotByModelRunId(modelRunId: number): PromptSnapshotRecord | null {
    this.deleteExpiredPromptSnapshots();

    const row = this.db
      .prepare(
        `
          SELECT
            id,
            model_run_id AS modelRunId,
            session_id AS sessionId,
            agent_id AS agentId,
            provider_name AS providerName,
            request_message_id AS requestMessageId,
            response_message_id AS responseMessageId,
            prompt_text AS promptText,
            system_prompt AS systemPrompt,
            warm_start_prompt AS warmStartPrompt,
            metadata_json AS metadataJson,
            created_at AS createdAt,
            expires_at AS expiresAt
          FROM prompt_snapshots
          WHERE model_run_id = ?
        `
      )
      .get(modelRunId) as
      | (Omit<PromptSnapshotRecord, "metadata"> & { metadataJson: string | null })
      | undefined;

    return row ? toPromptSnapshotRecord(row) : null;
  }

  findPromptSnapshotByRequestMessageId(messageId: number): PromptSnapshotRecord | null {
    this.deleteExpiredPromptSnapshots();

    const row = this.db
      .prepare(
        `
          SELECT
            id,
            model_run_id AS modelRunId,
            session_id AS sessionId,
            agent_id AS agentId,
            provider_name AS providerName,
            request_message_id AS requestMessageId,
            response_message_id AS responseMessageId,
            prompt_text AS promptText,
            system_prompt AS systemPrompt,
            warm_start_prompt AS warmStartPrompt,
            metadata_json AS metadataJson,
            created_at AS createdAt,
            expires_at AS expiresAt
          FROM prompt_snapshots
          WHERE request_message_id = ?
          ORDER BY id DESC
          LIMIT 1
        `
      )
      .get(messageId) as
      | (Omit<PromptSnapshotRecord, "metadata"> & { metadataJson: string | null })
      | undefined;

    return row ? toPromptSnapshotRecord(row) : null;
  }

  findPromptSnapshotByResponseMessageId(messageId: number): PromptSnapshotRecord | null {
    this.deleteExpiredPromptSnapshots();

    const row = this.db
      .prepare(
        `
          SELECT
            id,
            model_run_id AS modelRunId,
            session_id AS sessionId,
            agent_id AS agentId,
            provider_name AS providerName,
            request_message_id AS requestMessageId,
            response_message_id AS responseMessageId,
            prompt_text AS promptText,
            system_prompt AS systemPrompt,
            warm_start_prompt AS warmStartPrompt,
            metadata_json AS metadataJson,
            created_at AS createdAt,
            expires_at AS expiresAt
          FROM prompt_snapshots
          WHERE response_message_id = ?
          ORDER BY id DESC
          LIMIT 1
        `
      )
      .get(messageId) as
      | (Omit<PromptSnapshotRecord, "metadata"> & { metadataJson: string | null })
      | undefined;

    return row ? toPromptSnapshotRecord(row) : null;
  }

  findPromptSnapshotByMessageId(messageId: number): PromptSnapshotRecord | null {
    return (
      this.findPromptSnapshotByRequestMessageId(messageId) ??
      this.findPromptSnapshotByResponseMessageId(messageId)
    );
  }

  listRecentPromptSnapshots(options: ListRecentPromptSnapshotsOptions = {}): PromptSnapshotRecord[] {
    this.deleteExpiredPromptSnapshots();

    const conditions: string[] = [];
    const values: Array<string | number> = [];

    if (options.since && options.since.trim().length > 0) {
      conditions.push("datetime(created_at) >= datetime(?)");
      values.push(options.since);
    }

    if (options.sessionId && options.sessionId.trim().length > 0) {
      conditions.push("session_id = ?");
      values.push(options.sessionId);
    }

    if (options.agentId && options.agentId.trim().length > 0) {
      conditions.push("agent_id = ?");
      values.push(options.agentId);
    }

    const resolvedLimit = Number.isFinite(options.limit) ? Math.max(options.limit ?? 20, 1) : 20;
    values.push(resolvedLimit);

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = this.db
      .prepare(
        `
          SELECT
            id,
            model_run_id AS modelRunId,
            session_id AS sessionId,
            agent_id AS agentId,
            provider_name AS providerName,
            request_message_id AS requestMessageId,
            response_message_id AS responseMessageId,
            prompt_text AS promptText,
            system_prompt AS systemPrompt,
            warm_start_prompt AS warmStartPrompt,
            metadata_json AS metadataJson,
            created_at AS createdAt,
            expires_at AS expiresAt
          FROM prompt_snapshots
          ${whereClause}
          ORDER BY datetime(created_at) DESC, id DESC
          LIMIT ?
        `
      )
      .all(...values) as Array<
      Omit<PromptSnapshotRecord, "metadata"> & { metadataJson: string | null }
    >;

    return rows.map((row) => toPromptSnapshotRecord(row));
  }

  listPromptSnapshotsForSession(sessionId: string, limit = 20): PromptSnapshotRecord[] {
    this.deleteExpiredPromptSnapshots();

    const resolvedLimit = Number.isFinite(limit) ? Math.max(limit, 1) : 20;
    const rows = this.db
      .prepare(
        `
          SELECT
            id,
            model_run_id AS modelRunId,
            session_id AS sessionId,
            agent_id AS agentId,
            provider_name AS providerName,
            request_message_id AS requestMessageId,
            response_message_id AS responseMessageId,
            prompt_text AS promptText,
            system_prompt AS systemPrompt,
            warm_start_prompt AS warmStartPrompt,
            metadata_json AS metadataJson,
            created_at AS createdAt,
            expires_at AS expiresAt
          FROM prompt_snapshots
          WHERE session_id = ?
          ORDER BY id DESC
          LIMIT ?
        `
      )
      .all(sessionId, resolvedLimit) as Array<
      Omit<PromptSnapshotRecord, "metadata"> & { metadataJson: string | null }
    >;

    return rows.map((row) => toPromptSnapshotRecord(row));
  }

  deleteExpiredPromptSnapshots(referenceTime?: string): number {
    const result = referenceTime && referenceTime.trim().length > 0
      ? this.db
          .prepare(
            `
              DELETE FROM prompt_snapshots
              WHERE datetime(expires_at) <= datetime(?)
            `
          )
          .run(referenceTime)
      : this.db
          .prepare(
            `
              DELETE FROM prompt_snapshots
              WHERE datetime(expires_at) <= datetime('now')
            `
          )
          .run();

    return toSafeNumber(result.changes);
  }

  insertDeadLetter(input: DeadLetterInsertInput): number {
    const metadataJson = toJsonOrNull(input.metadata);

    const result = this.db
      .prepare(
        `
          INSERT INTO dead_letters (
            session_id,
            agent_id,
            provider_name,
            conversation_key,
            provider_session_id,
            request_message_id,
            discord_channel_id,
            discord_user_id,
            discord_username,
            prompt_text,
            system_prompt,
            response_mode,
            failure_count,
            last_error_message,
            metadata_json,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `
      )
      .run(
        input.sessionId,
        input.agentId,
        input.providerName,
        input.conversationKey,
        input.providerSessionId ?? null,
        input.requestMessageId ?? null,
        input.discordChannelId ?? null,
        input.discordUserId ?? null,
        input.discordUsername ?? null,
        input.promptText,
        input.systemPrompt ?? null,
        input.responseMode ?? null,
        input.failureCount ?? 1,
        input.lastErrorMessage,
        metadataJson
      );

    const rowId = result.lastInsertRowid;
    return typeof rowId === "bigint" ? Number(rowId) : rowId;
  }

  getDeadLetter(id: number): DeadLetterRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            session_id AS sessionId,
            agent_id AS agentId,
            provider_name AS providerName,
            conversation_key AS conversationKey,
            provider_session_id AS providerSessionId,
            request_message_id AS requestMessageId,
            discord_channel_id AS discordChannelId,
            discord_user_id AS discordUserId,
            discord_username AS discordUsername,
            prompt_text AS promptText,
            system_prompt AS systemPrompt,
            response_mode AS responseMode,
            failure_count AS failureCount,
            replay_count AS replayCount,
            last_error_message AS lastErrorMessage,
            status,
            metadata_json AS metadataJson,
            resolved_message_id AS resolvedMessageId,
            resolved_model_run_id AS resolvedModelRunId,
            created_at AS createdAt,
            updated_at AS updatedAt,
            resolved_at AS resolvedAt
          FROM dead_letters
          WHERE id = ?
        `
      )
      .get(id) as
      | (Omit<DeadLetterRecord, "metadata"> & {
          metadataJson: string | null;
        })
      | undefined;

    if (!row) return null;

    return {
      id: row.id,
      sessionId: row.sessionId,
      agentId: row.agentId,
      providerName: row.providerName,
      conversationKey: row.conversationKey,
      providerSessionId: row.providerSessionId,
      requestMessageId: row.requestMessageId,
      discordChannelId: row.discordChannelId,
      discordUserId: row.discordUserId,
      discordUsername: row.discordUsername,
      promptText: row.promptText,
      systemPrompt: row.systemPrompt,
      responseMode: row.responseMode,
      failureCount: row.failureCount,
      replayCount: row.replayCount,
      lastErrorMessage: row.lastErrorMessage,
      status: row.status,
      metadata: row.metadataJson ? safeJsonParse(row.metadataJson) : null,
      resolvedMessageId: row.resolvedMessageId,
      resolvedModelRunId: row.resolvedModelRunId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      resolvedAt: row.resolvedAt
    };
  }

  listDeadLetters(options: DeadLetterListOptions = {}): DeadLetterRecord[] {
    const status = options.status ?? "pending";
    const limit = Number.isFinite(options.limit) ? Math.max(options.limit ?? 100, 1) : 100;
    const sessionId = options.sessionId;

    const queryByStatusAndSession = `
      SELECT
        id,
        session_id AS sessionId,
        agent_id AS agentId,
        provider_name AS providerName,
        conversation_key AS conversationKey,
        provider_session_id AS providerSessionId,
        request_message_id AS requestMessageId,
        discord_channel_id AS discordChannelId,
        discord_user_id AS discordUserId,
        discord_username AS discordUsername,
        prompt_text AS promptText,
        system_prompt AS systemPrompt,
        response_mode AS responseMode,
        failure_count AS failureCount,
        replay_count AS replayCount,
        last_error_message AS lastErrorMessage,
        status,
        metadata_json AS metadataJson,
        resolved_message_id AS resolvedMessageId,
        resolved_model_run_id AS resolvedModelRunId,
        created_at AS createdAt,
        updated_at AS updatedAt,
        resolved_at AS resolvedAt
      FROM dead_letters
      WHERE status = ? AND session_id = ?
      ORDER BY id DESC
      LIMIT ?
    `;

    const queryByStatus = `
      SELECT
        id,
        session_id AS sessionId,
        agent_id AS agentId,
        provider_name AS providerName,
        conversation_key AS conversationKey,
        provider_session_id AS providerSessionId,
        request_message_id AS requestMessageId,
        discord_channel_id AS discordChannelId,
        discord_user_id AS discordUserId,
        discord_username AS discordUsername,
        prompt_text AS promptText,
        system_prompt AS systemPrompt,
        response_mode AS responseMode,
        failure_count AS failureCount,
        replay_count AS replayCount,
        last_error_message AS lastErrorMessage,
        status,
        metadata_json AS metadataJson,
        resolved_message_id AS resolvedMessageId,
        resolved_model_run_id AS resolvedModelRunId,
        created_at AS createdAt,
        updated_at AS updatedAt,
        resolved_at AS resolvedAt
      FROM dead_letters
      WHERE status = ?
      ORDER BY id DESC
      LIMIT ?
    `;

    const queryBySession = `
      SELECT
        id,
        session_id AS sessionId,
        agent_id AS agentId,
        provider_name AS providerName,
        conversation_key AS conversationKey,
        provider_session_id AS providerSessionId,
        request_message_id AS requestMessageId,
        discord_channel_id AS discordChannelId,
        discord_user_id AS discordUserId,
        discord_username AS discordUsername,
        prompt_text AS promptText,
        system_prompt AS systemPrompt,
        response_mode AS responseMode,
        failure_count AS failureCount,
        replay_count AS replayCount,
        last_error_message AS lastErrorMessage,
        status,
        metadata_json AS metadataJson,
        resolved_message_id AS resolvedMessageId,
        resolved_model_run_id AS resolvedModelRunId,
        created_at AS createdAt,
        updated_at AS updatedAt,
        resolved_at AS resolvedAt
      FROM dead_letters
      WHERE session_id = ?
      ORDER BY id DESC
      LIMIT ?
    `;

    const queryAll = `
      SELECT
        id,
        session_id AS sessionId,
        agent_id AS agentId,
        provider_name AS providerName,
        conversation_key AS conversationKey,
        provider_session_id AS providerSessionId,
        request_message_id AS requestMessageId,
        discord_channel_id AS discordChannelId,
        discord_user_id AS discordUserId,
        discord_username AS discordUsername,
        prompt_text AS promptText,
        system_prompt AS systemPrompt,
        response_mode AS responseMode,
        failure_count AS failureCount,
        replay_count AS replayCount,
        last_error_message AS lastErrorMessage,
        status,
        metadata_json AS metadataJson,
        resolved_message_id AS resolvedMessageId,
        resolved_model_run_id AS resolvedModelRunId,
        created_at AS createdAt,
        updated_at AS updatedAt,
        resolved_at AS resolvedAt
      FROM dead_letters
      ORDER BY id DESC
      LIMIT ?
    `;

    const rows =
      status === "all"
        ? sessionId
          ? (this.db.prepare(queryBySession).all(sessionId, limit) as Array<
              Omit<DeadLetterRecord, "metadata"> & { metadataJson: string | null }
            >)
          : (this.db.prepare(queryAll).all(limit) as Array<
              Omit<DeadLetterRecord, "metadata"> & { metadataJson: string | null }
            >)
        : sessionId
          ? (this.db.prepare(queryByStatusAndSession).all(status, sessionId, limit) as Array<
              Omit<DeadLetterRecord, "metadata"> & { metadataJson: string | null }
            >)
          : (this.db.prepare(queryByStatus).all(status, limit) as Array<
              Omit<DeadLetterRecord, "metadata"> & { metadataJson: string | null }
            >);

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.sessionId,
      agentId: row.agentId,
      providerName: row.providerName,
      conversationKey: row.conversationKey,
      providerSessionId: row.providerSessionId,
      requestMessageId: row.requestMessageId,
      discordChannelId: row.discordChannelId,
      discordUserId: row.discordUserId,
      discordUsername: row.discordUsername,
      promptText: row.promptText,
      systemPrompt: row.systemPrompt,
      responseMode: row.responseMode,
      failureCount: row.failureCount,
      replayCount: row.replayCount,
      lastErrorMessage: row.lastErrorMessage,
      status: row.status,
      metadata: row.metadataJson ? safeJsonParse(row.metadataJson) : null,
      resolvedMessageId: row.resolvedMessageId,
      resolvedModelRunId: row.resolvedModelRunId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      resolvedAt: row.resolvedAt
    }));
  }

  resolveDeadLetter(input: DeadLetterResolveInput): boolean {
    const metadataJson = toJsonOrNull(input.metadata);
    const result = this.db
      .prepare(
        `
          UPDATE dead_letters
          SET
            status = 'resolved',
            resolved_message_id = COALESCE(?, resolved_message_id),
            resolved_model_run_id = COALESCE(?, resolved_model_run_id),
            replay_count = replay_count + ?,
            metadata_json = COALESCE(?, metadata_json),
            resolved_at = datetime('now'),
            updated_at = datetime('now')
          WHERE id = ?
        `
      )
      .run(
        input.resolvedMessageId ?? null,
        input.resolvedModelRunId ?? null,
        input.incrementReplayCount === true ? 1 : 0,
        metadataJson,
        input.id
      );

    return toSafeNumber(result.changes) > 0;
  }

  recordDeadLetterReplayFailure(input: DeadLetterReplayFailureInput): boolean {
    const metadataJson = toJsonOrNull(input.metadata);
    const result = this.db
      .prepare(
        `
          UPDATE dead_letters
          SET
            replay_count = replay_count + 1,
            failure_count = failure_count + 1,
            last_error_message = ?,
            metadata_json = COALESCE(?, metadata_json),
            updated_at = datetime('now')
          WHERE id = ?
        `
      )
      .run(input.errorMessage, metadataJson, input.id);

    return toSafeNumber(result.changes) > 0;
  }

  claimVoiceTurnReceipt(input: {
    sessionId: string;
    agentId: string;
    utteranceId: string;
    metadata?: Record<string, unknown> | null;
  }): { created: boolean; receipt: VoiceTurnReceiptRecord } {
    const normalizedSessionId = input.sessionId.trim();
    const normalizedAgentId = input.agentId.trim();
    const normalizedUtteranceId = input.utteranceId.trim();
    if (!normalizedSessionId || !normalizedAgentId || !normalizedUtteranceId) {
      throw new Error("sessionId, agentId, and utteranceId are required.");
    }

    const metadataJson = toJsonOrNull(input.metadata);
    const turnId = randomUUID();
    const insertResult = this.db
      .prepare(
        `
          INSERT INTO voice_turn_receipts (
            turn_id,
            session_id,
            agent_id,
            utterance_id,
            status,
            metadata_json,
            updated_at
          )
          VALUES (?, ?, ?, ?, 'processing', ?, datetime('now'))
          ON CONFLICT(session_id, utterance_id) DO NOTHING
        `
      )
      .run(
        turnId,
        normalizedSessionId,
        normalizedAgentId,
        normalizedUtteranceId,
        metadataJson
      );

    const receipt = this.getVoiceTurnReceipt(normalizedSessionId, normalizedUtteranceId);
    if (!receipt) {
      throw new Error("Failed to resolve voice turn receipt.");
    }

    return {
      created: toSafeNumber(insertResult.changes) > 0,
      receipt
    };
  }

  getVoiceTurnReceipt(sessionId: string, utteranceId: string): VoiceTurnReceiptRecord | null {
    const normalizedSessionId = sessionId.trim();
    const normalizedUtteranceId = utteranceId.trim();
    if (!normalizedSessionId || !normalizedUtteranceId) {
      return null;
    }

    const row = this.db
      .prepare(
        `
          SELECT
            turn_id AS turnId,
            session_id AS sessionId,
            agent_id AS agentId,
            utterance_id AS utteranceId,
            status,
            provider_name AS providerName,
            provider_session_id AS providerSessionId,
            response_text AS responseText,
            provider_used_failover AS providerUsedFailover,
            warm_start_used AS warmStartUsed,
            request_message_id AS requestMessageId,
            response_message_id AS responseMessageId,
            model_run_id AS modelRunId,
            error_message AS errorMessage,
            metadata_json AS metadataJson,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM voice_turn_receipts
          WHERE session_id = ? AND utterance_id = ?
        `
      )
      .get(normalizedSessionId, normalizedUtteranceId) as
      | VoiceTurnReceiptRow
      | undefined;

    return row ? toVoiceTurnReceiptRecord(row) : null;
  }

  completeVoiceTurnReceipt(input: {
    turnId: string;
    providerName: string;
    providerSessionId?: string | null;
    responseText: string;
    providerUsedFailover?: boolean;
    warmStartUsed?: boolean;
    requestMessageId?: number | null;
    responseMessageId?: number | null;
    modelRunId?: number | null;
    metadata?: Record<string, unknown> | null;
  }): boolean {
    const metadataJson = toJsonOrNull(input.metadata);
    const result = this.db
      .prepare(
        `
          UPDATE voice_turn_receipts
          SET
            status = 'completed',
            provider_name = ?,
            provider_session_id = ?,
            response_text = ?,
            provider_used_failover = ?,
            warm_start_used = ?,
            request_message_id = COALESCE(?, request_message_id),
            response_message_id = COALESCE(?, response_message_id),
            model_run_id = COALESCE(?, model_run_id),
            error_message = NULL,
            metadata_json = COALESCE(?, metadata_json),
            updated_at = datetime('now')
          WHERE turn_id = ?
        `
      )
      .run(
        input.providerName,
        input.providerSessionId ?? null,
        input.responseText,
        toSqliteBoolean(input.providerUsedFailover),
        toSqliteBoolean(input.warmStartUsed),
        input.requestMessageId ?? null,
        input.responseMessageId ?? null,
        input.modelRunId ?? null,
        metadataJson,
        input.turnId
      );

    return toSafeNumber(result.changes) > 0;
  }

  failVoiceTurnReceipt(input: {
    turnId: string;
    errorMessage: string;
    requestMessageId?: number | null;
    responseMessageId?: number | null;
    modelRunId?: number | null;
    metadata?: Record<string, unknown> | null;
  }): boolean {
    const metadataJson = toJsonOrNull(input.metadata);
    const result = this.db
      .prepare(
        `
          UPDATE voice_turn_receipts
          SET
            status = 'failed',
            error_message = ?,
            request_message_id = COALESCE(?, request_message_id),
            response_message_id = COALESCE(?, response_message_id),
            model_run_id = COALESCE(?, model_run_id),
            metadata_json = COALESCE(?, metadata_json),
            updated_at = datetime('now')
          WHERE turn_id = ?
        `
      )
      .run(
        input.errorMessage,
        input.requestMessageId ?? null,
        input.responseMessageId ?? null,
        input.modelRunId ?? null,
        metadataJson,
        input.turnId
      );

    return toSafeNumber(result.changes) > 0;
  }

  getMessage(messageId: number): StoredMessageRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            session_id AS sessionId,
            agent_id AS agentId,
            provider_name AS providerName,
            direction,
            source,
            visibility,
            discord_message_id AS discordMessageId,
            discord_channel_id AS discordChannelId,
            discord_user_id AS discordUserId,
            discord_username AS discordUsername,
            content,
            metadata_json AS metadataJson,
            created_at AS createdAt
          FROM messages
          WHERE id = ?
        `
      )
      .get(messageId) as
      | (Omit<StoredMessageRecord, "metadata"> & { metadataJson: string | null })
      | undefined;

    if (!row) return null;
    return {
      id: row.id,
      sessionId: row.sessionId,
      agentId: row.agentId,
      providerName: row.providerName,
      direction: row.direction,
      source: row.source,
      visibility: row.visibility,
      discordMessageId: row.discordMessageId,
      discordChannelId: row.discordChannelId,
      discordUserId: row.discordUserId,
      discordUsername: row.discordUsername,
      content: row.content,
      metadata: row.metadataJson ? safeJsonParse(row.metadataJson) : null,
      createdAt: row.createdAt
    };
  }

  getMessageByDiscordMessageId(
    discordMessageId: string,
    options?: { channelId?: string | null }
  ): StoredMessageRecord | null {
    const normalizedMessageId = discordMessageId.trim();
    if (!normalizedMessageId) return null;
    const normalizedChannelId = options?.channelId?.trim() || null;
    const row = (normalizedChannelId
      ? this.db
          .prepare(
            `
              SELECT
                id,
                session_id AS sessionId,
                agent_id AS agentId,
                provider_name AS providerName,
                direction,
                source,
                visibility,
                discord_message_id AS discordMessageId,
                discord_channel_id AS discordChannelId,
                discord_user_id AS discordUserId,
                discord_username AS discordUsername,
                content,
                metadata_json AS metadataJson,
                created_at AS createdAt
              FROM messages
              WHERE discord_message_id = ?
                AND discord_channel_id = ?
              ORDER BY id DESC
              LIMIT 1
            `
          )
          .get(normalizedMessageId, normalizedChannelId)
      : this.db
          .prepare(
            `
              SELECT
                id,
                session_id AS sessionId,
                agent_id AS agentId,
                provider_name AS providerName,
                direction,
                source,
                visibility,
                discord_message_id AS discordMessageId,
                discord_channel_id AS discordChannelId,
                discord_user_id AS discordUserId,
                discord_username AS discordUsername,
                content,
                metadata_json AS metadataJson,
                created_at AS createdAt
              FROM messages
              WHERE discord_message_id = ?
              ORDER BY id DESC
              LIMIT 1
            `
          )
          .get(normalizedMessageId)) as
      | (Omit<StoredMessageRecord, "metadata"> & { metadataJson: string | null })
      | undefined;

    if (!row) return null;
    return {
      id: row.id,
      sessionId: row.sessionId,
      agentId: row.agentId,
      providerName: row.providerName,
      direction: row.direction,
      source: row.source,
      visibility: row.visibility,
      discordMessageId: row.discordMessageId,
      discordChannelId: row.discordChannelId,
      discordUserId: row.discordUserId,
      discordUsername: row.discordUsername,
      content: row.content,
      metadata: row.metadataJson ? safeJsonParse(row.metadataJson) : null,
      createdAt: row.createdAt,
    };
  }

  listRecentMessagesForDiscordChannel(channelId: string, limit = 20): StoredMessageRecord[] {
    const normalizedChannelId = channelId.trim();
    if (!normalizedChannelId) return [];
    const rows = this.db
      .prepare(
        `
          SELECT
            id,
            session_id AS sessionId,
            agent_id AS agentId,
            provider_name AS providerName,
            direction,
            source,
            visibility,
            discord_message_id AS discordMessageId,
            discord_channel_id AS discordChannelId,
            discord_user_id AS discordUserId,
            discord_username AS discordUsername,
            content,
            metadata_json AS metadataJson,
            created_at AS createdAt
          FROM messages
          WHERE discord_channel_id = ?
          ORDER BY id DESC
          LIMIT ?
        `
      )
      .all(normalizedChannelId, Math.max(1, Math.trunc(limit))) as Array<
      Omit<StoredMessageRecord, "metadata"> & { metadataJson: string | null }
    >;

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.sessionId,
      agentId: row.agentId,
      providerName: row.providerName,
      direction: row.direction,
      source: row.source,
      visibility: row.visibility,
      discordMessageId: row.discordMessageId,
      discordChannelId: row.discordChannelId,
      discordUserId: row.discordUserId,
      discordUsername: row.discordUsername,
      content: row.content,
      metadata: row.metadataJson ? safeJsonParse(row.metadataJson) : null,
      createdAt: row.createdAt,
    }));
  }

  listRecoverableDiscordInboundMessages(options?: {
    minAgeMinutes?: number;
    maxAgeMinutes?: number;
    limit?: number;
  }): StoredMessageRecord[] {
    const minAgeMinutes = Math.max(0, Math.trunc(options?.minAgeMinutes ?? 2));
    const maxAgeMinutes = Math.max(1, Math.trunc(options?.maxAgeMinutes ?? 180));
    const limit = Math.max(1, Math.trunc(options?.limit ?? 50));
    const rows = this.db
      .prepare(
        `
          SELECT
            id,
            session_id AS sessionId,
            agent_id AS agentId,
            provider_name AS providerName,
            direction,
            source,
            visibility,
            discord_message_id AS discordMessageId,
            discord_channel_id AS discordChannelId,
            discord_user_id AS discordUserId,
            discord_username AS discordUsername,
            content,
            metadata_json AS metadataJson,
            created_at AS createdAt
          FROM messages
          WHERE source = 'discord'
            AND direction = 'inbound'
            AND visibility = 'public'
            AND discord_message_id IS NOT NULL
            AND discord_channel_id IS NOT NULL
            AND created_at >= datetime('now', ?)
            AND created_at <= datetime('now', ?)
            AND NOT EXISTS (
              SELECT 1
              FROM model_runs
              WHERE request_message_id = messages.id
            )
            AND NOT EXISTS (
              SELECT 1
              FROM deterministic_turns
              WHERE request_message_id = messages.id
            )
            AND NOT EXISTS (
              SELECT 1
              FROM dead_letters
              WHERE request_message_id = messages.id
            )
            AND NOT EXISTS (
              SELECT 1
              FROM messages AS newer
              WHERE newer.id > messages.id
                AND newer.source = 'discord'
                AND newer.direction = 'inbound'
                AND newer.session_id = messages.session_id
                AND COALESCE(newer.agent_id, '') = COALESCE(messages.agent_id, '')
                AND COALESCE(newer.discord_channel_id, '') = COALESCE(messages.discord_channel_id, '')
                AND COALESCE(newer.discord_user_id, '') = COALESCE(messages.discord_user_id, '')
                AND newer.content = messages.content
                AND (
                  EXISTS (
                    SELECT 1
                    FROM model_runs
                    WHERE request_message_id = newer.id
                  )
                  OR EXISTS (
                    SELECT 1
                    FROM deterministic_turns
                    WHERE request_message_id = newer.id
                  )
                  OR EXISTS (
                    SELECT 1
                    FROM dead_letters
                    WHERE request_message_id = newer.id
                  )
                )
            )
          ORDER BY id ASC
          LIMIT ?
        `
      )
      .all(`-${maxAgeMinutes} minutes`, `-${minAgeMinutes} minutes`, limit) as Array<
      Omit<StoredMessageRecord, "metadata"> & { metadataJson: string | null }
    >;

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.sessionId,
      agentId: row.agentId,
      providerName: row.providerName,
      direction: row.direction,
      source: row.source,
      visibility: row.visibility,
      discordMessageId: row.discordMessageId,
      discordChannelId: row.discordChannelId,
      discordUserId: row.discordUserId,
      discordUsername: row.discordUsername,
      content: row.content,
      metadata: row.metadataJson ? safeJsonParse(row.metadataJson) : null,
      createdAt: row.createdAt
    }));
  }

  listMessagesForSession(sessionId: string, limit = 100): StoredMessageRecord[] {
    const rows = this.db
      .prepare(
        `
          SELECT
            id,
            session_id AS sessionId,
            agent_id AS agentId,
            provider_name AS providerName,
            direction,
            source,
            visibility,
            discord_message_id AS discordMessageId,
            discord_channel_id AS discordChannelId,
            discord_user_id AS discordUserId,
            discord_username AS discordUsername,
            content,
            metadata_json AS metadataJson,
            created_at AS createdAt
          FROM messages
          WHERE session_id = ?
          ORDER BY id ASC
          LIMIT ?
        `
      )
      .all(sessionId, limit) as Array<
      Omit<StoredMessageRecord, "metadata"> & { metadataJson: string | null }
    >;

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.sessionId,
      agentId: row.agentId,
      providerName: row.providerName,
      direction: row.direction,
      source: row.source,
      visibility: row.visibility,
      discordMessageId: row.discordMessageId,
      discordChannelId: row.discordChannelId,
      discordUserId: row.discordUserId,
      discordUsername: row.discordUsername,
      content: row.content,
      metadata: row.metadataJson ? safeJsonParse(row.metadataJson) : null,
      createdAt: row.createdAt
    }));
  }

  listModelRunsForSession(sessionId: string, limit = 100): ModelRunRecord[] {
    const rows = this.db
      .prepare(
        `
          SELECT
            id,
            session_id AS sessionId,
            agent_id AS agentId,
            provider_name AS providerName,
            conversation_key AS conversationKey,
            provider_session_id AS providerSessionId,
            model,
            stop_reason AS stopReason,
            response_mode AS responseMode,
            latency_ms AS latencyMs,
            provider_duration_ms AS providerDurationMs,
            provider_api_duration_ms AS providerApiDurationMs,
            input_tokens AS inputTokens,
            output_tokens AS outputTokens,
            cache_read_input_tokens AS cacheReadInputTokens,
            cache_creation_input_tokens AS cacheCreationInputTokens,
            total_cost_usd AS totalCostUsd,
            is_error AS isError,
            error_message AS errorMessage,
            request_message_id AS requestMessageId,
            response_message_id AS responseMessageId,
            metadata_json AS metadataJson,
            raw_response_json AS rawResponseJson,
            created_at AS createdAt
          FROM model_runs
          WHERE session_id = ?
          ORDER BY id ASC
          LIMIT ?
        `
      )
      .all(sessionId, limit) as Array<
      Omit<ModelRunRecord, "metadata" | "rawResponse"> & {
        metadataJson: string | null;
        rawResponseJson: string | null;
      }
    >;

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.sessionId,
      agentId: row.agentId,
      providerName: row.providerName,
      conversationKey: row.conversationKey,
      providerSessionId: row.providerSessionId,
      model: row.model,
      stopReason: row.stopReason,
      responseMode: row.responseMode,
      latencyMs: row.latencyMs,
      providerDurationMs: row.providerDurationMs,
      providerApiDurationMs: row.providerApiDurationMs,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadInputTokens: row.cacheReadInputTokens,
      cacheCreationInputTokens: row.cacheCreationInputTokens,
      totalCostUsd: row.totalCostUsd,
      isError: row.isError,
      errorMessage: row.errorMessage,
      requestMessageId: row.requestMessageId,
      responseMessageId: row.responseMessageId,
      metadata: row.metadataJson ? safeJsonParse(row.metadataJson) : null,
      rawResponse: row.rawResponseJson ? safeJsonParse(row.rawResponseJson) : null,
      createdAt: row.createdAt
    }));
  }

  listModelRunsForConversation(conversationKey: string, limit = 100): ModelRunRecord[] {
    const resolvedLimit = Number.isFinite(limit) ? Math.max(limit, 1) : 100;
    const rows = this.db
      .prepare(
        `
          SELECT
            id,
            session_id AS sessionId,
            agent_id AS agentId,
            provider_name AS providerName,
            conversation_key AS conversationKey,
            provider_session_id AS providerSessionId,
            model,
            stop_reason AS stopReason,
            response_mode AS responseMode,
            latency_ms AS latencyMs,
            provider_duration_ms AS providerDurationMs,
            provider_api_duration_ms AS providerApiDurationMs,
            input_tokens AS inputTokens,
            output_tokens AS outputTokens,
            cache_read_input_tokens AS cacheReadInputTokens,
            cache_creation_input_tokens AS cacheCreationInputTokens,
            total_cost_usd AS totalCostUsd,
            is_error AS isError,
            error_message AS errorMessage,
            request_message_id AS requestMessageId,
            response_message_id AS responseMessageId,
            metadata_json AS metadataJson,
            raw_response_json AS rawResponseJson,
            created_at AS createdAt
          FROM model_runs
          WHERE conversation_key = ?
          ORDER BY id DESC
          LIMIT ?
        `
      )
      .all(conversationKey, resolvedLimit) as Array<
      Omit<ModelRunRecord, "metadata" | "rawResponse"> & {
        metadataJson: string | null;
        rawResponseJson: string | null;
      }
    >;

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.sessionId,
      agentId: row.agentId,
      providerName: row.providerName,
      conversationKey: row.conversationKey,
      providerSessionId: row.providerSessionId,
      model: row.model,
      stopReason: row.stopReason,
      responseMode: row.responseMode,
      latencyMs: row.latencyMs,
      providerDurationMs: row.providerDurationMs,
      providerApiDurationMs: row.providerApiDurationMs,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadInputTokens: row.cacheReadInputTokens,
      cacheCreationInputTokens: row.cacheCreationInputTokens,
      totalCostUsd: row.totalCostUsd,
      isError: row.isError,
      errorMessage: row.errorMessage,
      requestMessageId: row.requestMessageId,
      responseMessageId: row.responseMessageId,
      metadata: row.metadataJson ? safeJsonParse(row.metadataJson) : null,
      rawResponse: row.rawResponseJson ? safeJsonParse(row.rawResponseJson) : null,
      createdAt: row.createdAt
    }));
  }

  listProviderArtifactCleanupCandidates(input: {
    olderThan: string;
    providerNamePrefixes?: string[];
    continuityMode?: string;
    limit?: number;
  }): ProviderArtifactCandidateRecord[] {
    const providerNamePrefixes = (input.providerNamePrefixes ?? [])
      .map((prefix) => prefix.trim())
      .filter((prefix) => prefix.length > 0);
    const continuityMode = input.continuityMode?.trim() || "stateless";
    const resolvedLimit = Number.isFinite(input.limit) ? Math.max(1, Math.trunc(input.limit ?? 500)) : 500;
    const providerClause =
      providerNamePrefixes.length > 0
        ? `AND (${providerNamePrefixes.map(() => "provider_name LIKE ?").join(" OR ")})`
        : "";
    const rows = this.db
      .prepare(
        `
          SELECT
            provider_name AS providerName,
            provider_session_id AS providerSessionId,
            MIN(created_at) AS firstSeenAt,
            MAX(created_at) AS lastSeenAt,
            COUNT(*) AS runCount
          FROM model_runs
          WHERE provider_session_id IS NOT NULL
            AND json_extract(metadata_json, '$.orchestratorContinuityMode') = ?
            ${providerClause}
          GROUP BY provider_name, provider_session_id
          HAVING MAX(created_at) < ?
          ORDER BY MAX(created_at) ASC, provider_session_id ASC
          LIMIT ?
        `
      )
      .all(
        continuityMode,
        ...providerNamePrefixes.map((prefix) => `${prefix}%`),
        input.olderThan,
        resolvedLimit
      ) as Array<{
      providerName: string;
      providerSessionId: string;
      firstSeenAt: string;
      lastSeenAt: string;
      runCount: number | bigint;
    }>;

    return rows.map((row) => ({
      providerName: row.providerName,
      providerSessionId: row.providerSessionId,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
      runCount: Number(row.runCount),
    }));
  }

  listStoredSessions(limit = 200): SessionSummary[] {
    const rows = this.db
      .prepare(
        `
          SELECT
            s.id AS sessionId,
            s.session_type AS sessionType,
            s.default_agent_id AS defaultAgentId,
            (
              SELECT COUNT(*)
              FROM messages m
              WHERE m.session_id = s.id
            ) AS messageCount,
            (
              SELECT COUNT(*)
              FROM model_runs mr
              WHERE mr.session_id = s.id
            ) AS modelRunCount,
            (
              SELECT COUNT(*)
              FROM provider_sessions ps
              WHERE ps.session_id = s.id
            ) AS providerSessionCount,
            (
              SELECT MAX(m.created_at)
              FROM messages m
              WHERE m.session_id = s.id
            ) AS lastMessageAt,
            (
              SELECT MAX(mr.created_at)
              FROM model_runs mr
              WHERE mr.session_id = s.id
            ) AS lastModelRunAt,
            s.updated_at AS updatedAt
          FROM sessions s
          ORDER BY s.id
          LIMIT ?
        `
      )
      .all(limit) as Array<{
      sessionId: string;
      sessionType: string;
      defaultAgentId: string;
      messageCount: number | bigint;
      modelRunCount: number | bigint;
      providerSessionCount: number | bigint;
      lastMessageAt: string | null;
      lastModelRunAt: string | null;
      updatedAt: string;
    }>;

    return rows.map((row) => ({
      sessionId: row.sessionId,
      sessionType: row.sessionType,
      defaultAgentId: row.defaultAgentId,
      messageCount: toSafeNumber(row.messageCount),
      modelRunCount: toSafeNumber(row.modelRunCount),
      providerSessionCount: toSafeNumber(row.providerSessionCount),
      lastMessageAt: row.lastMessageAt,
      lastModelRunAt: row.lastModelRunAt,
      updatedAt: row.updatedAt
    }));
  }

  getSessionSummary(sessionId: string): SessionSummary | null {
    const row = this.db
      .prepare(
        `
          SELECT
            s.id AS sessionId,
            s.session_type AS sessionType,
            s.default_agent_id AS defaultAgentId,
            (
              SELECT COUNT(*)
              FROM messages m
              WHERE m.session_id = s.id
            ) AS messageCount,
            (
              SELECT COUNT(*)
              FROM model_runs mr
              WHERE mr.session_id = s.id
            ) AS modelRunCount,
            (
              SELECT COUNT(*)
              FROM provider_sessions ps
              WHERE ps.session_id = s.id
            ) AS providerSessionCount,
            (
              SELECT MAX(m.created_at)
              FROM messages m
              WHERE m.session_id = s.id
            ) AS lastMessageAt,
            (
              SELECT MAX(mr.created_at)
              FROM model_runs mr
              WHERE mr.session_id = s.id
            ) AS lastModelRunAt,
            s.updated_at AS updatedAt
          FROM sessions s
          WHERE s.id = ?
        `
      )
      .get(sessionId) as
      | {
          sessionId: string;
          sessionType: string;
          defaultAgentId: string;
          messageCount: number | bigint;
          modelRunCount: number | bigint;
          providerSessionCount: number | bigint;
          lastMessageAt: string | null;
          lastModelRunAt: string | null;
          updatedAt: string;
        }
      | undefined;

    if (!row) return null;

    return {
      sessionId: row.sessionId,
      sessionType: row.sessionType,
      defaultAgentId: row.defaultAgentId,
      messageCount: toSafeNumber(row.messageCount),
      modelRunCount: toSafeNumber(row.modelRunCount),
      providerSessionCount: toSafeNumber(row.providerSessionCount),
      lastMessageAt: row.lastMessageAt,
      lastModelRunAt: row.lastModelRunAt,
      updatedAt: row.updatedAt
    };
  }

  getHealthSnapshot(): HealthSnapshot {
    const row = this.db
      .prepare(
        `
          SELECT
            (SELECT COUNT(*) FROM sessions) AS sessions,
            (SELECT COUNT(*) FROM messages) AS messages,
            (SELECT COUNT(*) FROM model_runs) AS modelRuns,
            (SELECT COUNT(*) FROM provider_sessions) AS providerSessions,
            (SELECT COUNT(*) FROM dead_letters) AS deadLettersTotal,
            (SELECT COUNT(*) FROM dead_letters WHERE status = 'pending') AS deadLettersPending,
            (SELECT MAX(created_at) FROM messages) AS lastMessageAt
        `
      )
      .get() as {
      sessions: number | bigint;
      messages: number | bigint;
      modelRuns: number | bigint;
      providerSessions: number | bigint;
      deadLettersTotal: number | bigint;
      deadLettersPending: number | bigint;
      lastMessageAt: string | null;
    };

    return {
      status: "healthy",
      dbUserVersion: this.getUserVersion(),
      sessions: toSafeNumber(row.sessions),
      messages: toSafeNumber(row.messages),
      modelRuns: toSafeNumber(row.modelRuns),
      providerSessions: toSafeNumber(row.providerSessions),
      deadLettersTotal: toSafeNumber(row.deadLettersTotal),
      deadLettersPending: toSafeNumber(row.deadLettersPending),
      lastMessageAt: row.lastMessageAt
    };
  }

  resetSession(sessionId: string, options: ResetSessionOptions = {}): ResetSessionResult {
    const clearHistory = options.clearHistory === true;
    const clearDiagnostics = options.clearDiagnostics === true || clearHistory;

    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const providerDelete = this.db
        .prepare(
          `
            DELETE FROM provider_sessions
            WHERE session_id = ?
          `
        )
        .run(sessionId);

      const promptSnapshotDelete = clearDiagnostics
        ? this.db
            .prepare(
              `
                DELETE FROM prompt_snapshots
                WHERE session_id = ?
              `
            )
            .run(sessionId)
        : { changes: 0 };

      const modelRunDelete = clearDiagnostics
        ? this.db
            .prepare(
              `
                DELETE FROM model_runs
                WHERE session_id = ?
              `
            )
            .run(sessionId)
        : { changes: 0 };

      const deadLetterDelete = clearDiagnostics
        ? this.db
            .prepare(
              `
                DELETE FROM dead_letters
                WHERE session_id = ?
              `
            )
            .run(sessionId)
        : { changes: 0 };

      if (clearDiagnostics) {
        this.db
          .prepare(
            `
              DELETE FROM voice_turn_receipts
              WHERE session_id = ?
            `
          )
          .run(sessionId);
      }

      const messageDelete = clearHistory
        ? this.db
            .prepare(
              `
                DELETE FROM messages
                WHERE session_id = ?
              `
            )
            .run(sessionId)
        : { changes: 0 };

      if (clearHistory) {
        this.db
          .prepare(
            `
              DELETE FROM session_compactions
              WHERE session_id = ?
            `
          )
          .run(sessionId);

        this.db
          .prepare(
            `
              DELETE FROM session_summaries
              WHERE session_id = ?
            `
          )
          .run(sessionId);

        this.db
          .prepare(
            `
              DELETE FROM memories
              WHERE session_id = ?
            `
          )
          .run(sessionId);

        this.db
          .prepare(
            `
              DELETE FROM pinned_facts
              WHERE scope = 'session' AND scope_id = ?
            `
          )
          .run(sessionId);
      }

      this.db.exec("COMMIT;");
      return {
        deletedProviderSessions: toSafeNumber(providerDelete.changes),
        deletedMessages: toSafeNumber(messageDelete.changes),
        deletedModelRuns: toSafeNumber(modelRunDelete.changes),
        deletedDeadLetters: toSafeNumber(deadLetterDelete.changes),
        deletedPromptSnapshots: toSafeNumber(promptSnapshotDelete.changes)
      };
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  upsertChannelReferent(input: ChannelReferentUpsertInput): void {
    const channelId = input.channelId.trim();
    const discordUserId = input.discordUserId.trim();
    const targetMessageId = input.targetMessageId.trim();
    const targetContent = input.targetContent.trim();
    if (!channelId || !discordUserId || !targetMessageId || !targetContent) {
      throw new Error("channelId, discordUserId, targetMessageId, and targetContent are required.");
    }

    const metadataJson = toJsonOrNull(input.metadata);
    const expiresAt = input.expiresAt?.trim() || toSqliteDateTime(new Date(Date.now() + 2 * 60 * 60 * 1000));
    this.db
      .prepare(
        `
          INSERT INTO channel_referents (
            channel_id,
            discord_user_id,
            kind,
            target_message_id,
            target_session_id,
            target_agent_id,
            target_direction,
            target_source,
            target_content,
            metadata_json,
            created_at,
            updated_at,
            expires_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?)
          ON CONFLICT(channel_id, discord_user_id) DO UPDATE SET
            kind = excluded.kind,
            target_message_id = excluded.target_message_id,
            target_session_id = excluded.target_session_id,
            target_agent_id = excluded.target_agent_id,
            target_direction = excluded.target_direction,
            target_source = excluded.target_source,
            target_content = excluded.target_content,
            metadata_json = excluded.metadata_json,
            updated_at = datetime('now'),
            expires_at = excluded.expires_at
        `
      )
      .run(
        channelId,
        discordUserId,
        input.kind,
        targetMessageId,
        input.targetSessionId ?? null,
        input.targetAgentId ?? null,
        input.targetDirection ?? null,
        input.targetSource ?? null,
        targetContent,
        metadataJson,
        expiresAt
      );
  }

  getChannelReferent(channelId: string, discordUserId: string): ChannelReferentRecord | null {
    const normalizedChannelId = channelId.trim();
    const normalizedDiscordUserId = discordUserId.trim();
    if (!normalizedChannelId || !normalizedDiscordUserId) return null;

    this.db
      .prepare(
        `
          DELETE FROM channel_referents
          WHERE channel_id = ?
            AND discord_user_id = ?
            AND expires_at <= datetime('now')
        `
      )
      .run(normalizedChannelId, normalizedDiscordUserId);

    const row = this.db
      .prepare(
        `
          SELECT
            channel_id AS channelId,
            discord_user_id AS discordUserId,
            kind,
            target_message_id AS targetMessageId,
            target_session_id AS targetSessionId,
            target_agent_id AS targetAgentId,
            target_direction AS targetDirection,
            target_source AS targetSource,
            target_content AS targetContent,
            metadata_json AS metadataJson,
            created_at AS createdAt,
            updated_at AS updatedAt,
            expires_at AS expiresAt
          FROM channel_referents
          WHERE channel_id = ?
            AND discord_user_id = ?
          LIMIT 1
        `
      )
      .get(normalizedChannelId, normalizedDiscordUserId) as
      | (Omit<ChannelReferentRecord, "metadata"> & { metadataJson: string | null })
      | undefined;

    if (!row) return null;
    return {
      channelId: row.channelId,
      discordUserId: row.discordUserId,
      kind: row.kind,
      targetMessageId: row.targetMessageId,
      targetSessionId: row.targetSessionId,
      targetAgentId: row.targetAgentId,
      targetDirection: row.targetDirection,
      targetSource: row.targetSource,
      targetContent: row.targetContent,
      metadata: row.metadataJson ? safeJsonParse(row.metadataJson) : null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      expiresAt: row.expiresAt
    };
  }

  clearChannelReferent(channelId: string, discordUserId: string): boolean {
    const result = this.db
      .prepare(
        `
          DELETE FROM channel_referents
          WHERE channel_id = ?
            AND discord_user_id = ?
        `
      )
      .run(channelId.trim(), discordUserId.trim());
    return toSafeNumber(result.changes) > 0;
  }

  getVoiceWatermark(channelId: string): { channelId: string; messageId: string; source: string; updatedAt: string } | null {
    const row = this.db
      .prepare(
        `SELECT channel_id AS channelId, watermark_message_id AS messageId, watermark_source AS source, updated_at AS updatedAt
         FROM voice_read_watermarks WHERE channel_id = ?`
      )
      .get(channelId) as { channelId: string; messageId: string; source: string; updatedAt: string } | undefined;
    return row ?? null;
  }

  advanceVoiceWatermark(channelId: string, messageId: string, source: string): boolean {
    const current = this.getVoiceWatermark(channelId);
    if (current && BigInt(messageId) <= BigInt(current.messageId)) {
      return false;
    }
    this.db
      .prepare(
        `INSERT INTO voice_read_watermarks (channel_id, watermark_message_id, watermark_source, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(channel_id) DO UPDATE SET
           watermark_message_id = excluded.watermark_message_id,
           watermark_source = excluded.watermark_source,
           updated_at = datetime('now')`
      )
      .run(channelId, messageId, source);
    return true;
  }

  getProcessingVoiceTurnCount(): number {
    // Auto-expire stale processing turns older than 30 minutes
    this.db
      .prepare(`UPDATE voice_turn_receipts SET status = 'failed', error_message = 'stale - auto-expired after 30min', updated_at = datetime('now') WHERE status = 'processing' AND created_at < datetime('now', '-30 minutes')`)
      .run();
    const row = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM voice_turn_receipts WHERE status = 'processing'`)
      .get() as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }

  private getUserVersion(): number {
    const row = this.db.prepare("PRAGMA user_version;").get() as { user_version?: number } | undefined;
    return row?.user_version ?? 0;
  }
}

type VoiceTurnReceiptRow = Omit<VoiceTurnReceiptRecord, "metadata" | "providerUsedFailover" | "warmStartUsed"> & {
  metadataJson: string | null;
  providerUsedFailover: number | null;
  warmStartUsed: number | null;
};

function safeJsonParse(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseJsonValue(input: string | null): unknown {
  if (!input) return null;
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function parseJsonArray(input: string | null): string[] {
  const parsed = parseJsonValue(input);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((value): value is string => typeof value === "string");
}

function mapActiveTaskRow(
  row: Omit<ActiveTaskRecord, "intentIds" | "missingSlots" | "structuredContext"> & {
    intentIdsJson: string | null;
    missingSlotsJson: string | null;
    structuredContextJson: string | null;
  }
): ActiveTaskRecord {
  const structuredContext = parseJsonValue(row.structuredContextJson);
  return {
    id: row.id,
    sessionId: row.sessionId,
    agentId: row.agentId,
    status: row.status,
    title: row.title,
    objective: row.objective,
    ownerWorkerId: row.ownerWorkerId,
    intentIds: parseJsonArray(row.intentIdsJson),
    missingSlots: parseJsonArray(row.missingSlotsJson),
    clarificationQuestion: row.clarificationQuestion,
    suggestedNextAction: row.suggestedNextAction,
    structuredContext:
      structuredContext && typeof structuredContext === "object" && !Array.isArray(structuredContext)
        ? (structuredContext as Record<string, unknown>)
        : null,
    sourceKind: row.sourceKind,
    createdByMessageId: row.createdByMessageId,
    updatedByMessageId: row.updatedByMessageId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    resolvedAt: row.resolvedAt,
    expiresAt: row.expiresAt,
  };
}

function toJsonOrNull(value: Record<string, unknown> | null | undefined): string | null {
  if (!value || Object.keys(value).length === 0) {
    return null;
  }
  return JSON.stringify(value);
}

function toStoredMemoryRecord(
  row: Omit<StoredMemoryRecord, "metadata"> & { metadataJson: string | null }
): StoredMemoryRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    agentId: row.agentId,
    source: row.source,
    content: row.content,
    importance: row.importance,
    sourceRef: row.sourceRef,
    embeddingJson: row.embeddingJson,
    embeddingModel: row.embeddingModel,
    createdAt: row.createdAt,
    lastAccessedAt: row.lastAccessedAt,
    accessCount: row.accessCount,
    archivedAt: row.archivedAt,
    metadata: row.metadataJson ? safeJsonParse(row.metadataJson) : null
  };
}

function toPromptSnapshotRecord(
  row: Omit<PromptSnapshotRecord, "metadata"> & { metadataJson: string | null }
): PromptSnapshotRecord {
  return {
    id: row.id,
    modelRunId: row.modelRunId,
    sessionId: row.sessionId,
    agentId: row.agentId,
    providerName: row.providerName,
    requestMessageId: row.requestMessageId,
    responseMessageId: row.responseMessageId,
    promptText: row.promptText,
    systemPrompt: row.systemPrompt,
    warmStartPrompt: row.warmStartPrompt,
    metadata: row.metadataJson ? safeJsonParse(row.metadataJson) : null,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}

function toSafeNumber(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}

function toSqliteBoolean(value: boolean | undefined): number | null {
  if (typeof value !== "boolean") return null;
  return value ? 1 : 0;
}

function toSqliteDateTime(value: Date): string {
  return value.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

function fromSqliteBoolean(value: number | null): boolean | null {
  if (value === null || value === undefined) return null;
  return value === 1;
}

function toVoiceTurnReceiptRecord(row: VoiceTurnReceiptRow): VoiceTurnReceiptRecord {
  return {
    turnId: row.turnId,
    sessionId: row.sessionId,
    agentId: row.agentId,
    utteranceId: row.utteranceId,
    status: row.status,
    providerName: row.providerName,
    providerSessionId: row.providerSessionId,
    responseText: row.responseText,
    providerUsedFailover: fromSqliteBoolean(row.providerUsedFailover),
    warmStartUsed: fromSqliteBoolean(row.warmStartUsed),
    requestMessageId: row.requestMessageId,
    responseMessageId: row.responseMessageId,
    modelRunId: row.modelRunId,
    errorMessage: row.errorMessage,
    metadata: row.metadataJson ? safeJsonParse(row.metadataJson) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}
