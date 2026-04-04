import type {
  ActiveTaskRecord,
  CapabilityRegistry,
  ChatProvider,
  OrchestratorContinuityMode,
  ProviderReasoningEffort,
  ProviderResponse,
  ProviderToolsConfig
} from "@tango/core";
import { extractRecentMessagesContext } from "@tango/core";
import type { VoiceTurnExecutor, VoiceTurnInput, VoiceTurnResult } from "@tango/voice";
import {
  generateWithFailover,
  type ProviderContinuityMap,
  type ProviderFailoverFailure
} from "./provider-failover.js";
import {
  formatWorkerReportForPrompt,
  mergeWorkerReports,
  type WorkerDispatchDescriptor,
  type WorkerReport
} from "./worker-report.js";
import {
  DISPATCH_MCP_SERVER_NAME,
  DISPATCH_TOOL_FULL_NAME,
  DISPATCH_TOOL_NAME,
  extractDispatchToolCalls
} from "./dispatch-extractor.js";
import {
  buildClarificationNarrationPrompt,
  buildDeterministicNarrationPrompt,
  buildDeterministicTurnSummary,
  executeDeterministicPlan,
  formatExecutionReceiptsForPrompt,
  receiptHasConfirmedWriteOutcome,
  type DeterministicTurnState,
  type ExecutionReceipt,
} from "./deterministic-runtime.js";
import {
  buildDeterministicExecutionPlan,
  getDeterministicIntentCatalog,
} from "./deterministic-router.js";
import {
  classifyDeterministicIntents,
  type DeterministicIntentCatalogEntry,
  type DeterministicIntentClassification
} from "./intent-classifier.js";
import {
  renderActiveTasksContext,
  resolveActiveTaskContinuation,
  type ActiveTaskContinuationResolution,
} from "./active-task-state.js";

export interface ProviderChainCandidate {
  providerName: string;
  provider: ChatProvider;
}

export interface DiscordTurnExecutionContext {
  conversationKey: string;
  providerNames: string[];
  configuredProviderNames: string[];
  projectId?: string;
  topicId?: string;
  orchestratorContinuityMode?: OrchestratorContinuityMode;
  overrideProviderName?: string;
  model?: string;
  reasoningEffort?: ProviderReasoningEffort;
  systemPrompt?: string;
  tools?: ProviderToolsConfig;
  warmStartPrompt?: string;
  excludeMessageIds?: number[];
  providerChain?: ProviderChainCandidate[];
  continuityByProvider?: ProviderContinuityMap;
  capabilityRegistry?: CapabilityRegistry;
  deterministicRouting?: {
    enabled: boolean;
    projectScope?: string;
    confidenceThreshold: number;
    providerNames: string[];
    configuredProviderNames: string[];
    model?: string;
    reasoningEffort?: ProviderReasoningEffort;
    explicitIntentIds?: string[];
  };
}

/** Handler for orchestrator-directed worker dispatch (workerId + explicit task) */
export type WorkerTaskHandler = (
  workerId: string,
  task: string,
  turn: VoiceTurnInput,
  context: DiscordTurnExecutionContext,
  options?: {
    toolIds?: string[];
    excludedToolIds?: string[];
    reasoningEffort?: ProviderReasoningEffort;
  },
) => Promise<WorkerReport | null>;

export interface WorkerDispatchTelemetryEntry {
  workerId: string;
  taskId?: string;
  concurrencyGroup?: string;
  status: "completed" | "failed";
  error?: string;
}

export interface WorkerDispatchTelemetry {
  dispatchSource: "tool" | "xml";
  dispatchCount: number;
  completedDispatchCount: number;
  failedDispatchCount: number;
  concurrencyLimit: number;
  workerIds: string[];
  taskIds: string[];
  concurrencyGroups: string[];
  constrainedConcurrencyGroups: string[];
  dispatches: WorkerDispatchTelemetryEntry[];
}

/** Default wall-clock timeout for a single worker dispatch (15 minutes). */
const DEFAULT_WORKER_DISPATCH_TIMEOUT_MS = 15 * 60 * 1000;
const NARRATED_DISPATCH_RETRY_SYSTEM_PROMPT = [
  "If you need a worker, tool, file lookup, or external check, do it in this response.",
  "Do not send progress-only replies such as 'grabbing that now', 'checking', 'waiting on the worker', or 'back in a sec' unless you actually called the tool or worker in this response.",
  "Do not claim a worker, tool call, or dispatch was canceled, timed out, failed, or never came back unless that actually happened in this response.",
  "If no tool or worker is needed, answer the user directly now."
].join(" ");
const WORKER_SYNTHESIS_PREFIX = [
  "[The worker has already completed.]",
  "Do not say you are still dispatching, waiting on the worker, or waiting on results.",
  "Use the worker execution results below to answer the user now in this message."
].join("\n");
const WORKER_SYNTHESIS_SYSTEM_PROMPT = [
  "This is the final answer after a worker already completed.",
  "Do not call tools or workers in this step.",
  "Do not mention internal dispatch, waiting, or background progress.",
  "Answer the user's request directly from the completed worker result.",
  "If the completed worker result includes a shortlist, comparison, recommendation, or tradeoffs, preserve a compact comparison block instead of flattening everything into pure prose.",
].join(" ");
const WORKER_SYNTHESIS_RETRY_SYSTEM_PROMPT = [
  "The worker report already contains the actual results.",
  "Do not claim the results are missing, still loading, or only acknowledged unless the report itself explicitly says that.",
  "Quote or summarize the concrete results now.",
].join(" ");
const DETERMINISTIC_NARRATION_SYSTEM_PROMPT = [
  "This is the final answer after the deterministic runtime already completed the necessary work.",
  "Do not call tools or workers in this step.",
  "Do not mention internal routing, dispatch, or background work.",
  "Answer directly from the completed receipts and the user's request.",
  "If any receipt says clarification is still needed or that no write operation was recorded, say that explicitly and do not claim the change was applied.",
  "If the completed receipts contain a shortlist, comparison, recommendation, or tradeoffs, preserve a compact comparison block instead of flattening everything into pure prose.",
].join(" ");

export interface DiscordTurnExecutionDependencies {
  providerRetryLimit: number;
  workerDispatchConcurrency?: number;
  /** Hard wall-clock cap per worker dispatch (ms). Default: 15 minutes. */
  workerDispatchTimeoutMs?: number;
  getWorkerDispatchConcurrencyGroup?: (dispatch: WorkerDispatchDescriptor) => string | undefined;
  resolveProviderChain(providerNames: string[]): ProviderChainCandidate[];
  loadProviderContinuityMap(
    conversationKey: string,
    providerNames: string[]
  ): ProviderContinuityMap;
  savePersistedProviderSession(input: {
    conversationKey: string;
    sessionId: string;
    agentId: string;
    providerName: string;
    providerSessionId: string;
  }): void;
  buildWarmStartContextPrompt(input: {
    sessionId: string;
    agentId: string;
    currentUserPrompt?: string;
    excludeMessageIds?: number[];
    discordChannelId?: string | null;
  }): string | undefined | Promise<string | undefined>;
  normalizeProviderContinuityMap?: (input: {
    turn: VoiceTurnInput;
    context: DiscordTurnExecutionContext;
    continuityByProvider: ProviderContinuityMap;
  }) => ProviderContinuityMap;
  executeWorker?: WorkerReportHandler;
  /** Orchestrator-directed dispatch: worker runs with explicit task from orchestrator */
  executeWorkerWithTask?: WorkerTaskHandler;
  listActiveTasks?: (sessionId: string, agentId: string) => ActiveTaskRecord[];
}

