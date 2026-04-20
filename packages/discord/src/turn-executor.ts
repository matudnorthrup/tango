import type {
  ActiveTaskRecord,
  CapabilityRegistry,
  ChatProvider,
  DeterministicTurnRecord,
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
  type DeterministicIntentClassification,
  type IntentClassifierContinuationContext,
  type IntentEnvelope,
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
    allowDirectStepExecution?: boolean;
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
const CONVERSATIONAL_FOLLOW_UP_SYSTEM_PROMPT = [
  "This user turn is a conversational follow-up, correction, planning question, or feedback about the current discussion.",
  "Answer directly from the conversation context and prior turns.",
  "Do not call tools or workers in this step.",
  "If the user is correcting the prior answer, acknowledge the correction and answer the revised request.",
  "If the user is asking for next steps or implementation guidance, give the concrete steps instead of re-running the previous workflow.",
].join(" ");
const CONVERSATIONAL_FOLLOW_UP_RETRY_SYSTEM_PROMPT = [
  "Do not emit worker-dispatch tags, tool markup, or internal progress narration.",
  "Answer the user directly in plain text right now.",
  "Use only the existing conversation context in this turn.",
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
  getLatestDeterministicTurnForConversation?: (conversationKey: string) => DeterministicTurnRecord | null;
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
  contextConfusionDetected?: boolean;
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

const RECENT_INTENT_REUSE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const GENERIC_CONTINUATION_PATTERN =
  /^(?:yes|yeah|yep|yup|sure|ok(?:ay)?|please do|go ahead|do that|try again|retry|running again|run it again|continue|go for it|proceed|same|same thing|same flow|use this|use this one|use this tab|here|here you go|this one)\b/iu;
const GENERIC_DEICTIC_PATTERN =
  /\b(?:that|it|this|same|again|the one|this tab|this doc|same flow|same meal)\b/iu;
const CONTINUATION_NUMBER_WORD_VALUES: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};
const DOCS_CONTINUATION_PATTERN =
  /docs\.google\.com\/document\/d\/|\b(?:doc|docs|tab|section|headline|copy|replace|rewrite|edit|update|write)\b/iu;
const NUTRITION_LOG_FOOD_CONTINUATION_PATTERN =
  /\b(?:breakfast|lunch|dinner|snack|meal|food|foods|log|track|calories?|protein|carbs?|fat|grams?|oz|tbsp|tsp|cup|cups|serving|portion)\b/iu;
const EXPLICIT_NUTRITION_WRITE_CONTINUATION_PATTERN =
  /\b(?:add(?:ing)?|log(?:ging)?|track(?:ing)?|record(?:ing)?|enter(?:ing)?)\b/iu;
const NUTRITION_REPAIR_STYLE_PATTERN =
  /\b(?:re-?add|wrong|clear(?:ed)?|fix|repair|correct(?:ion)?)\b/iu;
const NUTRITION_LOG_RECIPE_CONTINUATION_PATTERN =
  /\b(?:recipe|ingredients?|instructions?|notes?|servings?|portion|double|halve|scale|update|edit|rewrite|change)\b/iu;
const NUTRITION_CHECK_BUDGET_CONTINUATION_PATTERN =
  /\b(?:calories?|protein|carbs?|fat|fiber|budget|remaining|left|today|tonight|room)\b/iu;
const NUTRITION_DAY_SUMMARY_CONTINUATION_PATTERN =
  /\b(?:calories?\s+so\s+far|macros?\s+so\s+far|what\s+(?:have\s+i|i(?:'ve| have))\s+eaten|what(?:'s| is)\s+my\s+(?:calories|macros?|total)|today'?s\s+(?:calories|macros?|total)|day\s+summary|summari[sz]e)\b/iu;
const ADDITIONAL_REQUEST_PATTERN =
  /\b(?:and|then|also)\s+tell\s+me\b|\band\s+what(?:'s| is)\b|\band\s+how\b/iu;
const CROSS_DOMAIN_REUSE_BLOCKERS = /\b(?:recipe|doc|docs|file|email|calendar|reimbursement|walmart|amazon|slack)\b/iu;
const PURE_ACKNOWLEDGEMENT_PATTERN =
  /^(?:ok(?:ay)?|thanks|thank you)[.!]*$/iu;
const CONTINUATION_NOISE_TOKENS = new Set([
  "add",
  "again",
  "ahead",
  "and",
  "back",
  "breakfast",
  "brought",
  "bowl",
  "can",
  "clear",
  "cleared",
  "correct",
  "correction",
  "dinner",
  "entry",
  "finish",
  "fix",
  "food",
  "for",
  "grams",
  "had",
  "i",
  "it",
  "ive",
  "just",
  "log",
  "lunch",
  "meal",
  "move",
  "moved",
  "my",
  "of",
  "okay",
  "ok",
  "please",
  "protein",
  "re",
  "readd",
  "readds",
  "relog",
  "relogged",
  "same",
  "snack",
  "that",
  "the",
  "this",
  "today",
  "track",
  "instead",
  "wrong",
  "yeah",
  "yogurt",
]);

function normalizeWhitespace(text: string): string {
  return text.trim().replace(/\s+/gu, " ");
}

type ConversationalTurnBypassKind =
  | "correction"
  | "planning"
  | "meta"
  | "feedback"
  | "follow_up";

interface ConversationalTurnBypassDecision {
  kind: ConversationalTurnBypassKind;
  reason: string;
}

function detectConversationalTurnBypass(input: {
  userMessage: string;
  activeTaskResolution: ActiveTaskContinuationResolution;
}): ConversationalTurnBypassDecision | null {
  if (input.activeTaskResolution.kind !== "none") {
    return null;
  }

  const normalized = normalizeWhitespace(input.userMessage);
  if (!normalized) {
    return null;
  }

  if (PURE_ACKNOWLEDGEMENT_PATTERN.test(normalized)) {
    return {
      kind: "feedback",
      reason: "pure acknowledgement should stay on the conversational LLM path",
    };
  }

  return null;
}

function extractNutritionContinuationTokens(text: string): string[] {
  return normalizeWhitespace(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) =>
      token.length >= 3
      && !CONTINUATION_NOISE_TOKENS.has(token)
      && !CONTINUATION_NUMBER_WORD_VALUES[token]
      && !["cup", "cups", "tbsp", "tsp", "serving", "portion", "meal"].includes(token),
    );
}

function extractPriorNutritionItemText(priorEntities: Record<string, unknown>): string {
  const items = priorEntities["items"];
  if (Array.isArray(items)) {
    return items
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        if (item && typeof item === "object" && !Array.isArray(item)) {
          const record = item as Record<string, unknown>;
          return (
            (typeof record["description"] === "string" ? record["description"] : "")
            || (typeof record["name"] === "string" ? record["name"] : "")
            || (typeof record["item"] === "string" ? record["item"] : "")
          );
        }
        return "";
      })
      .filter((value) => value.trim().length > 0)
      .join(" ");
  }
  if (typeof priorEntities["recipe_query"] === "string") {
    return String(priorEntities["recipe_query"]);
  }
  return "";
}

function messageIntroducesDifferentNutritionContent(
  priorEntities: Record<string, unknown>,
  userMessage: string,
): boolean {
  const priorText = extractPriorNutritionItemText(priorEntities);
  if (!priorText) {
    return false;
  }

  const priorTokens = new Set(extractNutritionContinuationTokens(priorText));
  if (priorTokens.size === 0) {
    return false;
  }

  const currentTokens = extractNutritionContinuationTokens(userMessage);
  if (currentTokens.length === 0) {
    return false;
  }

  return !currentTokens.some((token) => priorTokens.has(token));
}

function parseIsoTimestampMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function extractSingleGoogleDocReference(text: string): string | null {
  const matches = [...text.matchAll(/https?:\/\/docs\.google\.com\/document\/d\/[A-Za-z0-9_-]+[^\s)"]*/giu)]
    .map((match) => match[0]?.trim())
    .filter((value): value is string => Boolean(value));
  return matches.length === 1 ? matches[0] ?? null : null;
}

function extractMealEntity(text: string): string | null {
  const normalized = text.toLowerCase();
  if (/\bbreakfast\b/u.test(normalized)) return "breakfast";
  if (/\blunch\b/u.test(normalized)) return "lunch";
  if (/\bdinner\b/u.test(normalized)) return "dinner";
  if (/\bsnack\b/u.test(normalized)) return "other";
  return null;
}

function parseIntentEnvelopeArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item),
  );
}

