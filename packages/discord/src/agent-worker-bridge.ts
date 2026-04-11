/**
 * Agent Worker Bridge — Converts WorkerAgentResult to WorkerReport.
 *
 * This bridges the gap between the LLM-powered worker agent output
 * (text + toolCalls) and the existing WorkerReport format that the
 * turn executor expects.
 */

import {
  runWorkerAgent,
  assembleAgentPrompt,
  buildRuntimePathEnv,
  resolveDatabasePath,
} from "@tango/core";
import type {
  AgentToolCall,
  ChatProvider,
  WorkerAgentResult,
  McpServerEntry,
  ProviderMcpServerConfig,
  ProviderReasoningEffort,
  ProviderToolCall,
  ProviderToolsConfig,
} from "@tango/core";
import type { WorkerReport, WorkerReportOperation } from "./worker-report.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getBrowserManager } from "./browser-manager.js";
import { tryExecuteDeterministicWorkerFastPath } from "./deterministic-worker-fast-path.js";
import { generateWithFailover } from "./provider-failover.js";
import { summarizePreferences } from "./walmart-cart-processor.js";
import {
  analyzeHistory,
  findLikelyHistoryMatches,
  parseReceipts,
} from "./walmart-history-parser.js";
import { callFatsecretApi, callRecipeWrite } from "./wellness-agent-tools.js";
import type { WellnessToolPaths } from "./wellness-agent-tools.js";

const FATSECRET_WRITE_METHODS = new Set([
  "food_entry_create",
  "food_entry_edit",
  "food_entry_delete",
]);
const HTTP_WRITE_METHODS = new Set(["PUT", "POST", "PATCH", "DELETE"]);
const NUMBER_WORD_VALUES: Record<string, number> = {
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

function isReadOnlyWorkerStep(task: string): boolean {
  return /\bREAD-ONLY step:/u.test(task);
}

function isReadOnlySql(value: unknown): boolean {
  if (typeof value !== "string") {
    return true;
  }
  const normalized = value.trim();
  if (!normalized) {
    return true;
  }
  return /^(select|with|pragma|explain)\b/i.test(normalized);
}

function browserActionLooksMutating(action: string): boolean {
  return ["click", "fill", "type", "press", "select", "eval"].includes(action);
}

function gogEmailCommandLooksMutating(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  return /^gmail\s+thread\s+modify\b/.test(normalized)
    || /^gmail\s+message\s+modify\b/.test(normalized)
    || /^gmail\s+drafts?\s+(create|update|delete)\b/.test(normalized)
    || /^gmail\s+send\b/.test(normalized);
}

function gogDocsCommandLooksMutating(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  if (!normalized || normalized.includes("--help") || /\shelp$/u.test(normalized)) {
    return false;
  }

  return /^docs\s+(create|copy|write|insert|rename|delete|share|edit|sed|update|clear|find-replace)\b/u.test(normalized)
    || /^docs\s+comments\s+(create|add|reply|resolve|delete)\b/u.test(normalized);
}

function receiptRegistryActionLooksMutating(action: string): boolean {
  return action.trim() === "upsert_walmart_reimbursement";
}

function rampReimbursementActionLooksMutating(action: string): boolean {
  return ["submit_ramp_reimbursement", "replace_ramp_reimbursement_receipt"].includes(action.trim());
}

function inferToolMode(
  toolCall: Pick<ProviderToolCall, "name" | "toolName" | "input">,
  task?: string,
): "read" | "write" {
  const normalizedName = normalizeToolName(
    (typeof toolCall.toolName === "string" && toolCall.toolName.trim().length > 0
      ? toolCall.toolName.trim()
      : toolCall.name).trim(),
  );
  const readOnlyTask = typeof task === "string" && isReadOnlyWorkerStep(task);

  switch (normalizedName) {
    case "Edit":
    case "MultiEdit":
    case "Write":
      return "write";
    case "recipe_write":
      return "write";
    case "fatsecret_api": {
      const method = typeof toolCall.input?.["method"] === "string"
        ? toolCall.input["method"].trim()
        : "";
      return FATSECRET_WRITE_METHODS.has(method) ? "write" : "read";
    }
    case "lunch_money": {
      const method = typeof toolCall.input?.["method"] === "string"
        ? toolCall.input["method"].trim().toUpperCase()
        : "";
      return HTTP_WRITE_METHODS.has(method) ? "write" : "read";
    }
    case "gog_email": {
      const command = typeof toolCall.input?.["command"] === "string"
        ? toolCall.input["command"].trim()
        : "";
      return gogEmailCommandLooksMutating(command) ? "write" : "read";
    }
    case "gog_docs": {
      const command = typeof toolCall.input?.["command"] === "string"
        ? toolCall.input["command"].trim()
        : "";
      return gogDocsCommandLooksMutating(command) ? "write" : "read";
    }
    case "gog_docs_update_tab":
      return "write";
    case "receipt_registry": {
      const action = typeof toolCall.input?.["action"] === "string"
        ? toolCall.input["action"].trim()
        : "";
      return receiptRegistryActionLooksMutating(action) ? "write" : "read";
    }
    case "ramp_reimbursement": {
      const action = typeof toolCall.input?.["action"] === "string"
        ? toolCall.input["action"].trim()
        : "";
      return rampReimbursementActionLooksMutating(action) ? "write" : "read";
    }
    case "workout_sql":
    case "atlas_sql":
      return isReadOnlySql(toolCall.input?.["sql"]) ? "read" : "write";
    case "file_ops": {
      const action = typeof toolCall.input?.["action"] === "string"
        ? toolCall.input["action"].trim()
        : typeof toolCall.input?.["operation"] === "string"
          ? toolCall.input["operation"].trim()
          : "";
      return ["copy", "move", "append", "write"].includes(action) ? "write" : "read";
    }
    case "walmart": {
      const action = typeof toolCall.input?.["action"] === "string"
        ? toolCall.input["action"].trim()
        : "";
      return ["queue_add", "queue_clear", "queue_remove"].includes(action) ? "write" : "read";
    }
    case "printer_command": {
      const action = typeof toolCall.input?.["action"] === "string"
        ? toolCall.input["action"].trim()
        : "";
      const dryRun = toolCall.input?.["dry_run"] === true;
      if (dryRun) {
        return "read";
      }
      return ["upload", "start", "stop"].includes(action) ? "write" : "read";
    }
    case "browser": {
      const action = typeof toolCall.input?.["action"] === "string"
        ? toolCall.input["action"].trim()
        : "";
      return !readOnlyTask && browserActionLooksMutating(action) ? "write" : "read";
    }
    default:
      return "read";
  }
}

function normalizeToolName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed.startsWith("mcp__")) {
    return trimmed;
  }

  const parts = trimmed.split("__");
  if (parts.length < 3 || parts[0] !== "mcp") {
    return trimmed;
  }

  return parts.slice(2).join("__");
}

function isFatsecretToolCall(toolCall: Pick<ProviderToolCall, "name" | "toolName">): boolean {
  const rawName = typeof toolCall.toolName === "string" && toolCall.toolName.trim().length > 0
    ? toolCall.toolName.trim()
    : toolCall.name;
  return normalizeToolName(rawName) === "fatsecret_api";
}

function isRecipeWriteToolCall(toolCall: Pick<ProviderToolCall, "name" | "toolName">): boolean {
  return isToolCallNamed(toolCall, "recipe_write");
}

function isToolCallNamed(
  toolCall: Pick<ProviderToolCall, "name" | "toolName">,
  normalizedName: string,
): boolean {
  const rawName = typeof toolCall.toolName === "string" && toolCall.toolName.trim().length > 0
    ? toolCall.toolName.trim()
    : toolCall.name;
  return normalizeToolName(rawName) === normalizedName;
}

function isBrowserLaunchToolCall(toolCall: Pick<ProviderToolCall, "name" | "toolName" | "input">): boolean {
  return isToolCallNamed(toolCall, "browser")
    && typeof toolCall.input?.["action"] === "string"
    && toolCall.input["action"].trim() === "launch";
}

function isBrowserStatusToolCall(toolCall: Pick<ProviderToolCall, "name" | "toolName" | "input">): boolean {
  return isToolCallNamed(toolCall, "browser")
    && typeof toolCall.input?.["action"] === "string"
    && toolCall.input["action"].trim() === "status";
}

function isBrowserOpenToolCall(toolCall: Pick<ProviderToolCall, "name" | "toolName" | "input">): boolean {
  return isToolCallNamed(toolCall, "browser")
    && typeof toolCall.input?.["action"] === "string"
    && toolCall.input["action"].trim() === "open";
}

function isBrowserSnapshotToolCall(toolCall: Pick<ProviderToolCall, "name" | "toolName" | "input">): boolean {
  return isToolCallNamed(toolCall, "browser")
    && typeof toolCall.input?.["action"] === "string"
    && toolCall.input["action"].trim() === "snapshot";
}

function isBrowserClickToolCall(toolCall: Pick<ProviderToolCall, "name" | "toolName" | "input">): boolean {
  return isToolCallNamed(toolCall, "browser")
    && typeof toolCall.input?.["action"] === "string"
    && toolCall.input["action"].trim() === "click"
    && typeof toolCall.input?.["ref"] === "number";
}

function isBrowserWaitToolCall(toolCall: Pick<ProviderToolCall, "name" | "toolName" | "input">): boolean {
  return isToolCallNamed(toolCall, "browser")
    && typeof toolCall.input?.["action"] === "string"
    && toolCall.input["action"].trim() === "wait";
}

function isWalmartHistoryPreferencesToolCall(
  toolCall: Pick<ProviderToolCall, "name" | "toolName" | "input">,
): boolean {
  return isToolCallNamed(toolCall, "walmart")
    && typeof toolCall.input?.["action"] === "string"
    && toolCall.input["action"].trim() === "history_preferences";
}

function isWalmartHistoryAnalyzeToolCall(
  toolCall: Pick<ProviderToolCall, "name" | "toolName" | "input">,
): boolean {
  return isToolCallNamed(toolCall, "walmart")
    && typeof toolCall.input?.["action"] === "string"
    && toolCall.input["action"].trim() === "history_analyze";
}

function formatAgeSeconds(ageSec: number): string {
  if (ageSec < 60) {
    return `${ageSec}s`;
  }
  if (ageSec < 3600) {
    return `${Math.round(ageSec / 60)}m`;
  }
  if (ageSec < 86_400) {
    const hours = ageSec / 3600;
    return `${Number.isInteger(hours) ? hours : hours.toFixed(1)}h`;
  }
  const days = ageSec / 86_400;
  return `${Number.isInteger(days) ? days : days.toFixed(1)}d`;
}

function buildWalmartHistoryAnalyzeOutput(daysBack = 365, topN = 20): Record<string, unknown> {
  const records = parseReceipts(daysBack);
  const stats = analyzeHistory(records);
  return {
    total_receipts_items: records.length,
    total_unique_items: stats.length,
    days_analyzed: daysBack,
    items: stats.slice(0, topN).map((s) => ({
      name: s.displayName,
      purchase_count: s.purchaseCount,
      total_spend: s.totalSpend,
      avg_price: s.averagePrice,
      avg_interval_days: s.averageIntervalDays,
      last_purchase: s.lastPurchase,
      next_expected: s.nextExpectedDate,
      days_until_next: s.daysUntilNext,
      is_staple: s.isStaple,
    })),
  };
}

function extractShoppingItemQuery(task: string): string | null {
  const extractedEntitiesLine = task
    .split(/\r?\n/u)
    .find((line) => line.startsWith("Extracted entities: "));
  const extractedJson = extractedEntitiesLine?.slice("Extracted entities: ".length).trim();
  if (extractedJson) {
    try {
      const parsed = JSON.parse(extractedJson) as Record<string, unknown>;
      if (typeof parsed.item === "string" && parsed.item.trim().length > 0) {
        return parsed.item.trim();
      }
      if (typeof parsed.query === "string" && parsed.query.trim().length > 0) {
        return parsed.query.trim();
      }
    } catch {
      // fall through to regex extraction below
    }
  }

  const itemMatch = task.match(/"item":"([^"]+)"/u);
  if (itemMatch?.[1]) {
    return itemMatch[1].trim();
  }

  return null;
}

function resolveShoppingHistoryCandidates(
  itemQuery: string | null,
  daysBack = 365,
  limit = 5,
): Array<{
  name: string;
  purchaseCount: number;
  lastPurchase: string;
  averagePrice: number;
}> {
  if (!itemQuery?.trim()) {
    return [];
  }
  const stats = analyzeHistory(parseReceipts(daysBack));
  return findLikelyHistoryMatches(stats, itemQuery, limit).map((item) => ({
    name: item.displayName,
    purchaseCount: item.purchaseCount,
    lastPurchase: item.lastPurchase,
    averagePrice: item.averagePrice,
  }));
}

function parseStructuredWorkerPayload(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  const candidate = fencedMatch?.[1]?.trim() || trimmed;
  if (!candidate.startsWith("{") || !candidate.endsWith("}")) {
    return null;
  }

  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? normalizeStructuredWorkerPayload(parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function taskRequestsMutation(task: string | undefined): boolean {
  if (typeof task !== "string" || task.trim().length === 0) {
    return false;
  }
  return /\bWRITE step:/u.test(task) || /\bIntent mode:\s*(?:write|mixed)\b/iu.test(task);
}

function recordHasTruthyWriteFlag(record: Record<string, unknown>): boolean {
  return [
    "committedStateVerified",
    "verifiedWriteOutcome",
    "writeVerified",
    "mutationVerified",
    "updated",
    "created",
    "success",
    "ok",
  ].some((key) => record[key] === true);
}

function recordHasAnyNonEmptyString(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => typeof record[key] === "string" && record[key].trim().length > 0);
}

function textLooksLikeConfirmedMutation(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }
  if (/\b(blocked|failed|cancelled|unconfirmed|not completed|not updated|not confirmed|could not)\b/iu.test(normalized)) {
    return false;
  }
  return /\b(updated?|created?|added?|appended?|rewrote?|wrote|preserved|verified|committed)\b/iu.test(normalized);
}

function structuredPayloadIndicatesConfirmedWriteOutcome(payload: Record<string, unknown> | null): boolean {
  if (!payload) {
    return false;
  }
  if (recordHasTruthyWriteFlag(payload)) {
    return true;
  }

  const status = typeof payload.status === "string" ? payload.status.trim().toLowerCase() : "";
  if (!["completed", "success", "ok"].includes(status)) {
    return false;
  }

  const candidates: Record<string, unknown>[] = [payload];
  const runtimeReplay = asRecord(payload.runtimeReplay);
  if (runtimeReplay) {
    candidates.push(runtimeReplay);
  }
  const resultsRecord = asRecord(payload.results);
  if (resultsRecord) {
    candidates.push(resultsRecord);
  }
  if (Array.isArray(payload.results)) {
    candidates.push(
      ...payload.results
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> => item !== null),
    );
  }

  return candidates.some((record) => {
    if (recordHasTruthyWriteFlag(record)) {
      return true;
    }
    if (recordHasAnyNonEmptyString(record, ["verified_excerpt", "final_excerpt", "resolved_file", "appended_line"])) {
      return true;
    }
    const editOutcome = typeof record.edit_outcome === "string" ? record.edit_outcome : "";
    const mutationOutcome = typeof record.mutation_outcome === "string" ? record.mutation_outcome : "";
    if (textLooksLikeConfirmedMutation(editOutcome) || textLooksLikeConfirmedMutation(mutationOutcome)) {
      return true;
    }
    return Array.isArray(record.artifacts)
      && record.artifacts.length > 0
      && (
        recordHasAnyNonEmptyString(record, ["edit_outcome", "verified_excerpt", "final_excerpt"])
        || recordHasTruthyWriteFlag(record)
      );
  });
}

function extractClarificationFromWorkerText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const structured = parseStructuredWorkerPayload(value);
  if (structured) {
    const direct = typeof structured.clarification === "string" ? structured.clarification.trim() : "";
    if (direct.length > 0) {
      return direct;
    }

    const status = typeof structured.status === "string" ? structured.status.trim().toLowerCase() : "";
    if (["needs_clarification", "clarification", "awaiting_user", "awaiting_input"].includes(status)) {
      const followUps = Array.isArray(structured.follow_up)
        ? structured.follow_up.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        : [];
      if (followUps.length > 0) {
        return followUps[0]!.trim();
      }
    }
  }

  const text = value.trim();
  if (text.length === 0) {
    return undefined;
  }

  const statusMatch = text.match(/(?:^|\n)status:\s*`?([a-z_]+)`?/iu);
  const status = statusMatch?.[1]?.trim().toLowerCase() ?? "";
  if (!["needs_clarification", "clarification", "awaiting_user", "awaiting_input"].includes(status)) {
    return undefined;
  }

  const lines = text.split(/\r?\n/u);
  const followUpIndex = lines.findIndex((line) => /^follow_up:\s*$/iu.test(line.trim()));
  if (followUpIndex >= 0) {
    const bullets: string[] = [];
    for (const line of lines.slice(followUpIndex + 1)) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const bulletMatch = trimmed.match(/^-\s+(.+)$/u);
      if (!bulletMatch) {
        break;
      }
      bullets.push(bulletMatch[1]!.trim());
    }
    if (bullets.length > 0) {
      return bullets[0];
    }
  }

  return undefined;
}

function extractStructuredPayloadWarnings(record: Record<string, unknown>): string[] {
  const warnings = new Set<string>();
  const status = typeof record.status === "string" ? record.status.trim().toLowerCase() : null;

  if (status && !["ok", "success", "completed"].includes(status)) {
    warnings.add(`Worker reported ${status} result.`);
  }

  const unresolved = Array.isArray(record.unresolved)
    ? record.unresolved.flatMap((value) => {
      if (typeof value === "string" && value.trim().length > 0) {
        return [value.trim()];
      }
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const reason = typeof (value as Record<string, unknown>).reason === "string"
          ? String((value as Record<string, unknown>).reason).trim()
          : "";
        return reason.length > 0 ? [reason] : [];
      }
      return [];
    })
    : [];
  const errors = Array.isArray(record.errors)
    ? record.errors.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];

  for (const unresolvedItem of unresolved) {
    warnings.add(unresolvedItem.trim());
  }
  for (const errorItem of errors) {
    warnings.add(errorItem.trim());
  }

  const collectExplicitWarnings = (value: unknown, parentKey?: string): void => {
    const normalizedKey = parentKey?.toLowerCase();
    if (typeof value === "string") {
      if ((normalizedKey === "warning" || normalizedKey === "warnings") && value.trim().length > 0) {
        warnings.add(value.trim());
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        collectExplicitWarnings(item, normalizedKey);
      }
      return;
    }
    if (!value || typeof value !== "object") {
      return;
    }
    for (const [childKey, childValue] of Object.entries(value)) {
      collectExplicitWarnings(childValue, childKey);
    }
  };

  collectExplicitWarnings(record);

  return [...warnings];
}

function collectLocationStaleWarnings(
  record: Record<string, unknown>,
  normalizedToolNames: ReadonlySet<string>,
): string[] {
  if (!normalizedToolNames.has("location_read")) {
    return [];
  }
  const rawAgeSec = record.ageSec ?? record.age_sec;
  if (typeof rawAgeSec !== "number" || !Number.isFinite(rawAgeSec) || rawAgeSec <= 3600) {
    return [];
  }
  return [`Location data is stale (${formatAgeSeconds(Math.round(rawAgeSec))} old).`];
}

function extractWarningsFromRecord(
  record: Record<string, unknown>,
  normalizedToolNames: ReadonlySet<string>,
  operationName: string,
): string[] {
  const warnings = new Set<string>();

  if (typeof record.error === "string" && record.error.trim().length > 0) {
    warnings.add(`${operationName} reported an error: ${record.error.trim()}`);
  }

  for (const warning of extractStructuredPayloadWarnings(record)) {
    warnings.add(warning);
  }
  for (const warning of collectLocationStaleWarnings(record, normalizedToolNames)) {
    warnings.add(warning);
  }

  return [...warnings];
}