export type WorkerReportHandler = (
  turn: VoiceTurnInput,
  context: DiscordTurnExecutionContext
) => Promise<WorkerReport | null>;

export interface DiscordTurnExecutionResult extends VoiceTurnResult {
  responseText: string;
  providerName: string;
  providerSessionId?: string;
  providerUsedFailover?: boolean;
  warmStartUsed?: boolean;
  providerRequestPrompt: string;
  providerRequestWarmStartUsed: boolean;
  initialRequestPrompt: string;
  initialRequestWarmStartUsed: boolean;
  usedWorkerSynthesis?: boolean;
  synthesisRetried?: boolean;
  response: ProviderResponse;
  attemptCount: number;
  attemptErrors: string[];
  providerFailures: ProviderFailoverFailure[];
  warmStartContextChars: number;
  configuredProviders: string[];
  effectiveProviders: string[];
  providerOverrideName?: string;
  workerReport?: WorkerReport;
  workerDispatchTelemetry?: WorkerDispatchTelemetry;
  deterministicTurn?: {
    state: DeterministicTurnState;
    summaryText: string;
    classifier: DeterministicIntentClassification;
    receipts: ExecutionReceipt[];
  };
  activeTaskResolution?: ActiveTaskContinuationResolution;
}

export type DiscordTurnContextResolver = (
  turn: VoiceTurnInput
) => DiscordTurnExecutionContext | Promise<DiscordTurnExecutionContext>;

export interface DiscordVoiceTurnExecutor extends VoiceTurnExecutor {
  executeTurnDetailed(
    turn: VoiceTurnInput,
    context: DiscordTurnExecutionContext
  ): Promise<DiscordTurnExecutionResult>;
}

// ---------------------------------------------------------------------------
// Worker dispatch tag stripping (defense-in-depth)
// ---------------------------------------------------------------------------

/**
 * Strip any <worker-dispatch> tags from text before it reaches Discord.
 * This is a safety net — the dispatch flow should already replace response1
 * with the synthesis, but if anything leaks through, this prevents raw XML
 * from being shown to the user.
 */
function stripWorkerDispatchTags(text: string): string {
  if (!text.includes('<worker-dispatch')) return text;
  return text
    .replace(/<worker-dispatch\b[^>]*>[\s\S]*?<\/worker-dispatch>/g, '')
    .replace(/<worker-dispatch\b[^>]*>[\s\S]*$/g, '')
    .trim();
}

function appendSystemPrompt(base: string | undefined, extra: string): string {
  const parts = [base?.trim(), extra.trim()].filter((value) => Boolean(value && value.length > 0));
  return parts.join("\n\n");
}

function hasDispatchCapability(context: DiscordTurnExecutionContext): boolean {
  const tools = context.tools;
  if (!tools || tools.mode === "off") {
    return false;
  }

  if (tools.allowlist?.includes(DISPATCH_TOOL_FULL_NAME) || tools.allowlist?.includes(DISPATCH_TOOL_NAME)) {
    return true;
  }

  return Boolean(tools.mcpServers?.[DISPATCH_MCP_SERVER_NAME]);
}

function isDeterministicEligible(context: DiscordTurnExecutionContext): boolean {
  const config = context.deterministicRouting;
  if (!config?.enabled) {
    return false;
  }
  if (!context.capabilityRegistry) {
    return false;
  }
  if (config.projectScope && context.projectId !== config.projectScope) {
    return false;
  }
  return config.providerNames.length > 0;
}

function buildExplicitDeterministicClassification(input: {
  intentIds: readonly string[];
  catalog: readonly DeterministicIntentCatalogEntry[];
}): DeterministicIntentClassification {
  const catalogByIntentId = new Map(input.catalog.map((entry) => [entry.id, entry] as const));
  const missingIntentIds = input.intentIds.filter((intentId) => !catalogByIntentId.has(intentId));
  if (missingIntentIds.length > 0) {
    throw new Error(`Unknown explicit deterministic intents: ${missingIntentIds.join(", ")}`);
  }

  const envelopes = input.intentIds.map((intentId, index) => {
    const entry = catalogByIntentId.get(intentId)!;
    return {
      id: `intent-${index + 1}`,
      domain: entry.domain,
      intentId: entry.id,
      mode: entry.mode,
      confidence: 1,
      entities: {},
      rawEntities: [],
      missingSlots: [],
      canRunInParallel: entry.canRunInParallel ?? true,
      routeHint: { ...entry.route },
    };
  });

  return {
    envelopes,
    meetsThreshold: envelopes.length > 0,
    providerName: "config",
    usedFailover: false,
    requestPrompt: "",
    systemPrompt: "",
    response: {
      text: "",
      metadata: {
        model: "config:explicit-intents",
      },
    },
    responseText: "",
    attemptCount: 0,
    attemptErrors: [],
    failures: [],
  };
}

