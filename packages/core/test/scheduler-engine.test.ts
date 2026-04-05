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
        executeWorker: async () => ({ text: "", durationMs: 0 }),
        executeScheduledTurn: async () => ({ text: "", durationMs: 0 }),
        db: new DatabaseSync(":memory:"),
      },
    );

    expect(engine.getSchedules()[0]?.nextRunAt).toBe(Date.parse("2026-04-05T14:00:00.000Z"));
  });
});
