import { sanitizeWorkerTextForDisplay } from "./worker-text-sanitizer.js";

export interface WorkerReportOperation {
  /** Operation name, e.g. "recipe_meal_log", "day_summary" */
  name: string;
  /** Tool contract IDs invoked, e.g. ["fatsecret.day_summary"] */
  toolNames: string[];
  /** Arguments passed to the tool */
  input: Record<string, unknown>;
  /** Structured result data */
  output: unknown;
  /** Whether state was mutated */
  mode: "read" | "write";
}

export interface WorkerReportTrace {
  workerId?: string;
  workerRuntime?: Record<string, unknown>;
  plannerRuntime?: Record<string, unknown>;
  durationMs?: number;
}

export interface WorkerDispatchDescriptor {
  workerId: string;
  task: string;
  taskId?: string;
}

export interface WorkerDispatchReport {
  workerId: string;
  task: string;
  taskId?: string;
  operations: WorkerReportOperation[];
  hasWriteOperations: boolean;
  data: Record<string, unknown>;
  warnings?: string[];
  trace?: WorkerReportTrace;
  clarification?: string;
  error?: string;
}

export interface WorkerReport {
  /** What operations were performed */
  operations: WorkerReportOperation[];
  /** Whether any write operations were executed */
  hasWriteOperations: boolean;
  /** Structured data for the orchestrator to interpret */
  data: Record<string, unknown>;
  /** Per-dispatch details when multiple workers ran in parallel */
  dispatches?: WorkerDispatchReport[];
  /** Execution trace for telemetry/debugging (not sent to Claude) */
  trace?: WorkerReportTrace;
  /** Worker suggests a clarifying question; orchestrator rephrases naturally */
  clarification?: string;
}

function parseStructuredWorkerText(workerText: unknown): Record<string, unknown> | null {
  if (typeof workerText !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(workerText);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function operationLooksLikeSuccessfulWrite(operation: WorkerReportOperation): boolean {
  if (operation.mode !== "write") {
    return false;
  }

  const textLooksLikeFailure = (value: string): boolean =>
    /\berror\b|\bfailed\b|\bblocked\b|\bcancelled\b|\bpermission denied\b|\bno tty available\b|\bcannot\b|\bcan't\b|\bcould not\b|\bdid not\b/iu
      .test(value);

  const output = operation.output;
  if (typeof output === "string") {
    return !textLooksLikeFailure(output);
  }
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return output !== null;
  }

  const record = output as Record<string, unknown>;
  if (typeof record.error === "string" && record.error.trim().length > 0) {
    return false;
  }
  if (typeof record.message === "string" && textLooksLikeFailure(record.message)) {
    return false;
  }
  if (typeof record.result === "string" && textLooksLikeFailure(record.result)) {
    return false;
  }
  if (typeof record.stdout === "string" && textLooksLikeFailure(record.stdout)) {
    return false;
  }
  if (typeof record.status === "string") {
    const normalizedStatus = record.status.trim().toLowerCase();
    if (["error", "failed", "blocked", "cancelled", "canceled"].includes(normalizedStatus)) {
      return false;
    }
    if (["ok", "success", "succeeded", "completed", "applied"].includes(normalizedStatus)) {
      return true;
    }
  }
  if (record.ok === true || record.success === true) {
    return true;
  }
  if (typeof record.value === "string" && record.value.trim().length > 0) {
    return !textLooksLikeFailure(record.value);
  }
  if (typeof record.result === "string" && record.result.trim().length > 0) {
    return !textLooksLikeFailure(record.result);
  }
  return Object.keys(record).length > 0;
}

export function dataIndicatesVerifiedWriteOutcome(data: Record<string, unknown> | undefined): boolean {
  if (!data || typeof data !== "object") {
    return false;
  }
  if (data["committedStateVerified"] === true || data["verifiedWriteOutcome"] === true) {
    return true;
  }
  if (textIndicatesVerifiedWriteOutcome(data["workerText"])) {
    return true;
  }
  const workerText = parseStructuredWorkerText(data["workerText"]);
  if (!workerText) {
    return false;
  }
  if (workerText["committedStateVerified"] === true || workerText["verifiedWriteOutcome"] === true) {
    return true;
  }
  const runtimeReplay = workerText["runtimeReplay"];
  if (!runtimeReplay || typeof runtimeReplay !== "object" || Array.isArray(runtimeReplay)) {
    return false;
  }
  return (runtimeReplay as Record<string, unknown>)["diaryWriteRecovered"] === true
    || (runtimeReplay as Record<string, unknown>)["diaryRefreshRecovered"] === true
    || (runtimeReplay as Record<string, unknown>)["writeVerified"] === true;
}

function textIndicatesVerifiedWriteOutcome(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }

  const text = value.trim();
  if (text.length === 0) {
    return false;
  }

  if (
    /\b(?:blocked|failed|cancelled|canceled|needs_clarification|awaiting_user|awaiting_input)\b/iu.test(text)
    || /\b(?:did(?: not|n't)\s+get\s+a\s+confirmed\s+write|can't\s+say\s+it\s+was\s+logged\s+yet|cannot\s+say\s+it\s+was\s+logged\s+yet)\b/iu.test(text)
  ) {
    return false;
  }

  if (/\b(?:committedStateVerified|verifiedWriteOutcome)\b\s*[:=]\s*true\b/iu.test(text)) {
    return true;
  }

  const hasDiaryVerification =
    /\bstatus:\s*`?(?:already_logged|logged|verified)`?/iu.test(text)
    && (
      /\bfood_entry_id:\s*\d+\b/iu.test(text)
      || /\bconfirmed\s+in\s+(?:today'?s\s+)?diary\b/iu.test(text)
      || /\bprevious\s+write\s+confirmed\s+present\s+in\s+diary\b/iu.test(text)
      || /\bno\s+new\s+entry\s+created\s+to\s+avoid\s+duplication\b/iu.test(text)
    );
  if (hasDiaryVerification) {
    return true;
  }

  const hasReceiptVerification =
    /\bstatus:\s*`?(?:completed|success|ok)`?/iu.test(text)
    && (
      /\bwrite\s+confirmed\s+by\s+revision\s+receipt\b/iu.test(text)
      || /\brevision(?:\s+token)?\s*:\s*`?[\w.-]+`?/iu.test(text)
      || /\bwrite\s+confirmed\b/iu.test(text)
    );

  return hasReceiptVerification;
}

function extractStructuredReportCandidates(data: Record<string, unknown> | undefined): Record<string, unknown>[] {
  if (!data || typeof data !== "object") {
    return [];
  }
  const candidates: Record<string, unknown>[] = [data];
  const workerText = parseStructuredWorkerText(data["workerText"]);
  if (workerText) {
    candidates.push(workerText);
  }
  return candidates;
}

function recordHasTruthyFlag(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => record[key] === true);
}

function recordHasNonEmptyArray(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => Array.isArray(record[key]) && (record[key] as unknown[]).length > 0);
}

