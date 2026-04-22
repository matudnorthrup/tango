/**
 * Scheduler Executor — Executes a single scheduled job based on its execution mode.
 *
 * Three modes:
 * - deterministic: calls a registered handler function directly
 * - conditional-agent: calls pre-check handler, then optionally spawns agent worker
 * - agent: always spawns agent worker
 */

import type {
  ScheduleConfig,
  WorkerExecuteFn,
  ScheduledTurnExecuteFn,
  V2ScheduledTurnExecuteFn,
  HandlerContext,
  RunStatus,
} from "./types.js";
import type { SchedulerStore } from "./store.js";
import { getDeterministicHandler, getPreCheckHandler } from "./handlers.js";

export interface ExecutionResult {
  status: RunStatus;
  durationMs: number;
  summary?: string;
  error?: string;
  modelUsed?: string;
  preCheckResult?: string;
  metadata?: Record<string, unknown>;
}

export interface ExecutorDeps {
  store: SchedulerStore;
  executeWorker: WorkerExecuteFn;
  executeScheduledTurn?: ScheduledTurnExecuteFn;
  executeV2Turn?: V2ScheduledTurnExecuteFn;
  db: import("node:sqlite").DatabaseSync;
}

export async function executeSchedule(
  config: ScheduleConfig,
  deps: ExecutorDeps,
): Promise<ExecutionResult> {
  const startTime = Date.now();
  const { mode } = config.execution;

  try {
    switch (mode) {
      case "deterministic":
        return await executeDeterministic(config, deps, startTime);
      case "conditional-agent":
        return await executeConditionalAgent(config, deps, startTime);
      case "agent":
        return await executeAgent(config, deps, startTime);
      default:
        return {
          status: "error",
          durationMs: Date.now() - startTime,
          error: `Unknown execution mode: ${mode}`,
        };
    }
  } catch (err) {
    return {
      status: "error",
      durationMs: Date.now() - startTime,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// -------------------------------------------------------------------
// Deterministic execution
// -------------------------------------------------------------------

async function executeDeterministic(
  config: ScheduleConfig,
  deps: ExecutorDeps,
  startTime: number,
): Promise<ExecutionResult> {
  const handlerName = config.execution.handler;
  if (!handlerName) {
    return {
      status: "error",
      durationMs: Date.now() - startTime,
      error: "Deterministic schedule missing 'execution.handler'",
    };
  }

  const handler = getDeterministicHandler(handlerName);
  if (!handler) {
    return {
      status: "error",
      durationMs: Date.now() - startTime,
      error: `No deterministic handler registered for '${handlerName}'`,
    };
  }

  const ctx: HandlerContext = {
    scheduleId: config.id,
    db: deps.db,
    lastRunAt: getLastRunDate(config.id, deps),
  };

  const timeoutMs = (config.execution.timeoutSeconds ?? 30) * 1000;
  const result = await withTimeout(handler(ctx), timeoutMs, `Handler '${handlerName}' timed out`);

  return {
    status: result.status,
    durationMs: Date.now() - startTime,
    summary: result.summary,
  };
}

// -------------------------------------------------------------------
// Conditional-agent execution
// -------------------------------------------------------------------

async function executeConditionalAgent(
  config: ScheduleConfig,
  deps: ExecutorDeps,
  startTime: number,
): Promise<ExecutionResult> {
  const preCheckConfig = config.execution.preCheck;
  if (!preCheckConfig) {
    return {
      status: "error",
      durationMs: Date.now() - startTime,
      error: "Conditional-agent schedule missing 'execution.pre_check'",
    };
  }

  const preCheckHandler = getPreCheckHandler(preCheckConfig.handler);
  if (!preCheckHandler) {
    return {
      status: "error",
      durationMs: Date.now() - startTime,
      error: `No pre-check handler registered for '${preCheckConfig.handler}'`,
    };
  }

  // Run the pre-check
  const ctx: HandlerContext = {
    scheduleId: config.id,
    db: deps.db,
    lastRunAt: getLastRunDate(config.id, deps),
  };

  const preCheckResult = await withTimeout(
    preCheckHandler(ctx),
    30_000,
    `Pre-check '${preCheckConfig.handler}' timed out`,
  );

  if (preCheckResult.action === "skip") {
    return {
      status: "skipped",
      durationMs: Date.now() - startTime,
      summary: preCheckResult.reason,
      preCheckResult: JSON.stringify(preCheckResult),
    };
  }

  // Pre-check says proceed — spawn the agent worker
  return await runAgentWorker(config, deps, startTime, preCheckResult.context);
}

// -------------------------------------------------------------------
// Agent execution
// -------------------------------------------------------------------

async function executeAgent(
  config: ScheduleConfig,
  deps: ExecutorDeps,
  startTime: number,
): Promise<ExecutionResult> {
  return await runAgentWorker(config, deps, startTime);
}

// -------------------------------------------------------------------
// Shared agent worker execution
// -------------------------------------------------------------------

async function runAgentWorker(
  config: ScheduleConfig,
  deps: ExecutorDeps,
  startTime: number,
  preCheckContext?: Record<string, unknown>,
): Promise<ExecutionResult> {
  const workerId = config.execution.workerId;
  if (!workerId) {
    return {
      status: "error",
      durationMs: Date.now() - startTime,
      error: "Agent schedule missing 'execution.worker_id'",
    };
  }

  // Resolve the task
  let task: string;
  if (preCheckContext && config.execution.taskTemplate) {
    task = interpolateTemplate(config.execution.taskTemplate, preCheckContext);
  } else if (config.execution.task) {
    task = config.execution.task;
  } else {
    return {
      status: "error",
      durationMs: Date.now() - startTime,
      error: "Agent schedule missing 'execution.task' or 'execution.task_template'",
    };
  }

  const model = config.provider?.model;
  const reasoningEffort = config.provider?.reasoningEffort;
  const timeoutMs = (config.execution.timeoutSeconds ?? 300) * 1000;

  // v2 runtime path: spawn a fresh Claude Code adapter for this job
  if (config.runtime === "v2" && deps.executeV2Turn) {
    const agentId = config.delivery?.agentId ?? config.execution.deterministicAgentId ?? "dispatch";
    const v2Result = await withTimeout(
      deps.executeV2Turn({ config, task, agentId }),
      timeoutMs,
      `V2 scheduled turn for agent '${agentId}' timed out`,
    );
    const trimmedText = v2Result.text.trim();
    const summary = trimmedText === "__NO_OUTPUT__" ? undefined : trimmedText.slice(0, 2000);

    return {
      status: "ok",
      durationMs: Date.now() - startTime,
      summary,
      modelUsed: v2Result.model,
      preCheckResult: preCheckContext ? JSON.stringify({ action: "proceed", context: preCheckContext }) : undefined,
      metadata: v2Result.metadata,
    };
  }

  if ((config.execution.intentIds?.length ?? 0) > 0) {
    if (!deps.executeScheduledTurn) {
      return {
        status: "error",
        durationMs: Date.now() - startTime,
        error: "Scheduler deterministic turn executor is not configured.",
      };
    }

    const scheduledTurnPromise = deps.executeScheduledTurn({
      config,
      workerId,
      task,
      model,
      reasoningEffort,
    });
    const result = await withTimeout(
      scheduledTurnPromise,
      timeoutMs,
      `Deterministic schedule turn for worker '${workerId}' timed out`,
    );
    const trimmedText = result.text.trim();
    const summary = trimmedText === "__NO_OUTPUT__" ? undefined : trimmedText.slice(0, 2000);

    return {
      status: "ok",
      durationMs: Date.now() - startTime,
      summary,
      modelUsed: result.modelUsed ?? model,
      preCheckResult: preCheckContext ? JSON.stringify({ action: "proceed", context: preCheckContext }) : undefined,
      metadata: result.metadata,
    };
  }

  const workerPromise = deps.executeWorker(workerId, task, model, reasoningEffort);
  const result = await withTimeout(workerPromise, timeoutMs, `Worker '${workerId}' timed out`);

  // Workers can return "__NO_OUTPUT__" to signal nothing to report (e.g., no
  // uncategorized transactions). Treat as a successful skip — no delivery, no
  // summary in logs.
  const trimmedText = result.text.trim();
  const summary = trimmedText === "__NO_OUTPUT__" ? undefined : trimmedText.slice(0, 2000);

  return {
    status: "ok",
    durationMs: Date.now() - startTime,
    summary,
    modelUsed: model,
    preCheckResult: preCheckContext ? JSON.stringify({ action: "proceed", context: preCheckContext }) : undefined,
  };
}

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

function getLastRunDate(scheduleId: string, deps: ExecutorDeps): Date | undefined {
  const state = deps.store.getState(scheduleId);
  if (state?.lastRunAt) {
    return new Date(state.lastRunAt);
  }
  return undefined;
}

function interpolateTemplate(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
    const value = context[key];
    if (value === undefined) return `{{${key}}}`;
    if (typeof value === "string") return value;
    return JSON.stringify(value);
  });
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
