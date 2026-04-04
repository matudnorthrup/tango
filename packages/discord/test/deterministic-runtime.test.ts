import { describe, expect, it } from "vitest";
import {
  buildDeterministicNarrationPrompt,
  executeDeterministicPlan,
  formatExecutionReceiptsForPrompt,
  type ExecutionReceipt,
} from "../src/deterministic-runtime.js";
import type { DeterministicExecutionPlan } from "../src/deterministic-router.js";
import type { WorkerReport } from "../src/worker-report.js";

function createWorkerReport(input: Partial<WorkerReport> = {}): WorkerReport {
  return {
    operations: input.operations ?? [],
    hasWriteOperations: input.hasWriteOperations ?? false,
    data: input.data ?? {},
    clarification: input.clarification,
    trace: input.trace,
  };
}

describe("deterministic runtime", () => {
  it("executes a single-step plan and captures the worker receipt", async () => {
    const plan: DeterministicExecutionPlan = {
      steps: [
        {
          id: "step-1",
          intentId: "nutrition.log_food",
          mode: "write",
          kind: "workflow",
          targetId: "wellness.log_food_items",
          workerId: "nutrition-logger",
          task: "Log breakfast",
          dependsOn: [],
          input: {},
        },
      ],
    };

    const receipts = await executeDeterministicPlan({
      plan,
      executeWorkerWithTask: async () =>
        createWorkerReport({
          operations: [
            {
              name: "fatsecret_api",
              toolNames: ["fatsecret.log_food"],
              input: { items: ["breakfast"] },
              mode: "write",
              output: { ok: true },
            },
          ],
          hasWriteOperations: true,
          data: {
            workerText: "Logged breakfast successfully.",
          },
        }),
      concurrencyLimit: 1,
      timeoutMs: 1_000,
    });

    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      stepId: "step-1",
      intentId: "nutrition.log_food",
      workerId: "nutrition-logger",
      status: "completed",
      hasWriteOperations: true,
      data: {
        workerText: "Logged breakfast successfully.",
      },
    });
    expect(receipts[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("runs multiple steps concurrently when allowed and preserves result order", async () => {
    const plan: DeterministicExecutionPlan = {
      steps: [
        {
          id: "step-1",
          intentId: "nutrition.day_summary",
          mode: "read",
          kind: "workflow",
          targetId: "wellness.analyze_nutrition_day",
          workerId: "nutrition-logger",
          task: "Summarize nutrition day",
          dependsOn: [],
          input: {},
        },
        {
          id: "step-2",
          intentId: "health.sleep_recovery",
          mode: "read",
          kind: "workflow",
          targetId: "wellness.analyze_sleep_recovery",
          workerId: "health-analyst",
          task: "Summarize sleep recovery",
          dependsOn: [],
          input: {},
        },
      ],
    };

    let activeCount = 0;
    let maxActiveCount = 0;

    const receipts = await executeDeterministicPlan({
      plan,
      executeWorkerWithTask: async (workerId) => {
        activeCount += 1;
        maxActiveCount = Math.max(maxActiveCount, activeCount);
        await new Promise((resolve) => setTimeout(resolve, 30));
        activeCount -= 1;
        return createWorkerReport({
          operations: [
            {
              name: workerId,
              toolNames: [workerId],
              input: {},
              mode: "read",
              output: { ok: true },
            },
          ],
          data: {
            workerText: `${workerId} completed`,
          },
        });
      },
      concurrencyLimit: 2,
      timeoutMs: 1_000,
    });

    expect(maxActiveCount).toBeGreaterThan(1);
    expect(receipts.map((receipt) => receipt.stepId)).toEqual(["step-1", "step-2"]);
    expect(receipts.every((receipt) => receipt.status === "completed")).toBe(true);
  });

  it("captures worker failures and timeouts as failed receipts", async () => {
    const plan: DeterministicExecutionPlan = {
      steps: [
        {
          id: "step-1",
          intentId: "recipe.read",
          mode: "read",
          kind: "worker",
          targetId: "recipe-librarian",
          workerId: "recipe-librarian",
          task: "Read recipe",
          dependsOn: [],
          input: {},
        },
        {
          id: "step-2",
          intentId: "workout.history",
          mode: "read",
          kind: "worker",
          targetId: "workout-recorder",
          workerId: "workout-recorder",
          task: "Read workout history",
          dependsOn: [],
          input: {},
        },
      ],
    };

    const receipts = await executeDeterministicPlan({
      plan,
      executeWorkerWithTask: async (workerId) => {
        if (workerId === "recipe-librarian") {
          throw new Error("Recipe note missing");
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
        return createWorkerReport({
          operations: [
            {
              name: "workout_sql",
              toolNames: ["workout_sql"],
              input: { query: "last three workouts" },
              mode: "read",
              output: { rows: 3 },
            },
          ],
          data: {
            workerText: "Found the last three workouts.",
          },
        });
      },
      concurrencyLimit: 2,
      timeoutMs: 10,
    });

    expect(receipts[0]).toMatchObject({
      workerId: "recipe-librarian",
      status: "failed",
      error: "Recipe note missing",
    });
    expect(receipts[1]).toMatchObject({
      workerId: "workout-recorder",
      status: "failed",
    });
    expect(receipts[1]?.error).toContain("exceeded wall-clock timeout");
  });

  it("formats receipts into a narration-grounding prompt", () => {
    const receipts: ExecutionReceipt[] = [
      {
        stepId: "step-1",
        intentId: "nutrition.day_summary",
        mode: "read",
        kind: "workflow",
        targetId: "wellness.analyze_nutrition_day",
        workerId: "nutrition-logger",
        status: "completed",
        durationMs: 75,
        operations: [
          {
            name: "fatsecret_api",
            toolNames: ["fatsecret.day_summary"],
            input: { date_scope: "today" },
            mode: "read",
            output: { calories: 1200, protein: 111 },
          },
        ],
        hasWriteOperations: false,
        data: {
          workerText: "1,202 calories and 111g protein logged today.",
        },
        warnings: [],
      },
    ];

    const receiptsText = formatExecutionReceiptsForPrompt(receipts);
    expect(receiptsText).toContain("Worker summary: 1,202 calories and 111g protein logged today.");
    expect(receiptsText).toContain("READ: fatsecret_api");

    const prompt = buildDeterministicNarrationPrompt({
      userMessage: "What have I eaten today?",
      receiptsText,
    });

    expect(prompt).toContain("The deterministic runtime already completed the necessary worker steps.");
    expect(prompt).toContain("Do not mention internal routing, dispatch, or that you are still waiting.");
  });

  it("surfaces receipt quality warnings in the narration-grounding prompt", () => {
    const receipts: ExecutionReceipt[] = [
      {
        stepId: "step-1",
        intentId: "travel.location_read",
        mode: "read",
        kind: "worker",
        targetId: "research-assistant",
        workerId: "research-assistant",
        status: "completed",
        durationMs: 42,
        operations: [
          {
            name: "location_read",
            toolNames: ["location_read"],
            input: {},
            mode: "read",
            output: { lat: 44.36, lon: -124.09, ageSec: 61_200 },
          },
        ],
        hasWriteOperations: false,
        data: {
          workerText: "Last known fix is home.",
        },
        warnings: ["Location data is stale (17h old)."],
      },
    ];

    const receiptsText = formatExecutionReceiptsForPrompt(receipts);
    expect(receiptsText).toContain("Warning: Location data is stale (17h old).");
  });

  it("warns when a write-mode step completes without recording any write operations", async () => {
    const plan: DeterministicExecutionPlan = {
      steps: [
        {
          id: "step-1",
          intentId: "nutrition.log_repair",
          mode: "write",
          kind: "worker",
          targetId: "nutrition-logger",
          workerId: "nutrition-logger",
          task: "Repair dinner diary",
          dependsOn: [],
          input: {},
        },
      ],
    };

    const receipts = await executeDeterministicPlan({
      plan,
      executeWorkerWithTask: async () =>
        createWorkerReport({
          operations: [
            {
              name: "fatsecret_api",
              toolNames: ["fatsecret_api"],
              input: { method: "food_entries_get", params: { date: "2026-03-31" } },
              mode: "read",
              output: [{ food_entry_name: "Banana" }],
            },
          ],
          hasWriteOperations: false,
          data: {
            workerText: "Looks good now.",
          },
        }),
      concurrencyLimit: 1,
      timeoutMs: 1_000,
    });

    expect(receipts[0]?.warnings).toContain(
      "No write operation was recorded for this write step. Do not claim that any change was applied unless a later receipt proves it.",
    );
  });

  it("warns when a write-mode step attempted a write but did not record a confirmed committed result", async () => {
    const plan: DeterministicExecutionPlan = {
      steps: [
        {
          id: "step-1",
          intentId: "files.local_write",
          mode: "write",
          kind: "worker",
          targetId: "research-assistant",
          workerId: "research-assistant",
          task: "Update temp file",
          dependsOn: [],
          input: {},
        },
      ],
    };

    const receipts = await executeDeterministicPlan({
      plan,
      executeWorkerWithTask: async () =>
        createWorkerReport({
          operations: [
            {
              name: "file_ops",
              toolNames: ["file_ops"],
              input: { operation: "write", path: "/tmp/codex-write-check.txt" },
              mode: "write",
              output: { error: "permission denied" },
            },
          ],
          hasWriteOperations: true,
          data: {
            workerText: "Tried to update the file, but the write did not land.",
          },
        }),
      concurrencyLimit: 1,
      timeoutMs: 1_000,
    });

    expect(receipts[0]?.warnings).toContain(
      "Write operations were attempted for this step, but no confirmed committed result was recorded. Do not claim that any change was applied unless a later receipt proves it.",
    );
  });

  it("suppresses the generic no-write warning when the intent explicitly allows a safe no-op outcome", async () => {
    const plan: DeterministicExecutionPlan = {
      steps: [
        {
          id: "step-1",
          intentId: "finance.transaction_categorization",
          mode: "write",
          kind: "worker",
          targetId: "personal-assistant",
          workerId: "personal-assistant",
          task: "Categorize recent transactions",
          dependsOn: [],
          input: {},
          safeNoopAllowed: true,
        },
      ],
    };

    const receipts = await executeDeterministicPlan({
      plan,
      executeWorkerWithTask: async () =>
        createWorkerReport({
          operations: [],
          hasWriteOperations: false,
          data: {
            workerText: [
              "All 23 transactions returned for the 48-hour window already have category IDs assigned:",
              "",
              "- 21 are `status=cleared` with categories — already fully processed",
              "- 2 pending Amazon charges already have Discretionary Spending assigned and cannot be cleared yet",
              "",
              "No uncategorized transactions to action tonight.",
              "",
              "__NO_OUTPUT__",
            ].join("\n"),
          },
        }),
      concurrencyLimit: 1,
      timeoutMs: 1_000,
    });

    expect(receipts[0]?.warnings).not.toContain(
      "No write operation was recorded for this write step. Do not claim that any change was applied unless a later receipt proves it.",
    );
  });

  it("waits for dependent same-worker steps instead of running them in parallel", async () => {
    const plan: DeterministicExecutionPlan = {
      steps: [
        {
          id: "step-1",
          intentId: "nutrition.log_food",
          mode: "write",
          kind: "workflow",
          targetId: "wellness.log_food_items",
          workerId: "nutrition-logger",
          task: "Log banana",
          dependsOn: [],
          input: {},
        },
        {
          id: "step-2",
          intentId: "nutrition.day_summary",
          mode: "read",
          kind: "workflow",
          targetId: "wellness.analyze_nutrition_day",
          workerId: "nutrition-logger",
          task: "Summarize nutrition day",
          dependsOn: ["step-1"],
          input: {},
        },
      ],
    };

    const startedAtByTask: Record<string, number> = {};
    const finishedAtByTask: Record<string, number> = {};

    const receipts = await executeDeterministicPlan({
      plan,
      executeWorkerWithTask: async (_workerId, task) => {
        startedAtByTask[task] = Date.now();
        await new Promise((resolve) => setTimeout(resolve, task === "Log banana" ? 40 : 5));
        finishedAtByTask[task] = Date.now();
        return createWorkerReport({
          operations: [
            {
              name: task,
              toolNames: [task],
              input: {},
              mode: task === "Log banana" ? "write" : "read",
              output: { ok: true },
            },
          ],
          hasWriteOperations: task === "Log banana",
          data: {
            workerText: `${task} completed`,
          },
        });
      },
      concurrencyLimit: 2,
      timeoutMs: 1_000,
    });

    expect(receipts.map((receipt) => receipt.status)).toEqual(["completed", "completed"]);
    expect(startedAtByTask["Summarize nutrition day"]).toBeGreaterThanOrEqual(finishedAtByTask["Log banana"] ?? 0);
  });

  it("skips dependent steps when an upstream step fails", async () => {
    const plan: DeterministicExecutionPlan = {
      steps: [
        {
          id: "step-1",
          intentId: "nutrition.log_food",
          mode: "write",
          kind: "workflow",
          targetId: "wellness.log_food_items",
          workerId: "nutrition-logger",
          task: "Log banana",
          dependsOn: [],
          input: {},
        },
        {
          id: "step-2",
          intentId: "nutrition.day_summary",
          mode: "read",
          kind: "workflow",
          targetId: "wellness.analyze_nutrition_day",
          workerId: "nutrition-logger",
          task: "Summarize nutrition day",
          dependsOn: ["step-1"],
          input: {},
        },
      ],
    };

    const receipts = await executeDeterministicPlan({
      plan,
      executeWorkerWithTask: async (_workerId, task) => {
        if (task === "Log banana") {
          throw new Error("FatSecret rejected the write");
        }
        return createWorkerReport({
          operations: [],
          data: {
            workerText: "Should not run",
          },
        });
      },
      concurrencyLimit: 2,
      timeoutMs: 1_000,
    });

    expect(receipts[0]).toMatchObject({
      status: "failed",
      error: "FatSecret rejected the write",
    });
    expect(receipts[1]).toMatchObject({
      status: "skipped",
    });
    expect(receipts[1]?.error).toContain("step-1");
  });
});