function extractOperationWarnings(operation: WorkerReportOperation): string[] {
  const warnings = new Set<string>();
  const normalizedToolNames = new Set([operation.name, ...operation.toolNames]);
  const output = operation.output;
  if (typeof output === "string") {
    const structured = parseStructuredWorkerPayload(output);
    if (structured) {
      for (const warning of extractWarningsFromRecord(structured, normalizedToolNames, operation.name)) {
        warnings.add(warning);
      }
    }
    for (const warning of extractTextWarnings(output)) {
      warnings.add(warning);
    }
    return [...warnings];
  }
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return [...warnings];
  }

  const record = output as Record<string, unknown>;
  for (const warning of extractWarningsFromRecord(record, normalizedToolNames, operation.name)) {
    warnings.add(warning);
  }

  const content = record.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        continue;
      }
      const text = typeof (item as { text?: unknown }).text === "string"
        ? String((item as { text?: unknown }).text)
        : null;
      if (!text) {
        continue;
      }
      const structured = parseStructuredWorkerPayload(text);
      if (structured) {
        for (const warning of extractWarningsFromRecord(structured, normalizedToolNames, operation.name)) {
          warnings.add(warning);
        }
      }
      for (const warning of extractTextWarnings(text)) {
        warnings.add(warning);
      }
    }
  }

  return [...warnings];
}

function extractTextWarnings(text: string | undefined): string[] {
  if (typeof text !== "string" || text.trim().length === 0) {
    return [];
  }

  const warnings = new Set<string>();
  const structured = parseStructuredWorkerPayload(text);
  if (structured) {
    for (const warning of extractStructuredPayloadWarnings(structured)) {
      warnings.add(warning);
    }
  }
  const ageSecMatch = text.match(/ageSec:\s*([\d,]+)/iu);
  const ageSec = ageSecMatch?.[1] ? Number.parseInt(ageSecMatch[1].replaceAll(",", ""), 10) : null;
  if (ageSec && Number.isFinite(ageSec) && ageSec > 3600 && /\bstale\b/iu.test(text)) {
    warnings.add(`Location data is stale (${formatAgeSeconds(ageSec)} old).`);
  }
  if (
    !ageSec
    && ![...warnings].some((warning) => /\bstale\b/iu.test(warning))
    && /\b(?:gps|location|owntracks|last ping|last update|last fix)\b/iu.test(text)
    && /\bstale\b/iu.test(text)
  ) {
    const humanAgeMatch = text.match(
      /\b(\d+(?:\.\d+)?)\s*(\+)?\s*(minutes?|hours?|days?)\s+stale\b/iu,
    );
    if (humanAgeMatch) {
      const amount = humanAgeMatch[1]!;
      const plus = humanAgeMatch[2] ? "+" : "";
      const unit = humanAgeMatch[3]!;
      warnings.add(`Location data is stale (${amount}${plus}${unit} old).`);
    } else {
      warnings.add("Location data is stale.");
    }
  }

  for (const match of text.matchAll(/(?:⚠️\s*)?(?:Warning:|\*\*⚠️\s*Warning:\*\*)\s*(.+)$/gimu)) {
    const warning = match[1]?.trim();
    if (warning) {
      warnings.add(warning);
    }
  }
  for (const line of text.split("\n")) {
    const normalized = line.replace(/\*\*/gu, "").trim();
    if (!normalized.startsWith("⚠️")) {
      continue;
    }
    const warning = normalized.replace(/^⚠️\s*/u, "").replace(/^Warning:\s*/iu, "").trim();
    if (warning.length > 0) {
      warnings.add(warning);
    }
  }

  return [...warnings];
}

function deriveQualityWarnings(
  operations: readonly WorkerReportOperation[],
  result: WorkerAgentResult,
): string[] {
  const warnings = new Set<string>();
  if (result.partial) {
    warnings.add(
      result.partialReason
        ? `Worker returned partial results: ${result.partialReason}.`
        : "Worker returned partial results.",
    );
  }

  for (const operation of operations) {
    for (const warning of extractOperationWarnings(operation)) {
      warnings.add(warning);
    }
  }
  for (const warning of extractTextWarnings(result.text)) {
    warnings.add(warning);
  }
  if (result.toolCalls.length === 0 && looksLikeToolFailureNarration(result.text)) {
    warnings.add("Worker described tool failure without recording any tool calls.");
  }

  return [...warnings];
}

function looksLikeToolFailureNarration(text: string | undefined): boolean {
  if (typeof text !== "string" || text.trim().length === 0) {
    return false;
  }

  return /\bcancelled\b|\bcan(?:not|'t) verify\b|\bcouldn'?t verify\b|\bcould not be verified\b|\bretry\b.*\b(read|lookup|query|tool)\b|\btool call\b/iu
    .test(text);
}

function toolCallLooksCancelled(toolCall: Pick<ProviderToolCall, "output">): boolean {
  const output = toolCall.output;
  if (typeof output === "string") {
    return /user cancelled MCP tool call/iu.test(output);
  }
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return false;
  }
  const message = (output as Record<string, unknown>)["message"];
  return typeof message === "string" && /user cancelled MCP tool call/iu.test(message);
}

function hasRecordedToolCancellation(result: WorkerAgentResult): boolean {
  return result.toolCalls.some((toolCall) => toolCallLooksCancelled(toolCall));
}

function hasBlockedWorkerPayload(result: WorkerAgentResult): boolean {
  const payload = parseStructuredWorkerPayload(result.text);
  const status = typeof payload?.["status"] === "string" ? payload["status"].trim().toLowerCase() : "";
  return ["blocked", "error", "failed"].includes(status);
}

function isCancellationLikeText(value: string): boolean {
  return /cancelled MCP tool call|provider cancelled|tool call.*cancelled|write(?:s)? were cancelled/iu.test(value);
}

function payloadIsCancellationOnly(record: Record<string, unknown>): boolean {
  const unresolved = Array.isArray(record.unresolved)
    ? record.unresolved.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];
  const errors = Array.isArray(record.errors)
    ? record.errors.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    : [];

  const combined = [...unresolved, ...errors];
  if (combined.length === 0) {
    return false;
  }

  return combined.every((entry) => isCancellationLikeText(entry));
}

function normalizeFatsecretParams(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function fatsecretWriteSucceeded(output: unknown): boolean {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return false;
  }
  const record = output as Record<string, unknown>;
  return (
    typeof record.value === "string" && record.value.trim().length > 0
  ) || record.ok === true;
}

interface FatsecretReplayOutcome {
  result: WorkerAgentResult;
  replayedCallCount: number;
  replayFailureMessages: string[];
}

type NormalizedMeal = "breakfast" | "lunch" | "dinner" | "other";

interface SynthesizedFoodEntry {
  item: string;
  meal: NormalizedMeal;
  params: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const normalized = value.trim().replaceAll(",", "");
    if (!normalized) {
      return null;
    }
    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeMeal(value: unknown): NormalizedMeal | null {
  if (typeof value !== "string") {
    return null;
  }
  switch (value.trim().toLowerCase()) {
    case "breakfast":
      return "breakfast";
    case "lunch":
      return "lunch";
    case "dinner":
      return "dinner";
    case "other":
    case "snack":
      return "other";
    default:
      return null;
  }
}

function normalizeStructuredWorkerPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (!looksLikeNutritionRecoveryPayload(payload)) {
    return payload;
  }

  const mealHint = extractPayloadMealHint(payload);
  const dateHint = extractPayloadDateHint(payload);
  const normalizedResults = normalizeStructuredPayloadResults(payload.results, mealHint, dateHint);

  return {
    ...payload,
    ...(normalizedResults !== undefined ? { results: normalizedResults } : {}),
    ...(Array.isArray(payload.logged)
      ? {
          logged: payload.logged.map((item) =>
            normalizeNutritionPayloadItem(asRecord(item) ?? { value: item }, mealHint, dateHint),
          ),
        }
      : {}),
    ...(Array.isArray(payload.unresolved)
      ? {
          unresolved: payload.unresolved.map((item) => {
            if (typeof item === "string") {
              return item;
            }
            const record = asRecord(item);
            return record ? normalizeNutritionPayloadItem(record, mealHint, dateHint) : item;
          }),
        }
      : {}),
  };
}

function looksLikeNutritionRecoveryPayload(payload: Record<string, unknown>): boolean {
  const action = typeof payload.action === "string" ? payload.action.trim() : "";
  if (action.startsWith("nutrition.") || action.startsWith("wellness.log_") || action === "log_food_items" || action === "log_recipe_meal") {
    return true;
  }
  const results = asRecord(payload.results);
  return Boolean(
    typeof results?.meal === "string"
    || typeof results?.date === "string"
    || Array.isArray(results?.resolved_items)
    || Array.isArray(payload.unresolved),
  );
}

function extractPayloadMealHint(payload: Record<string, unknown>): NormalizedMeal | null {
  const results = asRecord(payload.results);
  const totals = asRecord(payload.totals);
  return normalizeMeal(results?.meal) ?? normalizeMeal(totals?.meal) ?? normalizeMeal(payload.meal);
}

function extractPayloadDateHint(payload: Record<string, unknown>): string | null {
  const results = asRecord(payload.results);
  const totals = asRecord(payload.totals);
  const directCandidates = [
    typeof results?.date === "string" ? results.date.trim() : "",
    typeof totals?.date === "string" ? totals.date.trim() : "",
    typeof payload.date === "string" ? payload.date.trim() : "",
  ];
  return directCandidates.find((value) => value.length > 0) ?? null;
}

function normalizeStructuredPayloadResults(
  resultsValue: unknown,
  mealHint: NormalizedMeal | null,
  dateHint: string | null,
): unknown {
  if (Array.isArray(resultsValue)) {
    return resultsValue.map((item) => {
      const record = asRecord(item);
      return record ? normalizeNutritionPayloadItem(record, mealHint, dateHint) : item;
    });
  }
  const results = asRecord(resultsValue);
  if (!results) {
    return resultsValue;
  }
  return {
    ...results,
    ...(Array.isArray(results.resolved_items)
      ? {
          resolved_items: results.resolved_items.map((item) => {
            const record = asRecord(item);
            return record ? normalizeNutritionPayloadItem(record, mealHint, dateHint) : item;
          }),
        }
      : {}),
  };
}

function parseAtlasResolutionSummary(
  value: string,
): Record<string, unknown> | null {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  const match = normalized.match(
    /Atlas match found:\s*(.+?)\s*\(food_id\s+(\d+),\s*serving_id\s+(\d+)(?:,\s*grams_per_serving\s+([\d.]+))?\)/iu,
  );
  if (!match?.[1] || !match[2] || !match[3]) {
    return null;
  }

  const gramsPerServing = match[4] ? Number.parseFloat(match[4]) : null;
  return {
    name: match[1].trim(),
    food_id: match[2].trim(),
    serving_id: match[3].trim(),
    ...(Number.isFinite(gramsPerServing) && gramsPerServing && gramsPerServing > 0
      ? { grams_per_serving: gramsPerServing }
      : {}),
  };
}

function normalizeNutritionPayloadItem(
  record: Record<string, unknown>,
  mealHint: NormalizedMeal | null,
  dateHint: string | null,
): Record<string, unknown> {
  const item = extractFoodRecordItemLabel(record);
  const amount = extractFoodRecordAmountText(record);
  const resolution = typeof record.resolution === "string" ? record.resolution.trim() : "";
  const parsedAtlasSummary = resolution ? parseAtlasResolutionSummary(resolution) : null;
  const existingAtlasMatch = asRecord(record.atlas_match);
  const mergedAtlasMatch = parsedAtlasSummary
    ? { ...parsedAtlasSummary, ...(existingAtlasMatch ?? {}) }
    : existingAtlasMatch;
  const existingFoodId =
    record.food_id === undefined || record.food_id === null ? "" : String(record.food_id).trim();
  const existingServingId =
    record.serving_id === undefined || record.serving_id === null ? "" : String(record.serving_id).trim();
  const meal = normalizeMeal(record.meal) ?? mealHint;
  const date =
    typeof record.date === "string" && record.date.trim().length > 0
      ? record.date.trim()
      : dateHint;

  return {
    ...record,
    ...(item ? { item } : {}),
    ...(amount ? { amount } : {}),
    ...(meal ? { meal } : {}),
    ...(date ? { date } : {}),
    ...(mergedAtlasMatch ? { atlas_match: mergedAtlasMatch } : {}),
    ...(!existingFoodId && mergedAtlasMatch?.food_id !== undefined ? { food_id: mergedAtlasMatch.food_id } : {}),
    ...(!existingServingId && mergedAtlasMatch?.serving_id !== undefined ? { serving_id: mergedAtlasMatch.serving_id } : {}),
    ...(
      (record.grams_per_serving === undefined || record.grams_per_serving === null)
      && mergedAtlasMatch?.grams_per_serving !== undefined
        ? { grams_per_serving: mergedAtlasMatch.grams_per_serving }
        : {}
    ),
  };
}

function extractLoggedDate(
  payload: Record<string, unknown>,
  toolCalls: readonly ProviderToolCall[],
): string | null {
  const results = asRecord(payload.results);
  const resultsDate = typeof results?.date === "string" ? results.date.trim() : "";
  if (resultsDate) {
    return resultsDate;
  }

  const totals = asRecord(payload.totals);
  const totalsDate = typeof totals?.date === "string" ? totals.date.trim() : "";
  if (totalsDate) {
    return totalsDate;
  }

  const unresolved = Array.isArray(payload.unresolved) ? payload.unresolved : [];
  for (const item of unresolved) {
    const record = asRecord(item);
    const date = typeof record?.date === "string" ? record.date.trim() : "";
    if (date) {
      return date;
    }
  }

  for (const toolCall of toolCalls) {
    if (!isFatsecretToolCall(toolCall) || toolCall.input?.method !== "food_entries_get") {
      continue;
    }
    const params = normalizeFatsecretParams(toolCall.input?.params);
    const date = typeof params.date === "string" ? params.date.trim() : "";
    if (date) {
      return date;
    }
  }

  return null;
}

function extractMealMappingFromFollowUps(payload: Record<string, unknown>): NormalizedMeal | null {
  if (!Array.isArray(payload.follow_up)) {
    return null;
  }
  for (const value of payload.follow_up) {
    if (typeof value !== "string") {
      continue;
    }
    const match = value.match(/`?([a-z]+)\s*->\s*(breakfast|lunch|dinner|other)`?/iu);
    if (match?.[2]) {
      const meal = normalizeMeal(match[2]);
      if (meal) {
        return meal;
      }
    }
  }
  return null;
}

function extractMealHintFromTask(task: string): NormalizedMeal | null {
  const match = task.match(/\b(breakfast|lunch|dinner|snack|other)\b/iu);
  return match?.[1] ? normalizeMeal(match[1]) : null;
}

function extractMealHint(payload: Record<string, unknown>, task: string): NormalizedMeal | null {
  const unresolved = Array.isArray(payload.unresolved) ? payload.unresolved : [];
  for (const item of unresolved) {
    const record = asRecord(item);
    const meal = normalizeMeal(record?.meal);
    if (meal) {
      return meal;
    }
  }

  return extractMealMappingFromFollowUps(payload) ?? extractMealHintFromTask(task);
}

function normalizeFatsecretServings(output: unknown): Record<string, unknown>[] {
  const record = asRecord(output);
  const servings = asRecord(record?.servings);
  const servingValue = servings?.serving;
  if (Array.isArray(servingValue)) {
    return servingValue
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== null);
  }
  const single = asRecord(servingValue);
  return single ? [single] : [];
}

function selectFatsecretServing(
  output: unknown,
  preferredServingId: string | null,
): Record<string, unknown> | null {
  const servings = normalizeFatsecretServings(output);
  if (servings.length === 0) {
    return null;
  }
  if (preferredServingId) {
    const matched = servings.find((serving) => String(serving.serving_id ?? "").trim() === preferredServingId);
    if (matched) {
      return matched;
    }
  }
  return servings[0] ?? null;
}

function extractFoodItemGrams(record: Record<string, unknown>): number | null {
  const direct =
    parseFiniteNumber(record.grams)
    ?? parseFiniteNumber(record.grams_per_item);
  if (direct && direct > 0) {
    return direct;
  }
  const item = extractFoodRecordItemLabel(record);
  const match = item.match(/(\d+(?:\.\d+)?)\s*g\b/iu);
  const parsed = match?.[1] ? Number.parseFloat(match[1]) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function extractFoodRecordItemLabel(record: Record<string, unknown>): string {
  const candidates = [
    typeof record.item === "string" ? record.item.trim() : "",
    typeof record.name === "string" ? record.name.trim() : "",
    typeof record.food_name === "string" ? record.food_name.trim() : "",
  ];
  return candidates.find((value) => value.length > 0) ?? "";
}

function extractFoodRecordAmountText(record: Record<string, unknown>): string {
  const candidates = [
    typeof record.amount === "string" ? record.amount.trim() : "",
    typeof record.quantity === "string" ? record.quantity.trim() : "",
  ];
  return candidates.find((value) => value.length > 0) ?? "";
}

function deriveFatsecretUnitsFromServing(
  grams: number,
  serving: Record<string, unknown>,
): number | null {
  const metricServingAmount = parseFiniteNumber(serving.metric_serving_amount);
  if (!metricServingAmount || metricServingAmount <= 0) {
    return null;
  }
  const units = grams / metricServingAmount;
  if (!Number.isFinite(units) || units <= 0) {
    return null;
  }
  return Number.parseFloat(units.toFixed(6));
}

function buildRecoveredFoodGetMap(
  toolCalls: readonly ProviderToolCall[],
): Map<string, Record<string, unknown>> {
  const recovered = new Map<string, Record<string, unknown>>();
  for (const toolCall of toolCalls) {
    if (!fatsecretReadSucceeded(toolCall) || toolCall.input?.method !== "food_get") {
      continue;
    }
    const output = asRecord(toolCall.output);
    const inputParams = asRecord(toolCall.input?.params);
    const fromOutput = typeof output?.food_id === "string" ? output.food_id.trim() : "";
    const fromInput =
      typeof inputParams?.food_id === "string" || typeof inputParams?.food_id === "number"
        ? String(inputParams.food_id).trim()
        : "";
    const foodId = fromOutput || fromInput;
    if (!foodId || !output) {
      continue;
    }
    recovered.set(foodId, output);
  }
  return recovered;
}

function extractFatsecretSearchRows(
  toolCalls: readonly ProviderToolCall[],
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const toolCall of toolCalls) {
    if (!fatsecretReadSucceeded(toolCall) || toolCall.input?.method !== "foods_search") {
      continue;
    }
    if (!Array.isArray(toolCall.output)) {
      continue;
    }
    rows.push(
      ...toolCall.output
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> => item !== null),
    );
  }
  return rows;
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function parseJsonArrayRecords(value: string): Record<string, unknown>[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.map((item) => asRecord(item)).filter((item): item is Record<string, unknown> => item !== null)
      : [];
  } catch {
    return [];
  }
}

interface ParsedRecipeIngredientHint {
  name: string;
  grams: number;
  amountText: string;
  section: string | null;
  perUnit: string | null;
  requiresSelection: boolean;
}

interface ParsedRecipeMatch {
  title: string;
  content: string;
  ingredients: ParsedRecipeIngredientHint[];
}

function parseRecipeReadPayload(output: unknown): Record<string, unknown> | null {
  const record = asRecord(output);
  if (!record) {
    return null;
  }
  if (Array.isArray(record.matches)) {
    return record;
  }

  const content = Array.isArray(record.content) ? record.content : [];
  for (const item of content) {
    const contentRecord = asRecord(item);
    const text = typeof contentRecord?.text === "string" ? contentRecord.text.trim() : "";
    if (!text) {
      continue;
    }
    const parsed = parseJsonRecord(text);
    if (parsed && Array.isArray(parsed.matches)) {
      return parsed;
    }
  }
  return null;
}

