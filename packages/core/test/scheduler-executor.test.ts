import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeSchedule } from "../src/scheduler/executor.js";
import { getPreCheckHandler, registerPreCheckHandler } from "../src/scheduler/handlers.js";
import type { ScheduleConfig } from "../src/scheduler/types.js";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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

function createTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-scheduler-home-"));
  tempDirs.push(dir);
  return dir;
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

  it("routes runtime=v2 agent schedules through executeV2Turn", async () => {
    const executeWorker = vi.fn(async () => ({ text: "legacy worker run", durationMs: 12 }));
    const executeScheduledTurn = vi.fn();
    const executeV2Turn = vi.fn(async () => ({
      text: "fresh v2 runtime run",
      durationMs: 20,
      model: "claude-sonnet-4-6",
      metadata: { runtime: "v2", sessionId: "provider-session-123" },
    }));

    const result = await executeSchedule(
      createAgentSchedule({
        runtime: "v2",
        delivery: {
          agentId: "malibu",
          mode: "message",
        },
      }),
      {
        store: { getState: () => null } as never,
        executeWorker,
        executeScheduledTurn,
        executeV2Turn,
        db: {} as never,
      },
    );

    expect(result.status).toBe("ok");
    expect(result.summary).toBe("fresh v2 runtime run");
    expect(result.modelUsed).toBe("claude-sonnet-4-6");
    expect(result.metadata).toEqual({ runtime: "v2", sessionId: "provider-session-123" });
    expect(executeV2Turn).toHaveBeenCalledOnce();
    expect(executeV2Turn).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "malibu",
      task: "Review and maintain the inbox.",
    }));
    expect(executeWorker).not.toHaveBeenCalled();
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

  it("writes an Obsidian job log after a successful agent run when configured", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T12:34:00Z"));
    process.env.HOME = createTempHome();

    const executeWorker = vi.fn(async () => ({
      text: "Planned focus blocks for inbox zero and budget review.",
      durationMs: 12,
    }));

    const result = await executeSchedule(
      createAgentSchedule({
        id: "morning-planning",
        obsidianLog: {
          domain: "Planning",
          jobName: "Morning Planning",
        },
      }),
      {
        store: { getState: () => null } as never,
        executeWorker,
        db: {} as never,
      },
    );

    expect(result.status).toBe("ok");

    const logPath = path.join(
      process.env.HOME!,
      "Documents",
      "main",
      "Records",
      "Jobs",
      "Planning",
      "2026-04.md",
    );
    const logText = fs.readFileSync(logPath, "utf8");

    expect(logText).toContain("## 2026-04-29");
    expect(logText).toContain("Morning Planning");
    expect(logText).toContain("**Status:** Done");
    expect(logText).toContain("**Summary:** Planned focus blocks for inbox zero and budget review.");
  });

  it("keeps successful runs green when Obsidian log writing fails", async () => {
    process.env.HOME = createTempHome();

    const executeWorker = vi.fn(async () => ({ text: "legacy worker run", durationMs: 12 }));
    vi.spyOn(fs, "appendFileSync").mockImplementation(() => {
      throw new Error("disk full");
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await executeSchedule(
      createAgentSchedule({
        obsidianLog: {
          domain: "Email",
          jobName: "Daily Email Review",
        },
      }),
      {
        store: { getState: () => null } as never,
        executeWorker,
        db: {} as never,
      },
    );

    expect(result.status).toBe("ok");
    expect(result.summary).toBe("legacy worker run");
    expect(consoleError).toHaveBeenCalledWith(
      "[scheduler] obsidian-log error for daily-email-review:",
      expect.any(Error),
    );
  });
});