function collectRecordText(record: Record<string, unknown>, keys: readonly string[]): string[] {
  const collected: string[] = [];
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      collected.push(value.trim());
    }
  }
  return collected;
}

const SAFE_NOOP_PATTERNS = [
  /\bnothing new to process\b/iu,
  /\bnothing to categorize\b/iu,
  /\b0 new categorizations?\b/iu,
  /\bno new work to apply rules to\b/iu,
  /\bno uncategorized transactions(?: to action tonight)?\b/iu,
  /__NO_OUTPUT__/u,
  /\bno changes? needed\b/iu,
  /\bno update needed\b/iu,
  /\ball transactions .* already have categories\b/iu,
  /\balready fully processed\b/iu,
  /\balready have categories and .*cleared\b/iu,
  /\balready satisfied\b/iu,
  /\balready at (?:quantity|qty|target)\b/iu,
  /\balready in (?:the )?cart\b/iu,
  /\bneeds? your input\b/iu,
  /\bneed your input\b/iu,
  /\bwaiting on your input\b/iu,
];

function recordIndicatesSafeNoop(record: Record<string, unknown>): boolean {
  if (
    recordHasTruthyFlag(record, [
      "safeNoop",
      "noop",
      "noWriteNeeded",
      "noMutationNeeded",
      "alreadySatisfied",
      "alreadyAtTarget",
      "noChangesNeeded",
    ])
  ) {
    return true;
  }

  const status = typeof record.status === "string" ? record.status.trim().toLowerCase() : "";
  const textValues = collectRecordText(record, [
    "reason",
    "summary",
    "outcome",
    "details",
    "workerText",
    "autoCategorized",
    "auto_categorized",
    "mutation_outcome",
  ]);
  if (status.length > 0) {
    textValues.push(status);
  }

  if (recordHasNonEmptyArray(record, ["needsUserInput", "needs_user_input", "pendingDecisions", "pending_decisions"])) {
    return true;
  }

  return textValues.some((value) => SAFE_NOOP_PATTERNS.some((pattern) => pattern.test(value)));
}

export function reportHasConfirmedWriteOutcome(report: Pick<WorkerReport, "operations" | "data">): boolean {
  return report.operations.some((operation) => operationLooksLikeSuccessfulWrite(operation))
    || dataIndicatesVerifiedWriteOutcome(report.data);
}