function extractPerUnitFromSection(section: string | null): string | null {
  if (!section) {
    return null;
  }
  const match = section.match(/\(\s*per\s+([^)]+)\)/iu);
  return match?.[1] ? normalizeFoodItemLabelForMatch(match[1]) : null;
}

function parseGramsFromAmountText(value: string): number | null {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  const directMatch = normalized.match(/(\d+(?:\.\d+)?)\s*g\b/iu);
  const parsed = directMatch?.[1] ? Number.parseFloat(directMatch[1]) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseRecipeIngredientHints(markdown: string): ParsedRecipeIngredientHint[] {
  const hints: ParsedRecipeIngredientHint[] = [];
  let currentSection: string | null = null;
  let currentTableHeaders: string[] | null = null;

  const pushHint = (name: string, amountText: string) => {
    const grams = parseGramsFromAmountText(amountText);
    const trimmedName = name.trim();
    if (!grams || !trimmedName) {
      return;
    }
    hints.push({
      name: trimmedName,
      grams,
      amountText: amountText.trim(),
      section: currentSection,
      perUnit: extractPerUnitFromSection(currentSection),
      requiresSelection: Boolean(currentSection && /\boptions?\b/iu.test(currentSection)),
    });
  };

  for (const line of markdown.split(/\r?\n/u)) {
    const headingMatch = line.match(/^#{1,6}\s+(.+)$/u);
    if (headingMatch?.[1]) {
      currentSection = headingMatch[1].trim();
      currentTableHeaders = null;
      continue;
    }

    const bulletMatch = line.match(/^\s*[-*]\s*(\d+(?:\.\d+)?)g\s+(.+?)(?:\s+[—-]\s+.*)?$/u);
    if (bulletMatch?.[1] && bulletMatch?.[2]) {
      pushHint(bulletMatch[2], `${bulletMatch[1]}g`);
      currentTableHeaders = null;
      continue;
    }

    if (!line.includes("|")) {
      currentTableHeaders = null;
      continue;
    }

    const cells = line
      .split("|")
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0);
    if (cells.length < 2) {
      continue;
    }
    if (cells.every((cell) => /^:?-{3,}:?$/u.test(cell))) {
      continue;
    }

    const looksLikeHeader =
      cells.some((cell) => /\b(?:ingredient|protein|tortilla|item|food)\b/iu.test(cell))
      && cells.some((cell) => /\b(?:amount|serving|quantity)\b/iu.test(cell));
    if (looksLikeHeader || !currentTableHeaders) {
      currentTableHeaders = cells;
      continue;
    }

    const nameIndex = currentTableHeaders.findIndex((cell) =>
      /\b(?:ingredient|protein|tortilla|item|food)\b/iu.test(cell),
    );
    const amountIndex = currentTableHeaders.findIndex((cell) =>
      /\b(?:amount|serving|quantity)\b/iu.test(cell),
    );
    if (nameIndex < 0 || amountIndex < 0 || !cells[nameIndex] || !cells[amountIndex]) {
      continue;
    }
    pushHint(cells[nameIndex], cells[amountIndex]);
  }

  return hints;
}

function extractRecipeMatches(toolCalls: readonly ProviderToolCall[]): ParsedRecipeMatch[] {
  const matches: ParsedRecipeMatch[] = [];
  for (const toolCall of toolCalls) {
    if (!isToolCallNamed(toolCall, "recipe_read")) {
      continue;
    }
    const payload = parseRecipeReadPayload(toolCall.output);
    const recipeMatches = Array.isArray(payload?.matches) ? payload.matches : [];
    for (const match of recipeMatches) {
      const record = asRecord(match);
      const title = typeof record?.title === "string" ? record.title.trim() : "";
      const content = typeof record?.content === "string" ? record.content : "";
      if (!title || !content) {
        continue;
      }
      matches.push({
        title,
        content,
        ingredients: parseRecipeIngredientHints(content),
      });
    }
  }
  return matches;
}

function singularizeToken(token: string): string {
  if (token.endsWith("ies") && token.length > 3) {
    return `${token.slice(0, -3)}y`;
  }
  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 3) {
    return token.slice(0, -1);
  }
  return token;
}

const RECIPE_SELECTION_STOPWORDS = new Set([
  "and",
  "for",
  "meal",
  "dish",
  "recipe",
  "serving",
  "servings",
  "option",
  "options",
  "taco",
  "tacos",
  "tortilla",
  "tortillas",
]);

const FATSECRET_SEARCH_STOPWORDS = new Set([
  ...Object.keys(NUMBER_WORD_VALUES),
  "small",
  "medium",
  "large",
  "plain",
  "fresh",
  "raw",
  "frozen",
  "whole",
]);
const FATSECRET_MEASUREMENT_TOKENS = new Set([
  "g",
  "gram",
  "grams",
  "oz",
  "ounce",
  "ounces",
  "lb",
  "lbs",
  "cup",
  "cups",
  "tbsp",
  "tsp",
  "tablespoon",
  "tablespoons",
  "teaspoon",
  "teaspoons",
  "slice",
  "slices",
  "piece",
  "pieces",
  "serving",
  "servings",
]);

function extractAtlasRows(toolCalls: readonly ProviderToolCall[]): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const toolCall of toolCalls) {
    if (!isToolCallNamed(toolCall, "atlas_sql")) {
      continue;
    }
    const output = asRecord(toolCall.output);
    const content = Array.isArray(output?.content) ? output.content : [];
    for (const item of content) {
      const record = asRecord(item);
      const text = typeof record?.text === "string" ? record.text.trim() : "";
      if (!text) {
        continue;
      }
      const outer = parseJsonRecord(text);
      const resultText = typeof outer?.result === "string" ? outer.result : "";
      if (!resultText) {
        continue;
      }
      rows.push(...parseJsonArrayRecords(resultText));
    }
  }
  return rows;
}

function normalizeFoodItemLabelForMatch(label: string): string {
  return label
    .toLowerCase()
    .replace(/\b\d+(?:\.\d+)?\s*g\b/gu, " ")
    .replace(/&/gu, " and ")
    .replace(/[^a-z0-9]+/gu, " ")
    .split(/\s+/u)
    .filter((token) => token.length > 0)
    .map((token) => singularizeToken(token))
    .join(" ")
    .trim();
}

function extractCoreFoodSearchPhrase(label: string): string {
  const normalized = normalizeFoodItemLabelForMatch(label);
  if (!normalized) {
    return "";
  }
  const tokens = normalized
    .split(/\s+/u)
    .filter((token) =>
      token.length > 0
      && !FATSECRET_SEARCH_STOPWORDS.has(token)
      && !FATSECRET_MEASUREMENT_TOKENS.has(token),
    );
  if (tokens.length === 0) {
    return normalized;
  }
  return tokens.join(" ").trim();
}

function parseAtlasAliasList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }
  try {
    const array = JSON.parse(value);
    return Array.isArray(array)
      ? array.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
  } catch {
    return value.split(",").map((entry) => entry.replaceAll('"', "").trim()).filter((entry) => entry.length > 0);
  }
}

function scoreAtlasRowForItem(itemLabel: string, row: Record<string, unknown>): number {
  const normalizedItem = normalizeFoodItemLabelForMatch(itemLabel);
  if (!normalizedItem) {
    return 0;
  }
  const aliases = parseAtlasAliasList(row.aliases);
  const haystacks = [
    typeof row.name === "string" ? row.name : "",
    typeof row.product === "string" ? row.product : "",
    typeof row.brand === "string" ? row.brand : "",
    ...aliases,
  ]
    .map((value) => normalizeFoodItemLabelForMatch(value))
    .filter((value) => value.length > 0);
  const itemWords = normalizedItem.split(" ").filter((word) => word.length > 1);
  let score = 0;
  for (const haystack of haystacks) {
    if (haystack === normalizedItem) {
      score += 100;
    } else if (haystack.includes(normalizedItem) || normalizedItem.includes(haystack)) {
      score += 50;
    }
    for (const word of itemWords) {
      if (haystack.includes(word)) {
        score += 5;
      }
    }
  }
  return score;
}

function findBestAtlasMatchForItem(
  itemLabel: string,
  atlasRows: readonly Record<string, unknown>[],
): Record<string, unknown> | null {
  let bestRow: Record<string, unknown> | null = null;
  let bestScore = 0;
  for (const row of atlasRows) {
    const score = scoreAtlasRowForItem(itemLabel, row);
    if (score > bestScore) {
      bestScore = score;
      bestRow = row;
    }
  }
  return bestScore > 0 ? bestRow : null;
}

function extractCountForUnit(taskText: string, unit: string): number | null {
  const normalizedUnit = normalizeFoodItemLabelForMatch(unit);
  if (!normalizedUnit) {
    return null;
  }
  const connector = "(?:\\s+[a-z]+){0,3}\\s+";
  const numericPattern = new RegExp(`\\b(\\d+(?:\\.\\d+)?)${connector}${normalizedUnit}s?\\b`, "iu");
  const numericMatch = taskText.match(numericPattern);
  if (numericMatch?.[1]) {
    const parsed = Number.parseFloat(numericMatch[1]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  const words = Object.keys(NUMBER_WORD_VALUES).join("|");
  const wordPattern = new RegExp(`\\b(${words})${connector}${normalizedUnit}s?\\b`, "iu");
  const wordMatch = taskText.match(wordPattern);
  if (wordMatch?.[1]) {
    return NUMBER_WORD_VALUES[wordMatch[1].toLowerCase()] ?? null;
  }
  return null;
}

function scoreRecipeIngredientSelection(hint: ParsedRecipeIngredientHint, taskText: string): number {
  const normalizedTask = normalizeFoodItemLabelForMatch(taskText);
  const tokens = normalizeFoodItemLabelForMatch(hint.name)
    .split(" ")
    .filter((token) => token.length > 2 && !RECIPE_SELECTION_STOPWORDS.has(token));
  if (tokens.length === 0) {
    return 0;
  }
  return tokens.reduce((score, token) => score + (normalizedTask.includes(token) ? 5 : 0), 0);
}

function extractResolvedItems(payload: Record<string, unknown>): Record<string, unknown>[] {
  const resultValue = payload.results;
  if (Array.isArray(resultValue)) {
    return resultValue
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== null);
  }
  const results = asRecord(resultValue);
  const resolved = Array.isArray(results?.resolved_items) ? results.resolved_items : [];
  return resolved
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== null);
}