function parseIntentEnvelopeRecord(
  value: Record<string, unknown>,
): IntentEnvelope | null {
  const intentId = typeof value.intentId === "string" ? value.intentId : null;
  if (!intentId) {
    return null;
  }
  const mode =
    value.mode === "read" || value.mode === "write" || value.mode === "mixed"
      ? value.mode
      : "read";
  const entities =
    value.entities && typeof value.entities === "object" && !Array.isArray(value.entities)
      ? { ...(value.entities as Record<string, unknown>) }
      : {};
  const rawEntities = Array.isArray(value.rawEntities)
    ? value.rawEntities.map((item) => (typeof item === "string" ? item.trim() : "")).filter((item) => item.length > 0)
    : [];
  const missingSlots = Array.isArray(value.missingSlots)
    ? value.missingSlots.map((item) => (typeof item === "string" ? item.trim() : "")).filter((item) => item.length > 0)
    : [];
  const routeHint: IntentEnvelope["routeHint"] =
    value.routeHint && typeof value.routeHint === "object" && !Array.isArray(value.routeHint)
      ? (() => {
          const record = value.routeHint as Record<string, unknown>;
          const kind =
            record.kind === "workflow"
              ? "workflow"
              : record.kind === "worker"
                ? "worker"
                : null;
          if (
            kind
            && typeof record.targetId === "string"
            && record.targetId.trim().length > 0
          ) {
            return {
              kind,
              targetId: record.targetId.trim(),
            };
          }
          return undefined;
        })()
      : undefined;

  return {
    id: typeof value.id === "string" && value.id.trim().length > 0 ? value.id.trim() : "intent-1",
    domain: typeof value.domain === "string" && value.domain.trim().length > 0 ? value.domain.trim() : "unknown",
    intentId,
    mode,
    confidence: typeof value.confidence === "number" ? value.confidence : 1,
    entities,
    rawEntities,
    missingSlots,
    canRunInParallel: typeof value.canRunInParallel === "boolean" ? value.canRunInParallel : true,
    routeHint,
  };
}

