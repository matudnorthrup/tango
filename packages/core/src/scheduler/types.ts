import type { ProviderReasoningEffort } from "../types.js";

/**
 * Scheduler Types — TypeScript interfaces for the scheduled jobs system.
 *
 * Config files use snake_case (YAML convention). TypeScript uses camelCase.
 * The mapping happens in loadScheduleConfigs() in config.ts.
 */

// ============================================================
// Schedule Configuration (loaded from YAML)
// ============================================================

export type ScheduleExecutionMode = "deterministic" | "conditional-agent" | "agent";
export type ScheduleDeliveryMode = "message" | "webhook" | "none";
export type CompletionScope = "daily" | "weekly" | "monthly";

export interface ScheduleTimingConfig {
  /** Cron expression (croner format, 5 or 6 fields) */
  cron?: string;
  /** Fixed interval in seconds */
  everySeconds?: number;
  /** ISO 8601 timestamp for one-shot execution */
  at?: string;
  /** IANA timezone (default: America/Los_Angeles) */
  timezone?: string;
}

export interface SchedulePreCheckConfig {
  /** Registered pre-check handler name */
  handler: string;
}

export interface ScheduleExecutionConfig {
  mode: ScheduleExecutionMode;
  /** Handler name for deterministic mode */
  handler?: string;
  /** Pre-check config for conditional-agent mode */
  preCheck?: SchedulePreCheckConfig;
  /** Worker ID for agent and conditional-agent modes */
  workerId?: string;
  /**
   * Explicit deterministic intent IDs for scheduled agent runs.
   * When provided, the scheduler routes this job through the deterministic
   * turn runtime instead of calling the worker bridge directly.
   */
  intentIds?: string[];
  /**
   * Optional agent identity to use for deterministic schedule execution.
   * Defaults to the worker owner agent when omitted.
   */
  deterministicAgentId?: string;
  /** Task prompt for agent mode */
  task?: string;
  /** Task template with {{interpolation}} for conditional-agent mode */
  taskTemplate?: string;
  /** Per-execution timeout in seconds */
  timeoutSeconds?: number;
}

export interface ScheduleProviderConfig {
  /** Provider override (default: inherit from worker) */
  default?: string;
  /** Model override (e.g., claude-haiku-4-5 for cheap jobs) */
  model?: string;
  /** Reasoning effort override (provider-normalized by the runtime) */
  reasoningEffort?: ProviderReasoningEffort;
  /** Fallback providers */
  fallback?: string[];
}

export interface ScheduleDeliveryConfig {
  /** Discord channel for output */
  channelId?: string;
  /** Agent identity for avatar/display name */
  agentId?: string;
  /** Delivery mechanism */
  mode?: ScheduleDeliveryMode;
}

export interface ScheduleBackoffConfig {
  enabled?: boolean;
  initialSeconds?: number;
  maxSeconds?: number;
}

export interface SchedulePolicyConfig {
  /** Alert after N consecutive failures (default: 3) */
  maxConsecutiveFailures?: number;
  /** Discord channel for failure alerts */
  alertChannelId?: string;
  /** For one-shot jobs: auto-delete after execution */
  deleteAfterRun?: boolean;
  /** Jobs in same group run serially */
  concurrencyGroup?: string;
  /** Higher = runs first when multiple are due (default: 0) */
  priority?: number;
  /** Exponential backoff on failure */
  backoff?: ScheduleBackoffConfig;
}

export interface ScheduleCompletionConfig {
  /** Logical workflow to track (default: same as schedule id) */
  workflowId?: string;
  /** Completion recurrence scope (default: daily) */
  scope?: CompletionScope;
  /** Check completion table before executing (default: true) */
  checkBeforeRun?: boolean;
  /** Write completion row after successful run (default: true) */
  markOnSuccess?: boolean;
}