function extractCountFromAmountText(value: string): number | null {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  const directMatch = normalized.match(/^(\d+(?:\.\d+)?)\b/u);
  if (directMatch?.[1]) {
    const parsed = Number.parseFloat(directMatch[1]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  const words = Object.keys(NUMBER_WORD_VALUES).join("|");
  const wordMatch = normalized.match(new RegExp(`^(${words})\\b`, "iu"));
  if (wordMatch?.[1]) {
    return NUMBER_WORD_VALUES[wordMatch[1].toLowerCase()] ?? null;
  }
  return null;
}

function parseLeadingQuantityToken(value: string): number | null {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  const mixedFractionMatch = normalized.match(/^(\d+)\s+(\d+)\/(\d+)\b/u);
  if (mixedFractionMatch?.[1] && mixedFractionMatch[2] && mixedFractionMatch[3]) {
    const whole = Number.parseFloat(mixedFractionMatch[1]);
    const numerator = Number.parseFloat(mixedFractionMatch[2]);
    const denominator = Number.parseFloat(mixedFractionMatch[3]);
    if (
      Number.isFinite(whole)
      && Number.isFinite(numerator)
      && Number.isFinite(denominator)
      && denominator > 0
    ) {
      return whole + (numerator / denominator);
    }
  }

  const fractionMatch = normalized.match(/^(\d+)\/(\d+)\b/u);
  if (fractionMatch?.[1] && fractionMatch[2]) {
    const numerator = Number.parseFloat(fractionMatch[1]);
    const denominator = Number.parseFloat(fractionMatch[2]);
    if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0) {
      return numerator / denominator;
    }
  }

  return extractCountFromAmountText(normalized);
}

function extractServingUnitCount(serving: Record<string, unknown>): number | null {
  const candidates = [
    typeof serving.serving_description === "string" ? serving.serving_description.trim() : "",
    typeof serving.measurement_description === "string" ? serving.measurement_description.trim() : "",
  ];

  for (const candidate of candidates) {
    const parsed = parseLeadingQuantityToken(candidate);
    if (parsed && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

function extractAmountUnitHint(value: string): string | null {
  const normalized = value.trim();
  if (!normalized) {
    return null;
  }
  const withoutLeadingCount = normalized
    .replace(/^(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/iu, "")
    .replace(/^\s+/u, "");
  const match = withoutLeadingCount.match(/^([a-z]+(?:\s+[a-z]+){0,2})/iu);
  return match?.[1] ? normalizeFoodItemLabelForMatch(match[1]) : null;
}

function servingMatchesAmountUnit(serving: Record<string, unknown>, amountUnit: string | null): boolean {
  if (!amountUnit) {
    return false;
  }
  const servingDescription = typeof serving.serving_description === "string" ? serving.serving_description : "";
  const measurementDescription = typeof serving.measurement_description === "string" ? serving.measurement_description : "";
  const haystack = normalizeFoodItemLabelForMatch(`${servingDescription} ${measurementDescription}`);
  if (!haystack) {
    return false;
  }
  if (haystack.includes(amountUnit)) {
    return true;
  }
  const tokens = amountUnit
    .split(/\s+/u)
    .map((token) => normalizeFoodItemLabelForMatch(token))
    .filter((token) => token.length >= 3);
  return tokens.some((token) => haystack.includes(token));
}

function deriveFatsecretUnitsFromAmountText(
  amountText: string,
  serving: Record<string, unknown>,
): number | null {
  const grams = parseGramsFromAmountText(amountText);
  if (grams) {
    return deriveFatsecretUnitsFromServing(grams, serving);
  }

  const count = extractCountFromAmountText(amountText);
  if (!count) {
    return null;
  }
  const amountUnit = extractAmountUnitHint(amountText);
  if (servingMatchesAmountUnit(serving, amountUnit)) {
    const servingUnitCount = extractServingUnitCount(serving) ?? 1;
    if (!Number.isFinite(servingUnitCount) || servingUnitCount <= 0) {
      return Number.parseFloat(count.toFixed(6));
    }
    return Number.parseFloat((count / servingUnitCount).toFixed(6));
  }

  return null;
}

function synthesizeFoodEntryFromResolvedItem(
  item: Record<string, unknown>,
  recoveredFoods: ReadonlyMap<string, Record<string, unknown>>,
  atlasRows: readonly Record<string, unknown>[],
  defaultMeal: NormalizedMeal | null,
  date: string | null,
): SynthesizedFoodEntry | null {
  const itemLabel = extractFoodRecordItemLabel(item);
  if (!itemLabel) {
    return null;
  }
  const amountText = extractFoodRecordAmountText(item);
  if (!amountText) {
    return null;
  }

  const atlasMatch = findBestAtlasMatchForItem(itemLabel, atlasRows);
  const foodId =
    atlasMatch?.food_id === undefined || atlasMatch.food_id === null
      ? ""
      : String(atlasMatch.food_id).trim();
  if (!atlasMatch || !foodId) {
    return null;
  }
  const recoveredFood = recoveredFoods.get(foodId);
  if (!recoveredFood) {
    return null;
  }
  const serving = selectFatsecretServing(
    recoveredFood,
    atlasMatch?.serving_id !== undefined && atlasMatch?.serving_id !== null
      ? String(atlasMatch.serving_id).trim()
      : null,
  );
  if (!serving) {
    return null;
  }
  const servingId =
    typeof serving.serving_id === "string" || typeof serving.serving_id === "number"
      ? String(serving.serving_id).trim()
      : typeof atlasMatch.serving_id === "string" || typeof atlasMatch.serving_id === "number"
        ? String(atlasMatch.serving_id).trim()
        : "";
  if (!servingId) {
    return null;
  }

  const numberOfUnits = deriveFatsecretUnitsFromAmountText(amountText, serving);
  const meal = defaultMeal;
  if (!numberOfUnits || !meal) {
    return null;
  }

  const entryName =
    typeof atlasMatch.product === "string" && atlasMatch.product.trim().length > 0
      ? atlasMatch.product.trim()
      : typeof recoveredFood.food_name === "string" && recoveredFood.food_name.trim().length > 0
          ? recoveredFood.food_name.trim()
        : typeof atlasMatch.name === "string" && atlasMatch.name.trim().length > 0
          ? atlasMatch.name.trim()
          : itemLabel;
  if (!entryName) {
    return null;
  }

  return {
    item: itemLabel,
    meal,
    params: {
      food_id: foodId,
      food_entry_name: entryName,
      serving_id: servingId,
      number_of_units: numberOfUnits,
      meal,
      ...(date ? { date } : {}),
    },
  };
}

function mergeSynthesizedEntries(
  ...groups: Array<readonly SynthesizedFoodEntry[]>
): SynthesizedFoodEntry[] {
  const seenItemNames = new Set<string>();
  const seenParamKeys = new Set<string>();
  const merged: SynthesizedFoodEntry[] = [];

  for (const group of groups) {
    for (const entry of group) {
      const normalizedItem = normalizeFoodItemLabelForMatch(entry.item);
      if (normalizedItem && seenItemNames.has(normalizedItem)) {
        continue;
      }
      const paramKey = [
        entry.params.food_id,
        entry.params.serving_id,
        entry.params.meal,
      ].join("|");
      if (seenParamKeys.has(paramKey)) {
        continue;
      }
      if (normalizedItem) {
        seenItemNames.add(normalizedItem);
      }
      seenParamKeys.add(paramKey);
      merged.push(entry);
    }
  }

  return merged;
}

function computeRecipeHintMultiplier(hint: ParsedRecipeIngredientHint, taskText: string): number {
  if (hint.perUnit) {
    return extractCountForUnit(taskText, hint.perUnit) ?? 1;
  }
  if (
    hint.section
    && /\btortilla\b/iu.test(hint.section)
    && /^1\s+tortilla\b/iu.test(hint.amountText)
  ) {
    return extractCountForUnit(taskText, "taco") ?? 1;
  }
  return 1;
}

function selectRecipeIngredientHints(
  matches: readonly ParsedRecipeMatch[],
  taskText: string,
): ParsedRecipeIngredientHint[] {
  const selected: ParsedRecipeIngredientHint[] = [];
  for (const match of matches) {
    const optionGroups = new Map<string, Array<{ hint: ParsedRecipeIngredientHint; score: number }>>();

    for (const hint of match.ingredients) {
      if (!hint.requiresSelection) {
        selected.push(hint);
        continue;
      }
      const groupKey = hint.section ?? hint.name;
      const score = scoreRecipeIngredientSelection(hint, taskText);
      if (!optionGroups.has(groupKey)) {
        optionGroups.set(groupKey, []);
      }
      optionGroups.get(groupKey)?.push({ hint, score });
    }

    for (const group of optionGroups.values()) {
      const best = [...group].sort((a, b) => b.score - a.score)[0];
      if (best && best.score > 0) {
        selected.push(best.hint);
      }
    }
  }
  return selected;
}

function dedupeSynthesizedEntries(entries: readonly SynthesizedFoodEntry[]): SynthesizedFoodEntry[] {
  const seen = new Set<string>();
  const deduped: SynthesizedFoodEntry[] = [];
  for (const entry of entries) {
    const key = [
      entry.params.food_id,
      entry.params.serving_id,
      entry.params.number_of_units,
      entry.params.meal,
      entry.params.date ?? "",
    ].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}

function buildRecipeDerivedSynthesizedEntries(
  toolCalls: readonly ProviderToolCall[],
  recoveredFoods: ReadonlyMap<string, Record<string, unknown>>,
  atlasRows: readonly Record<string, unknown>[],
  defaultMeal: NormalizedMeal | null,
  date: string | null,
  task: string,
): SynthesizedFoodEntry[] {
  const recipeMatches = extractRecipeMatches(toolCalls);
  if (recipeMatches.length === 0) {
    return [];
  }

  const hints = selectRecipeIngredientHints(recipeMatches, task);
  const synthesized: SynthesizedFoodEntry[] = [];
  for (const hint of hints) {
    const atlasMatch = findBestAtlasMatchForItem(hint.name, atlasRows);
    const foodId =
      atlasMatch?.food_id === undefined || atlasMatch.food_id === null
        ? ""
        : String(atlasMatch.food_id).trim();
    if (!atlasMatch || !foodId) {
      continue;
    }
    const recoveredFood = recoveredFoods.get(foodId);
    if (!recoveredFood) {
      continue;
    }
    const serving = selectFatsecretServing(
      recoveredFood,
      atlasMatch?.serving_id !== undefined && atlasMatch?.serving_id !== null
        ? String(atlasMatch.serving_id).trim()
        : null,
    );
    if (!serving) {
      continue;
    }
    const servingId =
      typeof serving.serving_id === "string" || typeof serving.serving_id === "number"
        ? String(serving.serving_id).trim()
        : typeof atlasMatch.serving_id === "string" || typeof atlasMatch.serving_id === "number"
          ? String(atlasMatch.serving_id).trim()
          : "";
    if (!servingId) {
      continue;
    }
    const grams = hint.grams * computeRecipeHintMultiplier(hint, task);
    const numberOfUnits = deriveFatsecretUnitsFromServing(grams, serving);
    const meal = defaultMeal;
    if (!numberOfUnits || !meal) {
      continue;
    }
    const entryName =
      typeof atlasMatch.product === "string" && atlasMatch.product.trim().length > 0
        ? atlasMatch.product.trim()
        : typeof atlasMatch.name === "string" && atlasMatch.name.trim().length > 0
          ? atlasMatch.name.trim()
          : typeof recoveredFood.food_name === "string" && recoveredFood.food_name.trim().length > 0
            ? recoveredFood.food_name.trim()
            : hint.name;
    synthesized.push({
      item: hint.name,
      meal,
      params: {
        food_id: foodId,
        food_entry_name: entryName,
        serving_id: servingId,
        number_of_units: numberOfUnits,
        meal,
        ...(date ? { date } : {}),
      },
    });
  }

  return dedupeSynthesizedEntries(synthesized);
}

function synthesizeFoodEntryFromUnresolvedItem(
  item: unknown,
  recoveredFoods: ReadonlyMap<string, Record<string, unknown>>,
  atlasRows: readonly Record<string, unknown>[],
  defaultMeal: NormalizedMeal | null,
  date: string | null,
): SynthesizedFoodEntry | null {
  const record = asRecord(item);
  if (!record) {
    return null;
  }
  const itemLabel = extractFoodRecordItemLabel(record);
  const atlasMatch = asRecord(record?.atlas_match) ?? (itemLabel ? findBestAtlasMatchForItem(itemLabel, atlasRows) : null);
  const foodId = atlasMatch?.food_id ?? record?.food_id;
  const normalizedFoodId = foodId === undefined || foodId === null ? "" : String(foodId).trim();
  if (!normalizedFoodId) {
    return null;
  }
  const recoveredFood = recoveredFoods.get(normalizedFoodId);
  if (!recoveredFood) {
    return null;
  }

  const preferredServingId =
    atlasMatch?.serving_id !== undefined && atlasMatch?.serving_id !== null
      ? String(atlasMatch.serving_id).trim()
      : typeof record?.serving_id === "string" || typeof record?.serving_id === "number"
        ? String(record.serving_id).trim()
        : null;
  const serving = selectFatsecretServing(recoveredFood, preferredServingId);
  if (!serving) {
    return null;
  }
  const servingId =
    typeof serving.serving_id === "string" || typeof serving.serving_id === "number"
      ? String(serving.serving_id).trim()
      : preferredServingId;
  if (!servingId) {
    return null;
  }

  const amountText = extractFoodRecordAmountText(record) || itemLabel;
  const grams = extractFoodItemGrams(record);
  const numberOfUnits = grams
    ? deriveFatsecretUnitsFromServing(grams, serving)
    : deriveFatsecretUnitsFromAmountText(amountText, serving);
  if (!numberOfUnits) {
    return null;
  }

  const meal = normalizeMeal(record?.meal) ?? defaultMeal;
  if (!meal) {
    return null;
  }
  const entryName =
    typeof atlasMatch?.product === "string" && atlasMatch.product.trim().length > 0
      ? atlasMatch.product.trim()
      : typeof recoveredFood.food_name === "string" && recoveredFood.food_name.trim().length > 0
          ? recoveredFood.food_name.trim()
        : typeof atlasMatch?.name === "string" && atlasMatch.name.trim().length > 0
          ? atlasMatch.name.trim()
          : itemLabel;
  if (!entryName) {
    return null;
  }

  return {
    item: itemLabel || entryName,
    meal,
    params: {
      food_id: normalizedFoodId,
      food_entry_name: entryName,
      serving_id: servingId,
      number_of_units: numberOfUnits,
      meal,
      ...(date ? { date } : {}),
    },
  };
}

function scoreFatsecretSearchRowForItem(
  itemLabel: string,
  row: Record<string, unknown>,
): number {
  const normalizedItem = normalizeFoodItemLabelForMatch(itemLabel);
  const foodName = typeof row.food_name === "string" ? row.food_name : "";
  const normalizedFoodName = normalizeFoodItemLabelForMatch(foodName);
  if (!normalizedFoodName) {
    return 0;
  }

  let score = 0;
  if (normalizedItem.includes(normalizedFoodName)) {
    score += 20;
  }
  const itemTokens = normalizedItem.split(" ").filter((token) =>
    token.length > 2 && !NUMBER_WORD_VALUES[token] && !["raw", "medium", "small", "large"].includes(token),
  );
  const rowTokens = normalizedFoodName.split(" ").filter((token) => token.length > 2);
  for (const token of rowTokens) {
    if (itemTokens.includes(token)) {
      score += 5;
    }
  }
  if (typeof row.food_type === "string" && row.food_type.toLowerCase() === "generic") {
    score += 2;
  }
  return score;
}

function findBestFatsecretSearchMatchForItem(
  itemLabel: string,
  searchRows: readonly Record<string, unknown>[],
): Record<string, unknown> | null {
  let bestRow: Record<string, unknown> | null = null;
  let bestScore = 0;
  for (const row of searchRows) {
    const score = scoreFatsecretSearchRowForItem(itemLabel, row);
    if (score > bestScore) {
      bestScore = score;
      bestRow = row;
    }
  }
  return bestScore > 0 ? bestRow : null;
}

function fatsecretSearchRowLooksGeneric(row: Record<string, unknown> | null | undefined): boolean {
  if (!row) {
    return false;
  }
  if (typeof row.food_type === "string" && row.food_type.trim().toLowerCase() === "generic") {
    return true;
  }
  const brandName = typeof row.brand_name === "string" ? row.brand_name.trim() : "";
  return brandName.length === 0;
}

function deriveSupplementalFatsecretSearchQueries(
  items: readonly Record<string, unknown>[],
  searchRows: readonly Record<string, unknown>[],
  atlasRows: readonly Record<string, unknown>[],
): string[] {
  const queries = new Set<string>();
  for (const item of items) {
    const existingMatch = asRecord(item.fatsecret_match);
    const existingMatchIsGeneric = fatsecretSearchRowLooksGeneric(existingMatch);
    if (
      item.food_id !== undefined
      && item.food_id !== null
      && String(item.food_id).trim().length > 0
      && !existingMatch
    ) {
      continue;
    }
    const itemLabel = typeof item.item === "string" ? item.item.trim() : "";
    if (!itemLabel) {
      continue;
    }
    if (findBestAtlasMatchForItem(itemLabel, atlasRows)) {
      continue;
    }
    const bestMatch = findBestFatsecretSearchMatchForItem(itemLabel, searchRows);
    const bestMatchIsGeneric = fatsecretSearchRowLooksGeneric(bestMatch);
    if ((bestMatch && bestMatchIsGeneric) || existingMatchIsGeneric) {
      continue;
    }
    const coreQuery = extractCoreFoodSearchPhrase(itemLabel);
    if (!coreQuery) {
      continue;
    }
    queries.add(coreQuery);
    if (!/\braw\b/u.test(coreQuery) && coreQuery.split(/\s+/u).length === 1) {
      queries.add(`${coreQuery} raw`);
    }
  }
  return [...queries];
}

async function runSupplementalFatsecretSearchQueries(
  items: readonly Record<string, unknown>[],
  searchRows: readonly Record<string, unknown>[],
  atlasRows: readonly Record<string, unknown>[],
  replayedToolCalls: readonly AgentToolCall[],
  replayedCallCount: number,
  replayFailureMessages: string[],
  executeReplay: (input: { method: string; params: Record<string, unknown> }) => Promise<unknown>,
): Promise<{
  replayedToolCalls: AgentToolCall[];
  replayedCallCount: number;
  searchRows: Record<string, unknown>[];
}> {
  let nextToolCalls = [...replayedToolCalls];
  let nextReplayCount = replayedCallCount;
  const existingQueries = new Set(
    nextToolCalls.flatMap((toolCall) => {
      if (!isFatsecretToolCall(toolCall) || toolCall.input?.method !== "foods_search") {
        return [];
      }
      const params = normalizeFatsecretParams(toolCall.input?.params);
      const query = typeof params.search_expression === "string"
        ? normalizeFoodItemLabelForMatch(params.search_expression)
        : "";
      return query ? [query] : [];
    }),
  );
  const supplementalQueries = deriveSupplementalFatsecretSearchQueries(items, searchRows, atlasRows)
    .filter((query) => {
      const normalized = normalizeFoodItemLabelForMatch(query);
      return normalized.length > 0 && !existingQueries.has(normalized);
    });

  for (const query of supplementalQueries) {
    try {
      const startedAt = Date.now();
      const output = await executeReplay({
        method: "foods_search",
        params: {
          search_expression: query,
          max_results: 10,
        },
      });
      nextReplayCount += 1;
      nextToolCalls = [
        ...nextToolCalls,
        {
          name: "fatsecret_api",
          input: {
            method: "foods_search",
            params: {
              search_expression: query,
              max_results: 10,
            },
          },
          output,
          durationMs: Date.now() - startedAt,
        },
      ];
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      replayFailureMessages.push(`Runtime replay of supplemental fatsecret_api.foods_search for ${query} failed: ${detail}`);
    }
  }

  return {
    replayedToolCalls: nextToolCalls,
    replayedCallCount: nextReplayCount,
    searchRows: extractFatsecretSearchRows(nextToolCalls),
  };
}

function enrichItemsWithRecoveredSearchMatches(
  items: readonly Record<string, unknown>[],
  searchRows: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  return items.map((item) => {
    const itemLabel = extractFoodRecordItemLabel(item);
    const existingMatch = asRecord(item.fatsecret_match);
    const existingFoodId =
      item.food_id !== undefined && item.food_id !== null && String(item.food_id).trim().length > 0
        ? String(item.food_id).trim()
        : "";
    const existingMatchIsGeneric = fatsecretSearchRowLooksGeneric(existingMatch);
    if (existingFoodId && !existingMatch) {
      return item;
    }
    if (!itemLabel) {
      return item;
    }
    const match = findBestFatsecretSearchMatchForItem(itemLabel, searchRows);
    if (existingFoodId && existingMatchIsGeneric) {
      return item;
    }
    if (
      existingFoodId
      && existingMatch
      && match
      && !fatsecretSearchRowLooksGeneric(match)
    ) {
      return item;
    }
    const foodId =
      match?.food_id === undefined || match?.food_id === null
        ? ""
        : String(match.food_id).trim();
    if (!foodId) {
      return item;
    }
    return {
      ...item,
      food_id: foodId,
      food_name: typeof match?.food_name === "string" ? match.food_name : item["food_name"],
      fatsecret_match: match,
    };
  });
}

function canSynthesizeMissingFatsecretWrites(payload: Record<string, unknown>): boolean {
  const action = typeof payload.action === "string" ? payload.action.trim() : "";
  return [
    "wellness.log_food_items",
    "log_food_items",
    "nutrition.log_food",
    "wellness.log_recipe_meal",
    "log_recipe_meal",
    "nutrition.log_recipe",
  ].includes(action);
}

function rewriteSynthesizedFatsecretWritePayload(
  payload: Record<string, unknown>,
  createdEntries: readonly SynthesizedFoodEntry[],
  replayedCallCount: number,
  recoveredReadMetadata: boolean,
  refreshSucceeded: boolean,
): Record<string, unknown> {
  const createdItemNames = new Set(
    createdEntries
      .map((entry) => normalizeFoodItemLabelForMatch(entry.item))
      .filter((value) => value.length > 0),
  );
  const existingLogged = Array.isArray(payload.logged) ? payload.logged : [];
  const remainingUnresolved = Array.isArray(payload.unresolved)
    ? payload.unresolved.filter((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return false;
      }
      const record = asRecord(item);
      const itemName = record ? extractFoodRecordItemLabel(record) : "";
      const normalizedItemName = normalizeFoodItemLabelForMatch(itemName);
      return !normalizedItemName || !createdItemNames.has(normalizedItemName);
    })
    : [];
  const loggedEntries = [
    ...existingLogged,
    ...createdEntries.map((entry) => ({
      item: entry.item,
      meal: entry.meal,
      ...entry.params,
      recovered: true,
    })),
  ];
  const nextStatus = remainingUnresolved.length === 0 ? "completed" : "partial_success";

  return {
    ...payload,
    status: nextStatus,
    logged: loggedEntries,
    unresolved: remainingUnresolved,
    errors: [],
    follow_up: remainingUnresolved.length === 0
      ? []
      : ["Retry the remaining diary writes now that FatSecret metadata has been recovered."],
    totals: payload.totals && typeof payload.totals === "object" && !Array.isArray(payload.totals)
      ? {
          ...(payload.totals as Record<string, unknown>),
          status: remainingUnresolved.length === 0 ? "confirmed" : "unconfirmed",
          ...(remainingUnresolved.length === 0 ? { reason: null } : {}),
        }
      : payload.totals,
    runtimeReplay: {
      fatsecretApiCalls: replayedCallCount,
      readMetadataRecovered: recoveredReadMetadata,
      diaryWriteRecovered: true,
      diaryRefreshRecovered: refreshSucceeded,
      synthesizedDiaryWrites: createdEntries.length,
    },
  };
}

function fatsecretReadSucceeded(toolCall: ProviderToolCall): boolean {
  if (!isFatsecretToolCall(toolCall)) {
    return false;
  }
  const method = typeof toolCall.input?.method === "string" ? toolCall.input.method.trim() : "";
  if (!method || FATSECRET_WRITE_METHODS.has(method) || method === "food_entries_get") {
    return false;
  }
  return toolCall.output !== null && toolCall.output !== undefined && !toolCallLooksCancelled(toolCall);
}

function describeRecoveredFatsecretReadState(methods: ReadonlySet<string>): {
  unresolvedReason: string;
  totalsReason: string;
  followUp: string;
} {
  if (methods.has("foods_search") && !methods.has("food_get")) {
    return {
      unresolvedReason: "FatSecret search results were recovered after runtime replay, but the original run still did not resolve a confident food match.",
      totalsReason: "FatSecret search results were recovered after runtime replay, but the original run still did not resolve a confident food match or complete a diary write.",
      followUp: "Retry with a more specific food description now that the FatSecret search path itself has recovered.",
    };
  }

  return {
    unresolvedReason: "FatSecret serving metadata was recovered after runtime replay, but the diary write was not attempted in the original run.",
    totalsReason: "FatSecret serving metadata was recovered after runtime replay, but no diary write was executed in the original run.",
    followUp: "Retry once to commit the diary write now that FatSecret metadata has been recovered.",
  };
}

function rewriteRecoveredFatsecretReadPayload(
  payload: Record<string, unknown>,
  replayedCallCount: number,
  recoveredReadMethods: ReadonlySet<string>,
): Record<string, unknown> {
  const recoveryMessage = describeRecoveredFatsecretReadState(recoveredReadMethods);
  const unresolved = Array.isArray(payload.unresolved)
    ? payload.unresolved.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return item;
      }
      const record = item as Record<string, unknown>;
      const reason = typeof record.reason === "string" ? record.reason.trim() : "";
      if (!reason || !/could not be verified|could not complete|cancelled/iu.test(reason)) {
        return item;
      }
      return {
        ...record,
        reason: recoveryMessage.unresolvedReason,
      };
    })
    : payload.unresolved;

  const totals = payload.totals && typeof payload.totals === "object" && !Array.isArray(payload.totals)
    ? {
        ...(payload.totals as Record<string, unknown>),
        status: "unconfirmed",
        reason: recoveryMessage.totalsReason,
      }
    : payload.totals;

  const followUpMessage = recoveryMessage.followUp;
  const nextFollowUp = Array.isArray(payload.follow_up)
    ? [
        ...payload.follow_up.filter((value): value is string => typeof value === "string" && !isCancellationLikeText(value)),
        followUpMessage,
      ]
    : [followUpMessage];

  return {
    ...payload,
    status: "blocked",
    unresolved,
    totals,
    errors: Array.isArray(payload.errors)
      ? payload.errors.filter((value): value is string => typeof value === "string" && !isCancellationLikeText(value))
      : [],
    follow_up: [...new Set(nextFollowUp)],
    runtimeReplay: {
      fatsecretApiCalls: replayedCallCount,
      readMetadataRecovered: true,
      diaryWriteRecovered: false,
      diaryRefreshRecovered: false,
    },
  };
}

async function replayCancelledFatsecretToolCalls(
  result: WorkerAgentResult,
  task: string,
  options: Pick<AgentWorkerOptions, "fatsecretReplayExecutor" | "wellnessToolPaths">,
): Promise<FatsecretReplayOutcome> {
  const cancelledFatsecretCalls = result.toolCalls.filter((toolCall) =>
    isFatsecretToolCall(toolCall) && toolCallLooksCancelled(toolCall),
  );
  if (cancelledFatsecretCalls.length === 0) {
    return {
      result,
      replayedCallCount: 0,
      replayFailureMessages: [],
    };
  }

  const executeReplay = options.fatsecretReplayExecutor
    ?? ((input: { method: string; params: Record<string, unknown> }) =>
      callFatsecretApi(input.method, input.params, options.wellnessToolPaths));

  const replayFailureMessages: string[] = [];
  let replayedCallCount = 0;
  let replayedToolCalls = await Promise.all(result.toolCalls.map(async (toolCall) => {
    if (!isFatsecretToolCall(toolCall) || !toolCallLooksCancelled(toolCall)) {
      return toolCall;
    }

    const method = typeof toolCall.input?.method === "string" ? toolCall.input.method.trim() : "";
    if (!method) {
      replayFailureMessages.push("FatSecret replay skipped because the cancelled tool call did not include a method.");
      return toolCall;
    }

    try {
      const startedAt = Date.now();
      const output = await executeReplay({
        method,
        params: normalizeFatsecretParams(toolCall.input?.params),
      });
      replayedCallCount += 1;
      return {
        ...toolCall,
        output,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      replayFailureMessages.push(`Runtime replay of fatsecret_api.${method} failed: ${detail}`);
      return toolCall;
    }
  }));

  if (replayedCallCount === 0) {
    return {
      result,
      replayedCallCount,
      replayFailureMessages,
    };
  }

  let remainingFatsecretCancellations = replayedToolCalls.some((toolCall) =>
    isFatsecretToolCall(toolCall) && toolCallLooksCancelled(toolCall),
  );
  let hasSuccessfulFatsecretWrite = replayedToolCalls.some((toolCall) =>
    isFatsecretToolCall(toolCall)
    && typeof toolCall.input?.method === "string"
    && FATSECRET_WRITE_METHODS.has(toolCall.input.method.trim())
    && fatsecretWriteSucceeded(toolCall.output),
  );
  let completedDiaryRefresh = replayedToolCalls.some((toolCall) =>
    isFatsecretToolCall(toolCall)
    && toolCall.input?.method === "food_entries_get"
    && toolCall.output !== null
    && toolCall.output !== undefined
    && !toolCallLooksCancelled(toolCall),
  );
  const recoveredFatsecretReadCalls = replayedToolCalls.filter((toolCall) => fatsecretReadSucceeded(toolCall));
  const recoveredFatsecretReadMetadata = recoveredFatsecretReadCalls.length > 0;
  const recoveredFatsecretReadMethods = new Set(
    recoveredFatsecretReadCalls
      .map((toolCall) => (typeof toolCall.input?.method === "string" ? toolCall.input.method.trim() : ""))
      .filter((method) => method.length > 0),
  );
  const payload = parseStructuredWorkerPayload(result.text);
  let synthesizedEntries: SynthesizedFoodEntry[] = [];

  if (
    !remainingFatsecretCancellations
    && replayFailureMessages.length === 0
    && payload
    && !hasSuccessfulFatsecretWrite
    && recoveredFatsecretReadMetadata
    && canSynthesizeMissingFatsecretWrites(payload)
  ) {
    let recoveredFoods = buildRecoveredFoodGetMap(replayedToolCalls);
    const atlasRows = extractAtlasRows(replayedToolCalls);
    let searchRows = extractFatsecretSearchRows(replayedToolCalls);
    const defaultMeal = extractMealHint(payload, task);
    const loggedDate = extractLoggedDate(payload, replayedToolCalls);
    let resolvedItems = enrichItemsWithRecoveredSearchMatches(extractResolvedItems(payload), searchRows);
    let unresolvedItems = enrichItemsWithRecoveredSearchMatches(
      Array.isArray(payload.unresolved)
        ? payload.unresolved
            .map((item) => asRecord(item))
            .filter((item): item is Record<string, unknown> => item !== null)
        : [],
      searchRows,
    );

    const supplementalSearchOutcome = await runSupplementalFatsecretSearchQueries(
      [...resolvedItems, ...unresolvedItems],
      searchRows,
      atlasRows,
      replayedToolCalls,
      replayedCallCount,
      replayFailureMessages,
      executeReplay,
    );
    replayedToolCalls = supplementalSearchOutcome.replayedToolCalls;
    replayedCallCount = supplementalSearchOutcome.replayedCallCount;
    searchRows = supplementalSearchOutcome.searchRows;
    resolvedItems = enrichItemsWithRecoveredSearchMatches(extractResolvedItems(payload), searchRows);
    unresolvedItems = enrichItemsWithRecoveredSearchMatches(
      Array.isArray(payload.unresolved)
        ? payload.unresolved
            .map((item) => asRecord(item))
            .filter((item): item is Record<string, unknown> => item !== null)
        : [],
      searchRows,
    );

    const missingRecoveredFoodIds = [...new Set(
      [...resolvedItems, ...unresolvedItems]
        .map((item) => item.food_id)
        .filter((foodId): foodId is string | number => foodId !== undefined && foodId !== null && String(foodId).trim().length > 0)
        .map((foodId) => String(foodId).trim()),
    )].filter((foodId) => !recoveredFoods.has(foodId));

    if (missingRecoveredFoodIds.length > 0) {
      for (const foodId of missingRecoveredFoodIds) {
        try {
          const startedAt = Date.now();
          const output = await executeReplay({
            method: "food_get",
            params: { food_id: foodId },
          });
          replayedCallCount += 1;
          replayedToolCalls = [
            ...replayedToolCalls,
            {
              name: "fatsecret_api",
              input: {
                method: "food_get",
                params: { food_id: foodId },
              },
              output,
              durationMs: Date.now() - startedAt,
            },
          ];
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          replayFailureMessages.push(`Runtime replay of synthesized fatsecret_api.food_get for ${foodId} failed: ${detail}`);
        }
      }
      recoveredFoods = buildRecoveredFoodGetMap(replayedToolCalls);
      resolvedItems = enrichItemsWithRecoveredSearchMatches(extractResolvedItems(payload), searchRows);
      unresolvedItems = enrichItemsWithRecoveredSearchMatches(
        Array.isArray(payload.unresolved)
          ? payload.unresolved
              .map((item) => asRecord(item))
              .filter((item): item is Record<string, unknown> => item !== null)
          : [],
        searchRows,
      );
    }
    const writeCandidatesFromResolvedItems = resolvedItems
      .map((item) => synthesizeFoodEntryFromResolvedItem(item, recoveredFoods, atlasRows, defaultMeal, loggedDate))
      .filter((entry): entry is SynthesizedFoodEntry => entry !== null);
    const writeCandidatesFromRecoveredResultItems = resolvedItems
      .map((item) => synthesizeFoodEntryFromUnresolvedItem(item, recoveredFoods, atlasRows, defaultMeal, loggedDate))
      .filter((entry): entry is SynthesizedFoodEntry => entry !== null);
    const writeCandidatesFromUnresolved = unresolvedItems
      .map((item) => synthesizeFoodEntryFromUnresolvedItem(item, recoveredFoods, atlasRows, defaultMeal, loggedDate))
      .filter((entry): entry is SynthesizedFoodEntry => entry !== null);
    const writeCandidatesFromRecipe = buildRecipeDerivedSynthesizedEntries(
      result.toolCalls,
      recoveredFoods,
      atlasRows,
      defaultMeal,
      loggedDate,
      task,
    );
    const writeCandidates = mergeSynthesizedEntries(
      writeCandidatesFromResolvedItems,
      writeCandidatesFromRecoveredResultItems,
      writeCandidatesFromUnresolved,
      writeCandidatesFromRecipe,
    );

    if (writeCandidates.length > 0) {
      for (const candidate of writeCandidates) {
        try {
          const startedAt = Date.now();
          const output = await executeReplay({
            method: "food_entry_create",
            params: candidate.params,
          });
          replayedCallCount += 1;
          replayedToolCalls = [
            ...replayedToolCalls,
            {
              name: "fatsecret_api",
              input: {
                method: "food_entry_create",
                params: candidate.params,
              },
              output,
              durationMs: Date.now() - startedAt,
            },
          ];
          if (fatsecretWriteSucceeded(output)) {
            synthesizedEntries = [...synthesizedEntries, candidate];
          } else {
            replayFailureMessages.push(
              `Runtime replay of synthesized fatsecret_api.food_entry_create for ${candidate.item} returned a non-success response.`,
            );
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          replayFailureMessages.push(
            `Runtime replay of synthesized fatsecret_api.food_entry_create for ${candidate.item} failed: ${detail}`,
          );
        }
      }

      if (synthesizedEntries.length > 0) {
        try {
          const refreshParams = loggedDate ? { date: loggedDate } : {};
          const startedAt = Date.now();
          const output = await executeReplay({
            method: "food_entries_get",
            params: refreshParams,
          });
          replayedCallCount += 1;
          replayedToolCalls = [
            ...replayedToolCalls,
            {
              name: "fatsecret_api",
              input: {
                method: "food_entries_get",
                params: refreshParams,
              },
              output,
              durationMs: Date.now() - startedAt,
            },
          ];
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          replayFailureMessages.push(`Runtime replay of fatsecret_api.food_entries_get failed after synthesized diary writes: ${detail}`);
        }
      }

      remainingFatsecretCancellations = replayedToolCalls.some((toolCall) =>
        isFatsecretToolCall(toolCall) && toolCallLooksCancelled(toolCall),
      );
      hasSuccessfulFatsecretWrite = replayedToolCalls.some((toolCall) =>
        isFatsecretToolCall(toolCall)
        && typeof toolCall.input?.method === "string"
        && FATSECRET_WRITE_METHODS.has(toolCall.input.method.trim())
        && fatsecretWriteSucceeded(toolCall.output),
      );
      completedDiaryRefresh = replayedToolCalls.some((toolCall) =>
        isFatsecretToolCall(toolCall)
        && toolCall.input?.method === "food_entries_get"
        && toolCall.output !== null
        && toolCall.output !== undefined
        && !toolCallLooksCancelled(toolCall),
      );
    }
  }

  const canRewriteBlockedPayload =
    !remainingFatsecretCancellations
    && replayFailureMessages.length === 0
    && payload
    && (
      payloadIsCancellationOnly(payload)
      || hasSuccessfulFatsecretWrite
      || completedDiaryRefresh
      || recoveredFatsecretReadMetadata
    );

  const nextText = canRewriteBlockedPayload
    ? JSON.stringify(
        synthesizedEntries.length > 0
          ? rewriteSynthesizedFatsecretWritePayload(
              payload,
              synthesizedEntries,
              replayedCallCount,
              recoveredFatsecretReadMetadata,
              completedDiaryRefresh,
            )
          : hasSuccessfulFatsecretWrite || completedDiaryRefresh
          ? {
              ...payload,
              status: hasSuccessfulFatsecretWrite ? "completed" : "ok",
              unresolved: [],
              errors: [],
              follow_up: [],
              runtimeReplay: {
                fatsecretApiCalls: replayedCallCount,
                readMetadataRecovered: recoveredFatsecretReadMetadata,
                diaryWriteRecovered: hasSuccessfulFatsecretWrite,
                diaryRefreshRecovered: completedDiaryRefresh,
              },
            }
          : rewriteRecoveredFatsecretReadPayload(payload, replayedCallCount, recoveredFatsecretReadMethods),
      )
    : result.text;

  return {
    result: {
      ...result,
      text: nextText,
      toolCalls: replayedToolCalls,
    },
    replayedCallCount,
    replayFailureMessages,
  };
}

async function synthesizeFatsecretWritesFromAvailableState(
  result: WorkerAgentResult,
  task: string,
  options: Pick<AgentWorkerOptions, "fatsecretReplayExecutor" | "wellnessToolPaths">,
): Promise<FatsecretReplayOutcome> {
  const payload = parseStructuredWorkerPayload(result.text);
  const hasSuccessfulFatsecretWrite = result.toolCalls.some((toolCall) =>
    isFatsecretToolCall(toolCall)
    && typeof toolCall.input?.method === "string"
    && FATSECRET_WRITE_METHODS.has(toolCall.input.method.trim())
    && fatsecretWriteSucceeded(toolCall.output),
  );

  if (!payload || hasSuccessfulFatsecretWrite || !canSynthesizeMissingFatsecretWrites(payload)) {
    return {
      result,
      replayedCallCount: 0,
      replayFailureMessages: [],
    };
  }

  const executeReplay = options.fatsecretReplayExecutor
    ?? ((input: { method: string; params: Record<string, unknown> }) =>
      callFatsecretApi(input.method, input.params, options.wellnessToolPaths));

  let replayedCallCount = 0;
  const replayFailureMessages: string[] = [];
  let replayedToolCalls = [...result.toolCalls];
  let recoveredFoods = buildRecoveredFoodGetMap(replayedToolCalls);
  const atlasRows = extractAtlasRows(replayedToolCalls);
  let searchRows = extractFatsecretSearchRows(replayedToolCalls);
  const defaultMeal = extractMealHint(payload, task);
  const loggedDate = extractLoggedDate(payload, replayedToolCalls);
  let resolvedItems = enrichItemsWithRecoveredSearchMatches(extractResolvedItems(payload), searchRows);
  let unresolvedItems = enrichItemsWithRecoveredSearchMatches(
    Array.isArray(payload.unresolved)
      ? payload.unresolved
          .map((item) => asRecord(item))
          .filter((item): item is Record<string, unknown> => item !== null)
      : [],
    searchRows,
  );

  const supplementalSearchOutcome = await runSupplementalFatsecretSearchQueries(
    [...resolvedItems, ...unresolvedItems],
    searchRows,
    atlasRows,
    replayedToolCalls,
    replayedCallCount,
    replayFailureMessages,
    executeReplay,
  );
  replayedToolCalls = supplementalSearchOutcome.replayedToolCalls;
  replayedCallCount = supplementalSearchOutcome.replayedCallCount;
  searchRows = supplementalSearchOutcome.searchRows;
  resolvedItems = enrichItemsWithRecoveredSearchMatches(extractResolvedItems(payload), searchRows);
  unresolvedItems = enrichItemsWithRecoveredSearchMatches(
    Array.isArray(payload.unresolved)
      ? payload.unresolved
          .map((item) => asRecord(item))
          .filter((item): item is Record<string, unknown> => item !== null)
      : [],
    searchRows,
  );

  const missingRecoveredFoodIds = [...new Set(
    [...resolvedItems, ...unresolvedItems]
      .map((item) => item.food_id)
      .filter((foodId): foodId is string | number => foodId !== undefined && foodId !== null && String(foodId).trim().length > 0)
      .map((foodId) => String(foodId).trim()),
  )].filter((foodId) => !recoveredFoods.has(foodId));

  for (const foodId of missingRecoveredFoodIds) {
    try {
      const startedAt = Date.now();
      const output = await executeReplay({
        method: "food_get",
        params: { food_id: foodId },
      });
      replayedCallCount += 1;
      replayedToolCalls = [
        ...replayedToolCalls,
        {
          name: "fatsecret_api",
          input: {
            method: "food_get",
            params: { food_id: foodId },
          },
          output,
          durationMs: Date.now() - startedAt,
        },
      ];
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      replayFailureMessages.push(`Runtime replay of synthesized fatsecret_api.food_get for ${foodId} failed: ${detail}`);
    }
  }

  if (replayedCallCount > 0) {
    recoveredFoods = buildRecoveredFoodGetMap(replayedToolCalls);
    resolvedItems = enrichItemsWithRecoveredSearchMatches(extractResolvedItems(payload), searchRows);
    unresolvedItems = enrichItemsWithRecoveredSearchMatches(
      Array.isArray(payload.unresolved)
        ? payload.unresolved
            .map((item) => asRecord(item))
            .filter((item): item is Record<string, unknown> => item !== null)
        : [],
      searchRows,
    );
  }

  const writeCandidatesFromResolvedItems = resolvedItems
    .map((item) => synthesizeFoodEntryFromResolvedItem(item, recoveredFoods, atlasRows, defaultMeal, loggedDate))
    .filter((entry): entry is SynthesizedFoodEntry => entry !== null);
  const writeCandidatesFromRecoveredResultItems = resolvedItems
    .map((item) => synthesizeFoodEntryFromUnresolvedItem(item, recoveredFoods, atlasRows, defaultMeal, loggedDate))
    .filter((entry): entry is SynthesizedFoodEntry => entry !== null);
  const writeCandidatesFromUnresolved = unresolvedItems
    .map((item) => synthesizeFoodEntryFromUnresolvedItem(item, recoveredFoods, atlasRows, defaultMeal, loggedDate))
    .filter((entry): entry is SynthesizedFoodEntry => entry !== null);
  const writeCandidatesFromRecipe = buildRecipeDerivedSynthesizedEntries(
    replayedToolCalls,
    recoveredFoods,
    atlasRows,
    defaultMeal,
    loggedDate,
    task,
  );
  const writeCandidates = mergeSynthesizedEntries(
    writeCandidatesFromResolvedItems,
    writeCandidatesFromRecoveredResultItems,
    writeCandidatesFromUnresolved,
    writeCandidatesFromRecipe,
  );

  const synthesizedEntries: SynthesizedFoodEntry[] = [];
  for (const candidate of writeCandidates) {
    try {
      const startedAt = Date.now();
      const output = await executeReplay({
        method: "food_entry_create",
        params: candidate.params,
      });
      replayedCallCount += 1;
      replayedToolCalls = [
        ...replayedToolCalls,
        {
          name: "fatsecret_api",
          input: {
            method: "food_entry_create",
            params: candidate.params,
          },
          output,
          durationMs: Date.now() - startedAt,
        },
      ];
      if (fatsecretWriteSucceeded(output)) {
        synthesizedEntries.push(candidate);
      } else {
        replayFailureMessages.push(
          `Runtime replay of synthesized fatsecret_api.food_entry_create for ${candidate.item} returned a non-success response.`,
        );
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      replayFailureMessages.push(
        `Runtime replay of synthesized fatsecret_api.food_entry_create for ${candidate.item} failed: ${detail}`,
      );
    }
  }

  if (synthesizedEntries.length === 0 || replayFailureMessages.length > 0) {
    return {
      result,
      replayedCallCount,
      replayFailureMessages,
    };
  }

  let completedDiaryRefresh = false;
  try {
    const refreshParams = loggedDate ? { date: loggedDate } : {};
    const startedAt = Date.now();
    const output = await executeReplay({
      method: "food_entries_get",
      params: refreshParams,
    });
    replayedCallCount += 1;
    replayedToolCalls = [
      ...replayedToolCalls,
      {
        name: "fatsecret_api",
        input: {
          method: "food_entries_get",
          params: refreshParams,
        },
        output,
        durationMs: Date.now() - startedAt,
      },
    ];
    completedDiaryRefresh = true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    replayFailureMessages.push(`Runtime replay of fatsecret_api.food_entries_get failed after synthesized diary writes: ${detail}`);
  }

  if (replayFailureMessages.length > 0) {
    return {
      result,
      replayedCallCount,
      replayFailureMessages,
    };
  }

  return {
    result: {
      ...result,
      text: JSON.stringify(
        rewriteSynthesizedFatsecretWritePayload(
          payload,
          synthesizedEntries,
          replayedCallCount,
          true,
          completedDiaryRefresh,
        ),
      ),
      toolCalls: replayedToolCalls,
    },
    replayedCallCount,
    replayFailureMessages,
  };
}

interface ShoppingBootstrapRecoveryOutcome {
  result: WorkerAgentResult;
  replayedCallCount: number;
  replayFailureMessages: string[];
  recoveredContextLines: string[];
}

interface ShoppingMutationRecoveryOutcome {
  result: WorkerAgentResult;
  replayedCallCount: number;
  replayFailureMessages: string[];
}

interface RecipeReplayOutcome {
  result: WorkerAgentResult;
  replayedCallCount: number;
  replayFailureMessages: string[];
}

interface ShoppingRecoveryTarget {
  targetItem: string;
  targetQuantity: number;
  pageUrl: string | null;
}

interface ShoppingSnapshotTargetState {
  addRef: number | null;
  quantityButtonRef: number | null;
  increaseRef: number | null;
  decreaseRef: number | null;
  currentQuantity: number | null;
  closeDialogRef: number | null;
  cartSummary: string | null;
}

function isShoppingBrowserOrderTask(task: string): boolean {
  return /Intent contract:\s*shopping\.browser_order_action/iu.test(task)
    || /Intent contract:\s*shopping\.browser_order_lookup/iu.test(task);
}

function extractRequestedQuantityFromShoppingText(value: string): number | null {
  const digitMatch = value.match(/\b(?:quantity\s+)?(\d+)\b/iu);
  if (digitMatch?.[1]) {
    return Number.parseInt(digitMatch[1], 10);
  }
  const wordMatch = value.match(
    /\b(?:quantity\s+)?(a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/iu,
  );
  if (!wordMatch?.[1]) {
    return null;
  }
  return NUMBER_WORD_VALUES[wordMatch[1].toLowerCase()] ?? null;
}

function extractShoppingRecoveryTarget(result: WorkerAgentResult, task: string): ShoppingRecoveryTarget | null {
  const payload = parseStructuredWorkerPayload(result.text);
  if (!payload) {
    return null;
  }
  const results = Array.isArray(payload.results) ? payload.results : [];
  for (const entry of results) {
    const record = asRecord(entry);
    if (!record) {
      continue;
    }
    const retailer = typeof record.retailer === "string" ? record.retailer.trim().toLowerCase() : "";
    const pageContext = asRecord(record.page_context);
    const preflightContext = asRecord(record.preflight_context_used);
    const requestedMutation = typeof record.requested_mutation === "string"
      ? record.requested_mutation.trim()
      : "";
    const requestedItem = typeof record.requested_item === "string"
      ? record.requested_item.trim()
      : "";
    const matchingResult = typeof pageContext?.matching_result === "string"
      ? pageContext.matching_result.trim().replace(/\s+at\s+\$[\d.]+.*$/iu, "")
      : "";
    const likelyHistoryMatch = typeof preflightContext?.likely_history_match === "string"
      ? preflightContext.likely_history_match.trim()
      : "";
    const taskItem = extractShoppingItemQuery(task) ?? "";
    const targetItem = [
      typeof record.target_item === "string" ? record.target_item.trim() : "",
      typeof record.item === "string" ? record.item.trim() : "",
      likelyHistoryMatch,
      matchingResult,
      requestedItem,
      taskItem,
    ].find((value) => value.length > 0) ?? "";
    const targetQuantity = Math.max(
      1,
      Math.round(
        parseFiniteNumber(record.target_quantity)
          ?? parseFiniteNumber(record.quantity_requested)
          ?? parseFiniteNumber(record.requested_quantity)
          ?? extractRequestedQuantityFromShoppingText(requestedMutation)
          ?? parseFiniteNumber(asRecord(record.extracted_entities)?.quantity)
          ?? extractRequestedQuantityFromShoppingText(task)
          ?? 1,
      ),
    );
    const pageUrlCandidate = [
      typeof pageContext?.url === "string" ? pageContext.url.trim() : "",
      typeof preflightContext?.active_url === "string" ? preflightContext.active_url.trim() : "",
      typeof preflightContext?.active_page === "string" ? preflightContext.active_page.trim() : "",
    ].find((value) => /^https?:\/\//iu.test(value));
    const pageUrl = pageUrlCandidate && pageUrlCandidate.length > 0 ? pageUrlCandidate : null;
    const inferredRetailer = retailer.length > 0
      ? retailer
      : /\bwalmart\b/iu.test(requestedMutation) || /\bwalmart\b/iu.test(task)
        ? "walmart"
        : "";
    if (inferredRetailer === "walmart" && targetItem.length > 0) {
      return {
        targetItem,
        targetQuantity,
        pageUrl,
      };
    }
  }
  return null;
}

function normalizeShoppingLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/\bgv\b/gu, "great value")
    .replace(/\busual\b/gu, " ")
    .replace(/[^a-z0-9]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function labelsReferToSameItem(targetItem: string, candidate: string): boolean {
  const normalizedTarget = normalizeShoppingLabel(targetItem);
  const normalizedCandidate = normalizeShoppingLabel(candidate);
  if (!normalizedTarget || !normalizedCandidate) {
    return false;
  }
  if (normalizedCandidate.includes(normalizedTarget) || normalizedTarget.includes(normalizedCandidate)) {
    return true;
  }

  const targetTokens = new Set(normalizedTarget.split(" ").filter(Boolean));
  const candidateTokens = new Set(normalizedCandidate.split(" ").filter(Boolean));
  if (targetTokens.size === 0 || candidateTokens.size === 0) {
    return false;
  }

  const sharedCount = [...targetTokens].filter((token) => candidateTokens.has(token)).length;
  return sharedCount >= Math.min(targetTokens.size, candidateTokens.size);
}

function parseSnapshotRefLine(line: string): { ref: number; label: string } | null {
  const match = line.match(/^\[(\d+)\]\s+\w+\s+"(.+)"$/u);
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return {
    ref: Number.parseInt(match[1], 10),
    label: match[2],
  };
}

function parseShoppingSnapshotTargetState(
  snapshot: string,
  targetItem: string,
): ShoppingSnapshotTargetState {
  const state: ShoppingSnapshotTargetState = {
    addRef: null,
    quantityButtonRef: null,
    increaseRef: null,
    decreaseRef: null,
    currentQuantity: null,
    closeDialogRef: null,
    cartSummary: null,
  };

  for (const line of snapshot.split("\n")) {
    const parsed = parseSnapshotRefLine(line.trim());
    if (!parsed) {
      continue;
    }
    const { ref, label } = parsed;

    if (/^Close dialog$/iu.test(label)) {
      state.closeDialogRef = ref;
      continue;
    }

    if (/^Cart contains\s+\d+\s+item/iu.test(label)) {
      state.cartSummary = label;
      continue;
    }

    const addMatch = label.match(/^Add to cart - (.+)$/iu);
    if (addMatch?.[1] && labelsReferToSameItem(targetItem, addMatch[1])) {
      state.addRef = ref;
      state.currentQuantity ??= 0;
      continue;
    }

    const quantityButtonMatch = label.match(/^(\d+)\s+in cart,\s+(.+)$/iu);
    if (quantityButtonMatch?.[1] && quantityButtonMatch[2] && labelsReferToSameItem(targetItem, quantityButtonMatch[2])) {
      state.quantityButtonRef = ref;
      state.currentQuantity = Number.parseInt(quantityButtonMatch[1], 10);
      continue;
    }

    const increaseMatch = label.match(/^Increase quantity (.+), Current Quantity (\d+)$/iu);
    if (increaseMatch?.[1] && increaseMatch[2] && labelsReferToSameItem(targetItem, increaseMatch[1])) {
      state.increaseRef = ref;
      state.currentQuantity = Number.parseInt(increaseMatch[2], 10);
      continue;
    }

    const decreaseMatch = label.match(/^Decrease quantity (.+), Current Quantity (\d+)$/iu);
    if (decreaseMatch?.[1] && decreaseMatch[2] && labelsReferToSameItem(targetItem, decreaseMatch[1])) {
      state.decreaseRef = ref;
      state.currentQuantity = Number.parseInt(decreaseMatch[2], 10);
      continue;
    }
  }

  return state;
}

function extractBrowserSnapshotText(output: unknown): string | null {
  if (typeof output === "string" && output.trim().length > 0) {
    return output;
  }
  const record = asRecord(output);
  const result = typeof record?.result === "string" ? record.result : null;
  return result && result.trim().length > 0 ? result : null;
}

function rewriteRecoveredShoppingMutationPayload(
  payload: Record<string, unknown>,
  target: ShoppingRecoveryTarget,
  finalQuantity: number,
  cartSummary: string | null,
): Record<string, unknown> {
  const results = Array.isArray(payload.results) ? payload.results : [];
  const nextResults = results.map((entry) => {
    const record = asRecord(entry);
    if (!record) {
      return entry;
    }
    const retailer = typeof record.retailer === "string" ? record.retailer.trim().toLowerCase() : "";
    const targetItem = typeof record.target_item === "string" ? record.target_item.trim() : "";
    if (retailer !== "walmart" || !labelsReferToSameItem(target.targetItem, targetItem)) {
      return entry;
    }
    const pageContext = asRecord(record.page_context) ?? {};
    return {
      ...record,
      target_quantity: finalQuantity,
      page_context: {
        ...pageContext,
        cart_after: cartSummary ?? pageContext.cart_after ?? null,
      },
      mutation_outcome: `Added to cart and verified quantity ${finalQuantity}.`,
    };
  });

  const existingArtifacts = Array.isArray(payload.artifacts) ? payload.artifacts : [];

  return {
    ...payload,
    status: "completed",
    results: nextResults,
    errors: [],
    follow_up: [],
    artifacts: [
      ...existingArtifacts,
      {
        type: "recovered_runtime_commit",
        details: `Runtime recovered the Walmart cart mutation and verified quantity ${finalQuantity}${cartSummary ? ` (${cartSummary})` : ""}.`,
      },
    ],
    committedStateVerified: true,
    verifiedWriteOutcome: true,
    runtimeReplay: {
      ...(asRecord(payload.runtimeReplay) ?? {}),
      shoppingMutationRecovered: true,
      writeVerified: true,
      finalQuantity,
      cartSummary,
    },
  };
}

function recipeWriteSucceeded(output: unknown): boolean {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return false;
  }
  const record = output as Record<string, unknown>;
  if (record.success === true || record.ok === true) {
    return true;
  }
  const action = typeof record.action === "string" ? record.action.trim().toLowerCase() : "";
  if (action === "updated" || action === "created") {
    return true;
  }
  return typeof record.file === "string" && record.file.trim().length > 0;
}

function rewriteRecoveredRecipeWritePayload(
  payload: Record<string, unknown>,
  recipeName: string,
  replayedCallCount: number,
): Record<string, unknown> {
  const existingArtifacts = Array.isArray(payload.artifacts) ? payload.artifacts : [];
  const priorResults = Array.isArray(payload.results)
    ? payload.results.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];

  return {
    ...payload,
    status: "completed",
    results: [
      ...priorResults,
      `Runtime replay confirmed the recipe write for "${recipeName}".`,
    ],
    unresolved: [],
    errors: [],
    follow_up: [],
    artifacts: [
      ...existingArtifacts,
      {
        type: "recovered_runtime_commit",
        details: `Runtime replayed recipe_write for "${recipeName}" and confirmed the file write.`,
      },
    ],
    committedStateVerified: true,
    verifiedWriteOutcome: true,
    runtimeReplay: {
      ...(asRecord(payload.runtimeReplay) ?? {}),
      recipeWriteRecovered: true,
      writeVerified: true,
      recipeWriteCalls: replayedCallCount,
      recipe: recipeName,
    },
  };
}

async function buildShoppingPreflightContext(
  task: string,
  options: Pick<
    AgentWorkerOptions,
    "browserLaunchExecutor" | "browserReadExecutor" | "walmartHistoryPreferencesExecutor" | "walmartHistoryAnalyzeExecutor"
  >,
): Promise<string[]> {
  if (!isShoppingBrowserOrderTask(task)) {
    return [];
  }

  const lines: string[] = [];
  const itemQuery = extractShoppingItemQuery(task);
  const executeBrowserLaunch = options.browserLaunchExecutor
    ?? (async (input: { port: number }) => ({ result: await getBrowserManager().launch(input.port) }));
  const executeBrowserRead = options.browserReadExecutor
    ?? (async (input: { action: "status" | "open" | "snapshot"; url?: string; interactive?: boolean }) => {
      const browserManager = getBrowserManager();
      switch (input.action) {
        case "status":
          return browserManager.status();
        case "open":
          return { result: await browserManager.open(input.url ?? "") };
        case "snapshot":
          return { result: await browserManager.snapshot({ interactive: input.interactive === true }) };
      }
    });
  const executeWalmartHistoryPreferences = options.walmartHistoryPreferencesExecutor
    ?? (async () => summarizePreferences());
  const executeWalmartHistoryAnalyze = options.walmartHistoryAnalyzeExecutor
    ?? (async (input: { daysBack?: number; topN?: number }) =>
      buildWalmartHistoryAnalyzeOutput(input.daysBack ?? 365, input.topN ?? 20));

  try {
    const output = await executeBrowserLaunch({ port: 9223 });
    lines.push(`Preflight browser launch at runtime: ${JSON.stringify(output)}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    lines.push(`Preflight browser launch failed: ${detail}`);
  }

  try {
    const output = await executeWalmartHistoryPreferences();
    lines.push(`Preflight Walmart history_preferences at runtime: ${JSON.stringify(output)}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    lines.push(`Preflight Walmart history_preferences failed: ${detail}`);
  }

  if (itemQuery) {
    try {
      await executeWalmartHistoryAnalyze({ daysBack: 365, topN: 50 });
      const matches = resolveShoppingHistoryCandidates(itemQuery, 365, 5);
      if (matches.length > 0) {
        lines.push(`Likely Walmart history matches for "${itemQuery}": ${JSON.stringify(matches)}`);
      } else {
        lines.push(`No specific Walmart receipt-history match was found for "${itemQuery}".`);
      }

      const preferredQuery = matches[0]?.name ?? itemQuery;
      const searchUrl = `https://www.walmart.com/search?q=${encodeURIComponent(preferredQuery)}`;
      const openOutput = await executeBrowserRead({ action: "open", url: searchUrl });
      lines.push(`Preflight browser open at runtime for "${preferredQuery}": ${JSON.stringify(openOutput)}`);
      lines.push(`The exact Walmart search results page for "${preferredQuery}" is already open. Start with a browser snapshot on the current page instead of re-launching or re-searching unless the page state proves stale.`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      lines.push(`Preflight shopping search context failed: ${detail}`);
    }
  }

  return lines;
}

async function replayCancelledShoppingBootstrapCalls(
  result: WorkerAgentResult,
  options: Pick<
    AgentWorkerOptions,
    "browserLaunchExecutor" | "browserReadExecutor" | "walmartHistoryPreferencesExecutor" | "walmartHistoryAnalyzeExecutor"
  >,
): Promise<ShoppingBootstrapRecoveryOutcome> {
  const withBootstrapTimeout = async <T>(
    promise: Promise<T>,
    ms: number,
    label: string,
  ): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  };
  const runBootstrapBrowserLaunch = async (step: string, input: { port: number }, timeoutMs = 20_000) => {
    shoppingDebug("shopping-bootstrap", `step:start ${step}`);
    const startedAt = Date.now();
    const output = await withBootstrapTimeout(
      executeBrowserLaunch(input),
      timeoutMs,
      `Shopping bootstrap ${step}`,
    );
    shoppingDebug("shopping-bootstrap", `step:finish ${step} ms=${Date.now() - startedAt}`);
    return output;
  };
  const runBootstrapBrowserRead = async (
    step: string,
    input: { action: "status" | "open" | "snapshot"; url?: string; interactive?: boolean },
    timeoutMs = input.action === "open" ? 35_000 : 15_000,
  ) => {
    shoppingDebug("shopping-bootstrap", `step:start ${step}`);
    const startedAt = Date.now();
    const output = await withBootstrapTimeout(
      executeBrowserRead(input),
      timeoutMs,
      `Shopping bootstrap ${step}`,
    );
    shoppingDebug("shopping-bootstrap", `step:finish ${step} ms=${Date.now() - startedAt}`);
    return output;
  };

  const cancelledBootstrapCalls = result.toolCalls.filter((toolCall) =>
    toolCallLooksCancelled(toolCall)
    && (
      isBrowserLaunchToolCall(toolCall)
      || isBrowserStatusToolCall(toolCall)
      || isBrowserOpenToolCall(toolCall)
      || isBrowserSnapshotToolCall(toolCall)
      || isWalmartHistoryPreferencesToolCall(toolCall)
      || isWalmartHistoryAnalyzeToolCall(toolCall)
    ),
  );

  if (cancelledBootstrapCalls.length === 0) {
    return {
      result,
      replayedCallCount: 0,
      replayFailureMessages: [],
      recoveredContextLines: [],
    };
  }

  const executeBrowserLaunch = options.browserLaunchExecutor
    ?? (async (input: { port: number }) => ({ result: await getBrowserManager().launch(input.port) }));
  const executeBrowserRead = options.browserReadExecutor
    ?? (async (input: { action: "status" | "open" | "snapshot"; url?: string; interactive?: boolean }) => {
      const browserManager = getBrowserManager();
      switch (input.action) {
        case "status":
          return browserManager.status();
        case "open":
          return { result: await browserManager.open(input.url ?? "") };
        case "snapshot":
          return { result: await browserManager.snapshot({ interactive: input.interactive === true }) };
      }
    });
  const executeWalmartHistoryPreferences = options.walmartHistoryPreferencesExecutor
    ?? (async () => summarizePreferences());
  const executeWalmartHistoryAnalyze = options.walmartHistoryAnalyzeExecutor
    ?? (async (input: { daysBack?: number; topN?: number }) =>
      buildWalmartHistoryAnalyzeOutput(input.daysBack ?? 365, input.topN ?? 20));

  const replayFailureMessages: string[] = [];
  const recoveredContextLines: string[] = [];
  let replayedCallCount = 0;

  const replayedToolCalls: AgentToolCall[] = [];
  for (const toolCall of result.toolCalls) {
    if (!toolCallLooksCancelled(toolCall)) {
      replayedToolCalls.push(toolCall);
      continue;
    }

    if (isBrowserLaunchToolCall(toolCall)) {
      const port = typeof toolCall.input?.port === "number" ? toolCall.input.port : 9223;
      try {
        const output = await runBootstrapBrowserLaunch(`launch-${port}`, { port });
        replayedCallCount += 1;
        recoveredContextLines.push(
          `Recovered browser launch at runtime on port ${port}. Treat the browser session as already available for this rerun.`,
        );
        replayedToolCalls.push({
          ...toolCall,
          output,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        replayFailureMessages.push(`Runtime replay of browser launch failed: ${detail}`);
        replayedToolCalls.push(toolCall);
      }
      continue;
    }

    if (isBrowserStatusToolCall(toolCall)) {
      try {
        const output = await runBootstrapBrowserRead("status", { action: "status" });
        replayedCallCount += 1;
        recoveredContextLines.push(`Recovered browser status at runtime: ${JSON.stringify(output)}`);
        replayedToolCalls.push({
          ...toolCall,
          output,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        replayFailureMessages.push(`Runtime replay of browser status failed: ${detail}`);
        replayedToolCalls.push(toolCall);
      }
      continue;
    }

    if (isBrowserOpenToolCall(toolCall)) {
      const url = typeof toolCall.input?.url === "string" ? toolCall.input.url : "";
      try {
        const output = await runBootstrapBrowserRead("open", { action: "open", url });
        replayedCallCount += 1;
        recoveredContextLines.push(`Recovered browser open at runtime for ${url}: ${JSON.stringify(output)}`);
        replayedToolCalls.push({
          ...toolCall,
          output,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        replayFailureMessages.push(`Runtime replay of browser open failed: ${detail}`);
        replayedToolCalls.push(toolCall);
      }
      continue;
    }

    if (isBrowserSnapshotToolCall(toolCall)) {
      const interactive = toolCall.input?.interactive === true;
      try {
        const output = await runBootstrapBrowserRead(
          interactive ? "snapshot-interactive" : "snapshot",
          { action: "snapshot", interactive },
        );
        replayedCallCount += 1;
        const snapshotText =
          output && typeof output === "object" && !Array.isArray(output) && typeof (output as Record<string, unknown>).result === "string"
            ? String((output as Record<string, unknown>).result)
            : JSON.stringify(output);
        recoveredContextLines.push(
          `Recovered browser snapshot at runtime${interactive ? " (interactive)" : ""}:\n${snapshotText.slice(0, 6000)}`,
        );
        replayedToolCalls.push({
          ...toolCall,
          output,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        replayFailureMessages.push(`Runtime replay of browser snapshot failed: ${detail}`);
        replayedToolCalls.push(toolCall);
      }
      continue;
    }

    if (isWalmartHistoryPreferencesToolCall(toolCall)) {
      try {
        const output = await executeWalmartHistoryPreferences();
        replayedCallCount += 1;
        recoveredContextLines.push(
          `Recovered Walmart history_preferences at runtime: ${JSON.stringify(output)}`,
        );
        replayedToolCalls.push({
          ...toolCall,
          output,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        replayFailureMessages.push(`Runtime replay of walmart history_preferences failed: ${detail}`);
        replayedToolCalls.push(toolCall);
      }
      continue;
    }

    if (isWalmartHistoryAnalyzeToolCall(toolCall)) {
      const daysBack = typeof toolCall.input?.days_back === "number" ? toolCall.input.days_back : 365;
      const topN = typeof toolCall.input?.top_n === "number" ? toolCall.input.top_n : 20;
      try {
        const output = await executeWalmartHistoryAnalyze({ daysBack, topN });
        replayedCallCount += 1;
        recoveredContextLines.push(`Recovered Walmart history_analyze at runtime: ${JSON.stringify(output)}`);
        replayedToolCalls.push({
          ...toolCall,
          output,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        replayFailureMessages.push(`Runtime replay of walmart history_analyze failed: ${detail}`);
        replayedToolCalls.push(toolCall);
      }
      continue;
    }

    replayedToolCalls.push(toolCall);
  }

  return {
    result: {
      ...result,
      toolCalls: replayedToolCalls,
    },
    replayedCallCount,
    replayFailureMessages,
    recoveredContextLines,
  };
}

async function synthesizeShoppingMutationFromAvailableState(
  result: WorkerAgentResult,
  task: string,
  options: Pick<
    AgentWorkerOptions,
    "browserLaunchExecutor" | "browserReadExecutor" | "browserMutationExecutor"
  >,
): Promise<ShoppingMutationRecoveryOutcome> {
  const withRecoveryTimeout = async <T>(
    promise: Promise<T>,
    ms: number,
    label: string,
  ): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  };
  const runBrowserRead = async (
    step: string,
    input: { action: "status" | "open" | "snapshot"; url?: string; interactive?: boolean },
    timeoutMs = input.action === "open" ? 35_000 : 15_000,
  ) => {
    shoppingDebug(task, `recovery step:start ${step}`);
    const startedAt = Date.now();
    const output = await withRecoveryTimeout(executeBrowserRead(input), timeoutMs, `Shopping recovery ${step}`);
    shoppingDebug(task, `recovery step:finish ${step} ms=${Date.now() - startedAt}`);
    return output;
  };
  const runBrowserMutation = async (
    step: string,
    input: { action: "click"; ref: number },
    timeoutMs = 15_000,
  ) => {
    shoppingDebug(task, `recovery step:start ${step}`);
    const startedAt = Date.now();
    const output = await withRecoveryTimeout(executeBrowserMutation(input), timeoutMs, `Shopping recovery ${step}`);
    shoppingDebug(task, `recovery step:finish ${step} ms=${Date.now() - startedAt}`);
    return output;
  };
  const runBrowserLaunch = async (
    step: string,
    input: { port: number },
    timeoutMs = 20_000,
  ) => {
    shoppingDebug(task, `recovery step:start ${step}`);
    const startedAt = Date.now();
    const output = await withRecoveryTimeout(executeBrowserLaunch(input), timeoutMs, `Shopping recovery ${step}`);
    shoppingDebug(task, `recovery step:finish ${step} ms=${Date.now() - startedAt}`);
    return output;
  };

  if (!isShoppingBrowserOrderTask(task)) {
    return {
      result,
      replayedCallCount: 0,
      replayFailureMessages: [],
    };
  }

  const payload = parseStructuredWorkerPayload(result.text);
  const target = extractShoppingRecoveryTarget(result, task);
  if (!payload || !target || !hasBlockedWorkerPayload(result)) {
    return {
      result,
      replayedCallCount: 0,
      replayFailureMessages: [],
    };
  }

  const cancelledCalls = result.toolCalls.filter((toolCall) => toolCallLooksCancelled(toolCall));
  const cancelledShoppingCalls = cancelledCalls.filter((toolCall) =>
    isToolCallNamed(toolCall, "browser") || isToolCallNamed(toolCall, "walmart"),
  );
  if (cancelledShoppingCalls.length === 0) {
    return {
      result,
      replayedCallCount: 0,
      replayFailureMessages: [],
    };
  }

  const executeBrowserLaunch = options.browserLaunchExecutor
    ?? (async (input: { port: number }) => ({ result: await getBrowserManager().launch(input.port) }));
  const executeBrowserRead = options.browserReadExecutor
    ?? (async (input: { action: "status" | "open" | "snapshot"; url?: string; interactive?: boolean }) => {
      const browserManager = getBrowserManager();
      switch (input.action) {
        case "status":
          return browserManager.status();
        case "open":
          return { result: await browserManager.open(input.url ?? "") };
        case "snapshot":
          return { result: await browserManager.snapshot({ interactive: input.interactive === true }) };
      }
    });
  const executeBrowserMutation = options.browserMutationExecutor
    ?? (async (input: { action: "click"; ref: number }) => {
      const browserManager = getBrowserManager();
      if (input.action !== "click") {
        throw new Error(`Unsupported browser mutation recovery action: ${input.action}`);
      }
      return { result: await browserManager.click(input.ref) };
    });

  const replayFailureMessages: string[] = [];
  let replayedCallCount = 0;
  const retainedToolCalls = result.toolCalls.filter((toolCall) => !toolCallLooksCancelled(toolCall));
  const replayedToolCalls: AgentToolCall[] = [...retainedToolCalls];
  const hasRecoveredBrowserStateFromToolCalls = retainedToolCalls.some((toolCall) =>
    isToolCallNamed(toolCall, "browser")
    && (
      isBrowserSnapshotToolCall(toolCall)
      || isBrowserStatusToolCall(toolCall)
      || isBrowserOpenToolCall(toolCall)
      || isBrowserClickToolCall(toolCall)
    ),
  );
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  try {
    let hasRecoveredBrowserState = hasRecoveredBrowserStateFromToolCalls;
    if (!hasRecoveredBrowserState) {
      try {
        const existingStatus = await runBrowserRead("reuse-status", { action: "status" }, 5_000);
        const statusRecord = asRecord(existingStatus);
        if (statusRecord?.connected === true) {
          hasRecoveredBrowserState = true;
          replayedCallCount += 1;
          replayedToolCalls.push({
            name: "browser",
            input: { action: "status" },
            output: existingStatus,
            durationMs: 0,
          });
          shoppingDebug(task, "recovery step:reuse connected browser page");
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        shoppingDebug(task, `recovery step:reuse-status failed detail=${detail}`);
      }
    }

    if (!hasRecoveredBrowserState) {
      const launchStartedAt = Date.now();
      const launchOutput = await runBrowserLaunch("launch", { port: 9223 });
      replayedCallCount += 1;
      replayedToolCalls.push({
        name: "browser",
        input: { action: "launch", port: 9223 },
        output: launchOutput,
        durationMs: Date.now() - launchStartedAt,
      });

      if (target.pageUrl) {
        const openStartedAt = Date.now();
        const openOutput = await runBrowserRead("open", {
          action: "open",
          url: target.pageUrl,
        });
        replayedCallCount += 1;
        replayedToolCalls.push({
          name: "browser",
          input: { action: "open", url: target.pageUrl },
          output: openOutput,
          durationMs: Date.now() - openStartedAt,
        });
      }
    } else {
      shoppingDebug(task, "recovery step:reuse existing browser state");
    }

    const cancelledBrowserCallsInOrder = result.toolCalls.filter((toolCall) =>
      toolCallLooksCancelled(toolCall) && isToolCallNamed(toolCall, "browser"),
    );
    if (cancelledBrowserCallsInOrder.some((toolCall) => isBrowserClickToolCall(toolCall))) {
      for (const toolCall of cancelledBrowserCallsInOrder) {
        if (isBrowserClickToolCall(toolCall)) {
          const ref = Number(toolCall.input?.ref);
          const clickStartedAt = Date.now();
          const clickOutput = await runBrowserMutation(`replay-click-${ref}`, { action: "click", ref });
          replayedCallCount += 1;
          replayedToolCalls.push({
            name: "browser",
            input: { action: "click", ref },
            output: clickOutput,
            durationMs: Date.now() - clickStartedAt,
          });
          continue;
        }

        if (isBrowserWaitToolCall(toolCall)) {
          const timeoutMs = typeof toolCall.input?.timeout === "number"
            ? Math.max(0, Math.min(toolCall.input.timeout, 2_000))
            : 500;
          const waitStartedAt = Date.now();
          await sleep(timeoutMs);
          replayedCallCount += 1;
          replayedToolCalls.push({
            name: "browser",
            input: { action: "wait", timeout: timeoutMs },
            output: { result: `Waited ${timeoutMs}ms` },
            durationMs: Date.now() - waitStartedAt,
          });
          continue;
        }

        if (isBrowserStatusToolCall(toolCall)) {
          const statusStartedAt = Date.now();
          const statusOutput = await runBrowserRead("replay-status", { action: "status" });
          replayedCallCount += 1;
          replayedToolCalls.push({
            name: "browser",
            input: { action: "status" },
            output: statusOutput,
            durationMs: Date.now() - statusStartedAt,
          });
          continue;
        }

        if (isBrowserSnapshotToolCall(toolCall)) {
          const interactive = toolCall.input?.interactive === true;
          const snapshotStartedAt = Date.now();
          const snapshotOutput = await runBrowserRead(
            interactive ? "replay-snapshot-interactive" : "replay-snapshot",
            { action: "snapshot", interactive },
          );
          replayedCallCount += 1;
          replayedToolCalls.push({
            name: "browser",
            input: { action: "snapshot", interactive },
            output: snapshotOutput,
            durationMs: Date.now() - snapshotStartedAt,
          });
        }
      }

      const verifyStartedAt = Date.now();
      const verifySnapshotOutput = await runBrowserRead("verify-snapshot", {
        action: "snapshot",
        interactive: true,
      });
      const verifySnapshotText = extractBrowserSnapshotText(verifySnapshotOutput);
      replayedCallCount += 1;
      replayedToolCalls.push({
        name: "browser",
        input: { action: "snapshot", interactive: true },
        output: verifySnapshotOutput,
        durationMs: Date.now() - verifyStartedAt,
      });

      if (verifySnapshotText) {
        const verifiedState = parseShoppingSnapshotTargetState(verifySnapshotText, target.targetItem);
        if (verifiedState.currentQuantity === target.targetQuantity) {
          return {
            result: {
              ...result,
              text: JSON.stringify(
                rewriteRecoveredShoppingMutationPayload(
                  payload,
                  target,
                  verifiedState.currentQuantity,
                  verifiedState.cartSummary,
                ),
              ),
              toolCalls: replayedToolCalls,
            },
            replayedCallCount,
            replayFailureMessages,
          };
        }
      }
    }

    let finalState: ShoppingSnapshotTargetState | null = null;
    const maxIterations = Math.max(target.targetQuantity + 6, 8);

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const snapshotStartedAt = Date.now();
      const snapshotOutput = await runBrowserRead(`loop-snapshot-${iteration + 1}`, {
        action: "snapshot",
        interactive: true,
      });
      const snapshotText = extractBrowserSnapshotText(snapshotOutput);
      replayedCallCount += 1;
      replayedToolCalls.push({
        name: "browser",
        input: { action: "snapshot", interactive: true },
        output: snapshotOutput,
        durationMs: Date.now() - snapshotStartedAt,
      });
      if (!snapshotText) {
        replayFailureMessages.push("Runtime shopping recovery could not read the live Walmart page snapshot.");
        break;
      }

      const state = parseShoppingSnapshotTargetState(snapshotText, target.targetItem);
      finalState = state;

      if (state.closeDialogRef !== null) {
        const clickStartedAt = Date.now();
        const clickOutput = await runBrowserMutation(`close-dialog-${state.closeDialogRef}`, {
          action: "click",
          ref: state.closeDialogRef,
        });
        replayedCallCount += 1;
        replayedToolCalls.push({
          name: "browser",
          input: { action: "click", ref: state.closeDialogRef },
          output: clickOutput,
          durationMs: Date.now() - clickStartedAt,
        });
        continue;
      }

      if (state.currentQuantity === target.targetQuantity && state.currentQuantity !== null) {
        finalState = state;
        break;
      }

      if ((state.currentQuantity ?? 0) === 0 && state.addRef !== null) {
        const clickStartedAt = Date.now();
        const clickOutput = await runBrowserMutation(`add-${state.addRef}`, {
          action: "click",
          ref: state.addRef,
        });
        replayedCallCount += 1;
        replayedToolCalls.push({
          name: "browser",
          input: { action: "click", ref: state.addRef },
          output: clickOutput,
          durationMs: Date.now() - clickStartedAt,
        });
        continue;
      }

      if (state.currentQuantity === null && state.quantityButtonRef !== null) {
        const clickStartedAt = Date.now();
        const clickOutput = await runBrowserMutation(`quantity-button-${state.quantityButtonRef}`, {
          action: "click",
          ref: state.quantityButtonRef,
        });
        replayedCallCount += 1;
        replayedToolCalls.push({
          name: "browser",
          input: { action: "click", ref: state.quantityButtonRef },
          output: clickOutput,
          durationMs: Date.now() - clickStartedAt,
        });
        continue;
      }

      if ((state.currentQuantity ?? 0) < target.targetQuantity && state.increaseRef !== null) {
        const clickStartedAt = Date.now();
        const clickOutput = await runBrowserMutation(`increase-${state.increaseRef}`, {
          action: "click",
          ref: state.increaseRef,
        });
        replayedCallCount += 1;
        replayedToolCalls.push({
          name: "browser",
          input: { action: "click", ref: state.increaseRef },
          output: clickOutput,
          durationMs: Date.now() - clickStartedAt,
        });
        continue;
      }

      if ((state.currentQuantity ?? 0) > target.targetQuantity && state.decreaseRef !== null) {
        const clickStartedAt = Date.now();
        const clickOutput = await runBrowserMutation(`decrease-${state.decreaseRef}`, {
          action: "click",
          ref: state.decreaseRef,
        });
        replayedCallCount += 1;
        replayedToolCalls.push({
          name: "browser",
          input: { action: "click", ref: state.decreaseRef },
          output: clickOutput,
          durationMs: Date.now() - clickStartedAt,
        });
        continue;
      }

      if ((state.currentQuantity ?? 0) < target.targetQuantity && state.quantityButtonRef !== null) {
        const clickStartedAt = Date.now();
        const clickOutput = await runBrowserMutation(`quantity-button-fallback-${state.quantityButtonRef}`, {
          action: "click",
          ref: state.quantityButtonRef,
        });
        replayedCallCount += 1;
        replayedToolCalls.push({
          name: "browser",
          input: { action: "click", ref: state.quantityButtonRef },
          output: clickOutput,
          durationMs: Date.now() - clickStartedAt,
        });
        continue;
      }

      replayFailureMessages.push(
        `Runtime shopping recovery could not reach quantity ${target.targetQuantity} for ${target.targetItem}. Last observed quantity: ${state.currentQuantity ?? "unknown"}.`,
      );
      break;
    }

    if (replayFailureMessages.length > 0) {
      return {
        result,
        replayedCallCount,
        replayFailureMessages,
      };
    }

    if (!finalState || finalState.currentQuantity !== target.targetQuantity) {
      return {
        result,
        replayedCallCount,
        replayFailureMessages: [
          `Runtime shopping recovery stopped before verifying quantity ${target.targetQuantity} for ${target.targetItem}.`,
        ],
      };
    }

    return {
      result: {
        ...result,
        text: JSON.stringify(
          rewriteRecoveredShoppingMutationPayload(
            payload,
            target,
            finalState.currentQuantity,
            finalState.cartSummary,
          ),
        ),
        toolCalls: replayedToolCalls,
      },
      replayedCallCount,
      replayFailureMessages,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      result,
      replayedCallCount,
      replayFailureMessages: [`Runtime shopping mutation recovery failed: ${detail}`],
    };
  }
}

async function replayCancelledRecipeWriteToolCalls(
  result: WorkerAgentResult,
  options: Pick<AgentWorkerOptions, "recipeWriteExecutor" | "wellnessToolPaths">,
): Promise<RecipeReplayOutcome> {
  const cancelledRecipeWrites = result.toolCalls.filter((toolCall) =>
    isRecipeWriteToolCall(toolCall) && toolCallLooksCancelled(toolCall),
  );
  if (cancelledRecipeWrites.length === 0) {
    return {
      result,
      replayedCallCount: 0,
      replayFailureMessages: [],
    };
  }

  const executeReplay = options.recipeWriteExecutor
    ?? (async (input: { name: string; content: string }) => callRecipeWrite(input.name, input.content, options.wellnessToolPaths));

  const replayFailureMessages: string[] = [];
  let replayedCallCount = 0;
  const replayedToolCalls = await Promise.all(result.toolCalls.map(async (toolCall) => {
    if (!isRecipeWriteToolCall(toolCall) || !toolCallLooksCancelled(toolCall)) {
      return toolCall;
    }

    const name = typeof toolCall.input?.name === "string" ? toolCall.input.name.trim() : "";
    const content = typeof toolCall.input?.content === "string" ? toolCall.input.content : "";
    if (!name || !content) {
      replayFailureMessages.push("Recipe write replay skipped because the cancelled tool call did not include both name and content.");
      return toolCall;
    }

    try {
      const startedAt = Date.now();
      const output = await executeReplay({ name, content });
      replayedCallCount += 1;
      return {
        ...toolCall,
        output,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      replayFailureMessages.push(`Runtime replay of recipe_write for ${name} failed: ${detail}`);
      return toolCall;
    }
  }));

  const payload = parseStructuredWorkerPayload(result.text);
  const remainingCancelledRecipeWrites = replayedToolCalls.some((toolCall) =>
    isRecipeWriteToolCall(toolCall) && toolCallLooksCancelled(toolCall),
  );
  const successfulRecipeWrite = replayedToolCalls
    .filter((toolCall) => isRecipeWriteToolCall(toolCall) && recipeWriteSucceeded(toolCall.output))
    .at(-1);
  const recipeName = typeof successfulRecipeWrite?.input?.name === "string"
    ? successfulRecipeWrite.input.name.trim()
    : typeof payload?.recipe === "string"
      ? payload.recipe.trim()
      : "recipe";
  const nextText =
    payload
    && !remainingCancelledRecipeWrites
    && replayFailureMessages.length === 0
    && successfulRecipeWrite
      ? JSON.stringify(rewriteRecoveredRecipeWritePayload(payload, recipeName, replayedCallCount))
      : result.text;

  return {
    result: {
      ...result,
      text: nextText,
      toolCalls: replayedToolCalls,
    },
    replayedCallCount,
    replayFailureMessages,
  };
}

function shouldRecoverShoppingBootstrap(result: WorkerAgentResult): boolean {
  const cancelledCalls = result.toolCalls.filter((toolCall) => toolCallLooksCancelled(toolCall));
  if (cancelledCalls.length === 0) {
    return false;
  }

  const safeBootstrapOnly = cancelledCalls.every((toolCall) =>
    isBrowserLaunchToolCall(toolCall)
    || isBrowserStatusToolCall(toolCall)
    || isBrowserOpenToolCall(toolCall)
    || isBrowserSnapshotToolCall(toolCall)
    || isWalmartHistoryPreferencesToolCall(toolCall)
    || isWalmartHistoryAnalyzeToolCall(toolCall),
  );
  if (!safeBootstrapOnly) {
    return false;
  }

  const payload = parseStructuredWorkerPayload(result.text);
  return hasBlockedWorkerPayload(result)
    || looksLikeToolFailureNarration(result.text)
    || (payload ? payloadIsCancellationOnly(payload) : false);
}

/**
 * Convert a WorkerAgentResult (from runWorkerAgent) to a WorkerReport
 * that the turn executor can inject into Claude's prompt.
 */
export function workerAgentResultToReport(
  result: WorkerAgentResult,
  workerId: string,
  task?: string,
): WorkerReport {
  const operations: WorkerReportOperation[] = result.toolCalls.map((tc) => ({
    name: normalizeToolName(tc.name),
    toolNames: [normalizeToolName(tc.name)],
    input: tc.input,
    output: tc.output,
    mode: inferToolMode({
      name: tc.name,
      toolName: normalizeToolName(tc.name),
      input: tc.input,
    }, task),
  }));
  const inferredStructuredWrite =
    taskRequestsMutation(task)
    && structuredPayloadIndicatesConfirmedWriteOutcome(parseStructuredWorkerPayload(result.text));

  // If no tool calls were extracted from metadata, try to infer from text
  // The CLI JSON output may not include tool call details, but the text
  // response contains the agent's findings.
  if (result.text && (operations.length === 0 || (inferredStructuredWrite && !operations.some((op) => op.mode === "write")))) {
    operations.push({
      name: "agent_response",
      toolNames: [],
      input: {},
      output: result.text,
      mode: inferredStructuredWrite ? "write" : "read",
    });
  }

  const qualityWarnings = deriveQualityWarnings(operations, result);

  return {
    operations,
    hasWriteOperations: operations.some((op) => op.mode === "write"),
    data: {
      ...(inferredStructuredWrite ? { committedStateVerified: true, verifiedWriteOutcome: true } : {}),
      workerText: result.text,
      toolCalls: result.toolCalls,
      numTurns: result.numTurns,
      partial: result.partial,
      partialReason: result.partialReason,
      qualityWarnings,
    },
    trace: {
      workerId,
      durationMs: result.durationMs,
    },
    clarification: extractClarificationFromWorkerText(result.text),
  };
}

export interface AgentWorkerOptions {
  /** Path to the MCP server script (compiled JS) */
  mcpServerScript: string;
  /** MCP server name (default: "wellness") */
  mcpServerName?: string;
  /** Explicit provider chain for model-agnostic worker execution. */
  providerChain?: Array<{ providerName: string; provider: ChatProvider }>;
  /** Retry count per provider when using providerChain. */
  providerRetryLimit?: number;
  /** Model for worker agent (default: "sonnet") */
  model?: string;
  /** Reasoning effort override for the worker agent. */
  reasoningEffort?: ProviderReasoningEffort;
  /** Max inactivity before killing the agent (default: 90_000). Agent can run
   *  indefinitely as long as MCP tools are being called. */
  inactivityTimeoutMs?: number;
  /** Port of persistent MCP HTTP server. When set, uses proxy for fast startup. */
  persistentMcpPort?: number;
  /** Tool IDs to allow through the MCP server for this worker. */
  toolIds?: string[];
  /** Additional MCP servers (for example, a remote work MCP) to include in worker config. */
  additionalMcpServers?: Record<string, McpServerEntry>;
  /** Full provider tool names from non-primary MCP servers to allow explicitly. */
  additionalAllowedToolNames?: string[];
  /** Optional runtime executor for deterministic FatSecret replay. Used in tests and recovery. */
  fatsecretReplayExecutor?: (input: {
    method: string;
    params: Record<string, unknown>;
  }) => Promise<unknown>;
  /** Optional runtime executor for deterministic recipe write replay. */
  recipeWriteExecutor?: (input: {
    name: string;
    content: string;
  }) => Promise<unknown>;
  /** Optional runtime executor for safe browser bootstrap recovery. */
  browserLaunchExecutor?: (input: { port: number }) => Promise<unknown>;
  /** Optional runtime executor for safe browser read/navigation recovery. */
  browserReadExecutor?: (input: {
    action: "status" | "open" | "snapshot";
    url?: string;
    interactive?: boolean;
  }) => Promise<unknown>;
  /** Optional runtime executor for safe browser mutation recovery. */
  browserMutationExecutor?: (input: {
    action: "click";
    ref: number;
  }) => Promise<unknown>;
  /** Optional runtime executor for safe Walmart preference bootstrap recovery. */
  walmartHistoryPreferencesExecutor?: () => Promise<unknown>;
  /** Optional runtime executor for safe Walmart history analysis bootstrap recovery. */
  walmartHistoryAnalyzeExecutor?: (input: {
    daysBack?: number;
    topN?: number;
  }) => Promise<unknown>;
  /** Optional tool-path overrides for runtime replay of wellness tools. */
  wellnessToolPaths?: WellnessToolPaths;
}

const EMPTY_ALLOWED_TOOL_IDS = "__none__";

function normalizeWorkerToolName(
  toolCall: ProviderToolCall,
  mcpServerName: string,
): string {
  if (typeof toolCall.toolName === "string" && toolCall.toolName.trim().length > 0) {
    return toolCall.toolName.trim();
  }

  const prefix = `mcp__${mcpServerName}__`;
  return toolCall.name.startsWith(prefix) ? toolCall.name.slice(prefix.length) : toolCall.name;
}

function buildPrimaryWorkerMcpServer(input: {
  workerId: string;
  mcpServerScript: string;
  persistentMcpPort?: number;
  readOnlyStep?: boolean;
  allowedToolIds?: string[];
}): ProviderMcpServerConfig {
  const env: Record<string, string> = {
    ...buildRuntimePathEnv({
      dbPath: resolveDatabasePath(),
    }),
    WORKER_ID: input.workerId,
  };
  if (input.readOnlyStep) {
    env.READ_ONLY_STEP = "1";
  }
  if (input.allowedToolIds) {
    env.ALLOWED_TOOL_IDS = input.allowedToolIds.length > 0
      ? [...new Set(input.allowedToolIds.map((toolId) => toolId.trim()).filter((toolId) => toolId.length > 0))].join(",")
      : EMPTY_ALLOWED_TOOL_IDS;
  }

  if (input.persistentMcpPort) {
    const proxyScript = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../core/dist/mcp-proxy.js",
    );
    return {
      command: process.execPath,
      args: [proxyScript],
      env: {
        ...env,
        MCP_SERVER_PORT: String(input.persistentMcpPort),
      },
    };
  }

  return {
    command: process.execPath,
    args: [input.mcpServerScript],
    env,
  };
}

function normalizeAdditionalMcpServers(
  servers: Record<string, McpServerEntry> | undefined,
): Record<string, ProviderMcpServerConfig> | undefined {
  if (!servers) {
    return undefined;
  }

  const entries = Object.entries(servers).flatMap(([name, server]) => {
    if ("type" in server && server.type === "url") {
      return [];
    }

    return [[name, {
      command: server.command,
      ...(server.args ? { args: server.args } : {}),
      ...(server.env ? { env: server.env } : {}),
    }] as const];
  });

  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function buildWorkerProviderTools(input: {
  workerId: string;
  mcpServerScript: string;
  mcpServerName: string;
  persistentMcpPort?: number;
  readOnlyStep?: boolean;
  toolIds?: string[];
  additionalMcpServers?: Record<string, McpServerEntry>;
  additionalAllowedToolNames?: string[];
}): ProviderToolsConfig {
  const normalizedPrimaryToolIds = [...new Set(
    (input.toolIds ?? [])
      .map((toolId) => toolId.trim())
      .filter((toolId) => toolId.length > 0),
  )];
  const allowlist = [...new Set([
    ...normalizedPrimaryToolIds.map((toolId) => `mcp__${input.mcpServerName}__${toolId}`),
    ...(
      input.additionalAllowedToolNames
        ?? []
    )
      .map((toolName) => toolName.trim())
      .filter((toolName) => toolName.length > 0),
  ])];

  const additionalServers = normalizeAdditionalMcpServers(input.additionalMcpServers);
  const restrictPrimaryToolIds =
    input.toolIds
      ? normalizedPrimaryToolIds
      : (allowlist.length > 0 ? [] : undefined);

  return {
    mode: allowlist.length > 0 ? "allowlist" : "default",
    ...(allowlist.length > 0 ? { allowlist } : {}),
    permissionMode: "bypass",
    mcpServers: {
      [input.mcpServerName]: buildPrimaryWorkerMcpServer({
        workerId: input.workerId,
        mcpServerScript: input.mcpServerScript,
        persistentMcpPort: input.persistentMcpPort,
        readOnlyStep: input.readOnlyStep,
        allowedToolIds: restrictPrimaryToolIds,
      }),
      ...(additionalServers ?? {}),
    },
  };
}

async function executeWorkerViaProviders(
  workerId: string,
  task: string,
  systemPrompt: string,
  options: AgentWorkerOptions,
): Promise<WorkerAgentResult> {
  const {
    mcpServerScript,
    mcpServerName = "wellness",
    providerChain,
    providerRetryLimit = 0,
    model,
    reasoningEffort,
    persistentMcpPort,
    toolIds,
    additionalMcpServers,
    additionalAllowedToolNames,
  } = options;

  if (!providerChain || providerChain.length === 0) {
    throw new Error(`Worker '${workerId}' has no configured providers.`);
  }

  const startTime = Date.now();
  const readOnlyStep = isReadOnlyWorkerStep(task);
  const tools = buildWorkerProviderTools({
    workerId,
    mcpServerScript,
    mcpServerName,
    persistentMcpPort,
    readOnlyStep,
    toolIds,
    additionalMcpServers,
    additionalAllowedToolNames,
  });

  const failover = await generateWithFailover(
    providerChain,
    {
      prompt: task,
      systemPrompt,
      tools,
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
    },
    providerRetryLimit,
  );

  const response = failover.retryResult.response;
  return {
    text: response.text,
    toolCalls: (response.toolCalls ?? []).map((toolCall) => ({
      name: normalizeWorkerToolName(toolCall, mcpServerName),
      input: toolCall.input,
      output: toolCall.output,
      durationMs: 0,
    })),
    durationMs: Date.now() - startTime,
    raw: response.raw,
  };
}

async function runWorkerOnce(
  workerId: string,
  task: string,
  systemPrompt: string,
  options: AgentWorkerOptions,
): Promise<WorkerAgentResult> {
  const {
    mcpServerScript,
    mcpServerName = "wellness",
    providerChain,
    providerRetryLimit,
    model,
    reasoningEffort,
    inactivityTimeoutMs,
    persistentMcpPort,
    toolIds,
    additionalMcpServers,
    additionalAllowedToolNames,
  } = options;

  return providerChain && providerChain.length > 0
    ? executeWorkerViaProviders(workerId, task, systemPrompt, {
        mcpServerScript,
        mcpServerName,
        providerChain,
        providerRetryLimit,
        model,
        reasoningEffort,
        persistentMcpPort,
        toolIds,
        additionalMcpServers,
        additionalAllowedToolNames,
      })
    : runWorkerAgent({
        systemPrompt,
        mcpServerScript,
        mcpServerName,
        task,
        model,
        reasoningEffort,
        inactivityTimeoutMs,
        workerId,
        persistentMcpPort,
        additionalMcpServers,
      });
}

function shoppingDebug(task: string, message: string): void {
  if (!isShoppingBrowserOrderTask(task)) {
    return;
  }
  console.log(`[shopping-worker] ${message}`);
}

/**
 * Execute a worker task using an LLM-powered agent with MCP tools.
 * The agent runs a full agentic loop: reason -> call tool -> see result -> reason.
 */
export async function executeAgentWorker(
  workerId: string,
  task: string,
  systemPrompt: string,
  options: AgentWorkerOptions,
): Promise<WorkerReport> {
  const {
    toolIds,
    additionalAllowedToolNames,
  } = options;
  const hasExposedTools =
    (toolIds?.length ?? 0) > 0
    || (additionalAllowedToolNames?.length ?? 0) > 0;
  const isShoppingOrderTask = (toolIds?.length ?? 0) > 0 && isShoppingBrowserOrderTask(task);

  shoppingDebug(
    task,
    `start worker=${workerId} providers=${options.providerChain?.map((candidate) => candidate.providerName).join(",") ?? "(direct)"} tools=${toolIds?.join(",") ?? "-"} additional=${additionalAllowedToolNames?.join(",") ?? "-"}`,
  );

  const preflightStartedAt = Date.now();
  const shoppingPreflightLines = await buildShoppingPreflightContext(task, options);
  shoppingDebug(
    task,
    `preflight ms=${Date.now() - preflightStartedAt} lines=${shoppingPreflightLines.length}`,
  );
  const effectiveTask = shoppingPreflightLines.length > 0
    ? [
        task,
        "",
        "Preflight context:",
        ...shoppingPreflightLines,
        "Use this already-available runtime context before repeating bootstrap checks.",
      ].join("\n")
    : task;

  const fastPathStartedAt = Date.now();
  const fastPathResult = await tryExecuteDeterministicWorkerFastPath({
    workerId,
    task: effectiveTask,
    toolIds,
    wellnessToolPaths: options.wellnessToolPaths,
    fatsecretExecutor: options.fatsecretReplayExecutor,
  });
  if (fastPathResult) {
    shoppingDebug(
      task,
      `fast-path ms=${Date.now() - fastPathStartedAt} toolCalls=${fastPathResult.toolCalls.length}`,
    );
    return workerAgentResultToReport(fastPathResult, workerId, effectiveTask);
  }

  const firstRunStartedAt = Date.now();
  let result = await runWorkerOnce(workerId, effectiveTask, systemPrompt, options);
  shoppingDebug(
    task,
    `first-run ms=${Date.now() - firstRunStartedAt} toolCalls=${result.toolCalls.length} blocked=${hasBlockedWorkerPayload(result)} partial=${result.partial === true}`,
  );
  const shouldRetryForNarratedToolFailure =
    hasExposedTools
    && result.toolCalls.length === 0
    && looksLikeToolFailureNarration(result.text);
  const shouldRetryForRecordedToolCancellation =
    hasExposedTools
    && result.toolCalls.length > 0
    && hasRecordedToolCancellation(result)
    && (hasBlockedWorkerPayload(result) || looksLikeToolFailureNarration(result.text) || result.partial === true);
  const shouldSkipRetryForShoppingRecovery =
    isShoppingOrderTask
    && shouldRetryForRecordedToolCancellation;

  if ((shouldRetryForNarratedToolFailure || shouldRetryForRecordedToolCancellation) && !shouldSkipRetryForShoppingRecovery) {
    const stricterPrompt = [
      systemPrompt,
      "",
      "If you need tool data, you must actually call the MCP tools in this run.",
      "Do not claim a tool was cancelled, unavailable, or retried unless a tool call is recorded in this run.",
      "If a tool call comes back cancelled, retry the needed tool work once in this run before giving up.",
      "If you cannot make progress, explain the actual evidence from this run instead of inventing unseen tool failures.",
    ].join("\n");
    shoppingDebug(
      task,
      `retry triggered narrated=${shouldRetryForNarratedToolFailure ? "yes" : "no"} recordedCancellation=${shouldRetryForRecordedToolCancellation ? "yes" : "no"}`,
    );
    const retryStartedAt = Date.now();
    result = await runWorkerOnce(workerId, effectiveTask, stricterPrompt, options);
    shoppingDebug(
      task,
      `retry-run ms=${Date.now() - retryStartedAt} toolCalls=${result.toolCalls.length} blocked=${hasBlockedWorkerPayload(result)} partial=${result.partial === true}`,
    );
  } else if (shouldSkipRetryForShoppingRecovery) {
    shoppingDebug(
      task,
      "retry skipped because shopping recovery can proceed directly from the recorded cancelled browser/Walmart calls.",
    );
  }

  if ((toolIds?.length ?? 0) > 0 && shouldRecoverShoppingBootstrap(result)) {
    const bootstrapStartedAt = Date.now();
    const bootstrapOutcome = await replayCancelledShoppingBootstrapCalls(result, options);
    result = bootstrapOutcome.result;
    shoppingDebug(
      task,
      `bootstrap-replay ms=${Date.now() - bootstrapStartedAt} replayed=${bootstrapOutcome.replayedCallCount} failures=${bootstrapOutcome.replayFailureMessages.length}`,
    );

    let shoppingRecoveredAfterBootstrap = false;
    if (isShoppingOrderTask) {
      const bootstrapMutationStartedAt = Date.now();
      const bootstrapMutationOutcome = await synthesizeShoppingMutationFromAvailableState(result, task, options);
      result = bootstrapMutationOutcome.result;
      shoppingRecoveredAfterBootstrap = !hasBlockedWorkerPayload(result);
      shoppingDebug(
        task,
        `bootstrap-mutation-recovery ms=${Date.now() - bootstrapMutationStartedAt} replayed=${bootstrapMutationOutcome.replayedCallCount} failures=${bootstrapMutationOutcome.replayFailureMessages.length} recovered=${shoppingRecoveredAfterBootstrap ? "yes" : "no"}`,
      );
    }

    if (
      bootstrapOutcome.replayedCallCount > 0
      && bootstrapOutcome.replayFailureMessages.length === 0
      && !shoppingRecoveredAfterBootstrap
    ) {
      const rerunSystemPrompt = [
        systemPrompt,
        "",
        "Runtime note: safe bootstrap tool calls were recovered outside the failed model attempt.",
        "Do not re-run browser launch or Walmart preference bootstrap work unless the recovered state proves unusable.",
        "Continue from the recovered bootstrap state and do the actual task work now.",
      ].join("\n");
      const rerunTask = [
        effectiveTask,
        "",
        "Recovered bootstrap context:",
        ...bootstrapOutcome.recoveredContextLines,
      ].join("\n");
      const rerunStartedAt = Date.now();
      const rerunResult = await runWorkerOnce(workerId, rerunTask, rerunSystemPrompt, options);
      shoppingDebug(
        task,
        `bootstrap-rerun ms=${Date.now() - rerunStartedAt} toolCalls=${rerunResult.toolCalls.length} blocked=${hasBlockedWorkerPayload(rerunResult)} partial=${rerunResult.partial === true}`,
      );
      result = {
        ...rerunResult,
        toolCalls: [...result.toolCalls, ...rerunResult.toolCalls],
      };
    }
  }

  if ((toolIds?.length ?? 0) > 0 && isShoppingBrowserOrderTask(task)) {
    const mutationStartedAt = Date.now();
    const mutationOutcome = await synthesizeShoppingMutationFromAvailableState(result, task, options);
    result = mutationOutcome.result;
    shoppingDebug(
      task,
      `mutation-recovery ms=${Date.now() - mutationStartedAt} replayed=${mutationOutcome.replayedCallCount} failures=${mutationOutcome.replayFailureMessages.length}`,
    );
  }

  if ((toolIds?.length ?? 0) > 0 && result.toolCalls.some((toolCall) =>
    isFatsecretToolCall(toolCall) && toolCallLooksCancelled(toolCall),
  )) {
    const replayOutcome = await replayCancelledFatsecretToolCalls(result, task, options);
    result = replayOutcome.result;
  }

  if ((toolIds?.length ?? 0) > 0 && result.toolCalls.some((toolCall) =>
    isRecipeWriteToolCall(toolCall) && toolCallLooksCancelled(toolCall),
  )) {
    const replayOutcome = await replayCancelledRecipeWriteToolCalls(result, options);
    result = replayOutcome.result;
  }

  if ((toolIds?.length ?? 0) > 0 && result.toolCalls.some((toolCall) => isFatsecretToolCall(toolCall))) {
    const synthesisOutcome = await synthesizeFatsecretWritesFromAvailableState(result, task, options);
    result = synthesisOutcome.result;
  }

  shoppingDebug(
    task,
    `finish worker=${workerId} toolCalls=${result.toolCalls.length} blocked=${hasBlockedWorkerPayload(result)} partial=${result.partial === true}`,
  );
  return workerAgentResultToReport(result, workerId, effectiveTask);
}

/**
 * Load the assembled prompt for a worker.
 * Uses convention-based multi-file assembly: soul.md, shared agent docs,
 * knowledge/workers docs, matching tool docs from agents/tools/, and
 * matching skill docs from agents/skills/.
 */
export function loadAgentSoulPrompt(
  workerId: string,
  options?: { agentsDir?: string; toolIds?: string[]; skillIds?: string[] },
): string {
  const baseDir = options?.agentsDir ?? path.resolve("agents");
  const agentDir = resolveAgentDir(baseDir, workerId);

  return assembleAgentPrompt(agentDir, {
    toolIds: options?.toolIds,
    skillIds: options?.skillIds,
    agentsRootDir: baseDir,
  });
}

function resolveAgentDir(agentsRootDir: string, agentId: string): string {
  const candidates = [
    agentId,
    path.join("workers", agentId),
    path.join("assistants", agentId),
    path.join("system", agentId),
  ];

  for (const candidate of candidates) {
    const resolved = path.join(agentsRootDir, candidate);
    if (fs.existsSync(path.join(resolved, "soul.md"))) {
      return resolved;
    }
  }

  return path.join(agentsRootDir, agentId);
}
