import { describe, expect, it, vi } from "vitest";
import { executeSchedule } from "../src/scheduler/executor.js";
import { getPreCheckHandler, registerPreCheckHandler } from "../src/scheduler/handlers.js";
import type { ScheduleConfig } from "../src/scheduler/types.js";

function createAgentSchedule(overrides?: Partial<ScheduleConfig>): ScheduleConfig {
  return {
    id: "daily-email-review",
    description: "Run inbox maintenance.",
    enabled: true,
    schedule: {
      cron: "0 16 * * *",
      timezone: "America/Los_Angeles",
    },
    execution: {
      mode: "agent",
      workerId: "personal-assistant",
      task: "Review and maintain the inbox.",
      timeoutSeconds: 30,
      ...overrides?.execution,
    },
    ...overrides,
  };
}

describe("executeSchedule", () => {
  it("routes explicit-intent agent schedules through executeScheduledTurn", async () => {
    const executeWorker = vi.fn(async () => ({ text: "worker path", durationMs: 5 }));
    const executeScheduledTurn = vi.fn(async () => ({
      text: "deterministic schedule turn",
      durationMs: 25,
      modelUsed: "sonnet",
      metadata: { deterministicIntentIds: ["email.inbox_maintenance"] },
    }));

    const result = await executeSchedule(
      createAgentSchedule({
        execution: {
          mode: "agent",
          workerId: "personal-assistant",
          intentIds: ["email.inbox_maintenance"],
          deterministicAgentId: "watson",
          task: "Review and maintain the inbox.",
          timeoutSeconds: 30,
        },
      }),
      {
        store: { getState: () => null } as never,
        executeWorker,
        executeScheduledTurn,
        db: {} as never,
      },
    );

    expect(result.status).toBe("ok");
    expect(result.summary).toBe("deterministic schedule turn");
    expect(result.modelUsed).toBe("sonnet");
    expect(result.metadata).toEqual({ deterministicIntentIds: ["email.inbox_maintenance"] });
    expect(executeScheduledTurn).toHaveBeenCalledOnce();
    expect(executeWorker).not.toHaveBeenCalled();
  });

  it("keeps legacy agent schedules on the direct worker path when no explicit intents are configured", async () => {
    const executeWorker = vi.fn(async () => ({ text: "legacy worker run", durationMs: 12 }));
    const executeScheduledTurn = vi.fn();

    const result = await executeSchedule(
      createAgentSchedule(),
      {
        store: { getState: () => null } as never,
        executeWorker,
        executeScheduledTurn,
        db: {} as never,
      },
    );

    expect(result.status).toBe("ok");
    expect(result.summary).toBe("legacy worker run");
    expect(executeWorker).toHaveBeenCalledOnce();
    expect(executeScheduledTurn).not.toHaveBeenCalled();
  });

  it("routes conditional-agent schedules through the deterministic turn only after a proceed pre-check", async () => {
    if (!getPreCheckHandler("test-unreviewed-transactions")) {
      registerPreCheckHandler("test-unreviewed-transactions", async () => ({
        action: "proceed",
        context: {
          startDate: "2026-03-31",
          endDate: "2026-04-02",
          unreviewedCount: 2,
        },
      }));
    }

    const executeWorker = vi.fn(async () => ({ text: "worker path", durationMs: 5 }));
    const executeScheduledTurn = vi.fn(async () => ({
      text: "deterministic schedule turn",
      durationMs: 25,
      modelUsed: "sonnet",
      metadata: { deterministicIntentIds: ["finance.transaction_categorization"] },
    }));

    const result = await executeSchedule(
      createAgentSchedule({
        execution: {
          mode: "conditional-agent",
          preCheck: { handler: "test-unreviewed-transactions" },
          workerId: "personal-assistant",
          intentIds: ["finance.transaction_categorization"],
          taskTemplate:
            "Found {{unreviewedCount}} unreviewed transactions between {{startDate}} and {{endDate}}.",
          timeoutSeconds: 30,
        },
      }),
      {
        store: { getState: () => null } as never,
        executeWorker,
        executeScheduledTurn,
        db: {} as never,
      },
    );

    expect(result.status).toBe("ok");
    expect(result.summary).toBe("deterministic schedule turn");
    expect(result.preCheckResult).toContain("\"action\":\"proceed\"");
    expect(executeScheduledTurn).toHaveBeenCalledOnce();
    expect(executeScheduledTurn.mock.calls[0]?.[0].task).toContain("Found 2 unreviewed transactions");
    expect(executeWorker).not.toHaveBeenCalled();
  });
});
