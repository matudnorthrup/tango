/**
 * Scheduler Store — SQLite persistence for schedule runs, state, and completions.
 */

import type { DatabaseSync } from "node:sqlite";
import type {
  ScheduleRunRecord,
  ScheduleStateRecord,
  ScheduleCompletionRecord,
  RunStatus,
  ScheduleExecutionMode,
  CompletionScope,
} from "./types.js";

export class SchedulerStore {
  constructor(private readonly db: DatabaseSync) {}

  // -------------------------------------------------------------------
  // Schedule Runs
  // -------------------------------------------------------------------

  insertRun(input: {
    scheduleId: string;
    executionMode: ScheduleExecutionMode;
    workerId?: string;
  }): number {
    const result = this.db
      .prepare(
        `INSERT INTO schedule_runs (schedule_id, execution_mode, worker_id)
         VALUES (?, ?, ?)`
      )
      .run(input.scheduleId, input.executionMode, input.workerId ?? null);
    return Number(result.lastInsertRowid);
  }

  updateRunFinished(
    runId: number,
    update: {
      status: RunStatus;
      durationMs: number;
      error?: string;
      summary?: string;
      modelUsed?: string;
      preCheckResult?: string;
      deliveryStatus?: string;
      deliveryError?: string;
      metadata?: Record<string, unknown>;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE schedule_runs SET
           finished_at = datetime('now'),
           status = ?,
           duration_ms = ?,
           error = ?,
           summary = ?,
           model_used = ?,
           pre_check_result = ?,
           delivery_status = ?,
           delivery_error = ?,
           metadata = ?
         WHERE id = ?`
      )
      .run(
        update.status,
        update.durationMs,
        update.error ?? null,
        update.summary ?? null,
        update.modelUsed ?? null,
        update.preCheckResult ?? null,
        update.deliveryStatus ?? null,
        update.deliveryError ?? null,
        update.metadata ? JSON.stringify(update.metadata) : null,
        runId,
      );
  }

  getRecentRuns(scheduleId: string, limit = 20): ScheduleRunRecord[] {
    return this.db
      .prepare(
        `SELECT
           id, schedule_id AS scheduleId, started_at AS startedAt,
           finished_at AS finishedAt, status, execution_mode AS executionMode,
           pre_check_result AS preCheckResult, duration_ms AS durationMs,
           error, summary, model_used AS modelUsed, worker_id AS workerId,
           delivery_status AS deliveryStatus, delivery_error AS deliveryError,
           metadata
         FROM schedule_runs
         WHERE schedule_id = ?
         ORDER BY started_at DESC
         LIMIT ?`
      )
      .all(scheduleId, limit) as unknown as ScheduleRunRecord[];
  }

  getRunningRuns(): ScheduleRunRecord[] {
    return this.db
      .prepare(
        `SELECT
           id, schedule_id AS scheduleId, started_at AS startedAt,
           finished_at AS finishedAt, status, execution_mode AS executionMode,
           pre_check_result AS preCheckResult, duration_ms AS durationMs,
           error, summary, model_used AS modelUsed, worker_id AS workerId,
           delivery_status AS deliveryStatus, delivery_error AS deliveryError,
           metadata
         FROM schedule_runs
         WHERE status = 'running'`
      )
      .all() as unknown as ScheduleRunRecord[];
  }

  // -------------------------------------------------------------------
  // Schedule State
  // -------------------------------------------------------------------

  getState(scheduleId: string): ScheduleStateRecord | null {
    const row = this.db
      .prepare(
        `SELECT
           schedule_id AS scheduleId, last_run_at AS lastRunAt,
           last_status AS lastStatus, last_duration_ms AS lastDurationMs,
           last_error AS lastError, consecutive_failures AS consecutiveFailures,
           backoff_until AS backoffUntil, total_runs AS totalRuns,
           total_ok AS totalOk, total_errors AS totalErrors,
           total_skipped AS totalSkipped,
           created_at AS createdAt, updated_at AS updatedAt
         FROM schedule_state
         WHERE schedule_id = ?`
      )
      .get(scheduleId) as ScheduleStateRecord | undefined;
    return row ?? null;
  }

  getAllStates(): ScheduleStateRecord[] {
    return this.db
      .prepare(
        `SELECT
           schedule_id AS scheduleId, last_run_at AS lastRunAt,
           last_status AS lastStatus, last_duration_ms AS lastDurationMs,
           last_error AS lastError, consecutive_failures AS consecutiveFailures,
           backoff_until AS backoffUntil, total_runs AS totalRuns,
           total_ok AS totalOk, total_errors AS totalErrors,
           total_skipped AS totalSkipped,
           created_at AS createdAt, updated_at AS updatedAt
         FROM schedule_state`
      )
      .all() as unknown as ScheduleStateRecord[];
  }

  upsertState(
    scheduleId: string,
    update: {
      lastRunAt: string;
      lastStatus: RunStatus;
      lastDurationMs?: number;
      lastError?: string;
      consecutiveFailures: number;
      backoffUntil?: string;
    },
  ): void {
    // Determine increment columns based on status
    const okInc = update.lastStatus === "ok" ? 1 : 0;
    const errInc = update.lastStatus === "error" ? 1 : 0;
    const skipInc = update.lastStatus === "skipped" ? 1 : 0;

    this.db
      .prepare(
        `INSERT INTO schedule_state (
           schedule_id, last_run_at, last_status, last_duration_ms, last_error,
           consecutive_failures, backoff_until, total_runs, total_ok, total_errors, total_skipped
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT(schedule_id) DO UPDATE SET
           last_run_at = excluded.last_run_at,
           last_status = excluded.last_status,
           last_duration_ms = excluded.last_duration_ms,
           last_error = excluded.last_error,
           consecutive_failures = excluded.consecutive_failures,
           backoff_until = excluded.backoff_until,
           total_runs = schedule_state.total_runs + 1,
           total_ok = schedule_state.total_ok + ?,
           total_errors = schedule_state.total_errors + ?,
           total_skipped = schedule_state.total_skipped + ?,
           updated_at = datetime('now')`
      )
      .run(
        scheduleId,
        update.lastRunAt,
        update.lastStatus,
        update.lastDurationMs ?? null,
        update.lastError ?? null,
        update.consecutiveFailures,
        update.backoffUntil ?? null,
        okInc,
        errInc,
        skipInc,
        okInc,
        errInc,
        skipInc,
      );
  }

  // -------------------------------------------------------------------
  // Completions
  // -------------------------------------------------------------------

  checkCompletion(workflowId: string, scope: CompletionScope): ScheduleCompletionRecord | null {
    const completedDate = formatCompletionDate(scope);
    const row = this.db
      .prepare(
        `SELECT
           id, workflow_id AS workflowId, completed_date AS completedDate,
           completed_by AS completedBy, schedule_run_id AS scheduleRunId,
           completed_at AS completedAt, metadata
         FROM schedule_completions
         WHERE workflow_id = ? AND completed_date = ?`
      )
      .get(workflowId, completedDate) as ScheduleCompletionRecord | undefined;
    return row ?? null;
  }

  markCompletion(input: {
    workflowId: string;
    scope: CompletionScope;
    completedBy: string;
    scheduleRunId?: number;
    metadata?: Record<string, unknown>;
  }): void {
    const completedDate = formatCompletionDate(input.scope);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO schedule_completions
           (workflow_id, completed_date, completed_by, schedule_run_id, metadata)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        input.workflowId,
        completedDate,
        input.completedBy,
        input.scheduleRunId ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
      );
  }
}

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

function formatCompletionDate(scope: CompletionScope): string {
  const now = new Date();
  switch (scope) {
    case "daily":
      return now.toISOString().slice(0, 10); // YYYY-MM-DD
    case "weekly": {
      // ISO week: YYYY-Www
      const jan4 = new Date(now.getFullYear(), 0, 4);
      const dayOfYear = Math.floor((now.getTime() - jan4.getTime()) / 86400000) + jan4.getDay();
      const week = Math.ceil(dayOfYear / 7);
      return `${now.getFullYear()}-W${String(week).padStart(2, "0")}`;
    }
    case "monthly":
      return now.toISOString().slice(0, 7); // YYYY-MM
  }
}
