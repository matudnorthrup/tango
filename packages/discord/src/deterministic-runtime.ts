import {
  formatWorkerReportForPrompt,
  reportHasConfirmedWriteOutcome,
  reportIndicatesSafeNoopWriteResult,
  type WorkerDispatchReport,
  type WorkerReport,
  type WorkerReportOperation,
} from "./worker-report.js";
import type { DeterministicExecutionPlan, DeterministicExecutionStep } from "./deterministic-router.js";
import type { IntentEnvelope } from "./intent-classifier.js";

export interface ExecutionReceipt {
  stepId: string;
  intentId: string;
  mode: "read" | "write" | "mixed";
  kind: "workflow" | "worker";
  targetId: string;
  workerId: string;
  status: "completed" | "failed" | "skipped";
  durationMs: number;
  operations: WorkerReportOperation[];
  hasWriteOperations: boolean;
  data: Record<string, unknown>;
  warnings: string[];
  error?: string;
  clarification?: string;
}

export interface DeterministicTurnState {
  auth: {
    initiatingPrincipalId: string;
    leadAgentPrincipalId: string;
    projectId?: string;
    topicId?: string;
    delegationChain: string[];
  };
  intent: {
    envelopes: IntentEnvelope[];
    classifierProvider?: string;
    classifierModel?: string;
    classifierLatencyMs?: number;
  };
  routing: {
    plan?: DeterministicExecutionPlan;
    clarificationNeeded: boolean;
    routeOutcome: "executed" | "clarification" | "fallback";
    routeLatencyMs?: number;
    fallbackReason?: string;
  };
  execution: {
    receipts: ExecutionReceipt[];
    completed: boolean;
    partialFailure: boolean;
    executionLatencyMs?: number;
    hasWriteOperations?: boolean;
  };
  narration: {
    synthesisProvider?: string;
    synthesisModel?: string;
    narrationLatencyMs?: number;
    usedRetry?: boolean;
    directResponse?: boolean;
  };
}

export function receiptHasConfirmedWriteOutcome(
  receipt: Pick<ExecutionReceipt, "status" | "operations" | "data">,
): boolean {
  if (receipt.status !== "completed") {
    return false;
  }
  return reportHasConfirmedWriteOutcome({
    operations: receipt.operations,
    data: receipt.data,
  });
}