export function reportIndicatesSafeNoopWriteResult(
  report: Pick<WorkerReport, "operations" | "data" | "clarification">,
): boolean {
  if (report.clarification || report.operations.some((operation) => operation.mode === "write")) {
    return false;
  }
  if (reportHasConfirmedWriteOutcome(report)) {
    return false;
  }

  return extractStructuredReportCandidates(report.data).some((record) => recordIndicatesSafeNoop(record));
}

export function formatWorkerReportForPrompt(report: WorkerReport): string {
  if (report.dispatches && report.dispatches.length > 0) {
    return formatMultiWorkerReportForPrompt(report.dispatches);
  }

  if (report.clarification) {
    return [
      "[Worker needs clarification before proceeding]",
      `Question: ${report.clarification}`,
      "[End worker results — rephrase this question naturally for the user]",
    ].join("\n");
  }

  if (report.operations.length === 0) {
    return "";
  }

  const isPartial = report.data?.partial === true;

  const lines: string[] = [
    isPartial
      ? "[Worker execution results (PARTIAL — agent timed out before completing all work)]"
      : "[Worker execution results — data retrieved/actions taken before this message]",
  ];
  const workerSummary = extractWorkerSummaryText(report.data);
  if (workerSummary) {
    lines.push(`Worker summary: ${workerSummary}`);
  }
  for (const warning of extractQualityWarnings(report.data)) {
    lines.push(`Warning: ${warning}`);
  }

  for (const op of report.operations) {
    const modeLabel = op.mode === "write" ? "WROTE" : "READ";
    lines.push(`${modeLabel}: ${op.name}`);

    const outputText = formatOperationOutput(op);
    if (outputText) {
      lines.push(`Result: ${outputText}`);
    }
  }

  lines.push(
    isPartial
      ? "[End worker results (PARTIAL). Summarize what WAS completed. Note that more work may have been intended. Do NOT claim operations succeeded if not listed above.]"
      : "[End worker results — summarize the outcome in 1-3 sentences. Lead with totals and notable items only.]",
  );
  return lines.join("\n");
}

export function mergeWorkerReports(
  dispatches: readonly WorkerDispatchDescriptor[],
  results: readonly PromiseSettledResult<WorkerReport | null>[],
): WorkerReport {
  const mergedDispatches: WorkerDispatchReport[] = dispatches.map((dispatch, index) => {
    const result = results[index];
    if (!result) {
      return {
        workerId: dispatch.workerId,
        task: dispatch.task,
        taskId: dispatch.taskId,
        operations: [],
        hasWriteOperations: false,
        data: {},
        error: "Worker execution did not produce a result.",
      };
    }

    if (result.status === "rejected") {
      return {
        workerId: dispatch.workerId,
        task: dispatch.task,
        taskId: dispatch.taskId,
        operations: [],
        hasWriteOperations: false,
        data: {},
        error: formatWorkerDispatchError(result.reason),
      };
    }

    if (!result.value) {
      return {
        workerId: dispatch.workerId,
        task: dispatch.task,
        taskId: dispatch.taskId,
        operations: [],
        hasWriteOperations: false,
        data: {},
        error: "Worker completed without returning data.",
      };
    }

    return {
      workerId: dispatch.workerId,
      task: dispatch.task,
      taskId: dispatch.taskId,
      operations: result.value.operations,
      hasWriteOperations: result.value.hasWriteOperations,
      data: result.value.data,
      warnings: extractQualityWarnings(result.value.data),
      trace: result.value.trace,
      clarification: result.value.clarification,
    };
  });

  return {
    operations: mergedDispatches.flatMap((dispatch) => dispatch.operations),
    hasWriteOperations: mergedDispatches.some((dispatch) => dispatch.hasWriteOperations),
    data: {
      dispatchCount: mergedDispatches.length,
      dispatches: mergedDispatches.map((dispatch) => ({
        workerId: dispatch.workerId,
        taskId: dispatch.taskId,
        hasWriteOperations: dispatch.hasWriteOperations,
        clarification: dispatch.clarification,
        error: dispatch.error,
      })),
    },
    dispatches: mergedDispatches,
    trace: {
      workerRuntime: {
        dispatchCount: mergedDispatches.length,
        failedDispatchCount: mergedDispatches.filter((dispatch) => dispatch.error).length,
      },
    },
  };
}

/**
 * Format an operation's output for Claude's prompt. For known write operations,
 * produce compact summaries so Claude doesn't echo raw ingredient lists.
 * For reads and unknown operations, use full JSON.
 */