function isLikelyContinuationForIntent(
  intentId: string,
  userMessage: string,
  priorEntities: Record<string, unknown> = {},
): boolean {
  const normalized = normalizeWhitespace(userMessage);
  if (!normalized) {
    return false;
  }
  const genericFollowUp =
    GENERIC_CONTINUATION_PATTERN.test(normalized)
    || GENERIC_DEICTIC_PATTERN.test(normalized)
    || (normalized.length <= 96 && !normalized.includes("?"));
  if (!genericFollowUp) {
    return false;
  }
  if (intentId === "docs.google_doc_read_or_update") {
    return DOCS_CONTINUATION_PATTERN.test(normalized) || extractSingleGoogleDocReference(normalized) !== null;
  }
  if (intentId === "nutrition.log_food") {
    if (/\brecipe\b/iu.test(normalized) && /\b(?:update|edit|rewrite|change)\b/iu.test(normalized)) {
      return false;
    }
    if (messageIntroducesDifferentNutritionContent(priorEntities, userMessage)) {
      if (
        !EXPLICIT_NUTRITION_WRITE_CONTINUATION_PATTERN.test(normalized)
        || NUTRITION_REPAIR_STYLE_PATTERN.test(normalized)
      ) {
        return false;
      }
    }
    if (NUTRITION_DAY_SUMMARY_CONTINUATION_PATTERN.test(normalized)) {
      return false;
    }
    if (NUTRITION_CHECK_BUDGET_CONTINUATION_PATTERN.test(normalized) && ADDITIONAL_REQUEST_PATTERN.test(normalized)) {
      return false;
    }
    return NUTRITION_LOG_FOOD_CONTINUATION_PATTERN.test(normalized) || (genericFollowUp && !CROSS_DOMAIN_REUSE_BLOCKERS.test(normalized));
  }
  if (intentId === "nutrition.log_recipe") {
    return NUTRITION_LOG_RECIPE_CONTINUATION_PATTERN.test(normalized) || (genericFollowUp && !CROSS_DOMAIN_REUSE_BLOCKERS.test(normalized));
  }
  if (intentId === "nutrition.check_budget") {
    return NUTRITION_CHECK_BUDGET_CONTINUATION_PATTERN.test(normalized) || (genericFollowUp && !CROSS_DOMAIN_REUSE_BLOCKERS.test(normalized));
  }
  return false;
}

function mergeContinuationEntities(
  intentId: string,
  priorEntities: Record<string, unknown>,
  userMessage: string,
): Record<string, unknown> {
  const merged = { ...priorEntities };
  if (intentId === "docs.google_doc_read_or_update") {
    const docReference = extractSingleGoogleDocReference(userMessage);
    if (docReference) {
      merged.doc_query = docReference;
    }
  }
  if (intentId === "nutrition.log_food" || intentId === "nutrition.log_recipe") {
    const meal = extractMealEntity(userMessage);
    if (meal) {
      merged.meal = meal;
    }
  }
  return merged;
}