function looksLikeNarratedDispatch(text: string): boolean {
  const normalized = text.trim();
  if (normalized.length === 0) {
    return false;
  }

  const patterns = [
    /\bwaiting on (?:the )?(?:worker|results?)\b/i,
    /\bwaiting for (?:the )?(?:worker|results?)\b/i,
    /\bback in (?:a|one) sec\b/i,
    /\b(?:one sec|hold on)\b/i,
    /\bdispatched(?:\s+again)?\b/i,
    /\b(?:let me|i(?:'ll| will)|i(?:'m| am))\s+(?:grab|fetch|pull|open|check|look up|look for|read|review|search|dig into|compare|dispatch|route|ask|hand off)\b/i,
    /\b(?:grabbing|fetching|pulling|opening|checking|looking up|looking for|reading|reviewing|searching|dispatching|routing|asking|handing off)\b/i,
    /\b(?:calling|using|dispatching)\s+(?:a|the)\s+worker\b/i,
    /\b(?:worker|tool call|dispatch)\b.{0,40}\b(?:cancel(?:ed|led)|timed out|failed|never came back|didn't return|did not return)\b/i,
    /\b(?:couldn't|could not|can't|cannot)\s+(?:confirm|claim|say)\b.{0,80}\b(?:logged|saved|made it into|in the diary|went through)\b/i,
  ];

  return patterns.some((pattern) => pattern.test(normalized));
}

// ---------------------------------------------------------------------------
// Worker dispatch tag parsing
// ---------------------------------------------------------------------------

/**
 * Parse all <worker-dispatch> tags from the orchestrator's response.
 * Format: <worker-dispatch worker="worker-id" task-id="optional-id">task instructions</worker-dispatch>
 *
 * Tries strict global parsing first (requires closing tags), then falls back to a
 * lenient single-match parse that captures everything after the first opening tag
 * and strips trailing XML junk. The lenient path handles cases where Claude emits
 * its native tool-call XML format (invoke/parameter/tool_use tags) inside the
 * dispatch block before the closing tag appears, causing strict parsing to fail.
 */
function parseAllWorkerDispatches(text: string): WorkerDispatchDescriptor[] {
  const strictDispatches: WorkerDispatchDescriptor[] = [];
  const strictPattern = /<worker-dispatch\b([^>]*)>([\s\S]*?)<\/worker-dispatch>/g;

  for (const match of text.matchAll(strictPattern)) {
    const attributes = parseWorkerDispatchAttributes(match[1] ?? "");
    const workerId = attributes.worker;
    const task = (match[2] ?? "").trim();
    if (!workerId || !task) continue;

    strictDispatches.push({
      workerId,
      task,
      taskId: attributes["task-id"],
    });
  }

  if (strictDispatches.length > 0) {
    return strictDispatches;
  }

  const lenientMatch = text.match(/<worker-dispatch\b([^>]*)>([\s\S]+)$/);
  if (!lenientMatch) return [];

  const attributes = parseWorkerDispatchAttributes(lenientMatch[1] ?? "");
  if (!attributes.worker) return [];

  // Strip trailing XML-like junk (closing tags from Claude's native tool-call format)
  const content = lenientMatch[2]!
    .replace(/<\/thinking>/gi, '')
    .replace(/<\/parameter>/gi, '')
    .replace(/<\/invoke>/gi, '')
    .replace(/<\/tool_use>/gi, '')
    .trim();

  if (!content) return [];
  console.log(`[turn-executor] lenient worker-dispatch parse succeeded, worker=${attributes.worker}`);
  return [{
    workerId: attributes.worker,
    task: content,
    taskId: attributes["task-id"],
  }];
}

function extractDispatchesFromResponse(response: ProviderResponse): {
  dispatches: WorkerDispatchDescriptor[];
  dispatchSource: "tool" | "xml" | "none";
} {
  let dispatches = extractDispatchToolCalls(response.toolCalls);
  let dispatchSource: "tool" | "xml" | "none" = dispatches.length > 0 ? "tool" : "none";

  if (dispatches.length === 0) {
    dispatches = parseAllWorkerDispatches(response.text);
    if (dispatches.length > 0) {
      dispatchSource = "xml";
      console.warn("[turn-executor] dispatch via XML fallback — agent should use dispatch_worker tool");
    }
  }

  return { dispatches, dispatchSource };
}

function parseWorkerDispatchAttributes(attributeText: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of attributeText.matchAll(/([a-zA-Z][\w-]*)="([^"]*)"/g)) {
    const key = match[1];
    const value = match[2];
    if (!key || value === undefined) continue;
    attributes[key] = value;
  }
  return attributes;
}

async function runWithConcurrencyLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  options?: {
    getConcurrencyGroup?: (item: T, index: number) => string | undefined;
  },
): Promise<Array<PromiseSettledResult<R>>> {
  const results: Array<PromiseSettledResult<R>> = new Array(items.length);
  const concurrency = Math.max(1, Math.min(limit, items.length));
  const started = new Array(items.length).fill(false);
  const activeGroups = new Set<string>();
  const getConcurrencyGroup = options?.getConcurrencyGroup;
  let activeCount = 0;
  let completedCount = 0;

  if (items.length === 0) {
    return results;
  }

  await new Promise<void>((resolve) => {
    let settled = false;

    const maybeResolve = () => {
      if (!settled && completedCount >= items.length) {
        settled = true;
        resolve();
      }
    };

    const findNextRunnableIndex = (): number => {
      for (let index = 0; index < items.length; index++) {
        if (started[index]) continue;
        const item = items[index];
        if (item === undefined) continue;
        const group = getConcurrencyGroup?.(item, index);
        if (group && activeGroups.has(group)) continue;
        return index;
      }
      return -1;
    };

    const schedule = () => {
      while (activeCount < concurrency) {
        const index = findNextRunnableIndex();
        if (index === -1) break;

        const item = items[index];
        if (item === undefined) {
          started[index] = true;
          completedCount++;
          continue;
        }

        started[index] = true;
        activeCount++;
        const group = getConcurrencyGroup?.(item, index);
        if (group) activeGroups.add(group);

        void fn(item, index)
          .then((value) => {
            results[index] = {
              status: "fulfilled",
              value,
            };
          })
          .catch((reason) => {
            results[index] = {
              status: "rejected",
              reason,
            };
          })
          .finally(() => {
            activeCount--;
            completedCount++;
            if (group) activeGroups.delete(group);
            maybeResolve();
            schedule();
          });
      }

      maybeResolve();
    };

    schedule();
  });

  return results;
}

function buildWorkerDispatchTelemetry(
  dispatches: readonly WorkerDispatchDescriptor[],
  results: readonly PromiseSettledResult<WorkerReport | null>[],
  dispatchSource: "tool" | "xml",
  concurrencyLimit: number,
  concurrencyGroups: readonly (string | undefined)[],
): WorkerDispatchTelemetry {
  const dispatchTelemetry = dispatches.map((dispatch, index) => {
    const result = results[index];
    if (!result || result.status === "rejected" || !result.value) {
      return {
        workerId: dispatch.workerId,
        taskId: dispatch.taskId,
        concurrencyGroup: concurrencyGroups[index],
        status: "failed" as const,
        error:
          !result
            ? "Worker execution did not produce a result."
            : result.status === "rejected"
              ? formatWorkerDispatchReason(result.reason)
              : "Worker completed without returning data.",
      };
    }

    return {
      workerId: dispatch.workerId,
      taskId: dispatch.taskId,
      concurrencyGroup: concurrencyGroups[index],
      status: "completed" as const,
    };
  });

  const constrainedConcurrencyGroups = [...new Set(
    concurrencyGroups.filter(
      (group, index): group is string =>
        typeof group === "string" && concurrencyGroups.indexOf(group) !== index
    ),
  )];

  return {
    dispatchSource,
    dispatchCount: dispatchTelemetry.length,
    completedDispatchCount: dispatchTelemetry.filter((dispatch) => dispatch.status === "completed").length,
    failedDispatchCount: dispatchTelemetry.filter((dispatch) => dispatch.status === "failed").length,
    concurrencyLimit,
    workerIds: dispatchTelemetry.map((dispatch) => dispatch.workerId),
    taskIds: dispatchTelemetry.flatMap((dispatch) => dispatch.taskId ? [dispatch.taskId] : []),
    concurrencyGroups: [...new Set(concurrencyGroups.filter((group): group is string => typeof group === "string"))],
    constrainedConcurrencyGroups,
    dispatches: dispatchTelemetry,
  };
}

function formatWorkerDispatchReason(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message;
  }

  if (typeof reason === "string") {
    return reason;
  }

  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

