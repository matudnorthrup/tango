import type { ChatProvider, ProviderRequest, ProviderResponse } from "@tango/core";
import { describe, expect, it } from "vitest";
import { createDiscordVoiceTurnExecutor } from "../src/turn-executor.js";
import {
  dataIndicatesVerifiedWriteOutcome,
  formatWorkerReportForPrompt,
  mergeWorkerReports,
  operationLooksLikeSuccessfulWrite,
  reportHasConfirmedWriteOutcome,
  type WorkerReport
} from "../src/worker-report.js";

class ScriptedProvider implements ChatProvider {
  readonly calls: ProviderRequest[] = [];

  constructor(
    private readonly impl: (callNumber: number, request: ProviderRequest) => ProviderResponse | Error
  ) {}

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    this.calls.push(request);
    const result = this.impl(this.calls.length, request);
    if (result instanceof Error) {
      throw result;
    }
    return result;
  }
}

describe("formatWorkerReportForPrompt", () => {
  it("formats read operations with structured output", () => {
    const report: WorkerReport = {
      operations: [
        {
          name: "health.recovery_summary",
          toolNames: ["healthdb.recovery_summary"],
          input: { dateScope: "last_night" },
          output: { sleep_hours: 7.2, hrv: 45, rhr: 52 },
          mode: "read",
        },
      ],
      hasWriteOperations: false,
      data: { sleep_hours: 7.2, hrv: 45 },
    };

    const text = formatWorkerReportForPrompt(report);
    expect(text).toContain("[Worker execution results");
    expect(text).toContain("READ: health.recovery_summary");
    expect(text).toContain('"sleep_hours":7.2');
    expect(text).toContain("[End worker results");
  });

  it("formats clarification request", () => {
    const report: WorkerReport = {
      operations: [],
      hasWriteOperations: false,
      data: {},
      clarification: "Which meal are you asking about?",
    };

    const text = formatWorkerReportForPrompt(report);
    expect(text).toContain("[Worker needs clarification");
    expect(text).toContain("Which meal are you asking about?");
    expect(text).toContain("rephrase this question naturally");
  });

  it("returns empty string for empty report", () => {
    const report: WorkerReport = {
      operations: [],
      hasWriteOperations: false,
      data: {},
    };

    expect(formatWorkerReportForPrompt(report)).toBe("");
  });

  it("formats multiple operations", () => {
    const report: WorkerReport = {
      operations: [
        {
          name: "nutrition.day_summary",
          toolNames: ["fatsecret.day_summary"],
          input: { date: "2026-03-07" },
          output: { calories: 1200, protein: 85 },
          mode: "read",
        },
        {
          name: "health.today_summary",
          toolNames: ["healthdb.today_summary"],
          input: { date: "2026-03-07" },
          output: { steps: 8500, active_cal: 350 },
          mode: "read",
        },
      ],
      hasWriteOperations: false,
      data: {},
    };

    const text = formatWorkerReportForPrompt(report);
    expect(text).toContain("READ: nutrition.day_summary");
    expect(text).toContain("READ: health.today_summary");
  });

  it("labels write operations with WROTE", () => {
    const report: WorkerReport = {
      operations: [
        {
          name: "recipe_meal_log",
          toolNames: ["fatsecret.log_food"],
          input: { recipe: "Power Salad" },
          output: { logged: 7 },
          mode: "write",
        },
      ],
      hasWriteOperations: true,
      data: {},
    };

    const text = formatWorkerReportForPrompt(report);
    expect(text).toContain("WROTE: recipe_meal_log");
  });

  it("treats runtime verification flags as a confirmed committed write outcome", () => {
    const report: WorkerReport = {
      operations: [],
      hasWriteOperations: false,
      data: {
        workerText: JSON.stringify({
          status: "ok",
          runtimeReplay: {
            diaryRefreshRecovered: true,
          },
        }),
      },
    };

    expect(dataIndicatesVerifiedWriteOutcome(report.data)).toBe(true);
    expect(reportHasConfirmedWriteOutcome(report)).toBe(true);
  });

  it("does not treat failed write outputs as confirmed committed write outcomes", () => {
    const report: WorkerReport = {
      operations: [
        {
          name: "file_ops",
          toolNames: ["file_ops"],
          input: { operation: "write", path: "/tmp/codex.txt" },
          output: { error: "permission denied" },
          mode: "write",
        },
      ],
      hasWriteOperations: true,
      data: {},
    };

    expect(operationLooksLikeSuccessfulWrite(report.operations[0]!)).toBe(false);
    expect(reportHasConfirmedWriteOutcome(report)).toBe(false);
  });

  it("uses partial framing when report.data.partial is true", () => {
    const report: WorkerReport = {
      operations: [
        {
          name: "workout_sql",
          toolNames: ["workout_sql"],
          input: { query: "SELECT * FROM sets" },
          output: { rows: 3 },
          mode: "read",
        },
      ],
      hasWriteOperations: false,
      data: { partial: true, partialReason: "Agent stalled: no activity for 90s" },
    };

    const text = formatWorkerReportForPrompt(report);
    expect(text).toContain("PARTIAL — agent timed out");
    expect(text).toContain("READ: workout_sql");
    expect(text).toContain("Summarize what WAS completed");
    expect(text).toContain("Do NOT claim operations succeeded if not listed above");
    expect(text).not.toContain("summarize the outcome in 1-3 sentences");
  });

  it("uses normal framing when report.data.partial is absent", () => {
    const report: WorkerReport = {
      operations: [
        {
          name: "fatsecret_api",
          toolNames: ["fatsecret_api"],
          input: {},
          output: "done",
          mode: "read",
        },
      ],
      hasWriteOperations: false,
      data: {},
    };

    const text = formatWorkerReportForPrompt(report);
    expect(text).not.toContain("PARTIAL");
    expect(text).toContain("summarize the outcome in 1-3 sentences");
  });

  it("appends partial suffix to dispatch heading when dispatch.data.partial is true", () => {
    const report = mergeWorkerReports(
      [
        { workerId: "research-assistant", taskId: "search", task: "Search for X" },
      ],
      [
        {
          status: "fulfilled",
          value: {
            operations: [
              { name: "agent_response", toolNames: [], input: {}, output: "partial data", mode: "read" },
            ],
            hasWriteOperations: false,
            data: { partial: true, partialReason: "timed out" },
          },
        },
      ],
    );

    const text = formatWorkerReportForPrompt(report);
    expect(text).toContain('Task "search" (research-assistant) (PARTIAL — timed out):');
  });

  it("formats merged multi-dispatch reports with task labels", () => {
    const report = mergeWorkerReports(
      [
        {
          workerId: "personal-assistant",
          taskId: "amazon-receipt",
          task: "Look up Amazon order",
        },
        {
          workerId: "personal-assistant",
          taskId: "bulk-categorize",
          task: "Categorize transactions",
        },
      ],
      [
        {
          status: "fulfilled",
          value: {
            operations: [
              {
                name: "obsidian.create_note",
                toolNames: ["obsidian"],
                input: {},
                output: "Created receipt note",
                mode: "write",
              },
            ],
            hasWriteOperations: true,
            data: { receiptCreated: true },
          },
        },
        {
          status: "rejected",
          reason: new Error("Lunch Money API timed out"),
        },
      ],
    );

    const text = formatWorkerReportForPrompt(report);
    expect(text).toContain("2 tasks executed in parallel");
    expect(text).toContain('Task "amazon-receipt" (personal-assistant):');
    expect(text).toContain("WROTE: obsidian.create_note");
    expect(text).toContain('Task "bulk-categorize" (personal-assistant):');
    expect(text).toContain("Error: Lunch Money API timed out");
  });

  it("formats recipe_meal_log compactly without ingredient details", () => {
    const report: WorkerReport = {
      operations: [
        {
          name: "recipe_meal_log",
          toolNames: ["fatsecret.log_food"],
          input: { recipeQuery: "Protein Yogurt Bowl", meal: "breakfast" },
          output: {
            recipeTitle: "Protein Yogurt Bowl",
            meal: "breakfast",
            logged: [
              { ingredient: "Greek Yogurt", grams: 170, units: 0.6, estimatedCalories: 90 },
              { ingredient: "Whey Protein", grams: 30, units: 1, estimatedCalories: 120 },
              { ingredient: "Blueberries", grams: 50, units: 0.5, estimatedCalories: 35 },
            ],
            unresolved: [],
            estimatedCalories: 245,
            estimatedProtein: 38,
            totals: { calories: 980, protein: 89 },
          },
          mode: "write",
        },
      ],
      hasWriteOperations: true,
      data: {},
    };

    const text = formatWorkerReportForPrompt(report);
    // Compact format: headline stats, not ingredient-by-ingredient
    expect(text).toContain("3 ingredients");
    expect(text).toContain("~245 cal");
    expect(text).toContain("~38g protein");
    expect(text).toContain("Protein Yogurt Bowl");
    // Does NOT dump individual ingredient details
    expect(text).not.toContain("Greek Yogurt");
    expect(text).not.toContain("Whey Protein");
    expect(text).not.toContain('"grams"');
  });

  it("includes unresolved items in compact recipe format", () => {
    const report: WorkerReport = {
      operations: [
        {
          name: "recipe_meal_log",
          toolNames: ["fatsecret.log_food"],
          input: {},
          output: {
            recipeTitle: "Power Salad",
            meal: "lunch",
            logged: [{ ingredient: "Chicken", grams: 200 }],
            unresolved: ["garden lettuce", "hemp hearts"],
            estimatedCalories: 200,
          },
          mode: "write",
        },
      ],
      hasWriteOperations: true,
      data: {},
    };

    const text = formatWorkerReportForPrompt(report);
    expect(text).toContain("1 ingredients");
    expect(text).toContain("garden lettuce");
    expect(text).toContain("hemp hearts");
  });
});