function buildRecentDeterministicContinuationObjective(
  priorEnvelope: IntentEnvelope,
): string {
  const base = [
    `The most recent deterministic turn in this conversation used intent ${priorEnvelope.intentId}.`,
    "Continue that same action only if the current user message is clearly asking to keep going with it.",
  ].join(" ");

  if (priorEnvelope.intentId === "nutrition.log_food") {
    return [
      base,
      "Short follow-up requests that explicitly ask to add or log food are still nutrition.log_food even when phrased as a question or when the food item changes.",
      "Only mark the turn conversational when the user is discussing the assistant reply or asking a meta question instead of asking to log food.",
    ].join(" ");
  }

  return base;
}

function buildRecentDeterministicContinuationContext(input: {
  latestTurn: DeterministicTurnRecord | null;
  userMessage: string;
}): IntentClassifierContinuationContext | undefined {
  const latestTurn = input.latestTurn;
  if (!latestTurn) {
    return undefined;
  }
  if (latestTurn.routeOutcome !== "executed" && latestTurn.routeOutcome !== "clarification") {
    return undefined;
  }
  const createdAtMs = parseIsoTimestampMs(latestTurn.createdAt);
  if (!createdAtMs || Date.now() - createdAtMs > RECENT_INTENT_REUSE_MAX_AGE_MS) {
    return undefined;
  }
  const envelopes = parseIntentEnvelopeArray(latestTurn.intentJson)
    .map((envelope) => parseIntentEnvelopeRecord(envelope))
    .filter((envelope): envelope is NonNullable<typeof envelope> => Boolean(envelope));
  if (envelopes.length !== 1) {
    return undefined;
  }
  const priorEnvelope = envelopes[0];
  if (!priorEnvelope) {
    return undefined;
  }
  if (!isLikelyContinuationForIntent(priorEnvelope.intentId, input.userMessage, priorEnvelope.entities)) {
    return undefined;
  }

  return {
    title: `Continue recent deterministic intent ${priorEnvelope.intentId}`,
    objective: buildRecentDeterministicContinuationObjective(priorEnvelope),
    expectedIntentIds: [priorEnvelope.intentId],
    structuredContext: {
      priorIntentId: priorEnvelope.intentId,
      priorMode: priorEnvelope.mode,
      priorEntities: priorEnvelope.entities,
      priorRawEntities: priorEnvelope.rawEntities,
      priorMissingSlots: priorEnvelope.missingSlots,
      mergedContinuationEntities: mergeContinuationEntities(
        priorEnvelope.intentId,
        priorEnvelope.entities,
        input.userMessage,
      ),
      continuationSignals:
        priorEnvelope.intentId === "nutrition.log_food"
          ? {
              explicitWriteCommand:
                EXPLICIT_NUTRITION_WRITE_CONTINUATION_PATTERN.test(normalizeWhitespace(input.userMessage)),
              changedNutritionContent:
                messageIntroducesDifferentNutritionContent(priorEnvelope.entities, input.userMessage),
            }
          : undefined,
    },
  };
}

