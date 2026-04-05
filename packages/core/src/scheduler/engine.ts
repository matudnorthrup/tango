/**
 * Scheduler Engine — Tick loop, due-job detection, concurrency management.
 *
 * Ticks every 15 seconds. On each tick:
 * 1. Find all due jobs (enabled + next_run_at <= now + not backed off)
 * 2. Sort by priority (descending)
 * 3. Respect concurrency group constraints
 * 4. Execute each job, tracking runs in SQLite
 */

import { Cron } from "croner";
import type {
  ScheduleConfig,
  RunStatus,
  WorkerExecuteFn,
  ScheduledTurnExecuteFn,
  DeliveryFn,
  AlertFn,
  SystemLogFn,
} from "./types.js";
import { SchedulerStore } from "./store.js";
import { executeSchedule, type ExecutionResult } from "./executor.js";

const TICK_INTERVAL_MS = 15_000;
const DEFAULT_MAX_CONCURRENT = 3;

export interface EngineConfig {
  maxConcurrent?: number;
}

export interface EngineDeps {
  store: SchedulerStore;
  executeWorker: WorkerExecuteFn;
  executeScheduledTurn?: ScheduledTurnExecuteFn;
  deliver?: DeliveryFn;
  alert?: AlertFn;
  systemLog?: SystemLogFn;
  db: import("node:sqlite").DatabaseSync;
}

interface ScheduleRuntimeState {
  config: ScheduleConfig;
  nextRunAt: number | null; // epoch ms, null = won't run (disabled or one-shot expired)
  running: boolean;
}

export class SchedulerEngine {
  private readonly schedules = new Map<string, ScheduleRuntimeState>();
  private readonly runningGroups = new Map<string, number>(); // group -> count of running jobs
  private readonly maxConcurrent: number;
  private readonly deps: EngineDeps;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private runningCount = 0;
  private alertedSchedules = new Set<string>(); // track which schedules have been alerted

  constructor(configs: ScheduleConfig[], deps: EngineDeps, engineConfig?: EngineConfig) {
    this.deps = deps;
    this.maxConcurrent = engineConfig?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;

    // Initialize runtime state for each schedule
    for (const config of configs) {
      const state = this.deps.store.getState(config.id);
      const nextRunAt = config.enabled ? this.computeNextRunAt(config, state?.backoffUntil ?? undefined) : null;

      this.schedules.set(config.id, {
        config,
        nextRunAt,
        running: false,
      });

      if (nextRunAt) {
        console.error(
          `[scheduler] loaded schedule=${config.id} next=${formatScheduleInstant(
            nextRunAt,
            config.schedule.timezone ?? "America/Los_Angeles",
          )}`
        );
      }
    }

    // Check for any stale "running" entries from a previous crash
    this.cleanupStaleRuns();
  }