function formatWorkerDispatchError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
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
            results[index] = { status: "fulfilled", value };
          })
          .catch((reason) => {
            results[index] = { status: "rejected", reason };
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

interface StepExecutionResult {
  report: WorkerReport | null;
  durationMs: number;
  error?: string;
  skipped?: boolean;
}

function extractQualityWarnings(data: Record<string, unknown> | undefined): string[] {
  const warnings = data?.qualityWarnings;
  if (!Array.isArray(warnings)) {
    return [];
  }
  return warnings.filter((warning): warning is string => typeof warning === "string" && warning.trim().length > 0);
}

function deriveExecutionWarnings(step: DeterministicExecutionStep, report: WorkerReport): string[] {
  const warnings = extractQualityWarnings(report.data);
  if ((step.mode === "write" || step.mode === "mixed") && !report.clarification) {
    if (!report.hasWriteOperations && !reportHasConfirmedWriteOutcome(report)) {
      if (!(step.safeNoopAllowed && reportIndicatesSafeNoopWriteResult(report))) {
        warnings.push(
          "No write operation was recorded for this write step. Do not claim that any change was applied unless a later receipt proves it.",
        );
      }
    } else if (report.hasWriteOperations && !reportHasConfirmedWriteOutcome(report)) {
      warnings.push(
        "Write operations were attempted for this step, but no confirmed committed result was recorded. Do not claim that any change was applied unless a later receipt proves it.",
      );
    }
  }
  return [...new Set(warnings)];
}

function isStepReadyForDependents(result: StepExecutionResult | undefined): boolean {
  if (!result || result.error || result.skipped || !result.report) {
    return false;
  }
  if (result.report.clarification) {
    return false;
  }
  return result.report.data?.partial !== true;
}

async function executePlanWithDependencies(input: {
  plan: DeterministicExecutionPlan;
  executeWorkerWithTask: (
    workerId: string,
    task: string,
    step: DeterministicExecutionStep,
  ) => Promise<WorkerReport | null>;
  concurrencyLimit: number;
  timeoutMs: number;
  getConcurrencyGroup?: (step: DeterministicExecutionStep) => string | undefined;
}): Promise<StepExecutionResult[]> {
  const results: Array<StepExecutionResult | undefined> = new Array(input.plan.steps.length);
  const stepIndexById = new Map(input.plan.steps.map((step, index) => [step.id, index] as const));
  const started = new Array(input.plan.steps.length).fill(false);
  const activeGroups = new Set<string>();
  let activeCount = 0;
  let completedCount = 0;

  const getStepGroups = (step: DeterministicExecutionStep): string[] => {
    const groups: string[] = [];
    if (step.parallelGroup) {
      groups.push(`plan:${step.parallelGroup}`);
    }
    const runtimeGroup = input.getConcurrencyGroup?.(step);
    if (runtimeGroup) {
      groups.push(`runtime:${runtimeGroup}`);
    }
    return groups;
  };

  const getDependencyState = (step: DeterministicExecutionStep): {
    ready: boolean;
    blockReason?: string;
  } => {
    for (const dependencyId of step.dependsOn) {
      const dependencyIndex = stepIndexById.get(dependencyId);
      if (dependencyIndex === undefined) {
        return {
          ready: true,
          blockReason: `Blocked by missing dependency '${dependencyId}'.`,
        };
      }
      const dependencyResult = results[dependencyIndex];
      if (!dependencyResult) {
        return { ready: false };
      }
      if (!isStepReadyForDependents(dependencyResult)) {
        return {
          ready: true,
          blockReason: `Blocked by dependency '${dependencyId}' not completing successfully.`,
        };
      }
    }

    return { ready: true };
  };

  if (input.plan.steps.length === 0) {
    return [];
  }

  await new Promise<void>((resolve) => {
    let settled = false;

    const maybeResolve = () => {
      if (!settled && completedCount >= input.plan.steps.length) {
        settled = true;
        resolve();
      }
    };

    const markBlockedSteps = () => {
      let changed = false;
      for (const [index, step] of input.plan.steps.entries()) {
        if (started[index]) continue;
        const dependencyState = getDependencyState(step);
        if (!dependencyState.ready || !dependencyState.blockReason) continue;
        started[index] = true;
        results[index] = {
          report: null,
          durationMs: 0,
          error: dependencyState.blockReason,
          skipped: true,
        };
        completedCount += 1;
        changed = true;
      }
      return changed;
    };

    const findNextRunnableIndex = (): number => {
      for (const [index, step] of input.plan.steps.entries()) {
        if (started[index]) continue;
        const dependencyState = getDependencyState(step);
        if (!dependencyState.ready || dependencyState.blockReason) continue;
        const groups = getStepGroups(step);
        if (groups.some((group) => activeGroups.has(group))) continue;
        return index;
      }
      return -1;
    };

    const schedule = () => {
      if (markBlockedSteps()) {
        maybeResolve();
      }

      while (activeCount < Math.max(1, Math.min(input.concurrencyLimit, input.plan.steps.length))) {
        const index = findNextRunnableIndex();
        if (index === -1) break;

        const step = input.plan.steps[index];
        if (!step) break;

        started[index] = true;
        activeCount += 1;
        const groups = getStepGroups(step);
        groups.forEach((group) => activeGroups.add(group));

        const startedAt = Date.now();
        const workerPromise = input.executeWorkerWithTask(step.workerId, step.task, step);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(
                `Worker ${step.workerId} exceeded wall-clock timeout of ${Math.round(input.timeoutMs / 1000)}s`,
              ),
            );
          }, input.timeoutMs);
          timer.unref();
        });

        void Promise.race([workerPromise, timeoutPromise])
          .then((report) => {
            results[index] = {
              report,
              durationMs: Date.now() - startedAt,
            };
          })
          .catch((reason) => {
            results[index] = {
              report: null,
              durationMs: Date.now() - startedAt,
              error: formatWorkerDispatchError(reason),
            };
          })
          .finally(() => {
            if (timer) {
              clearTimeout(timer);
            }
            activeCount -= 1;
            completedCount += 1;
            groups.forEach((group) => activeGroups.delete(group));
            schedule();
            maybeResolve();
          });
      }

      maybeResolve();
    };

    schedule();
  });

  return input.plan.steps.map((_, index) => results[index] ?? {
    report: null,
    durationMs: 0,
    error: "Worker did not return a result.",
  });
}

export async function executeDeterministicPlan(input: {
  plan: DeterministicExecutionPlan;
  executeWorkerWithTask: (
    workerId: string,
    task: string,
    step: DeterministicExecutionStep,
  ) => Promise<WorkerReport | null>;
  concurrencyLimit: number;
  timeoutMs: number;
  getConcurrencyGroup?: (step: DeterministicExecutionStep) => string | undefined;
}): Promise<ExecutionReceipt[]> {
  const results = await executePlanWithDependencies(input);

  return input.plan.steps.map((step, index) => {
    const result = results[index];
    if (!result) {
      return {
        stepId: step.id,
        intentId: step.intentId,
        mode: step.mode,
        kind: step.kind,
        targetId: step.targetId,
        workerId: step.workerId,
        status: "failed" as const,
        durationMs: 0,
        operations: [],
        hasWriteOperations: false,
        data: {},
        warnings: [],
        error: "Worker did not return a result.",
      };
    }

    if (result.skipped) {
      return {
        stepId: step.id,
        intentId: step.intentId,
        mode: step.mode,
        kind: step.kind,
        targetId: step.targetId,
        workerId: step.workerId,
        status: "skipped" as const,
        durationMs: result.durationMs,
        operations: [],
        hasWriteOperations: false,
        data: {},
        warnings: [],
        error: result.error ?? "Step was skipped.",
      };
    }

    if (result.error) {
      return {
        stepId: step.id,
        intentId: step.intentId,
        mode: step.mode,
        kind: step.kind,
        targetId: step.targetId,
        workerId: step.workerId,
        status: "failed" as const,
        durationMs: result.durationMs,
        operations: [],
        hasWriteOperations: false,
        data: {},
        warnings: [],
        error: result.error,
      };
    }

    const report = result.report;
    if (!report) {
      return {
        stepId: step.id,
        intentId: step.intentId,
        mode: step.mode,
        kind: step.kind,
        targetId: step.targetId,
        workerId: step.workerId,
        status: "failed" as const,
        durationMs: result.durationMs,
        operations: [],
        hasWriteOperations: false,
        data: {},
        warnings: [],
        error: "Worker completed without returning data.",
      };
    }

    return {
      stepId: step.id,
      intentId: step.intentId,
      mode: step.mode,
      kind: step.kind,
      targetId: step.targetId,
      workerId: step.workerId,
      status: "completed" as const,
      durationMs: result.durationMs,
      operations: report.operations,
      hasWriteOperations: report.hasWriteOperations,
      data: report.data,
      warnings: deriveExecutionWarnings(step, report),
      clarification: report.clarification,
    };
  });
}

