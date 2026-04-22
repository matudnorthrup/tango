/**
 * Scheduler Service — Main entry point for the scheduled jobs system.
 *
 * Lifecycle:
 *   const scheduler = new SchedulerService(configs, deps);
 *   scheduler.start();    // Begins tick loop
 *   scheduler.stop();     // Stops tick loop
 *   scheduler.trigger(id); // Manual trigger
 */

import type { DatabaseSync } from "node:sqlite";
import type {
  ScheduleConfig,
  WorkerExecuteFn,
  ScheduledTurnExecuteFn,
  V2ScheduledTurnExecuteFn,
  DeliveryFn,
  AlertFn,
  SystemLogFn,
} from "./types.js";
import { SchedulerStore } from "./store.js";
import { SchedulerEngine, type EngineConfig } from "./engine.js";

export interface SchedulerServiceDeps {
  /** SQLite database (shared with TangoStorage) */
  db: DatabaseSync;
  /** Function to execute an agent worker */
  executeWorker: WorkerExecuteFn;
  /** Optional function to execute an explicit deterministic scheduled turn */
  executeScheduledTurn?: ScheduledTurnExecuteFn;
  /** Optional function to execute a scheduled turn via the fresh v2 runtime */
  executeV2Turn?: V2ScheduledTurnExecuteFn;
  /** Function to deliver messages to Discord channels */
  deliver?: DeliveryFn;
  /** Function to send alert messages */
  alert?: AlertFn;
  /** Function to post system log entries (every run) */
  systemLog?: SystemLogFn;
  /** Engine configuration overrides */
  engineConfig?: EngineConfig;
}

export class SchedulerService {
  private readonly store: SchedulerStore;
  private readonly engine: SchedulerEngine;

  constructor(configs: ScheduleConfig[], deps: SchedulerServiceDeps) {
    this.store = new SchedulerStore(deps.db);
    this.engine = new SchedulerEngine(configs, {
      store: this.store,
      executeWorker: deps.executeWorker,
      executeScheduledTurn: deps.executeScheduledTurn,
      executeV2Turn: deps.executeV2Turn,
      deliver: deps.deliver,
      alert: deps.alert,
      systemLog: deps.systemLog,
      db: deps.db,
    }, deps.engineConfig);

    console.error(`[scheduler] initialized with ${configs.length} schedules`);
  }

  /** Start the scheduler tick loop. */
  start(): void {
    this.engine.start();
  }

  /** Stop the scheduler tick loop. */
  stop(): void {
    this.engine.stop();
  }

  /** Manually trigger a specific schedule. */
  async trigger(scheduleId: string) {
    return this.engine.trigger(scheduleId);
  }

  /** Get all schedules with runtime state (for dashboard/API). */
  getSchedules() {
    return this.engine.getSchedules();
  }

  /** Get the underlying store for direct queries (dashboard, completions from interactive). */
  getStore(): SchedulerStore {
    return this.store;
  }
}

// Re-export everything consumers need
export { SchedulerStore } from "./store.js";
export { SchedulerEngine } from "./engine.js";
export {
  registerDeterministicHandler,
  registerPreCheckHandler,
  getDeterministicHandler,
  getPreCheckHandler,
  listRegisteredHandlers,
} from "./handlers.js";
export type {
  ScheduleConfig,
  ScheduleExecutionMode,
  ScheduleTimingConfig,
  ScheduleExecutionConfig,
  ScheduleProviderConfig,
  ScheduleDeliveryConfig,
  SchedulePolicyConfig,
  ScheduleCompletionConfig,
  ScheduleBackoffConfig,
  ScheduleDeliveryMode,
  CompletionScope,
  RunStatus,
  ScheduleRunRecord,
  ScheduleStateRecord,
  ScheduleCompletionRecord,
  HandlerContext,
  DeterministicResult,
  DeterministicHandler,
  PreCheckResult,
  PreCheckHandler,
  WorkerExecuteFn,
  ScheduledTurnExecuteFn,
  V2ScheduledTurnExecuteFn,
  DeliveryFn,
  AlertFn,
  SystemLogFn,
  SystemLogEntry,
} from "./types.js";