export interface ScheduleConfig {
  id: string;
  displayName?: string;
  description: string;
  enabled: boolean;
  /** Runtime to use for agent execution: 'legacy' (default) or 'v2' (Claude Code adapter) */
  runtime?: "legacy" | "v2";
  schedule: ScheduleTimingConfig;
  execution: ScheduleExecutionConfig;
  provider?: ScheduleProviderConfig;
  delivery?: ScheduleDeliveryConfig;
  policy?: SchedulePolicyConfig;
  completion?: ScheduleCompletionConfig;
  tags?: string[];
}

// ============================================================
// Runtime State
// ============================================================

export type RunStatus = "running" | "ok" | "error" | "skipped";

export interface ScheduleRunRecord {
  id: number;
  scheduleId: string;
  startedAt: string;
  finishedAt: string | null;
  status: RunStatus;
  executionMode: ScheduleExecutionMode;
  preCheckResult: string | null;
  durationMs: number | null;
  error: string | null;
  summary: string | null;
  modelUsed: string | null;
  workerId: string | null;
  deliveryStatus: string | null;
  deliveryError: string | null;
  metadata: string | null;
}

export interface ScheduleStateRecord {
  scheduleId: string;
  lastRunAt: string | null;
  lastStatus: string | null;
  lastDurationMs: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  backoffUntil: string | null;
  totalRuns: number;
  totalOk: number;
  totalErrors: number;
  totalSkipped: number;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleCompletionRecord {
  id: number;
  workflowId: string;
  completedDate: string;
  completedBy: string;
  scheduleRunId: number | null;
  completedAt: string;
  metadata: string | null;
}

// ============================================================
// Handler Types
// ============================================================

export interface HandlerContext {
  scheduleId: string;
  db: import("node:sqlite").DatabaseSync;
  lastRunAt?: Date;
}

export type DeterministicResult = {
  status: "ok" | "error" | "skipped";
  summary?: string;
  data?: Record<string, unknown>;
};

export type DeterministicHandler = (ctx: HandlerContext) => Promise<DeterministicResult>;

export type PreCheckResult =
  | { action: "skip"; reason: string }
  | { action: "proceed"; context: Record<string, unknown> };

export type PreCheckHandler = (ctx: HandlerContext) => Promise<PreCheckResult>;

// ============================================================
// Worker Execution Function Type
// ============================================================

/** Function signature for executing an agent worker. Injected by main.ts. */
export type WorkerExecuteFn = (
  workerId: string,
  task: string,
  model?: string,
  reasoningEffort?: ProviderReasoningEffort,
) => Promise<{ text: string; durationMs: number }>;

/** Function signature for executing a scheduled turn via the deterministic runtime. */
export type ScheduledTurnExecuteFn = (input: {
  config: ScheduleConfig;
  workerId: string;
  task: string;
  model?: string;
  reasoningEffort?: ProviderReasoningEffort;
}) => Promise<{
  text: string;
  durationMs: number;
  modelUsed?: string;
  metadata?: Record<string, unknown>;
}>;

/** Function signature for executing a scheduled turn via the v2 Claude Code runtime. */
export type V2ScheduledTurnExecuteFn = (input: {
  config: ScheduleConfig;
  task: string;
  agentId: string;
}) => Promise<{
  text: string;
  durationMs: number;
  model?: string;
  metadata?: Record<string, unknown>;
}>;

/** Function signature for delivering messages to Discord. Injected by main.ts. */
export type DeliveryFn = (
  channelId: string,
  agentId: string,
  content: string,
) => Promise<void>;

/** Function signature for sending alert messages. */
export type AlertFn = (
  channelId: string,
  content: string,
) => Promise<void>;

/** System log entry for every job run (ok, skip, error). */
export interface SystemLogEntry {
  scheduleId: string;
  displayName?: string;
  status: RunStatus;
  durationMs: number;
  executionMode: ScheduleExecutionMode;
  summary?: string;
  error?: string;
  modelUsed?: string;
  workerId?: string;
}

/** Function signature for posting system log entries. */
export type SystemLogFn = (entry: SystemLogEntry) => Promise<void>;
