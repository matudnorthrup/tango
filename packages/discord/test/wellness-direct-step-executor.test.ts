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
    expect(report?.data.workerText).toContain("2026-04-13");
    expect(report?.data.workerText).toContain("225 calories");
    expect(report?.operations[0]?.toolNames).toEqual(["fatsecret.day_summary"]);
  });

  it("directly handles a strict nutrition log when classifier entities are structured", async () => {
    const executeNutritionLogItems = vi.fn().mockResolvedValue({
      status: "confirmed",
      logged: [
        {
          item: "banana",
          food_entry_id: "23202983246",
        },
      ],
      totals: {
        calories: 105,
        protein: 1.3,
        carbs: 27,
        fat: 0.4,
      },
    });

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
        callFatsecretApi: vi.fn(),
        callFatsecretApiBatch: vi.fn(),
        executeNutritionLogItems,
        runHealthQuery: vi.fn(),
      },
    );

    expect(executeNutritionLogItems).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [{ name: "banana", quantity: "1 medium" }],
        meal: "other",
        date: "2026-04-13",
        strict: true,
      }),
      expect.any(Object),
    );
    expect(report?.hasWriteOperations).toBe(true);
    expect(report?.data.workerText).toContain("Banana logged");
    expect(report?.data.workerText).toContain("23202983246");
  });

  it("falls back when the strict nutrition log cannot be confirmed", async () => {
    const report = await tryExecuteDirectWellnessStep(
      createStep({
        intentId: "nutrition.log_food",
        mode: "write",
        targetId: "wellness.log_food_items",
        input: {
          items: "one medium banana",
          meal: "other",
          date_scope: "2026-04-13",
        },
      }),
      {
        callFatsecretApi: vi.fn(),
        callFatsecretApiBatch: vi.fn(),
        executeNutritionLogItems: vi.fn().mockResolvedValue({
          status: "needs_clarification",
          logged: [],
          unresolved: [{ item: "banana", reason: "missing" }],
        }),
        runHealthQuery: vi.fn(),
      },
    );

    expect(report).toBeNull();
  });

  it("recovers a simple unresolved food log through direct FatSecret search and write", async () => {
    const callFatsecretApi = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "foods_search" && params.search_expression === "banana") {
        return [
          {
            food_id: "73513198",
            food_name: "Banana - Shakes Medium",
            food_type: "Brand",
            brand_name: "Braum's",
          },
        ];
      }
      if (method === "foods_search" && params.search_expression === "banana raw") {
        return [
          {
            food_id: "5388",
            food_name: "Banana",
            food_type: "Generic",
          },
        ];
      }
      if (method === "food_get" && params.food_id === "5388") {
        return {
          food_id: "5388",
          food_name: "Banana",
          servings: {
            serving: [
              {
                serving_id: "19134",
                serving_description: "1 medium",
                measurement_description: "medium",
                metric_serving_amount: "118.000",
                number_of_units: "1.000",
                calories: "105",
                protein: "1.29",
                carbohydrate: "26.95",
                fat: "0.39",
              },
            ],
          },
        };
      }
      throw new Error(`Unexpected FatSecret method ${method}`);
    });

    const executeNutritionLogItems = vi.fn()
      .mockResolvedValueOnce({
        status: "needs_clarification",
        logged: [],
        unresolved: [{ item: "banana", quantity: "1 medium", reason: "missing" }],
        totals: null,
        errors: [],
      })
      .mockResolvedValueOnce({
        status: "needs_clarification",
        logged: [],
        unresolved: [{ item: "banana", quantity: "1 medium", reason: "missing" }],
        totals: null,
        errors: [],
      });

    const callFatsecretApiBatch = vi.fn().mockResolvedValue([
      { ok: true, result: { success: true, food_entry_id: "23202983246" } },
      {
        ok: true,
        result: [
          {
            food_entry_name: "Banana",
            meal: "Other",
            calories: "105",
            protein: "1.29",
            carbohydrate: "26.95",
            fat: "0.39",
          },
        ],
      },
    ]);

    const report = await tryExecuteDirectWellnessStep(
      createStep({
        intentId: "nutrition.log_food",
        mode: "write",
        targetId: "wellness.log_food_items",
        input: {
          items: "one medium banana",
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

    expect(report).not.toBeNull();
    expect(report?.hasWriteOperations).toBe(true);
    expect(report?.data.workerText).toContain("Banana logged");
    expect(report?.data.workerText).toContain("23202983246");
    expect(callFatsecretApi.mock.calls.filter(([method]) => method === "foods_search")).toEqual([
      ["foods_search", { search_expression: "banana", max_results: 10 }],
      ["foods_search", { search_expression: "banana raw", max_results: 10 }],
    ]);
    expect(callFatsecretApiBatch).toHaveBeenCalledTimes(1);
  });

  it("writes gram-based FatSecret servings using raw grams", async () => {
    const callFatsecretApi = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "foods_search" && params.search_expression === "unsweetened almond milk") {
        return [
          {
            food_id: "5406437",
            food_name: "Unsweetened Almond Milk",
            food_type: "Generic",
          },
        ];
      }
      if (method === "food_get" && params.food_id === "5406437") {
        return {
          food_id: "5406437",
          food_name: "Unsweetened Almond Milk",
          servings: {
            serving: [
              {
                serving_id: "5255197",
                serving_description: "100 g",
                measurement_description: "g",
                metric_serving_amount: "100.000",
                number_of_units: "100.000",
                calories: "13",
                protein: "0.5",
                carbohydrate: "0.5",
                fat: "1.0",
              },
            ],
          },
        };
      }
      throw new Error(`Unexpected FatSecret method ${method}`);
    });

    const executeNutritionLogItems = vi.fn()
      .mockResolvedValueOnce({
        status: "needs_clarification",
        logged: [],
        unresolved: [{ item: "unsweetened almond milk", quantity: "60g", reason: "missing" }],
        totals: null,
        errors: [],
      })
      .mockResolvedValueOnce({
        status: "needs_clarification",
        logged: [],
        unresolved: [{ item: "unsweetened almond milk", quantity: "60g", reason: "missing" }],
        totals: null,
        errors: [],
      });

    const callFatsecretApiBatch = vi.fn().mockResolvedValue([
      { ok: true, result: { success: true, food_entry_id: "23206182873" } },
      {
        ok: true,
        result: [
          {
            food_entry_name: "Unsweetened Almond Milk",
            meal: "Breakfast",
            calories: "8",
            protein: "0.3",
            carbohydrate: "0.3",
            fat: "0.6",
          },
        ],
      },
    ]);

    const report = await tryExecuteDirectWellnessStep(
      createStep({
        intentId: "nutrition.log_food",
        mode: "write",
        targetId: "wellness.log_food_items",
        input: {
          items: [{ name: "unsweetened almond milk", quantity: "60g" }],
          meal: "breakfast",
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

    expect(report).not.toBeNull();
    expect(callFatsecretApiBatch).toHaveBeenCalledWith([
      {
        method: "food_entry_create",
        params: {
          food_id: "5406437",
          food_entry_name: "Unsweetened Almond Milk",
          serving_id: "5255197",
          number_of_units: 60,
          meal: "breakfast",
          date: "2026-04-13",
        },
      },
      {
        method: "food_entries_get",
        params: { date: "2026-04-13" },
      },
    ]);
    expect(report?.data.workerText).toContain("Unsweetened almond milk logged");
    expect(report?.data.workerText).toContain("8 cal");
  });

  it("returns a direct partial report when Atlas logs some items but one remains unresolved", async () => {
    const executeNutritionLogItems = vi.fn()
      .mockResolvedValueOnce({
        status: "needs_clarification",
        logged: [],
        unresolved: [
          { item: "yogurt", quantity: "200 g", reason: "mixed" },
          { item: "mystery topping", quantity: "1 tbsp", reason: "mixed" },
        ],
        totals: null,
        errors: [],
      })
      .mockResolvedValueOnce({
        status: "partial_success",
        logged: [
          {
            item: "yogurt",
            food_entry_id: "2001",
            estimated_macros: {
              calories: 140,
              protein: 20,
              carbs: 8,
              fat: 0,
              fiber: 0,
            },
          },
        ],
        unresolved: [{ item: "mystery topping", quantity: "1 tbsp", reason: "missing" }],
        totals: {
          calories: 140,
          protein: 20,
          carbs: 8,
          fat: 0,
        },
        errors: [],
      });

    const report = await tryExecuteDirectWellnessStep(
      createStep({
        intentId: "nutrition.log_food",
        mode: "write",
        targetId: "wellness.log_food_items",
        input: {
          items: [
            { name: "yogurt", quantity: "200 g" },
            { name: "mystery topping", quantity: "1 tbsp" },
          ],
          meal: "breakfast",
          date_scope: "2026-04-13",
        },
      }),
      {
        callFatsecretApi: vi.fn().mockResolvedValue([]),
        callFatsecretApiBatch: vi.fn(),
        executeNutritionLogItems,
        runHealthQuery: vi.fn(),
      },
    );

    expect(report).not.toBeNull();
    expect(report?.hasWriteOperations).toBe(true);
    expect(report?.data.workerText).toContain("Yogurt logged");
    expect(report?.data.workerText).toContain("mystery topping");
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

  it("directly handles a TDEE trend analysis", async () => {
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
        runHealthQuery: vi.fn().mockResolvedValue({
          days: 14,
          data: [
            { date: "2026-04-01", tdee: 3000, sleep_hrs: 8.0, rhr: 44 },
            { date: "2026-04-02", tdee: 2950, sleep_hrs: 7.9, rhr: 45 },
            { date: "2026-04-03", tdee: 3025, sleep_hrs: 8.1, rhr: 44 },
            { date: "2026-04-04", tdee: 3100, sleep_hrs: 8.3, rhr: 43 },
            { date: "2026-04-05", tdee: 3050, sleep_hrs: 8.0, rhr: 44 },
            { date: "2026-04-06", tdee: 2990, sleep_hrs: 7.8, rhr: 45 },
            { date: "2026-04-07", tdee: 3010, sleep_hrs: 8.2, rhr: 44 },
            { date: "2026-04-08", tdee: 2890, sleep_hrs: 8.1, rhr: 45 },
            { date: "2026-04-09", tdee: 2860, sleep_hrs: 7.9, rhr: 46 },
            { date: "2026-04-10", tdee: 2840, sleep_hrs: 8.0, rhr: 45 },
            { date: "2026-04-11", tdee: 2825, sleep_hrs: 8.2, rhr: 45 },
            { date: "2026-04-12", tdee: 2810, sleep_hrs: 8.1, rhr: 46 },
            { date: "2026-04-13", tdee: 2805, sleep_hrs: 8.0, rhr: 45 },
            { date: "2026-04-14", tdee: 2790, sleep_hrs: 8.1, rhr: 45 },
          ],
        }),
      },
    );

    expect(report).not.toBeNull();
    expect(report?.data.workerText).toContain("average TDEE");
    expect(report?.data.workerText).toContain("last 14 completed days");
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