// ---------------------------------------------------------------------------
// Explicit synthesis prompt (fallback when --resume fails)
// ---------------------------------------------------------------------------

/**
 * Build a self-contained synthesis prompt when the session --resume path fails
 * to produce a new response. Embeds the orchestrator's initial reply and the
 * worker report so the LLM can synthesize without session continuity.
 */
function buildExplicitSynthesisPrompt(
  userMessage: string,
  workerReport: string
): string {
  return [
    `Original user message:`,
    userMessage,
    ``,
    `A worker has already completed. Here are the results:`,
    ``,
    workerReport,
    ``,
    `Write the final reply to the user now.`,
    `Do not mention internal dispatch, tool plumbing, or that you are still waiting.`,
    `If the worker asked for clarification, ask that question naturally.`,
  ].join("\n");
}

function looksLikeIncompleteWorkerSynthesis(text: string): boolean {
  const normalized = text.trim();
  if (normalized.length === 0) {
    return true;
  }

  const patterns = [
    /\bstanding by\b/i,
    /\bstill (?:waiting|getting)\b/i,
    /\b(?:didn't|did not|weren't|were not|wasn't|was not)\s+(?:come back|surface|show up|appear|make it)\b/i,
    /\blost in tool noise\b/i,
    /\b(?:read|saw)\s+the tool schema\b/i,
    /\bno real query output\b/i,
    /\bdispatch-only acknowledgments?\b/i,
  ];

  return patterns.some((pattern) => pattern.test(normalized));
}

function receiptExpectsWriteButHasNoConfirmedWrite(receipt: ExecutionReceipt): boolean {
  return (receipt.mode === "write" || receipt.mode === "mixed") && !receiptHasConfirmedWriteOutcome(receipt);
}

function collectDeterministicWriteClarifications(receipts: readonly ExecutionReceipt[]): string[] {
  return receipts
    .filter(receiptExpectsWriteButHasNoConfirmedWrite)
    .flatMap((receipt) => {
      if (typeof receipt.clarification === "string" && receipt.clarification.trim().length > 0) {
        return [receipt.clarification.trim()];
      }
      return [];
    });
}

function responseAcknowledgesUnverifiedWrite(text: string): boolean {
  const normalized = text.trim();
  if (normalized.length === 0) {
    return false;
  }

  const patterns = [
    /\bnot\s+(?:logged|saved|written|applied|patched|repaired|confirmed)\b/i,
    /\bdid(?: not|n't)\s+(?:get|go|write|land)\b/i,
    /\bcan(?:not|'t)\s+(?:confirm|verify|claim)\b/i,
    /\bcould(?: not|n't)\s+(?:confirm|verify|claim)\b/i,
    /\bnot yet\b/i,
    /\bunresolved\b/i,
    /\bneeds (?:a )?retry\b/i,
    /\bstill needs\b/i,
    /\bclarification\b/i,
  ];

  return patterns.some((pattern) => pattern.test(normalized));
}

function looksLikeDeterministicWriteSuccess(text: string): boolean {
  const normalized = text.trim();
  if (normalized.length === 0 || responseAcknowledgesUnverifiedWrite(normalized)) {
    return false;
  }

  const patterns = [
    /\b(?:breakfast|lunch|dinner|snack)\s+is\s+in\b/i,
    /\bon the books\b/i,
    /\blogged\b/i,
    /\blocked(?:\s+in)?\b/i,
    /\bpatched\b/i,
    /\brepaired\b/i,
    /\blanded clean\b/i,
    /\bofficially\b.{0,40}\b(?:logged|saved|in|repaired)\b/i,
  ];

  return patterns.some((pattern) => pattern.test(normalized));
}

function buildDeterministicWriteGuardReply(receipts: readonly ExecutionReceipt[]): string {
  const clarification = collectDeterministicWriteClarifications(receipts)[0];
  if (clarification) {
    return `I didn't get a confirmed write through yet. ${clarification}`;
  }
  return "I didn't get a confirmed write through on that step, so I can't say it was logged yet.";
}

// ---------------------------------------------------------------------------
// Turn execution
// ---------------------------------------------------------------------------

export async function executeDiscordTurn(
  dependencies: DiscordTurnExecutionDependencies,
  input: {
    turn: VoiceTurnInput;
    context: DiscordTurnExecutionContext;
  }
): Promise<DiscordTurnExecutionResult> {
  const orchestratorContinuityMode = input.context.orchestratorContinuityMode ?? "provider";
  const shouldPersistProviderContinuity = orchestratorContinuityMode === "provider";
  const providerChain =
    input.context.providerChain ??
    dependencies.resolveProviderChain(input.context.providerNames);

  const loadedContinuityByProvider =
    shouldPersistProviderContinuity
      ? input.context.continuityByProvider ??
        dependencies.loadProviderContinuityMap(
          input.context.conversationKey,
          input.context.providerNames
        )
      : {};

  const continuityByProvider =
    shouldPersistProviderContinuity
      ? dependencies.normalizeProviderContinuityMap?.({
          turn: input.turn,
          context: input.context,
          continuityByProvider: loadedContinuityByProvider,
        }) ?? loadedContinuityByProvider
      : {};

  const warmStartPrompt =
    input.context.warmStartPrompt ??
    await dependencies.buildWarmStartContextPrompt({
      sessionId: input.turn.sessionId,
      agentId: input.turn.agentId,
      currentUserPrompt: input.turn.transcript,
      excludeMessageIds: input.context.excludeMessageIds,
      discordChannelId: input.turn.channelId,
    });
  const activeTasks =
    dependencies.listActiveTasks?.(input.turn.sessionId, input.turn.agentId) ?? [];
  const activeTaskResolution = resolveActiveTaskContinuation({
    tasks: activeTasks,
    userMessage: input.turn.transcript,
  });
  const effectiveUserMessage = activeTaskResolution.effectiveUserMessage;
  const activeTaskPromptContext =
    activeTaskResolution.promptContext ?? renderActiveTasksContext(activeTasks);
  const effectiveWarmStartPrompt =
    activeTaskPromptContext && activeTaskPromptContext.trim().length > 0
      ? [warmStartPrompt?.trim(), activeTaskPromptContext.trim()].filter(Boolean).join("\n\n")
      : warmStartPrompt;
  const warmStartContextChars = effectiveWarmStartPrompt?.length ?? 0;
  const deterministicConversationContext = extractRecentMessagesContext(effectiveWarmStartPrompt, {
    maxLines: 8,
    maxChars: 800,
  });
  let deterministicTurn: DiscordTurnExecutionResult["deterministicTurn"];

  if (isDeterministicEligible(input.context)) {
    const deterministicConfig = input.context.deterministicRouting!;
    const capabilityRegistry = input.context.capabilityRegistry!;
    const classifierProviderChain = dependencies.resolveProviderChain(deterministicConfig.providerNames);
    const intentCatalog = getDeterministicIntentCatalog({
      registry: capabilityRegistry,
      agentId: input.turn.agentId,
      projectId: input.context.projectId,
      domain: deterministicConfig.projectScope,
    });

    if (intentCatalog.length > 0 && dependencies.executeWorkerWithTask) {
      try {
        const classificationStartedAt = Date.now();
        const explicitIntentIds =
          deterministicConfig.explicitIntentIds?.filter((intentId) => intentId.trim().length > 0) ?? [];
        const classification =
          explicitIntentIds.length > 0
            ? buildExplicitDeterministicClassification({
                intentIds: explicitIntentIds,
                catalog: intentCatalog,
              })
            : await classifyDeterministicIntents({
                userMessage: effectiveUserMessage,
                catalog: intentCatalog,
                providerChain: classifierProviderChain,
                retryLimit: dependencies.providerRetryLimit,
                confidenceThreshold: deterministicConfig.confidenceThreshold,
                model: deterministicConfig.model,
                reasoningEffort: deterministicConfig.reasoningEffort,
                continuation:
                  activeTaskResolution.kind === "continue" && activeTaskResolution.matchedTask
                    ? {
                        title: activeTaskResolution.matchedTask.title,
                        objective: activeTaskResolution.matchedTask.objective,
                        expectedIntentIds: activeTaskResolution.matchedTask.intentIds,
                        structuredContext: activeTaskResolution.matchedTask.structuredContext,
                      }
                    : undefined,
                conversationContext: deterministicConversationContext ?? undefined,
              });
        const intentLatencyMs = Date.now() - classificationStartedAt;

        if (classification.meetsThreshold) {
          const routingStartedAt = Date.now();
          const routingResult = buildDeterministicExecutionPlan({
            userMessage: effectiveUserMessage,
            envelopes: classification.envelopes,
            catalog: intentCatalog,
            registry: capabilityRegistry,
            conversationContext: deterministicConversationContext,
          });
          const routeLatencyMs = Date.now() - routingStartedAt;

          if (routingResult.outcome === "clarification" && routingResult.clarificationQuestion) {
            const clarificationFailoverResult = await generateWithFailover(
              providerChain,
              {
                prompt: buildClarificationNarrationPrompt({
                  userMessage: effectiveUserMessage,
                  clarificationQuestion: routingResult.clarificationQuestion,
                }),
                systemPrompt: appendSystemPrompt(input.context.systemPrompt, DETERMINISTIC_NARRATION_SYSTEM_PROMPT),
                tools: { mode: "off" },
                model: input.context.model,
                reasoningEffort: input.context.reasoningEffort,
              },
              dependencies.providerRetryLimit,
              {},
              { warmStartPrompt: effectiveWarmStartPrompt },
            );

            if (shouldPersistProviderContinuity && clarificationFailoverResult.retryResult.response.providerSessionId) {
              dependencies.savePersistedProviderSession({
                conversationKey: input.context.conversationKey,
                sessionId: input.turn.sessionId,
                agentId: input.turn.agentId,
                providerName: clarificationFailoverResult.providerName,
                providerSessionId: clarificationFailoverResult.retryResult.response.providerSessionId,
              });
            }

            const state: DeterministicTurnState = {
              auth: {
                initiatingPrincipalId: `user:${input.turn.discordUserId ?? "unknown"}`,
                leadAgentPrincipalId: `agent:${input.turn.agentId}`,
                projectId: input.context.projectId,
                topicId: input.context.topicId,
                delegationChain: [
                  `user:${input.turn.discordUserId ?? "unknown"}`,
                  `agent:${input.turn.agentId}`,
                ],
              },
              intent: {
                envelopes: classification.envelopes,
                classifierProvider: classification.providerName,
                classifierModel: classification.response.metadata?.model,
                classifierLatencyMs: intentLatencyMs,
              },
              routing: {
                plan: undefined,
                clarificationNeeded: true,
                routeOutcome: "clarification",
                routeLatencyMs,
              },
              execution: {
                receipts: [],
                completed: false,
                partialFailure: false,
                executionLatencyMs: 0,
                hasWriteOperations: false,
              },
              narration: {
                synthesisProvider: clarificationFailoverResult.providerName,
                synthesisModel: clarificationFailoverResult.retryResult.response.metadata?.model,
                narrationLatencyMs: clarificationFailoverResult.retryResult.response.metadata?.durationMs,
                usedRetry: false,
              },
            };
            deterministicTurn = {
              state,
              summaryText: buildDeterministicTurnSummary({
                userMessage: effectiveUserMessage,
                routeOutcome: "clarification",
                intents: classification.envelopes,
                finalReply: clarificationFailoverResult.retryResult.response.text,
              }),
              classifier: classification,
              receipts: [],
            };

            return {
              responseText: clarificationFailoverResult.retryResult.response.text,
              providerName: clarificationFailoverResult.providerName,
              providerSessionId: clarificationFailoverResult.retryResult.response.providerSessionId,
              providerUsedFailover: classification.usedFailover || clarificationFailoverResult.usedFailover,
              warmStartUsed: clarificationFailoverResult.warmStartUsed,
              providerRequestPrompt: clarificationFailoverResult.requestPrompt,
              providerRequestWarmStartUsed: clarificationFailoverResult.warmStartUsed,
              initialRequestPrompt: clarificationFailoverResult.requestPrompt,
              initialRequestWarmStartUsed: clarificationFailoverResult.warmStartUsed,
              usedWorkerSynthesis: false,
              response: clarificationFailoverResult.retryResult.response,
              attemptCount: classification.attemptCount + clarificationFailoverResult.retryResult.attempts,
              attemptErrors: [
                ...classification.attemptErrors,
                ...clarificationFailoverResult.retryResult.attemptErrors,
              ],
              providerFailures: [...classification.failures, ...clarificationFailoverResult.failures],
              warmStartContextChars,
              configuredProviders: [...input.context.configuredProviderNames],
              effectiveProviders: [...input.context.providerNames],
              providerOverrideName: input.context.overrideProviderName,
              deterministicTurn,
              activeTaskResolution,
            };
          }

          if (routingResult.outcome === "executed" && routingResult.plan) {
            const executionStartedAt = Date.now();
            const receipts = await executeDeterministicPlan({
              plan: routingResult.plan,
              executeWorkerWithTask: (workerId, task, step) =>
                dependencies.executeWorkerWithTask!(workerId, task, input.turn, input.context, {
                  toolIds: step.allowedToolIds,
                  excludedToolIds: step.excludedToolIds,
                  reasoningEffort: step.reasoningEffort,
                }),
              concurrencyLimit: Math.max(1, dependencies.workerDispatchConcurrency ?? 3),
              timeoutMs: dependencies.workerDispatchTimeoutMs ?? DEFAULT_WORKER_DISPATCH_TIMEOUT_MS,
              getConcurrencyGroup: dependencies.getWorkerDispatchConcurrencyGroup
                ? (step) =>
                    step.excludedToolIds?.includes("browser")
                      ? undefined
                      :
                    dependencies.getWorkerDispatchConcurrencyGroup?.({
                      workerId: step.workerId,
                      task: step.task,
                      taskId: step.id,
                    })
                : undefined,
            });
            const executionLatencyMs = Date.now() - executionStartedAt;
            const receiptsText = formatExecutionReceiptsForPrompt(receipts);
            const narrationFailoverResult = await generateWithFailover(
              providerChain,
              {
                prompt: buildDeterministicNarrationPrompt({
                  userMessage: effectiveUserMessage,
                  receiptsText,
                }),
                systemPrompt: appendSystemPrompt(input.context.systemPrompt, DETERMINISTIC_NARRATION_SYSTEM_PROMPT),
                tools: { mode: "off" },
                model: input.context.model,
                reasoningEffort: input.context.reasoningEffort,
              },
              dependencies.providerRetryLimit,
              {},
              { warmStartPrompt: effectiveWarmStartPrompt },
            );
            const guardedNarrationText =
              receipts.some(receiptExpectsWriteButHasNoConfirmedWrite)
              && looksLikeDeterministicWriteSuccess(narrationFailoverResult.retryResult.response.text)
                ? buildDeterministicWriteGuardReply(receipts)
                : narrationFailoverResult.retryResult.response.text;

            if (shouldPersistProviderContinuity && narrationFailoverResult.retryResult.response.providerSessionId) {
              dependencies.savePersistedProviderSession({
                conversationKey: input.context.conversationKey,
                sessionId: input.turn.sessionId,
                agentId: input.turn.agentId,
                providerName: narrationFailoverResult.providerName,
                providerSessionId: narrationFailoverResult.retryResult.response.providerSessionId,
              });
            }

            const state: DeterministicTurnState = {
              auth: {
                initiatingPrincipalId: `user:${input.turn.discordUserId ?? "unknown"}`,
                leadAgentPrincipalId: `agent:${input.turn.agentId}`,
                projectId: input.context.projectId,
                topicId: input.context.topicId,
                delegationChain: [
                  `user:${input.turn.discordUserId ?? "unknown"}`,
                  `agent:${input.turn.agentId}`,
                  ...[...new Set(receipts.map((receipt) => `worker:${receipt.workerId}`))],
                ],
              },
              intent: {
                envelopes: classification.envelopes,
                classifierProvider: classification.providerName,
                classifierModel: classification.response.metadata?.model,
                classifierLatencyMs: intentLatencyMs,
              },
              routing: {
                plan: routingResult.plan,
                clarificationNeeded: false,
                routeOutcome: "executed",
                routeLatencyMs,
              },
              execution: {
                receipts,
                completed: true,
                partialFailure: receipts.some((receipt) => receipt.status !== "completed"),
                executionLatencyMs,
                hasWriteOperations: receipts.some((receipt) => receipt.hasWriteOperations),
              },
              narration: {
                synthesisProvider: narrationFailoverResult.providerName,
                synthesisModel: narrationFailoverResult.retryResult.response.metadata?.model,
                narrationLatencyMs: narrationFailoverResult.retryResult.response.metadata?.durationMs,
                usedRetry: false,
              },
            };
            deterministicTurn = {
              state,
              summaryText: buildDeterministicTurnSummary({
                userMessage: effectiveUserMessage,
                routeOutcome: "executed",
                intents: classification.envelopes,
                receipts,
                finalReply: guardedNarrationText,
              }),
              classifier: classification,
              receipts,
            };

            return {
              responseText: guardedNarrationText,
              providerName: narrationFailoverResult.providerName,
              providerSessionId: narrationFailoverResult.retryResult.response.providerSessionId,
              providerUsedFailover: classification.usedFailover || narrationFailoverResult.usedFailover,
              warmStartUsed: narrationFailoverResult.warmStartUsed,
              providerRequestPrompt: narrationFailoverResult.requestPrompt,
              providerRequestWarmStartUsed: narrationFailoverResult.warmStartUsed,
              initialRequestPrompt: narrationFailoverResult.requestPrompt,
              initialRequestWarmStartUsed: narrationFailoverResult.warmStartUsed,
              usedWorkerSynthesis: false,
              response: narrationFailoverResult.retryResult.response,
              attemptCount: classification.attemptCount + narrationFailoverResult.retryResult.attempts,
              attemptErrors: [
                ...classification.attemptErrors,
                ...narrationFailoverResult.retryResult.attemptErrors,
              ],
              providerFailures: [...classification.failures, ...narrationFailoverResult.failures],
              warmStartContextChars,
              configuredProviders: [...input.context.configuredProviderNames],
              effectiveProviders: [...input.context.providerNames],
              providerOverrideName: input.context.overrideProviderName,
              deterministicTurn,
              activeTaskResolution,
            };
          }

        }
        deterministicTurn = {
          state: {
            auth: {
              initiatingPrincipalId: `user:${input.turn.discordUserId ?? "unknown"}`,
              leadAgentPrincipalId: `agent:${input.turn.agentId}`,
              projectId: input.context.projectId,
              topicId: input.context.topicId,
              delegationChain: [
                `user:${input.turn.discordUserId ?? "unknown"}`,
                `agent:${input.turn.agentId}`,
              ],
            },
            intent: {
              envelopes: classification.envelopes,
              classifierProvider: classification.providerName,
              classifierModel: classification.response.metadata?.model,
              classifierLatencyMs: intentLatencyMs,
            },
            routing: {
              plan: undefined,
              clarificationNeeded: false,
              routeOutcome: "fallback",
              routeLatencyMs: undefined,
              fallbackReason: classification.meetsThreshold
                ? "Deterministic routing did not produce an executable plan."
                : "Classification confidence was below the deterministic routing threshold.",
            },
            execution: {
              receipts: [],
              completed: false,
              partialFailure: false,
              executionLatencyMs: 0,
              hasWriteOperations: false,
            },
            narration: {},
          },
          summaryText: buildDeterministicTurnSummary({
            userMessage: effectiveUserMessage,
            routeOutcome: "fallback",
            intents: classification.envelopes,
          }),
          classifier: classification,
          receipts: [],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[turn-executor] deterministic routing fell back: ${message}`);
      }
    }
  }

  // --- Pre-dispatch path: worker runs before orchestrator (for reads) ---
  let workerReport: WorkerReport | null = null;
  let workerDispatchTelemetry: WorkerDispatchTelemetry | undefined;
  if (dependencies.executeWorker) {
    try {
      workerReport = await dependencies.executeWorker(input.turn, input.context);
    } catch (workerError) {
      console.error(`[turn-executor] executeWorker failed:`, workerError instanceof Error ? workerError.message : workerError);
    }
  }

  // If pre-dispatch returned data, inject it and let orchestrator synthesize
  let effectivePrompt = effectiveUserMessage;
  if (workerReport && (workerReport.operations.length > 0 || workerReport.clarification)) {
    const reportText = formatWorkerReportForPrompt(workerReport);
    if (reportText) {
      effectivePrompt = `${reportText}\n\nUser message: ${effectiveUserMessage}`;
    }
  }

  // --- Phase 1: Call orchestrator ---
  const failoverResult1 = await generateWithFailover(
    providerChain,
    {
      prompt: effectivePrompt,
      systemPrompt: input.context.systemPrompt,
      tools: input.context.tools,
      model: input.context.model,
      reasoningEffort: input.context.reasoningEffort,
    },
    dependencies.providerRetryLimit,
    continuityByProvider,
    { warmStartPrompt: effectiveWarmStartPrompt }
  );

  const initialRequestPrompt = failoverResult1.requestPrompt;
  const warmStartUsed = failoverResult1.warmStartUsed;
  const initialRequestWarmStartUsed = warmStartUsed;
  let phase1ProviderName = failoverResult1.providerName;
  let phase1RetryResult = failoverResult1.retryResult;
  let phase1Failures = [...failoverResult1.failures];
  let phase1UsedFailover = failoverResult1.usedFailover;
  let phase1RequestPrompt = failoverResult1.requestPrompt;
  let phase1RequestWarmStartUsed = failoverResult1.warmStartUsed;
  let response1 = phase1RetryResult.response;

  // --- Phase 2: Check for orchestrator-directed worker dispatch ---
  let { dispatches, dispatchSource } = extractDispatchesFromResponse(response1);

  if (
    dispatches.length === 0 &&
    dependencies.executeWorkerWithTask &&
    hasDispatchCapability(input.context) &&
    looksLikeNarratedDispatch(response1.text)
  ) {
    console.warn("[turn-executor] narrated worker progress without dispatch — retrying phase 1 with stricter instruction");
    const retryContinuity = { ...continuityByProvider };
    if (response1.providerSessionId) {
      retryContinuity[phase1ProviderName] = response1.providerSessionId;
    }

    const guardedFailoverResult = await generateWithFailover(
      providerChain,
      {
        prompt: effectivePrompt,
        systemPrompt: appendSystemPrompt(input.context.systemPrompt, NARRATED_DISPATCH_RETRY_SYSTEM_PROMPT),
        tools: input.context.tools,
        model: input.context.model,
        reasoningEffort: input.context.reasoningEffort,
      },
      dependencies.providerRetryLimit,
      retryContinuity,
      {}
    );

    phase1ProviderName = guardedFailoverResult.providerName;
    phase1RetryResult = {
      response: guardedFailoverResult.retryResult.response,
      attempts: phase1RetryResult.attempts + guardedFailoverResult.retryResult.attempts,
      attemptErrors: [...phase1RetryResult.attemptErrors, ...guardedFailoverResult.retryResult.attemptErrors],
    };
    phase1Failures = [...phase1Failures, ...guardedFailoverResult.failures];
    phase1UsedFailover = phase1UsedFailover || guardedFailoverResult.usedFailover;
    phase1RequestPrompt = guardedFailoverResult.requestPrompt;
    phase1RequestWarmStartUsed = guardedFailoverResult.warmStartUsed;
    response1 = guardedFailoverResult.retryResult.response;
    ({ dispatches, dispatchSource } = extractDispatchesFromResponse(response1));

    if (dispatches.length === 0 && looksLikeNarratedDispatch(response1.text)) {
      console.error("[turn-executor] repeated narrated worker progress without dispatch — suppressing fake status reply");
      return {
        responseText: "Sorry, something went wrong before I could actually start that worker task. Please try again.",
        providerName: phase1ProviderName,
        providerSessionId: response1.providerSessionId ?? retryContinuity[phase1ProviderName],
        providerUsedFailover: phase1UsedFailover,
        warmStartUsed,
        providerRequestPrompt: phase1RequestPrompt,
        providerRequestWarmStartUsed: phase1RequestWarmStartUsed,
        initialRequestPrompt,
        initialRequestWarmStartUsed,
        usedWorkerSynthesis: false,
        response: response1,
        attemptCount: phase1RetryResult.attempts,
        attemptErrors: phase1RetryResult.attemptErrors,
        providerFailures: phase1Failures,
        warmStartContextChars,
        configuredProviders: [...input.context.configuredProviderNames],
        effectiveProviders: [...input.context.providerNames],
        providerOverrideName: input.context.overrideProviderName,
        workerReport: workerReport ?? undefined,
        workerDispatchTelemetry,
        deterministicTurn,
        activeTaskResolution,
      };
    }
  }

  if (shouldPersistProviderContinuity && response1.providerSessionId) {
    dependencies.savePersistedProviderSession({
      conversationKey: input.context.conversationKey,
      sessionId: input.turn.sessionId,
      agentId: input.turn.agentId,
      providerName: phase1ProviderName,
      providerSessionId: response1.providerSessionId
    });
  }

  if (dispatches.length > 0 && dependencies.executeWorkerWithTask) {
    const workerDispatchConcurrency = Math.max(1, dependencies.workerDispatchConcurrency ?? 3);
    const dispatchConcurrencyGroups = dispatches.map((dispatch) =>
      dependencies.getWorkerDispatchConcurrencyGroup?.(dispatch)
    );
    console.log(
      `[turn-executor] orchestrator dispatching ${dispatches.length} worker task(s) ` +
      `with concurrency=${workerDispatchConcurrency}`
    );

    const dispatchTimeoutMs = dependencies.workerDispatchTimeoutMs ?? DEFAULT_WORKER_DISPATCH_TIMEOUT_MS;

    const workerResults = await runWithConcurrencyLimit(
      dispatches,
      workerDispatchConcurrency,
      async (dispatch) => {
        const concurrencyGroup = dependencies.getWorkerDispatchConcurrencyGroup?.(dispatch);
        console.log(
          `[turn-executor] worker-dispatch:start worker=${dispatch.workerId}` +
          (dispatch.taskId ? ` taskId=${dispatch.taskId}` : "") +
          (concurrencyGroup ? ` group=${concurrencyGroup}` : "")
        );
        const workerPromise = dependencies.executeWorkerWithTask!(
          dispatch.workerId,
          dispatch.task,
          input.turn,
          input.context
        );
        // Hard wall-clock cap — prevents chatty workers from blocking indefinitely
        const timeoutPromise = new Promise<never>((_, reject) => {
          const timer = setTimeout(() => {
            reject(new Error(
              `Worker ${dispatch.workerId} exceeded wall-clock timeout of ${Math.round(dispatchTimeoutMs / 1000)}s`
            ));
          }, dispatchTimeoutMs);
          timer.unref();
        });
        return Promise.race([workerPromise, timeoutPromise]);
      },
      {
        getConcurrencyGroup: (_dispatch, index) => dispatchConcurrencyGroups[index],
      }
    );

    workerDispatchTelemetry = buildWorkerDispatchTelemetry(
      dispatches,
      workerResults,
      dispatchSource === "xml" ? "xml" : "tool",
      workerDispatchConcurrency,
      dispatchConcurrencyGroups,
    );

    if (dispatches.length === 1) {
      const [result] = workerResults;
      if (result?.status === "fulfilled") {
        workerReport = result.value;
      } else if (result?.status === "rejected") {
        console.error(`[turn-executor] orchestrator-directed worker failed:`, formatWorkerDispatchReason(result.reason));
      }
    } else {
      workerReport = mergeWorkerReports(dispatches, workerResults);
    }

    // Phase 3: Send worker result back to orchestrator for synthesis
    const reportText = workerReport
      ? `${WORKER_SYNTHESIS_PREFIX}\n${formatWorkerReportForPrompt(workerReport)}`
      : "[Worker execution failed — no data returned. Explain to the user that the operation couldn't be completed and suggest they try again.]";

    console.log(`[turn-executor] synthesizing completed worker result with a fresh tool-free prompt`);

    const synthesisPrompt = buildExplicitSynthesisPrompt(effectiveUserMessage, reportText);

    let failoverResult2 = await generateWithFailover(
      providerChain,
      {
        prompt: synthesisPrompt,
        systemPrompt: appendSystemPrompt(input.context.systemPrompt, WORKER_SYNTHESIS_SYSTEM_PROMPT),
        tools: { mode: "off" },
        model: input.context.model,
        reasoningEffort: input.context.reasoningEffort,
      },
      dependencies.providerRetryLimit,
      {},
      {}
    );

    let response2 = failoverResult2.retryResult.response;
    let synthesisRetried = false;

    const strippedResponse2 = stripWorkerDispatchTags(response2.text);
    if (
      looksLikeNarratedDispatch(strippedResponse2) ||
      looksLikeIncompleteWorkerSynthesis(strippedResponse2)
    ) {
      console.warn(
        `[turn-executor] incomplete worker synthesis detected (${strippedResponse2.length}ch), retrying with stricter grounding`
      );

      const retryResult = await generateWithFailover(
        providerChain,
        {
          prompt: synthesisPrompt,
          systemPrompt: appendSystemPrompt(
            appendSystemPrompt(input.context.systemPrompt, WORKER_SYNTHESIS_SYSTEM_PROMPT),
            WORKER_SYNTHESIS_RETRY_SYSTEM_PROMPT,
          ),
          tools: { mode: "off" },
          model: input.context.model,
          reasoningEffort: input.context.reasoningEffort,
        },
        dependencies.providerRetryLimit,
        {},
        {}
      );

      failoverResult2 = retryResult;
      response2 = retryResult.retryResult.response;
      synthesisRetried = true;
      console.log(
        `[turn-executor] synthesis retry produced ${stripWorkerDispatchTags(response2.text).length}ch response`
      );
    }

    if (shouldPersistProviderContinuity && response2.providerSessionId) {
      dependencies.savePersistedProviderSession({
        conversationKey: input.context.conversationKey,
        sessionId: input.turn.sessionId,
        agentId: input.turn.agentId,
        providerName: failoverResult2.providerName,
        providerSessionId: response2.providerSessionId
      });
    }

    return {
      responseText: stripWorkerDispatchTags(response2.text),
      providerName: failoverResult2.providerName,
      providerSessionId: response2.providerSessionId,
      providerUsedFailover: phase1UsedFailover || failoverResult2.usedFailover,
      warmStartUsed,
      providerRequestPrompt: failoverResult2.requestPrompt,
      providerRequestWarmStartUsed: failoverResult2.warmStartUsed,
      initialRequestPrompt,
      initialRequestWarmStartUsed,
      usedWorkerSynthesis: true,
      synthesisRetried,
      response: response2,
      attemptCount: phase1RetryResult.attempts + failoverResult2.retryResult.attempts,
      attemptErrors: [...phase1RetryResult.attemptErrors, ...failoverResult2.retryResult.attemptErrors],
      providerFailures: [...phase1Failures, ...failoverResult2.failures],
      warmStartContextChars,
      configuredProviders: [...input.context.configuredProviderNames],
      effectiveProviders: [...input.context.providerNames],
      providerOverrideName: input.context.overrideProviderName,
      workerReport: workerReport ?? undefined,
      workerDispatchTelemetry,
      deterministicTurn,
      activeTaskResolution,
    };
  }

  // --- No dispatch: return orchestrator's response directly ---
  // Guard: if the response contains a worker-dispatch opening tag but dispatch failed
  // (strict and lenient both failed, or lenient produced empty content), do NOT return
  // raw XML to the user.
  if (response1.text.includes('<worker-dispatch')) {
    console.error(`[turn-executor] worker-dispatch tag present but parse failed — suppressing raw XML`);
      return {
        responseText: "Sorry, something went wrong processing that request. Please try again.",
        providerName: phase1ProviderName,
        providerSessionId: response1.providerSessionId ?? continuityByProvider[phase1ProviderName],
        providerUsedFailover: phase1UsedFailover,
        warmStartUsed,
        providerRequestPrompt: phase1RequestPrompt,
        providerRequestWarmStartUsed: phase1RequestWarmStartUsed,
        initialRequestPrompt,
        initialRequestWarmStartUsed,
        usedWorkerSynthesis: false,
        response: response1,
        attemptCount: phase1RetryResult.attempts,
        attemptErrors: phase1RetryResult.attemptErrors,
        providerFailures: phase1Failures,
      warmStartContextChars,
      configuredProviders: [...input.context.configuredProviderNames],
      effectiveProviders: [...input.context.providerNames],
      providerOverrideName: input.context.overrideProviderName,
      workerReport: workerReport ?? undefined,
      workerDispatchTelemetry,
      deterministicTurn,
      activeTaskResolution,
    };
  }

  return {
    responseText: stripWorkerDispatchTags(response1.text),
    providerName: phase1ProviderName,
    providerSessionId: response1.providerSessionId ?? continuityByProvider[phase1ProviderName],
    providerUsedFailover: phase1UsedFailover,
    warmStartUsed,
    providerRequestPrompt: phase1RequestPrompt,
    providerRequestWarmStartUsed: phase1RequestWarmStartUsed,
    initialRequestPrompt,
    initialRequestWarmStartUsed,
    usedWorkerSynthesis: false,
    response: response1,
    attemptCount: phase1RetryResult.attempts,
    attemptErrors: phase1RetryResult.attemptErrors,
    providerFailures: phase1Failures,
    warmStartContextChars,
    configuredProviders: [...input.context.configuredProviderNames],
    effectiveProviders: [...input.context.providerNames],
    providerOverrideName: input.context.overrideProviderName,
    workerReport: workerReport ?? undefined,
    workerDispatchTelemetry,
    deterministicTurn,
    activeTaskResolution,
  };
}

export function createDiscordVoiceTurnExecutor(
  dependencies: DiscordTurnExecutionDependencies,
  resolveContext: DiscordTurnContextResolver
): DiscordVoiceTurnExecutor {
  return {
    async executeTurn(turn: VoiceTurnInput): Promise<VoiceTurnResult> {
      const context = await resolveContext(turn);
      return executeDiscordTurn(dependencies, { turn, context });
    },
    async executeTurnDetailed(
      turn: VoiceTurnInput,
      context: DiscordTurnExecutionContext
    ): Promise<DiscordTurnExecutionResult> {
      return executeDiscordTurn(dependencies, { turn, context });
    }
  };
}
