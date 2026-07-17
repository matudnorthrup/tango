import { describe, expect, it, vi, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { SchedulerEngine } from "../src/scheduler/engine.js";
import type { ScheduleConfig } from "../src/scheduler/types.js";

function createSchedule(overrides?: Partial<ScheduleConfig>): ScheduleConfig {
  return {
    id: "weekly-finance-review",
    description: "Run the weekly finance review.",
    enabled: true,
    schedule: {
      cron: "0 7 * * 0",
      timezone: "America/Los_Angeles",
    },
    execution: {
      mode: "agent",
      workerId: "personal-assistant",
      task: "Review finances.",
      timeoutSeconds: 30,
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SchedulerEngine timezone handling", () => {
  it("computes the next Sunday 7am run in the configured timezone", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-05T11:48:23.000Z"));

    const engine = new SchedulerEngine(
      [createSchedule()],
      {
        store: {
          getState: () => null,
          getRunningRuns: () => [],
          updateRunFinished: () => undefined,
        } as never,
        db: new DatabaseSync(":memory:"),
      },
    );

    expect(engine.getSchedules()[0]?.nextRunAt).toBe(Date.parse("2026-04-05T14:00:00.000Z"));
  });

  it("emits persisted run-started and run-finished lifecycle hooks", async () => {
    const started = vi.fn(async () => undefined);
    const finished = vi.fn(async () => undefined);
    const run = {
      id: 77,
      scheduleId: "weekly-finance-review",
      startedAt: "2026-07-12T14:00:00.000Z",
      finishedAt: null as string | null,
      status: "running" as const,
      executionMode: "agent" as const,
      preCheckResult: null,
      durationMs: null as number | null,
      error: null as string | null,
      summary: null as string | null,
      modelUsed: null as string | null,
      workerId: "personal-assistant",
      deliveryStatus: null,
      deliveryError: null,
      metadata: null,
    };
    let scheduleState: Record<string, unknown> | null = null;
    const store = {
      getState: () => scheduleState,
      getRunningRuns: () => [],
      insertRun: () => run.id,
      getRun: () => ({ ...run }),
      updateRunFinished: (_id: number, update: Record<string, unknown>) => {
        Object.assign(run, update, { finishedAt: "2026-07-12T14:01:00.000Z" });
      },
      upsertState: (_id: string, update: Record<string, unknown>) => {
        scheduleState = { ...update };
      },
      markCompletion: () => undefined,
    };
    const engine = new SchedulerEngine(
      [createSchedule({ runtime: "v2" })],
      {
        store: store as never,
        db: new DatabaseSync(":memory:"),
        executeV2Turn: async () => ({ text: "done", durationMs: 25, model: "fixture" }),
        onRunStarted: started,
        onRunFinished: finished,
      },
    );

    const result = await engine.trigger("weekly-finance-review");

    expect(result?.status).toBe("ok");
    expect(started).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({ id: "weekly-finance-review" }),
      run: expect.objectContaining({ id: 77, status: "running", finishedAt: null }),
    }));
    expect(finished).toHaveBeenCalledWith(expect.objectContaining({
      run: expect.objectContaining({ id: 77, status: "ok", finishedAt: "2026-07-12T14:01:00.000Z" }),
    }));
  });
});