describe("executeWorker integration with turn executor", () => {
  it("injects worker report into prompt and always calls provider chain", async () => {
    const provider = new ScriptedProvider((_n, request) => ({
      text: "Synthesized response based on worker data",
      providerSessionId: "sess-1",
    }));

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((name) => ({ providerName: name, provider })),
        loadProviderContinuityMap: () => ({}),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () => undefined,
        executeWorker: async () => ({
          operations: [
            {
              name: "health.recovery_summary",
              toolNames: ["healthdb.recovery_summary"],
              input: {},
              output: { sleep_hours: 7.5 },
              mode: "read" as const,
            },
          ],
          hasWriteOperations: false,
          data: { sleep_hours: 7.5 },
        }),
      },
      () => ({
        conversationKey: "project:wellness:malibu",
        providerNames: ["claude-oauth"],
        configuredProviderNames: ["claude-oauth"],
      }),
    );

    const result = await executor.executeTurn({
      sessionId: "project:wellness",
      agentId: "malibu",
      transcript: "how did I sleep?",
      channelId: "ch-1",
      discordUserId: "u-1",
    });

    // Provider was called (not bypassed)
    expect(provider.calls).toHaveLength(1);
    // Prompt includes worker report data
    expect(provider.calls[0]?.prompt).toContain("[Worker execution results");
    expect(provider.calls[0]?.prompt).toContain("READ: health.recovery_summary");
    expect(provider.calls[0]?.prompt).toContain('"sleep_hours":7.5');
    // Prompt includes original user message
    expect(provider.calls[0]?.prompt).toContain("User message: how did I sleep?");
    // Result reflects provider response
    expect(result.responseText).toBe("Synthesized response based on worker data");
    expect(result.providerName).toBe("claude-oauth");
  });

  it("proceeds to Claude as pure conversation when worker returns null", async () => {
    const provider = new ScriptedProvider(() => ({
      text: "Claude handles this as conversation",
      providerSessionId: "sess-conv",
    }));

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((name) => ({ providerName: name, provider })),
        loadProviderContinuityMap: () => ({}),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () => undefined,
        executeWorker: async () => null,
      },
      () => ({
        conversationKey: "project:wellness:malibu",
        providerNames: ["claude-oauth"],
        configuredProviderNames: ["claude-oauth"],
      }),
    );

    const result = await executor.executeTurn({
      sessionId: "project:wellness",
      agentId: "malibu",
      transcript: "thanks, that's helpful",
      channelId: "ch-1",
      discordUserId: "u-1",
    });

    // Provider called with original prompt (no worker injection)
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.prompt).toBe("thanks, that's helpful");
    expect(result.responseText).toBe("Claude handles this as conversation");
  });

  it("handles worker errors gracefully and falls through to Claude", async () => {
    const provider = new ScriptedProvider(() => ({
      text: "Claude handled after worker crash",
    }));

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((name) => ({ providerName: name, provider })),
        loadProviderContinuityMap: () => ({}),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () => undefined,
        executeWorker: async () => {
          throw new Error("Worker crashed");
        },
      },
      () => ({
        conversationKey: "project:wellness:malibu",
        providerNames: ["claude-oauth"],
        configuredProviderNames: ["claude-oauth"],
      }),
    );

    const result = await executor.executeTurn({
      sessionId: "project:wellness",
      agentId: "malibu",
      transcript: "how did I sleep?",
      channelId: "ch-1",
      discordUserId: "u-1",
    });

    // Worker error was caught, Claude handled as conversation
    expect(result.responseText).toBe("Claude handled after worker crash");
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.prompt).toBe("how did I sleep?");
  });

  it("runs multiple orchestrator-directed worker dispatches and sends a merged report for synthesis", async () => {
    const provider = new ScriptedProvider((callNumber, request) => {
      if (callNumber === 1) {
        return {
          text: [
            "<worker-dispatch worker=\"personal-assistant\" task-id=\"amazon-receipt\">",
            "Look up the Amazon order for $165.40 on March 2.",
            "</worker-dispatch>",
            "",
            "<worker-dispatch worker=\"personal-assistant\" task-id=\"walmart-receipt\">",
            "Look up the Walmart order for $273.42 on March 3.",
            "</worker-dispatch>",
          ].join("\n"),
          providerSessionId: "sess-1",
        };
      }

      expect(request.prompt).toContain("[Worker execution results — 2 tasks executed in parallel]");
      expect(request.prompt).toContain('Task "amazon-receipt" (personal-assistant):');
      expect(request.prompt).toContain('Task "walmart-receipt" (personal-assistant):');
      return {
        text: "I found both receipts.",
        providerSessionId: "sess-2",
      };
    });

    const executedTasks: Array<{ workerId: string; task: string }> = [];

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        workerDispatchConcurrency: 3,
        resolveProviderChain: (providerNames) =>
          providerNames.map((name) => ({ providerName: name, provider })),
        loadProviderContinuityMap: () => ({}),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () => undefined,
        executeWorkerWithTask: async (workerId, task) => {
          executedTasks.push({ workerId, task });
          return {
            operations: [
              {
                name: "agent_response",
                toolNames: [],
                input: {},
                output: task,
                mode: "read",
              },
            ],
            hasWriteOperations: false,
            data: { task },
          };
        },
      },
      () => ({
        conversationKey: "project:watson:personal",
        providerNames: ["claude-oauth"],
        configuredProviderNames: ["claude-oauth"],
      }),
    );

    const result = await executor.executeTurn({
      sessionId: "project:watson",
      agentId: "watson",
      transcript: "Find both receipts",
      channelId: "ch-1",
      discordUserId: "u-1",
    });

    expect(executedTasks).toHaveLength(2);
    expect(executedTasks[0]?.task).toContain("Amazon");
    expect(executedTasks[1]?.task).toContain("Walmart");
    expect(provider.calls).toHaveLength(2);
    expect(result.responseText).toBe("I found both receipts.");
    expect(result.workerReport?.dispatches).toHaveLength(2);
    expect(result.workerDispatchTelemetry).toEqual({
      dispatchSource: "xml",
      dispatchCount: 2,
      completedDispatchCount: 2,
      failedDispatchCount: 0,
      concurrencyLimit: 3,
      workerIds: ["personal-assistant", "personal-assistant"],
      taskIds: ["amazon-receipt", "walmart-receipt"],
      concurrencyGroups: [],
      constrainedConcurrencyGroups: [],
      dispatches: [
        {
          workerId: "personal-assistant",
          taskId: "amazon-receipt",
          concurrencyGroup: undefined,
          status: "completed",
        },
        {
          workerId: "personal-assistant",
          taskId: "walmart-receipt",
          concurrencyGroup: undefined,
          status: "completed",
        },
      ],
    });
  });

  it("respects the configured worker dispatch concurrency limit", async () => {
    const provider = new ScriptedProvider((callNumber) => {
      if (callNumber === 1) {
        return {
          text: [
            "<worker-dispatch worker=\"personal-assistant\" task-id=\"one\">First task</worker-dispatch>",
            "<worker-dispatch worker=\"personal-assistant\" task-id=\"two\">Second task</worker-dispatch>",
            "<worker-dispatch worker=\"personal-assistant\" task-id=\"three\">Third task</worker-dispatch>",
          ].join("\n"),
        };
      }

      return { text: "done" };
    });

    let activeWorkers = 0;
    let maxActiveWorkers = 0;

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        workerDispatchConcurrency: 2,
        resolveProviderChain: (providerNames) =>
          providerNames.map((name) => ({ providerName: name, provider })),
        loadProviderContinuityMap: () => ({}),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () => undefined,
        executeWorkerWithTask: async (_workerId, task) => {
          activeWorkers++;
          maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers);
          await new Promise((resolve) => setTimeout(resolve, 20));
          activeWorkers--;
          return {
            operations: [
              {
                name: "agent_response",
                toolNames: [],
                input: {},
                output: task,
                mode: "read",
              },
            ],
            hasWriteOperations: false,
            data: { task },
          };
        },
      },
      () => ({
        conversationKey: "project:watson:personal",
        providerNames: ["claude-oauth"],
        configuredProviderNames: ["claude-oauth"],
      }),
    );

    await executor.executeTurn({
      sessionId: "project:watson",
      agentId: "watson",
      transcript: "Run all three tasks",
      channelId: "ch-1",
      discordUserId: "u-1",
    });

    expect(maxActiveWorkers).toBe(2);
  });

  it("serializes dispatches that share a concurrency group while allowing others to overlap", async () => {
    const provider = new ScriptedProvider((callNumber) => {
      if (callNumber === 1) {
        return {
          text: [
            "<worker-dispatch worker=\"personal-assistant\" task-id=\"amazon\">Browser task one</worker-dispatch>",
            "<worker-dispatch worker=\"personal-assistant\" task-id=\"walmart\">Browser task two</worker-dispatch>",
            "<worker-dispatch worker=\"personal-assistant\" task-id=\"categorize\">API task</worker-dispatch>",
          ].join("\n"),
        };
      }

      return { text: "done" };
    });

    let activeWorkers = 0;
    let activeBrowserWorkers = 0;
    let maxActiveWorkers = 0;
    let maxActiveBrowserWorkers = 0;

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        workerDispatchConcurrency: 3,
        getWorkerDispatchConcurrencyGroup: (dispatch) =>
          dispatch.taskId === "amazon" || dispatch.taskId === "walmart" ? "browser" : undefined,
        resolveProviderChain: (providerNames) =>
          providerNames.map((name) => ({ providerName: name, provider })),
        loadProviderContinuityMap: () => ({}),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () => undefined,
        executeWorkerWithTask: async (_workerId, task) => {
          activeWorkers++;
          maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers);

          const isBrowserTask = task.includes("Browser task");
          if (isBrowserTask) {
            activeBrowserWorkers++;
            maxActiveBrowserWorkers = Math.max(maxActiveBrowserWorkers, activeBrowserWorkers);
          }

          await new Promise((resolve) => setTimeout(resolve, 20));

          if (isBrowserTask) {
            activeBrowserWorkers--;
          }
          activeWorkers--;

          return {
            operations: [
              {
                name: "agent_response",
                toolNames: [],
                input: {},
                output: task,
                mode: "read",
              },
            ],
            hasWriteOperations: false,
            data: { task },
          };
        },
      },
      () => ({
        conversationKey: "project:watson:personal",
        providerNames: ["claude-oauth"],
        configuredProviderNames: ["claude-oauth"],
      }),
    );

    const result = await executor.executeTurn({
      sessionId: "project:watson",
      agentId: "watson",
      transcript: "Run browser and API tasks",
      channelId: "ch-1",
      discordUserId: "u-1",
    });

    expect(maxActiveWorkers).toBe(2);
    expect(maxActiveBrowserWorkers).toBe(1);
    expect(result.workerDispatchTelemetry?.constrainedConcurrencyGroups).toEqual(["browser"]);
    expect(result.workerDispatchTelemetry?.concurrencyGroups).toEqual(["browser"]);
  });

  it("includes workerReport in result for telemetry", async () => {
    const provider = new ScriptedProvider(() => ({
      text: "ok",
      providerSessionId: "sess-1",
    }));

    const workerReport: WorkerReport = {
      operations: [
        {
          name: "nutrition.day_summary",
          toolNames: ["fatsecret.day_summary"],
          input: {},
          output: { calories: 800 },
          mode: "read",
        },
      ],
      hasWriteOperations: false,
      data: { calories: 800 },
    };

    const executor = createDiscordVoiceTurnExecutor(
      {
        providerRetryLimit: 0,
        resolveProviderChain: (providerNames) =>
          providerNames.map((name) => ({ providerName: name, provider })),
        loadProviderContinuityMap: () => ({}),
        savePersistedProviderSession: () => undefined,
        buildWarmStartContextPrompt: () => undefined,
        executeWorker: async () => workerReport,
      },
      () => ({
        conversationKey: "project:wellness:malibu",
        providerNames: ["claude-oauth"],
        configuredProviderNames: ["claude-oauth"],
      }),
    );

    const result = await executor.executeTurnDetailed(
      {
        sessionId: "project:wellness",
        agentId: "malibu",
        transcript: "what have I eaten today?",
        channelId: "ch-1",
        discordUserId: "u-1",
      },
      {
        conversationKey: "project:wellness:malibu",
        providerNames: ["claude-oauth"],
        configuredProviderNames: ["claude-oauth"],
      },
    );

    expect(result.workerReport).toBeDefined();
    expect(result.workerReport?.operations).toHaveLength(1);
    expect(result.workerReport?.operations[0]?.name).toBe("nutrition.day_summary");
  });
});