  start(): void {
    if (this.tickTimer) return;
    console.error(`[scheduler] starting tick loop (${TICK_INTERVAL_MS / 1000}s interval, max_concurrent=${this.maxConcurrent})`);
    this.tickTimer = setInterval(() => this.tick(), TICK_INTERVAL_MS);
    this.tickTimer.unref(); // Don't prevent process exit
    // Run first tick immediately
    this.tick();
  }

  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    console.error("[scheduler] stopped");
  }

  /** Manual trigger for a specific schedule (for API/dashboard use). */
  async trigger(scheduleId: string): Promise<ExecutionResult | null> {
    const runtime = this.schedules.get(scheduleId);
    if (!runtime) return null;
    return await this.executeJob(runtime);
  }

  getSchedules(): Array<{ config: ScheduleConfig; nextRunAt: number | null; running: boolean }> {
    return [...this.schedules.values()].map((s) => ({
      config: s.config,
      nextRunAt: s.nextRunAt,
      running: s.running,
    }));
  }

  // -------------------------------------------------------------------
  // Tick loop
  // -------------------------------------------------------------------

  private tick(): void {
    const now = Date.now();
    const due: ScheduleRuntimeState[] = [];

    for (const runtime of this.schedules.values()) {
      if (!runtime.config.enabled) continue;
      if (runtime.running) continue;
      if (runtime.nextRunAt === null) continue;
      if (runtime.nextRunAt > now) continue;

      // Check backoff
      const state = this.deps.store.getState(runtime.config.id);
      if (state?.backoffUntil) {
        const backoffUntilMs = new Date(state.backoffUntil).getTime();
        if (now < backoffUntilMs) continue;
      }

      due.push(runtime);
    }

    if (due.length === 0) return;

    // Sort by priority (higher first)
    due.sort((a, b) => {
      const pa = a.config.policy?.priority ?? 0;
      const pb = b.config.policy?.priority ?? 0;
      return pb - pa;
    });

    // Execute due jobs respecting concurrency limits
    for (const runtime of due) {
      if (this.runningCount >= this.maxConcurrent) break;

      // Check concurrency group
      const group = runtime.config.policy?.concurrencyGroup;
      if (group && (this.runningGroups.get(group) ?? 0) > 0) continue;

      // Fire and forget (tracked via promise)
      this.executeJob(runtime).catch((err) => {
        console.error(`[scheduler] unexpected error schedule=${runtime.config.id}`, err);
      });
    }
  }

  // -------------------------------------------------------------------
  // Job execution
  // -------------------------------------------------------------------

  private async executeJob(runtime: ScheduleRuntimeState): Promise<ExecutionResult> {
    const { config } = runtime;
    const { store } = this.deps;

    // Mark as running
    runtime.running = true;
    this.runningCount++;
    const group = config.policy?.concurrencyGroup;
    if (group) {
      this.runningGroups.set(group, (this.runningGroups.get(group) ?? 0) + 1);
    }

    // Check completion before running
    if (config.completion?.checkBeforeRun !== false && config.completion) {
      const workflowId = config.completion.workflowId ?? config.id;
      const scope = config.completion.scope ?? "daily";
      const existing = store.checkCompletion(workflowId, scope);
      if (existing) {
        const result: ExecutionResult = {
          status: "skipped",
          durationMs: 0,
          summary: `Already completed by ${existing.completedBy} at ${existing.completedAt}`,
        };
        console.error(
          `[scheduler] run:skip schedule=${config.id} reason="workflow already completed"`
        );
        // Record the skip in state so dashboard can see it
        store.upsertState(config.id, {
          lastRunAt: new Date().toISOString(),
          lastStatus: "skipped",
          lastDurationMs: 0,
          consecutiveFailures: 0,
        });
        this.finishJob(runtime, result);
        return result;
      }
    }

    // Insert run record
    const runId = store.insertRun({
      scheduleId: config.id,
      executionMode: config.execution.mode,
      workerId: config.execution.workerId,
    });

    console.error(
      `[scheduler] run:start schedule=${config.id} mode=${config.execution.mode}` +
        (config.execution.workerId ? ` worker=${config.execution.workerId}` : "")
    );

    // Execute
    const result = await executeSchedule(config, {
      store,
      executeWorker: this.deps.executeWorker,
      executeScheduledTurn: this.deps.executeScheduledTurn,
      db: this.deps.db,
    });

    // Update run record
    store.updateRunFinished(runId, {
      status: result.status,
      durationMs: result.durationMs,
      error: result.error,
      summary: result.summary,
      modelUsed: result.modelUsed,
      preCheckResult: result.preCheckResult,
      metadata: result.metadata,
    });

    // Log result
    if (result.status === "ok") {
      console.error(
        `[scheduler] run:ok schedule=${config.id} duration=${result.durationMs}ms` +
          (result.modelUsed ? ` model=${result.modelUsed}` : "")
      );
    } else if (result.status === "error") {
      console.error(
        `[scheduler] run:error schedule=${config.id} error="${result.error}" duration=${result.durationMs}ms`
      );
    } else if (result.status === "skipped") {
      console.error(
        `[scheduler] run:skip schedule=${config.id} reason="${result.summary}"`
      );
    }

    // Update state
    const prevState = store.getState(config.id);
    const prevFailures = prevState?.consecutiveFailures ?? 0;
    const newFailures = result.status === "error" ? prevFailures + 1 : 0;
    const backoffUntil = this.computeBackoff(config, newFailures);

    store.upsertState(config.id, {
      lastRunAt: new Date().toISOString(),
      lastStatus: result.status,
      lastDurationMs: result.durationMs,
      lastError: result.error,
      consecutiveFailures: newFailures,
      backoffUntil,
    });

    // Mark completion on success
    if (
      result.status === "ok" &&
      config.completion?.markOnSuccess !== false &&
      config.completion
    ) {
      const workflowId = config.completion.workflowId ?? config.id;
      const scope = config.completion.scope ?? "daily";
      store.markCompletion({
        workflowId,
        scope,
        completedBy: `schedule:${config.id}`,
        scheduleRunId: runId,
      });
    }

    // Deliver results
    if (
      result.status === "ok" &&
      result.summary &&
      config.delivery?.channelId &&
      config.delivery?.mode !== "none" &&
      this.deps.deliver
    ) {
      try {
        await this.deps.deliver(
          config.delivery.channelId,
          config.delivery.agentId ?? "dispatch",
          result.summary,
        );
        store.updateRunFinished(runId, {
          ...result,
          deliveryStatus: "delivered",
        });
      } catch (deliveryErr) {
        const errMsg = deliveryErr instanceof Error ? deliveryErr.message : String(deliveryErr);
        console.error(`[scheduler] delivery failed schedule=${config.id}: ${errMsg}`);
        store.updateRunFinished(runId, {
          ...result,
          deliveryStatus: "failed",
          deliveryError: errMsg,
        });
      }
    }

    // Check failure threshold and alert
    const maxFailures = config.policy?.maxConsecutiveFailures ?? 3;
    if (
      newFailures >= maxFailures &&
      !this.alertedSchedules.has(config.id) &&
      config.policy?.alertChannelId &&
      this.deps.alert
    ) {
      this.alertedSchedules.add(config.id);
      const alertMsg =
        `**Schedule Alert: ${config.displayName ?? config.id}**\n` +
        `${newFailures} consecutive failures. Last error: "${result.error}"\n` +
        `Last successful run: ${prevState?.lastRunAt ?? "never"}`;
      try {
        await this.deps.alert(config.policy.alertChannelId, alertMsg);
      } catch (alertErr) {
        console.error(`[scheduler] alert failed schedule=${config.id}`, alertErr);
      }
    }

    // Clear alert flag on success
    if (result.status === "ok") {
      this.alertedSchedules.delete(config.id);
    }

    // Post to system log channel (every run, regardless of status)
    if (this.deps.systemLog) {
      this.deps.systemLog({
        scheduleId: config.id,
        displayName: config.displayName,
        status: result.status,
        durationMs: result.durationMs,
        executionMode: config.execution.mode,
        summary: result.summary,
        error: result.error,
        modelUsed: result.modelUsed,
        workerId: config.execution.workerId,
      }).catch((err) => {
        console.error(`[scheduler] system log failed schedule=${config.id}`, err);
      });
    }

    this.finishJob(runtime, result);
    return result;
  }

  private finishJob(runtime: ScheduleRuntimeState, result: ExecutionResult): void {
    const { config } = runtime;

    runtime.running = false;
    this.runningCount--;
    const group = config.policy?.concurrencyGroup;
    if (group) {
      const current = this.runningGroups.get(group) ?? 1;
      if (current <= 1) this.runningGroups.delete(group);
      else this.runningGroups.set(group, current - 1);
    }

    // Handle one-shot schedules
    if (config.schedule.at && config.policy?.deleteAfterRun) {
      runtime.nextRunAt = null;
      return;
    }

    // Compute next run
    const backoff = result.status === "error"
      ? this.computeBackoff(config, (this.deps.store.getState(config.id)?.consecutiveFailures ?? 0))
      : undefined;
    runtime.nextRunAt = this.computeNextRunAt(config, backoff ?? undefined);
  }

  // -------------------------------------------------------------------
  // Scheduling helpers
  // -------------------------------------------------------------------

  computeNextRunAt(config: ScheduleConfig, backoffUntil?: string): number | null {
    const now = Date.now();

    if (config.schedule.cron) {
      try {
        const cron = new Cron(config.schedule.cron, {
          timezone: config.schedule.timezone ?? "America/Los_Angeles",
        });
        const next = cron.nextRun();
        if (!next) return null;
        let nextMs = next.getTime();
        if (backoffUntil) {
          const backoffMs = new Date(backoffUntil).getTime();
          if (nextMs < backoffMs) nextMs = backoffMs;
        }
        return nextMs;
      } catch {
        console.error(`[scheduler] invalid cron expression for schedule=${config.id}: ${config.schedule.cron}`);
        return null;
      }
    }

    if (config.schedule.everySeconds) {
      let nextMs = now + config.schedule.everySeconds * 1000;
      if (backoffUntil) {
        const backoffMs = new Date(backoffUntil).getTime();
        if (nextMs < backoffMs) nextMs = backoffMs;
      }
      return nextMs;
    }

    if (config.schedule.at) {
      const atMs = new Date(config.schedule.at).getTime();
      return atMs > now ? atMs : null;
    }

    return null;
  }

  private computeBackoff(config: ScheduleConfig, consecutiveFailures: number): string | undefined {
    const backoffConfig = config.policy?.backoff;
    if (backoffConfig?.enabled === false) return undefined;
    if (consecutiveFailures === 0) return undefined;

    const initialMs = (backoffConfig?.initialSeconds ?? 60) * 1000;
    const maxMs = (backoffConfig?.maxSeconds ?? 3600) * 1000;
    const delayMs = Math.min(initialMs * Math.pow(2, consecutiveFailures - 1), maxMs);
    return new Date(Date.now() + delayMs).toISOString();
  }

  private cleanupStaleRuns(): void {
    const staleRuns = this.deps.store.getRunningRuns();
    for (const run of staleRuns) {
      console.error(`[scheduler] cleaning up stale run id=${run.id} schedule=${run.scheduleId}`);
      this.deps.store.updateRunFinished(run.id, {
        status: "error",
        durationMs: 0,
        error: "Stale run from previous process (cleaned up on boot)",
      });
    }
  }
}

function formatScheduleInstant(timestampMs: number, timezone: string): string {
  const date = new Date(timestampMs);
  const local = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "long",
  }).format(date);
  return `${date.toISOString()} (${timezone} ${local})`;
}