function receiptToDispatchReport(receipt: ExecutionReceipt): WorkerDispatchReport {
  return {
    workerId: receipt.workerId,
    task: receipt.stepId,
    taskId: receipt.stepId,
    operations: receipt.operations,
    hasWriteOperations: receipt.hasWriteOperations,
    data: receipt.data,
    warnings: receipt.warnings,
    clarification: receipt.clarification,
    error: receipt.status === "completed" ? undefined : receipt.error,
  };
}

export function formatExecutionReceiptsForPrompt(receipts: readonly ExecutionReceipt[]): string {
  if (receipts.length === 0) {
    return "[Worker execution failed — no data returned. Explain to the user that the operation could not be completed and suggest they try again.]";
  }

  if (receipts.length === 1) {
    const [receipt] = receipts;
    if (!receipt) {
      return "[Worker execution failed — no data returned. Explain to the user that the operation could not be completed and suggest they try again.]";
    }
    return formatWorkerReportForPrompt({
      operations: receipt.operations,
      hasWriteOperations: receipt.hasWriteOperations,
      data: {
        ...receipt.data,
        qualityWarnings: receipt.warnings,
      },
      clarification: receipt.clarification,
      dispatches: receipt.status === "completed" ? undefined : [receiptToDispatchReport(receipt)],
    });
  }

  return formatWorkerReportForPrompt({
    operations: receipts.flatMap((receipt) => receipt.operations),
    hasWriteOperations: receipts.some((receipt) => receipt.hasWriteOperations),
    data: {
      dispatchCount: receipts.length,
    },
    dispatches: receipts.map(receiptToDispatchReport),
  });
}

export function buildDeterministicNarrationPrompt(input: {
  userMessage: string;
  receiptsText: string;
}): string {
  return [
    "Original user message:",
    input.userMessage,
    "",
    "The deterministic runtime already completed the necessary worker steps.",
    "Here are the execution receipts:",
    "",
    input.receiptsText,
    "",
    "Write the final reply to the user now.",
    "Do not mention internal routing, dispatch, or that you are still waiting.",
    "If the receipts contain a recommendation, shortlist, comparison, or tradeoffs, preserve a compact comparison block instead of flattening everything into pure prose.",
  ].join("\n");
}

export function buildClarificationNarrationPrompt(input: {
  userMessage: string;
  clarificationQuestion: string;
}): string {
  return [
    "Original user message:",
    input.userMessage,
    "",
    "The deterministic router concluded that one clarification is required before any worker runs.",
    `Clarification needed: ${input.clarificationQuestion}`,
    "",
    "Ask that question naturally and briefly.",
  ].join("\n");
}

export function buildDeterministicTurnSummary(input: {
  userMessage: string;
  routeOutcome: "executed" | "clarification" | "fallback";
  intents: readonly IntentEnvelope[];
  receipts?: readonly ExecutionReceipt[];
  finalReply?: string;
}): string {
  const lines = [
    "[Deterministic turn summary]",
    `Outcome: ${input.routeOutcome}`,
    `User: ${input.userMessage}`,
  ];

  if (input.intents.length > 0) {
    lines.push(`Intents: ${input.intents.map((intent) => intent.intentId).join(", ")}`);
  }

  if (input.receipts && input.receipts.length > 0) {
    for (const receipt of input.receipts) {
      const summary =
        typeof receipt.data?.workerText === "string"
          ? receipt.data.workerText.trim()
          : receipt.error ?? receipt.clarification ?? `${receipt.operations.length} operations`;
      lines.push(`- ${receipt.stepId} (${receipt.workerId}) ${receipt.status}: ${summary}`);
      for (const warning of receipt.warnings) {
        lines.push(`  warning: ${warning}`);
      }
    }
  }

  if (input.finalReply) {
    lines.push(`Reply: ${input.finalReply}`);
  }

  return lines.join("\n");
}