function hasDispatchCapability(tools: ProviderToolsConfig | undefined): boolean {
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
    conversationMode: "none",
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

function mergeClassificationAttempts(
  first: DeterministicIntentClassification,
  second: DeterministicIntentClassification,
): DeterministicIntentClassification {
  return {
    ...second,
    usedFailover: first.usedFailover || second.usedFailover,
    attemptCount: first.attemptCount + second.attemptCount,
    attemptErrors: [...first.attemptErrors, ...second.attemptErrors],
    failures: [...first.failures, ...second.failures],
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
    /\b(?:let me|i(?:'ll| will)|i(?:'m| am))\s+(?:grab|fetch|pull|dig into|dispatch|route|hand off)\b/i,
    /\b(?:grabbing|fetching|pulling|dispatching|handing off)\b/i,
    /\brouting\b.{0,24}\b(?:worker|tool|agent|task|request)\b/i,
    /\b(?:calling|using|dispatching)\s+(?:a|the)\s+worker\b/i,
    /\b(?:worker|tool call|dispatch)\b.{0,40}\b(?:cancel(?:ed|led)|timed out|failed|never came back|didn't return|did not return)\b/i,
    /\b(?:couldn't|could not|can't|cannot)\s+(?:confirm|claim|say)\b.{0,80}\b(?:logged|saved|made it into|in the diary|went through)\b/i,
  ];

  return patterns.some((pattern) => pattern.test(normalized));
}

function looksLikeContextConfusion(text: string): boolean {
  const normalized = text.trim();
  if (normalized.length === 0) {
    return false;
  }

  const patterns = [
    /\breply in context\b/i,
    /\bneed(?:s)?\s+(?:to\s+)?(?:see|have|access)\s+(?:the\s+)?(?:conversation|context|thread|prior)\b/i,
    /\bdon'?t\s+have\s+(?:the\s+)?(?:context|conversation|thread)\b/i,
    /\bwithout\s+(?:the\s+)?(?:context|conversation|prior\s+turns)\b/i,
    /\bcan'?t\s+(?:answer|respond|reply)\s+(?:without|from)\b/i,
    /\bno\s+(?:conversation\s+)?context\s+(?:available|to\s+work)\b/i,
    /\bneed(?:s)?\s+(?:the\s+)?conversation\s+context\b/i,
    /\banswer\b.{0,20}\b(?:directly\s+)?from\s+(?:the\s+)?(?:current\s+)?(?:conversation|context)\b/i,
    /\bneed to answer\b.{0,30}\bconversation context\b/i,
    /\bnot start another worker task\b/i,
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

function noReceiptHasConfirmedWrite(receipts: readonly ExecutionReceipt[]): boolean {
  return !receipts.some((r) => receiptHasConfirmedWriteOutcome(r));
}

function guardDeterministicNarrationText(
  text: string,
  receipts: readonly ExecutionReceipt[],
): string {
  const stripped = stripWorkerDispatchTags(text);

  if (text.includes("<worker-dispatch")) {
    return receipts.some(receiptExpectsWriteButHasNoConfirmedWrite)
      ? buildDeterministicWriteGuardReply(receipts)
      : stripped;
  }

  if (
    (
      looksLikeNarratedDispatch(stripped)
      || looksLikeIncompleteWorkerSynthesis(stripped)
    )
    && noReceiptHasConfirmedWrite(receipts)
  ) {
    return receipts.some(receiptExpectsWriteButHasNoConfirmedWrite)
      ? buildDeterministicWriteGuardReply(receipts)
      : "Sorry, something went wrong before I could finish that step. Please try again.";
  }

  // Only block "looks like success" narrations when NO receipt confirmed a write.
  // When multiple steps run (e.g. nutrition-logger rejects + workout-recorder succeeds),
  // the misdirected step's missing write should not override the successful one.
  if (
    noReceiptHasConfirmedWrite(receipts)
    && looksLikeDeterministicWriteSuccess(stripped)
  ) {
    return buildDeterministicWriteGuardReply(receipts);
  }
  return stripped;
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
  let conversationalTurnBypass = detectConversationalTurnBypass({
    userMessage: input.turn.transcript,
    activeTaskResolution,
  });
  if (conversationalTurnBypass) {
    console.log(
      `[turn-executor] bypassing deterministic routing for ${conversationalTurnBypass.kind}: ${conversationalTurnBypass.reason}`,
    );
  }
  const deterministicConversationContext = extractRecentMessagesContext(effectiveWarmStartPrompt, {
    maxLines: 8,
    maxChars: 800,
  });
  let deterministicTurn: DiscordTurnExecutionResult["deterministicTurn"];

  if (isDeterministicEligible(input.context) && !conversationalTurnBypass) {
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
        const recentDeterministicContinuation =
          explicitIntentIds.length === 0 && activeTaskResolution.kind === "none"
            ? buildRecentDeterministicContinuationContext({
                latestTurn: dependencies.getLatestDeterministicTurnForConversation?.(input.context.conversationKey) ?? null,
                userMessage: input.turn.transcript,
              })
            : undefined;
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
                    : recentDeterministicContinuation,
                conversationContext: deterministicConversationContext ?? undefined,
              });
        let effectiveClassification = classification;

        if (
          !conversationalTurnBypass &&
          recentDeterministicContinuation &&
          !effectiveClassification.meetsThreshold &&
          effectiveClassification.envelopes.length === 0 &&
          recentDeterministicContinuation.expectedIntentIds.length === 1
        ) {
          const narrowedIntentId = recentDeterministicContinuation.expectedIntentIds[0];
          const narrowedCatalog = intentCatalog.filter((entry) => entry.id === narrowedIntentId);
          if (narrowedCatalog.length === 1) {
            const retriedClassification = await classifyDeterministicIntents({
              userMessage: effectiveUserMessage,
              catalog: narrowedCatalog,
              providerChain: classifierProviderChain,
              retryLimit: dependencies.providerRetryLimit,
              confidenceThreshold: deterministicConfig.confidenceThreshold,
              model: deterministicConfig.model,
              reasoningEffort: deterministicConfig.reasoningEffort,
              continuation: recentDeterministicContinuation,
              conversationContext: deterministicConversationContext ?? undefined,
            });
            if (retriedClassification.meetsThreshold) {
              console.log(
                `[turn-executor] recovered deterministic continuation via narrowed classifier retry: ${narrowedIntentId}`,
              );
              effectiveClassification = mergeClassificationAttempts(
                effectiveClassification,
                retriedClassification,
              );
            }
          }
        }

        const intentLatencyMs = Date.now() - classificationStartedAt;

        if (
          !conversationalTurnBypass &&
          effectiveClassification.conversationMode === "follow_up" &&
          effectiveClassification.envelopes.length === 0
        ) {
          conversationalTurnBypass = {
            kind: "follow_up",
            reason: "intent classifier marked the turn as a conversational follow-up",
          };
          console.log(
            `[turn-executor] classifier marked turn conversational: ${conversationalTurnBypass.reason}`,
          );
        }

        if (effectiveClassification.meetsThreshold && !conversationalTurnBypass) {
          const routingStartedAt = Date.now();
          const routingResult = buildDeterministicExecutionPlan({
            userMessage: effectiveUserMessage,
            envelopes: effectiveClassification.envelopes,
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
                envelopes: effectiveClassification.envelopes,
                classifierProvider: effectiveClassification.providerName,
                classifierModel: effectiveClassification.response.metadata?.model,
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
                intents: effectiveClassification.envelopes,
                finalReply: clarificationFailoverResult.retryResult.response.text,
              }),
              classifier: effectiveClassification,
              receipts: [],
            };

            return {
              responseText: clarificationFailoverResult.retryResult.response.text,
              providerName: clarificationFailoverResult.providerName,
              providerSessionId: clarificationFailoverResult.retryResult.response.providerSessionId,
              providerUsedFailover: effectiveClassification.usedFailover || clarificationFailoverResult.usedFailover,
              warmStartUsed: clarificationFailoverResult.warmStartUsed,
              providerRequestPrompt: clarificationFailoverResult.requestPrompt,
              providerRequestWarmStartUsed: clarificationFailoverResult.warmStartUsed,
              initialRequestPrompt: clarificationFailoverResult.requestPrompt,
              initialRequestWarmStartUsed: clarificationFailoverResult.warmStartUsed,
              usedWorkerSynthesis: false,
              response: clarificationFailoverResult.retryResult.response,
              attemptCount: effectiveClassification.attemptCount + clarificationFailoverResult.retryResult.attempts,
              attemptErrors: [
                ...effectiveClassification.attemptErrors,
                ...clarificationFailoverResult.retryResult.attemptErrors,
              ],
              providerFailures: [...effectiveClassification.failures, ...clarificationFailoverResult.failures],
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
              tryExecuteDirectStep: deterministicConfig.allowDirectStepExecution === false
                ? async () => null
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
            const guardedNarrationText = guardDeterministicNarrationText(
              narrationFailoverResult.retryResult.response.text,
              receipts,
            );

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
                  envelopes: effectiveClassification.envelopes,
                  classifierProvider: effectiveClassification.providerName,
                  classifierModel: effectiveClassification.response.metadata?.model,
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
              classifier: effectiveClassification,
              receipts,
            };

            return {
              responseText: guardedNarrationText,
              providerName: narrationFailoverResult.providerName,
              providerSessionId: narrationFailoverResult.retryResult.response.providerSessionId,
              providerUsedFailover: effectiveClassification.usedFailover || narrationFailoverResult.usedFailover,
              warmStartUsed: narrationFailoverResult.warmStartUsed,
              providerRequestPrompt: narrationFailoverResult.requestPrompt,
              providerRequestWarmStartUsed: narrationFailoverResult.warmStartUsed,
              initialRequestPrompt: narrationFailoverResult.requestPrompt,
              initialRequestWarmStartUsed: narrationFailoverResult.warmStartUsed,
              usedWorkerSynthesis: false,
              response: narrationFailoverResult.retryResult.response,
              attemptCount: effectiveClassification.attemptCount + narrationFailoverResult.retryResult.attempts,
              attemptErrors: [
                ...effectiveClassification.attemptErrors,
                ...narrationFailoverResult.retryResult.attemptErrors,
              ],
              providerFailures: [...effectiveClassification.failures, ...narrationFailoverResult.failures],
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
              envelopes: effectiveClassification.envelopes,
              classifierProvider: effectiveClassification.providerName,
              classifierModel: effectiveClassification.response.metadata?.model,
              classifierLatencyMs: intentLatencyMs,
            },
            routing: {
              plan: undefined,
              clarificationNeeded: false,
              routeOutcome: "fallback",
              routeLatencyMs: undefined,
              fallbackReason:
                effectiveClassification.conversationMode === "follow_up" &&
                effectiveClassification.envelopes.length === 0
                ? "Intent classifier marked this turn as conversational."
                : effectiveClassification.meetsThreshold
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
            intents: effectiveClassification.envelopes,
          }),
          classifier: effectiveClassification,
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
  if (!conversationalTurnBypass && dependencies.executeWorker) {
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
  let phase1SystemPrompt = conversationalTurnBypass
    ? appendSystemPrompt(input.context.systemPrompt, CONVERSATIONAL_FOLLOW_UP_SYSTEM_PROMPT)
    : input.context.systemPrompt;
  let phase1Tools = conversationalTurnBypass ? { mode: "off" as const } : input.context.tools;
  const failoverResult1 = await generateWithFailover(
    providerChain,
    {
      prompt: effectivePrompt,
      systemPrompt: phase1SystemPrompt,
      tools: phase1Tools,
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
  let contextConfusionDetected = false;

  // --- Phase 2: Check for orchestrator-directed worker dispatch ---
  let { dispatches, dispatchSource } = extractDispatchesFromResponse(response1);

  if (conversationalTurnBypass && (dispatches.length > 0 || looksLikeNarratedDispatch(response1.text))) {
    console.warn(
      "[turn-executor] conversational follow-up attempted worker dispatch or progress narration — retrying for a direct answer",
    );
    const directRetryResult = await generateWithFailover(
      providerChain,
      {
        prompt: effectivePrompt,
        systemPrompt: appendSystemPrompt(
          phase1SystemPrompt,
          CONVERSATIONAL_FOLLOW_UP_RETRY_SYSTEM_PROMPT,
        ),
        tools: { mode: "off" },
        model: input.context.model,
        reasoningEffort: input.context.reasoningEffort,
      },
      dependencies.providerRetryLimit,
      {},
      { warmStartPrompt: effectiveWarmStartPrompt }
    );

    phase1ProviderName = directRetryResult.providerName;
    phase1RetryResult = {
      response: directRetryResult.retryResult.response,
      attempts: phase1RetryResult.attempts + directRetryResult.retryResult.attempts,
      attemptErrors: [...phase1RetryResult.attemptErrors, ...directRetryResult.retryResult.attemptErrors],
    };
    phase1Failures = [...phase1Failures, ...directRetryResult.failures];
    phase1UsedFailover = phase1UsedFailover || directRetryResult.usedFailover;
    phase1RequestPrompt = directRetryResult.requestPrompt;
    phase1RequestWarmStartUsed = directRetryResult.warmStartUsed;
    response1 = directRetryResult.retryResult.response;
    ({ dispatches, dispatchSource } = extractDispatchesFromResponse(response1));

    if (dispatches.length > 0 || looksLikeNarratedDispatch(response1.text)) {
      const strippedResponse = stripWorkerDispatchTags(response1.text);
      if (!strippedResponse || looksLikeNarratedDispatch(strippedResponse)) {
        // Both attempts with tools disabled produced dispatch/narration.
        // The LLM clearly needs tools to answer this turn. Retry with
        // original system prompt and tools re-enabled as an escape hatch.
        console.warn(
          "[turn-executor] conversational follow-up suppression triggered — retrying with tools re-enabled",
        );
        phase1SystemPrompt = input.context.systemPrompt;
        phase1Tools = input.context.tools;
        contextConfusionDetected = true;
        const escapeRetryResult = await generateWithFailover(
          providerChain,
          {
            prompt: effectivePrompt,
            systemPrompt: phase1SystemPrompt,
            tools: phase1Tools,
            model: input.context.model,
            reasoningEffort: input.context.reasoningEffort,
          },
          dependencies.providerRetryLimit,
          {},
          { warmStartPrompt: effectiveWarmStartPrompt }
        );

        phase1ProviderName = escapeRetryResult.providerName;
        phase1RetryResult = {
          response: escapeRetryResult.retryResult.response,
          attempts: phase1RetryResult.attempts + escapeRetryResult.retryResult.attempts,
          attemptErrors: [...phase1RetryResult.attemptErrors, ...escapeRetryResult.retryResult.attemptErrors],
        };
        phase1Failures = [...phase1Failures, ...escapeRetryResult.failures];
        phase1UsedFailover = phase1UsedFailover || escapeRetryResult.usedFailover;
        phase1RequestPrompt = escapeRetryResult.requestPrompt;
        phase1RequestWarmStartUsed = escapeRetryResult.warmStartUsed;
        response1 = escapeRetryResult.retryResult.response;
        ({ dispatches, dispatchSource } = extractDispatchesFromResponse(response1));
      } else {
        response1 = {
          ...response1,
          text: strippedResponse,
        };
      }
      if (dispatches.length > 0) {
        dispatches = [];
        dispatchSource = "none";
      }
    }
  }

  // Phase 1: Detect context-confusion responses on conversational bypass path.
  // When the LLM says it "needs context" or "can't reply without context", the provider
  // session is stale and warm-start was skipped. Retry with empty continuity (forces
  // warm-start) and tools re-enabled so the LLM can actually do work.
  if (conversationalTurnBypass && looksLikeContextConfusion(response1.text)) {
    console.warn(
      "[turn-executor] conversational follow-up produced context-confusion response — retrying with warm-start and tools enabled",
    );
    phase1SystemPrompt = input.context.systemPrompt;
    phase1Tools = input.context.tools;
    contextConfusionDetected = true;
    const contextRetryResult = await generateWithFailover(
      providerChain,
      {
        prompt: effectivePrompt,
        systemPrompt: phase1SystemPrompt,
        tools: phase1Tools,
        model: input.context.model,
        reasoningEffort: input.context.reasoningEffort,
      },
      dependencies.providerRetryLimit,
      {},
      { warmStartPrompt: effectiveWarmStartPrompt }
    );

    phase1ProviderName = contextRetryResult.providerName;
    phase1RetryResult = {
      response: contextRetryResult.retryResult.response,
      attempts: phase1RetryResult.attempts + contextRetryResult.retryResult.attempts,
      attemptErrors: [...phase1RetryResult.attemptErrors, ...contextRetryResult.retryResult.attemptErrors],
    };
    phase1Failures = [...phase1Failures, ...contextRetryResult.failures];
    phase1UsedFailover = phase1UsedFailover || contextRetryResult.usedFailover;
    phase1RequestPrompt = contextRetryResult.requestPrompt;
    phase1RequestWarmStartUsed = contextRetryResult.warmStartUsed;
    response1 = contextRetryResult.retryResult.response;
    ({ dispatches, dispatchSource } = extractDispatchesFromResponse(response1));
  }

  if (
    dispatches.length === 0 &&
    dependencies.executeWorkerWithTask &&
    hasDispatchCapability(phase1Tools) &&
    looksLikeNarratedDispatch(response1.text)
  ) {
    console.warn("[turn-executor] narrated worker progress without dispatch — retrying phase 1 with stricter instruction");
    const guardedFailoverResult = await generateWithFailover(
      providerChain,
      {
        prompt: effectivePrompt,
        systemPrompt: appendSystemPrompt(phase1SystemPrompt, NARRATED_DISPATCH_RETRY_SYSTEM_PROMPT),
        tools: phase1Tools,
        model: input.context.model,
        reasoningEffort: input.context.reasoningEffort,
      },
      dependencies.providerRetryLimit,
      {},
      { warmStartPrompt: effectiveWarmStartPrompt }
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
        providerSessionId: response1.providerSessionId,
        providerUsedFailover: phase1UsedFailover,
        warmStartUsed,
        providerRequestPrompt: phase1RequestPrompt,
        providerRequestWarmStartUsed: phase1RequestWarmStartUsed,
        initialRequestPrompt,
        initialRequestWarmStartUsed,
        usedWorkerSynthesis: false,
        contextConfusionDetected: contextConfusionDetected || undefined,
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
      contextConfusionDetected: contextConfusionDetected || undefined,
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
        contextConfusionDetected: contextConfusionDetected || undefined,
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
    contextConfusionDetected: contextConfusionDetected || undefined,
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

export const __testOnly = {
  detectConversationalTurnBypass,
  isLikelyContinuationForIntent,
  looksLikeNarratedDispatch,
  looksLikeIncompleteWorkerSynthesis,
  guardDeterministicNarrationText,
};