function formatOperationOutput(op: WorkerReportOperation): string {
  const output = op.output;
  if (output === null || output === undefined) return "";
  if (typeof output === "string") return output;

  // Compact summaries for known write operations
  if (op.mode === "write" && typeof output === "object" && !Array.isArray(output)) {
    const compact = formatCompactWriteOutput(op.name, output as Record<string, unknown>);
    if (compact) return compact;
  }

  try {
    const text = JSON.stringify(output);
    if (text.length > 4000) {
      return `${text.slice(0, 3997)}...`;
    }
    return text;
  } catch {
    return String(output);
  }
}

function formatCompactWriteOutput(
  operationName: string,
  output: Record<string, unknown>,
): string | null {
  if (output.error) {
    return JSON.stringify(output);
  }

  switch (operationName) {
    case "recipe_meal_log": {
      const logged = Array.isArray(output.logged) ? output.logged : [];
      const unresolved = Array.isArray(output.unresolved) ? output.unresolved : [];
      const parts = [
        `recipe=${json(output.recipeTitle)}`,
        `meal=${json(output.meal)}`,
        `logged=${logged.length} ingredients`,
      ];
      if (output.estimatedCalories !== undefined) parts.push(`~${output.estimatedCalories} cal`);
      if (output.estimatedProtein !== undefined) parts.push(`~${output.estimatedProtein}g protein`);
      if (unresolved.length > 0) parts.push(`unresolved=[${unresolved.map(json).join(",")}]`);
      if (output.totals !== undefined) parts.push(`day_totals=${JSON.stringify(output.totals)}`);
      return parts.join(", ");
    }
    case "food_log": {
      const parts: string[] = [];
      if (output.result) parts.push(`result=${json(output.result)}`);
      if (output.totals !== undefined) parts.push(`day_totals=${JSON.stringify(output.totals)}`);
      return parts.length > 0 ? parts.join(", ") : null;
    }
    case "workout_log_set": {
      const parts = [
        `exercise=${json(output.exercise)}`,
        `set=${json(output.setNumber)}`,
        `weight=${json(output.weight)}`,
        `reps=${json(output.reps)}`,
      ];
      if (output.volume !== undefined) parts.push(`volume=${output.volume}`);
      return parts.join(", ");
    }
    default:
      return null;
  }
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function formatMultiWorkerReportForPrompt(dispatches: readonly WorkerDispatchReport[]): string {
  const lines: string[] = [
    `[Worker execution results — ${dispatches.length} task${dispatches.length === 1 ? "" : "s"} executed in parallel]`,
  ];

  dispatches.forEach((dispatch, index) => {
    lines.push("");
    lines.push(formatDispatchHeading(dispatch, index));

    if (dispatch.error) {
      lines.push(`Error: ${dispatch.error}`);
      return;
    }

    if (dispatch.clarification) {
      lines.push(`Clarification needed: ${dispatch.clarification}`);
      return;
    }

    const workerSummary = extractWorkerSummaryText(dispatch.data);
    if (workerSummary) {
      lines.push(`Worker summary: ${workerSummary}`);
    }
    const warnings = dispatch.warnings && dispatch.warnings.length > 0
      ? dispatch.warnings
      : extractQualityWarnings(dispatch.data);
    for (const warning of warnings) {
      lines.push(`Warning: ${warning}`);
    }

    if (dispatch.operations.length === 0) {
      if (!workerSummary) {
        lines.push("Result: Worker returned no operations.");
      }
      return;
    }

    for (const op of dispatch.operations) {
      const modeLabel = op.mode === "write" ? "WROTE" : "READ";
      lines.push(`  ${modeLabel}: ${op.name}`);

      const outputText = formatOperationOutput(op);
      if (outputText) {
        lines.push(`  Result: ${outputText}`);
      }
    }
  });

  lines.push("");
  lines.push(
    "[End worker results — synthesize the outcome for the user. Lead with totals and notable items only.]",
  );
  return lines.join("\n");
}

function formatDispatchHeading(dispatch: WorkerDispatchReport, index: number): string {
  const taskLabel = dispatch.taskId ? `Task "${dispatch.taskId}"` : `Task ${index + 1}`;
  const partialSuffix = dispatch.data?.partial ? " (PARTIAL — timed out)" : "";
  return `${taskLabel} (${dispatch.workerId})${partialSuffix}:`;
}

function formatWorkerDispatchError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function extractWorkerSummaryText(data: Record<string, unknown> | undefined): string | null {
  const normalized = sanitizeWorkerTextForDisplay(data?.workerText);
  if (normalized.length === 0) {
    return null;
  }

  return normalized.length > 2000
    ? `${normalized.slice(0, 1997)}...`
    : normalized;
}

function extractQualityWarnings(data: Record<string, unknown> | undefined): string[] {
  const warnings = data?.qualityWarnings;
  if (!Array.isArray(warnings)) {
    return [];
  }
  return warnings.filter((warning): warning is string => typeof warning === "string" && warning.trim().length > 0);
}
