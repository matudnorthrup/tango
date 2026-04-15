import { describe, expect, it, vi } from "vitest";
import type { DeterministicExecutionStep } from "../src/deterministic-router.js";
import { tryExecuteDirectWellnessStep } from "../src/wellness-direct-step-executor.js";

function createStep(input: Partial<DeterministicExecutionStep>): DeterministicExecutionStep {
  return {
    id: input.id ?? "step-1",
    intentId: input.intentId ?? "nutrition.day_summary",
    mode: input.mode ?? "read",
    kind: input.kind ?? "workflow",
    targetId: input.targetId ?? "wellness.analyze_nutrition_day",
    workerId: input.workerId ?? "nutrition-logger",
    task: input.task ?? "test task",
    dependsOn: input.dependsOn ?? [],
    input: input.input ?? {},
    allowedToolIds: input.allowedToolIds,
    excludedToolIds: input.excludedToolIds,
    reasoningEffort: input.reasoningEffort,
    parallelGroup: input.parallelGroup,
    safeNoopAllowed: input.safeNoopAllowed,
  };
}

describe("tryExecuteDirectWellnessStep", () => {
  it("directly handles a nutrition day summary", async () => {
    const report = await tryExecuteDirectWellnessStep(
      createStep({
        intentId: "nutrition.day_summary",
        targetId: "wellness.analyze_nutrition_day",
        input: {
          date_scope: "2026-04-13",
        },
      }),
      {
        callFatsecretApi: vi.fn().mockResolvedValue([
          {
            food_entry_name: "Banana",
            meal: "Breakfast",
            calories: "105",
            protein: "1.3",
            carbohydrate: "27",
            fat: "0.4",
          },
          {
            food_entry_name: "Greek Yogurt",
            meal: "Breakfast",
            calories: "120",
            protein: "15",
            carbohydrate: "8",
            fat: "0",
          },
        ]),
        callFatsecretApiBatch: vi.fn(),
        executeNutritionLogItems: vi.fn(),
        runHealthQuery: vi.fn(),
      },
    );

    expect(report).not.toBeNull();
    expect(report?.hasWriteOperations).toBe(false);
    expect(report?.data.workerText).toMatch(/today|yesterday|2026-04-13/u);
    expect(report?.data.workerText).toContain("225 calories");
    expect(report?.operations[0]?.toolNames).toEqual(["fatsecret.day_summary"]);
  });

  it("does not directly handle nutrition.log_food writes", async () => {
    const executeNutritionLogItems = vi.fn();
    const callFatsecretApi = vi.fn();
    const callFatsecretApiBatch = vi.fn();

    const report = await tryExecuteDirectWellnessStep(
      createStep({
        intentId: "nutrition.log_food",
        mode: "write",
        targetId: "wellness.log_food_items",
        input: {
          items: [{ description: "one medium banana", quantity: 1, unit: "medium" }],
          meal: "other",
          date_scope: "2026-04-13",
        },
      }),
      {
        callFatsecretApi,
        callFatsecretApiBatch,
        executeNutritionLogItems,
        runHealthQuery: vi.fn(),
      },
    );

    expect(report).toBeNull();
    expect(executeNutritionLogItems).not.toHaveBeenCalled();
    expect(callFatsecretApi).not.toHaveBeenCalled();
    expect(callFatsecretApiBatch).not.toHaveBeenCalled();
  });

  it("directly handles a nutrition budget check for today", async () => {
    const report = await tryExecuteDirectWellnessStep(
      createStep({
        intentId: "nutrition.check_budget",
        targetId: "wellness.check_nutrition_budget",
        input: {
          date_scope: "today",
          planned_item: "yogurt tonight",
        },
      }),
      {
        callFatsecretApi: vi.fn().mockResolvedValue([
          {
            food_entry_name: "Protein Yogurt Bowl",
            meal: "Breakfast",
            calories: "420",
            protein: "42",
            carbohydrate: "30",
            fat: "11",
          },
        ]),
        callFatsecretApiBatch: vi.fn(),
        executeNutritionLogItems: vi.fn(),
        runHealthQuery: vi.fn().mockResolvedValue({
          calorie_budget: {
            food_budget: 1800,
          },
        }),
      },
    );

    expect(report).not.toBeNull();
    expect(report?.data.workerText).toContain("food budget of roughly 1,800 calories");
    expect(report?.data.workerText).toContain("Yogurt tonight");
    expect(report?.operations).toHaveLength(2);
  });

  it("does not directly handle health trend analysis", async () => {
    const runHealthQuery = vi.fn();

    const report = await tryExecuteDirectWellnessStep(
      createStep({
        intentId: "health.trend_analysis",
        targetId: "wellness.analyze_health_trends",
        input: {
          days: 14,
          focus: "tdee",
        },
      }),
      {
        callFatsecretApi: vi.fn(),
        callFatsecretApiBatch: vi.fn(),
        executeNutritionLogItems: vi.fn(),
        runHealthQuery,
      },
    );

    expect(report).toBeNull();
    expect(runHealthQuery).not.toHaveBeenCalled();
  });

  it("directly handles a simple health metric lookup", async () => {
    const report = await tryExecuteDirectWellnessStep(
      createStep({
        intentId: "health.metric_lookup_or_question",
        kind: "worker",
        targetId: "health-analyst",
        workerId: "health-analyst",
        input: {
          metric_focus: "steps",
          date_scope: "yesterday",
        },
      }),
      {
        callFatsecretApi: vi.fn(),
        callFatsecretApiBatch: vi.fn(),
        executeNutritionLogItems: vi.fn(),
        runHealthQuery: vi.fn().mockResolvedValue({
          steps: 12750,
          exercise_min: 122,
          tdee: 2710,
        }),
      },
    );

    expect(report).not.toBeNull();
    expect(report?.data.workerText).toContain("12,750 steps");
    expect(report?.operations[0]?.toolNames).toEqual(["healthdb.activity_summary"]);
  });
});
