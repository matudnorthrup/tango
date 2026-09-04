import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeNutritionLogItems,
} from "../src/nutrition-log-executor.js";

import { ensureWellnessDb } from "../src/wellness-db-migrations.js";

const tempDirs: string[] = [];
const originalTangoTimeZone = process.env.TANGO_TIME_ZONE;
const originalTz = process.env.TZ;

afterEach(() => {
  vi.useRealTimers();
  if (originalTangoTimeZone === undefined) {
    delete process.env.TANGO_TIME_ZONE;
  } else {
    process.env.TANGO_TIME_ZONE = originalTangoTimeZone;
  }
  if (originalTz === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = originalTz;
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function createWellnessDb(rows: Array<Record<string, unknown>>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-wellness-db-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "wellness.db");
  ensureWellnessDb(dbPath);
  const db = new DatabaseSync(dbPath);
  for (const row of rows) {
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO products (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`)
      .run(...keys.map((key) => row[key] as string | number | null));
  }
  db.close();
  return dbPath;
}

describe("executeNutritionLogItems", () => {
  it("logs Wellness DB-backed items and refreshes the diary once", async () => {
    const wellnessDbPath = createWellnessDb([
      {
        name: "Light Vanilla Greek Yogurt",
        fatsecret_food_id: "1001",
        fatsecret_serving_id: "2001",
        serving_size: "100 g",
        grams_per_serving: 100,
        calories: 60,
        protein_g: 10,
        carbs_g: 5,
        fat_g: 0,
        shorthand: ["light vanilla greek yogurt", "greek yogurt"].join(","),
      },
      {
        name: "PB Powder",
        fatsecret_food_id: "1002",
        fatsecret_serving_id: "2002",
        serving_size: "1 tbsp",
        grams_per_serving: 6,
        calories: 25,
        protein_g: 3,
        carbs_g: 2,
        fat_g: 1,
        shorthand: ["pb powder", "peanut butter powder"].join(","),
      },
    ]);
    const fatsecretCall = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "food_entry_create") {
        return {
          success: true,
          food_entry_id: `${params.food_id}-entry`,
        };
      }
      if (method === "food_entries_get") {
        return {
          other: [{ food_entry_id: "1001-entry" }, { food_entry_id: "1002-entry" }],
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const result = await executeNutritionLogItems(
      {
        items: [
          { name: "light vanilla greek yogurt", quantity: "100g" },
          { name: "pb powder", quantity: "12g" },
        ],
        meal: "other",
        date: "2026-04-09",
      },
      {
        wellnessDbPath,
        fatsecretCall,
      },
    );

    expect(result).toMatchObject({
      action: "nutrition_log_items",
      status: "confirmed",
      meal: "other",
      date: "2026-04-09",
      unresolved: [],
    });
    expect(result.logged).toHaveLength(2);
    expect(fatsecretCall.mock.calls.map(([method]) => method)).toEqual([
      "food_entry_create",
      "food_entry_create",
      "food_entries_get",
    ]);
    expect(fatsecretCall.mock.calls[0]?.[1]).toMatchObject({
      food_id: "1001",
      serving_id: "2001",
      // "100 g" is a gram-unit serving → FatSecret wants raw grams (100), not 1.
      number_of_units: 100,
      meal: "other",
      date: "2026-04-09",
    });
    expect(fatsecretCall.mock.calls[1]?.[1]).toMatchObject({
      food_id: "1002",
      serving_id: "2002",
      number_of_units: 2,
      meal: "other",
      date: "2026-04-09",
    });
  });

  it("defaults an omitted log date to the configured local timezone day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-03T01:15:00.000Z"));
    process.env.TANGO_TIME_ZONE = "America/Los_Angeles";
    process.env.TZ = "UTC";

    const wellnessDbPath = createWellnessDb([
      {
        name: "Light Vanilla Greek Yogurt",
        fatsecret_food_id: "1001",
        fatsecret_serving_id: "2001",
        serving_size: "100 g",
        grams_per_serving: 100,
        calories: 60,
        protein_g: 10,
        carbs_g: 5,
        fat_g: 0,
        shorthand: ["light vanilla greek yogurt"].join(","),
      },
    ]);
    const fatsecretCall = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "food_entry_create") {
        return {
          success: true,
          food_entry_id: `${params.food_id}-entry`,
        };
      }
      if (method === "food_entries_get") {
        return {
          breakfast: [{ food_entry_id: "1001-entry" }],
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const result = await executeNutritionLogItems(
      {
        items: [{ name: "light vanilla greek yogurt", quantity: "100g" }],
        meal: "breakfast",
      },
      {
        wellnessDbPath,
        fatsecretCall,
      },
    );

    expect(result).toMatchObject({
      action: "nutrition_log_items",
      status: "confirmed",
      meal: "breakfast",
      date: "2026-06-02",
    });
    expect(fatsecretCall.mock.calls[0]?.[1]).toMatchObject({
      meal: "breakfast",
      date: "2026-06-02",
    });
    expect(fatsecretCall.mock.calls[1]?.[1]).toEqual({ date: "2026-06-02" });
  });

  it("uses raw grams for Wellness DB servings whose unit is just grams", async () => {
    const wellnessDbPath = createWellnessDb([
      {
        name: "Custom Protein Powder",
        fatsecret_food_id: "9001",
        fatsecret_serving_id: "9101",
        serving_size: "g",
        grams_per_serving: 1,
        calories: 4,
        protein_g: 0.8,
        carbs_g: 0.1,
        fat_g: 0.05,
        shorthand: ["custom protein powder"].join(","),
      },
    ]);
    const fatsecretCall = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "food_entry_create") {
        return {
          success: true,
          food_entry_id: `${params.food_id}-entry`,
        };
      }
      if (method === "food_entries_get") {
        return {
          other: [{ food_entry_id: "9001-entry" }],
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const result = await executeNutritionLogItems(
      {
        items: [{ name: "custom protein powder", quantity: "42g" }],
        meal: "other",
        date: "2026-04-09",
      },
      {
        wellnessDbPath,
        fatsecretCall,
      },
    );

    expect(result).toMatchObject({
      action: "nutrition_log_items",
      status: "confirmed",
      totals: {
        calories: 168,
      },
    });
    expect(fatsecretCall.mock.calls[0]?.[1]).toMatchObject({
      food_id: "9001",
      serving_id: "9101",
      number_of_units: 42,
      meal: "other",
      date: "2026-04-09",
    });
  });

  // Regression: the recurring "sweet potato logs as ~1 cal" bug. FatSecret
  // serving 59350 has measurement_description "g" / metric_serving_amount 100,
  // so it interprets number_of_units as RAW GRAMS. Logging 140 g must send 140,
  // not 140/100 = 1.4 (which FatSecret reads as 1.4 g → ~1 cal). The gram unit
  // is detected from serving_size "100g".
  it("sends raw grams for a numeric gram serving (sweet potato 140g)", async () => {
    const wellnessDbPath = createWellnessDb([
      {
        name: "Sweet Potato",
        fatsecret_food_id: "36619",
        fatsecret_serving_id: "59350",
        serving_size: "100g",
        grams_per_serving: 100,
        calories: 76,
        protein_g: 1.37,
        carbs_g: 17.72,
        fat_g: 0.14,
        fiber_g: 2.5,
        shorthand: ["sweet potato"].join(","),
      },
    ]);
    const fatsecretCall = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "food_entry_create") {
        return { success: true, food_entry_id: `${params.food_id}-entry` };
      }
      if (method === "food_entries_get") {
        return { dinner: [{ food_entry_id: "36619-entry" }] };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const result = await executeNutritionLogItems(
      {
        items: [{ name: "sweet potato", quantity: "140g" }],
        meal: "dinner",
        date: "2026-04-09",
      },
      { wellnessDbPath, fatsecretCall },
    );

    expect(result).toMatchObject({
      action: "nutrition_log_items",
      status: "confirmed",
      totals: {
        calories: 106,
      },
    });
    expect(fatsecretCall.mock.calls[0]?.[1]).toMatchObject({
      food_id: "36619",
      serving_id: "59350",
      number_of_units: 140,
      meal: "dinner",
      date: "2026-04-09",
    });
  });

  // Guard against over-triggering the raw-grams rule: a "1 cup" serving that
  // merely WEIGHS 227g must log as serving-count (1), not 227 raw grams. The
  // unit lives in serving_size; grams_per_serving is only the gram weight.
  it("does not treat a cup serving's gram weight as raw grams", async () => {
    const wellnessDbPath = createWellnessDb([
      {
        name: "Whole Milk Greek Yogurt",
        fatsecret_food_id: "23761706",
        fatsecret_serving_id: "22170245",
        serving_size: "1 cup",
        grams_per_serving: 227,
        calories: 230,
        protein_g: 22,
        carbs_g: 9,
        fat_g: 11,
        shorthand: ["whole milk greek yogurt", "greek yogurt"].join(","),
      },
    ]);
    const fatsecretCall = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "food_entry_create") {
        return { success: true, food_entry_id: `${params.food_id}-entry` };
      }
      if (method === "food_entries_get") {
        return { breakfast: [{ food_entry_id: "23761706-entry" }] };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const result = await executeNutritionLogItems(
      {
        items: [{ name: "whole milk greek yogurt", quantity: "227g" }],
        meal: "breakfast",
        date: "2026-04-09",
      },
      { wellnessDbPath, fatsecretCall },
    );

    expect(result).toMatchObject({
      action: "nutrition_log_items",
      status: "confirmed",
      totals: {
        calories: 230,
      },
    });
    expect(fatsecretCall.mock.calls[0]?.[1]).toMatchObject({
      food_id: "23761706",
      serving_id: "22170245",
      number_of_units: 1,
      meal: "breakfast",
      date: "2026-04-09",
    });
  });

  // Regression: the 28,600-calorie chicken thighs mislog. FatSecret serving
  // 1601782 is "4 oz" (a serving-count unit) whose gram WEIGHT is 112 g, and
  // the Wellness DB row carries that weight in grams_per_serving with no
  // serving_size. Reading serving_size as a gram UNIT sent 220 g as 220
  // servings. With the unit unknown, the serving-count path must win.
  it("assumes serving-count units when serving_size is missing", async () => {
    const wellnessDbPath = createWellnessDb([
      {
        name: "Chicken Thighs",
        fatsecret_food_id: "1624102",
        fatsecret_serving_id: "1601782",
        serving_size: null,
        grams_per_serving: 112,
        calories: 130,
        protein_g: 22,
        carbs_g: 0,
        fat_g: 4.5,
        shorthand: ["chicken thighs"].join(","),
      },
    ]);
    const fatsecretCall = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "food_entry_create") {
        return { success: true, food_entry_id: `${params.food_id}-entry` };
      }
      if (method === "food_entries_get") {
        return { lunch: [{ food_entry_id: "1624102-entry" }] };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    await executeNutritionLogItems(
      {
        items: [{ name: "chicken thighs", quantity: "220g" }],
        meal: "lunch",
        date: "2026-08-05",
      },
      { wellnessDbPath, fatsecretCall },
    );

    const units = (fatsecretCall.mock.calls[0]?.[1] as { number_of_units: number }).number_of_units;
    expect(units).toBeCloseTo(220 / 112, 3);
    expect(units).not.toBe(220);
  });

  // Wellness DB rows drift from the FatSecret food they point at: Wellness DB carried
  // 180 cal per 112 g serving for chicken thighs while FatSecret's serving is
  // 130. Reporting the Wellness DB estimate told the user 354 cal for 220 g when the
  // diary actually held 255. The refreshed diary is authoritative.
  it("reports the diary's macros rather than the Wellness DB estimate", async () => {
    const wellnessDbPath = createWellnessDb([
      {
        name: "Chicken Thighs",
        fatsecret_food_id: "1624102",
        fatsecret_serving_id: "1601782",
        serving_size: "4 oz",
        grams_per_serving: 112,
        calories: 180,
        protein_g: 24,
        carbs_g: 0,
        fat_g: 9,
        shorthand: ["chicken thighs"].join(","),
      },
    ]);
    const fatsecretCall = vi.fn(async (method: string) => {
      if (method === "food_entry_create") {
        return { success: true, food_entry_id: "entry-1" };
      }
      if (method === "food_entries_get") {
        return [
          {
            food_entry_id: "entry-1",
            food_entry_name: "Chicken Thighs",
            calories: "255",
            protein: "43.20",
            carbohydrate: "0",
            fat: "8.84",
          },
        ];
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const result = await executeNutritionLogItems(
      {
        items: [{ name: "chicken thighs", quantity: "220g" }],
        meal: "lunch",
        date: "2026-08-05",
      },
      { wellnessDbPath, fatsecretCall },
    ) as {
      totals: Record<string, number | string>;
      logged: Array<Record<string, unknown>>;
    };

    // Wellness DB would have claimed 180 * (220/112) = 354 cal.
    expect(result.totals.calories).toBe(255);
    expect(result.totals.protein).toBe(43.2);
    expect(result.totals.totals_source).toBe("fatsecret");
    expect(result.logged[0]?.logged_macros).toMatchObject({ calories: 255 });
  });

  // A write the diary refresh cannot confirm still reports a number, but it is
  // labelled as the estimate it is rather than passed off as verified.
  it("falls back to the Wellness DB estimate when the diary cannot confirm the entry", async () => {
    const wellnessDbPath = createWellnessDb([
      {
        name: "Chicken Thighs",
        fatsecret_food_id: "1624102",
        fatsecret_serving_id: "1601782",
        serving_size: "4 oz",
        grams_per_serving: 112,
        calories: 180,
        protein_g: 24,
        carbs_g: 0,
        fat_g: 9,
        shorthand: ["chicken thighs"].join(","),
      },
    ]);
    const fatsecretCall = vi.fn(async (method: string) => {
      if (method === "food_entry_create") {
        return { success: true, food_entry_id: "entry-1" };
      }
      if (method === "food_entries_get") {
        return [{ food_entry_id: "some-other-entry", calories: "999" }];
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const result = await executeNutritionLogItems(
      {
        items: [{ name: "chicken thighs", quantity: "220g" }],
        meal: "lunch",
        date: "2026-08-05",
      },
      { wellnessDbPath, fatsecretCall },
    ) as { totals: Record<string, number | string> };

    expect(result.totals.calories).toBe(354);
    expect(result.totals.totals_source).toBe("wellnessdb_estimate");
  });

  it("uses the FatSecret batch path when available", async () => {
    const wellnessDbPath = createWellnessDb([
      {
        name: "Light Vanilla Greek Yogurt",
        fatsecret_food_id: "1001",
        fatsecret_serving_id: "2001",
        serving_size: "100 g",
        grams_per_serving: 100,
        calories: 60,
        protein_g: 10,
        carbs_g: 5,
        fat_g: 0,
        shorthand: ["light vanilla greek yogurt", "greek yogurt"].join(","),
      },
      {
        name: "PB Powder",
        fatsecret_food_id: "1002",
        fatsecret_serving_id: "2002",
        serving_size: "1 tbsp",
        grams_per_serving: 6,
        calories: 25,
        protein_g: 3,
        carbs_g: 2,
        fat_g: 1,
        shorthand: ["pb powder", "peanut butter powder"].join(","),
      },
    ]);
    const fatsecretCall = vi.fn();
    const fatsecretBatchCall = vi.fn(async (calls: Array<{ method: string; params?: Record<string, unknown> }>) => {
      expect(calls).toHaveLength(3);
      expect(calls[0]).toMatchObject({
        method: "food_entry_create",
        params: {
          food_id: "1001",
          serving_id: "2001",
          // "100 g" gram-unit serving → raw grams (100), not 1.
          number_of_units: 100,
          meal: "other",
          date: "2026-04-09",
        },
      });
      expect(calls[1]).toMatchObject({
        method: "food_entry_create",
        params: {
          food_id: "1002",
          serving_id: "2002",
          number_of_units: 2,
          meal: "other",
          date: "2026-04-09",
        },
      });
      expect(calls[2]).toMatchObject({
        method: "food_entries_get",
        params: { date: "2026-04-09" },
      });
      return [
        { ok: true, result: { success: true, food_entry_id: "1001-entry" } },
        { ok: true, result: { success: true, food_entry_id: "1002-entry" } },
        { ok: true, result: { other: [{ food_entry_id: "1001-entry" }, { food_entry_id: "1002-entry" }] } },
      ];
    });

    const result = await executeNutritionLogItems(
      {
        items: [
          { name: "light vanilla greek yogurt", quantity: "100g" },
          { name: "pb powder", quantity: "12g" },
        ],
        meal: "other",
        date: "2026-04-09",
      },
      {
        wellnessDbPath,
        fatsecretCall,
        fatsecretBatchCall,
      },
    );

    expect(result).toMatchObject({
      action: "nutrition_log_items",
      status: "confirmed",
    });
    expect(result.logged).toHaveLength(2);
    expect(fatsecretBatchCall).toHaveBeenCalledTimes(1);
    expect(fatsecretCall).not.toHaveBeenCalled();
  });

  it("falls back to individual FatSecret calls when the batch path fails", async () => {
    const wellnessDbPath = createWellnessDb([
      {
        name: "Light Vanilla Greek Yogurt",
        fatsecret_food_id: "1001",
        fatsecret_serving_id: "2001",
        serving_size: "100 g",
        grams_per_serving: 100,
        calories: 60,
        protein_g: 10,
        carbs_g: 5,
        fat_g: 0,
        shorthand: ["light vanilla greek yogurt", "greek yogurt"].join(","),
      },
    ]);
    const fatsecretCall = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "food_entry_create") {
        return {
          success: true,
          food_entry_id: `${params.food_id}-entry`,
        };
      }
      if (method === "food_entries_get") {
        return {
          other: [{ food_entry_id: "1001-entry" }],
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    const fatsecretBatchCall = vi.fn(async () => {
      throw new Error("python batch helper unavailable");
    });

    const result = await executeNutritionLogItems(
      {
        items: [{ name: "light vanilla greek yogurt", quantity: "100g" }],
        meal: "other",
        date: "2026-04-09",
      },
      {
        wellnessDbPath,
        fatsecretCall,
        fatsecretBatchCall,
      },
    );

    expect(result).toMatchObject({
      action: "nutrition_log_items",
      status: "confirmed",
    });
    expect(result.errors).toEqual([]);
    expect(fatsecretBatchCall).toHaveBeenCalledTimes(1);
    expect(fatsecretCall.mock.calls.map(([method]) => method)).toEqual([
      "food_entry_create",
      "food_entries_get",
    ]);
  });

  it("returns needs_clarification without writing when strict mode hits a Wellness DB miss", async () => {
    const wellnessDbPath = createWellnessDb([
      {
        name: "Light Vanilla Greek Yogurt",
        fatsecret_food_id: "1001",
        fatsecret_serving_id: "2001",
        serving_size: "100 g",
        grams_per_serving: 100,
        shorthand: ["light vanilla greek yogurt"].join(","),
      },
    ]);
    const fatsecretCall = vi.fn();

    const result = await executeNutritionLogItems(
      {
        items: [
          { name: "light vanilla greek yogurt", quantity: "100g" },
          { name: "mystery protein bar", quantity: "1 bar" },
        ],
        meal: "breakfast",
        date: "2026-04-09",
        strict: true,
      },
      {
        wellnessDbPath,
        fatsecretCall,
      },
    );

    expect(result).toMatchObject({
      action: "nutrition_log_items",
      status: "needs_clarification",
      logged: [],
    });
    expect(result.unresolved).toEqual([
      {
        item: "mystery protein bar",
        quantity: "1 bar",
        reason: "No active wellness.db product or recipe match found. Use low-level FatSecret search for this item.",
      },
    ]);
    expect(fatsecretCall).not.toHaveBeenCalled();
  });

  it("logs resolved items when strict is omitted and another item misses Wellness DB", async () => {
    const wellnessDbPath = createWellnessDb([
      {
        name: "Light Vanilla Greek Yogurt",
        fatsecret_food_id: "1001",
        fatsecret_serving_id: "2001",
        serving_size: "100 g",
        grams_per_serving: 100,
        calories: 60,
        protein_g: 10,
        carbs_g: 5,
        fat_g: 0,
        shorthand: ["light vanilla greek yogurt"].join(","),
      },
    ]);
    const fatsecretCall = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "food_entry_create") {
        return {
          success: true,
          food_entry_id: `${params.food_id}-entry`,
        };
      }
      if (method === "food_entries_get") {
        return {
          breakfast: [{ food_entry_id: "1001-entry" }],
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const result = await executeNutritionLogItems(
      {
        items: [
          { name: "light vanilla greek yogurt", quantity: "100g" },
          { name: "mystery protein bar", quantity: "1 bar" },
        ],
        meal: "breakfast",
        date: "2026-04-09",
      },
      {
        wellnessDbPath,
        fatsecretCall,
      },
    );

    expect(result).toMatchObject({
      action: "nutrition_log_items",
      status: "partial_success",
      meal: "breakfast",
      date: "2026-04-09",
      unresolved: [
        {
          item: "mystery protein bar",
          quantity: "1 bar",
          reason: "No active wellness.db product or recipe match found. Use low-level FatSecret search for this item.",
        },
      ],
      totals: {
        calories: 60,
        protein: 10,
        carbs: 5,
        fat: 0,
        fiber: 0,
      },
    });
    expect(result.logged).toHaveLength(1);
    expect(result.logged[0]).toMatchObject({
      item: "light vanilla greek yogurt",
      food_id: "1001",
      serving_id: "2001",
      // "100 g" gram-unit serving → raw grams (100), not 1.
      number_of_units: 100,
    });
    expect(fatsecretCall.mock.calls.map(([method]) => method)).toEqual([
      "food_entry_create",
      "food_entries_get",
    ]);
  });

  it("treats branded package quantities as one serving when Wellness DB only exposes gram serving metadata", async () => {
    const wellnessDbPath = createWellnessDb([
      {
        name: "Freeze-Dried Apple Crisps",
        brand: "Great Value",
        fatsecret_food_id: "25856420",
        fatsecret_serving_id: "23931789",
        serving_size: "",
        grams_per_serving: 10,
        calories: 40,
        protein_g: 0,
        carbs_g: 10,
        fat_g: 0,
        fiber_g: 1,
        shorthand: ["freeze dried apples", "apple crisps"].join(","),
      },
    ]);
    const fatsecretCall = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "food_entry_create") {
        return {
          success: true,
          food_entry_id: `${params.food_id}-entry`,
        };
      }
      if (method === "food_entries_get") {
        return {
          other: [{ food_entry_id: "25856420-entry" }],
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const result = await executeNutritionLogItems(
      {
        items: [{ name: "freeze dried apples", quantity: "1 package" }],
        meal: "snack",
        date: "2026-04-22",
      },
      {
        wellnessDbPath,
        fatsecretCall,
      },
    );

    expect(result).toMatchObject({
      action: "nutrition_log_items",
      status: "confirmed",
      meal: "snack",
      date: "2026-04-22",
      unresolved: [],
      totals: {
        calories: 40,
        protein: 0,
        carbs: 10,
        fat: 0,
        fiber: 1,
      },
    });
    expect(result.logged).toHaveLength(1);
    expect(fatsecretCall.mock.calls.map(([method]) => method)).toEqual([
      "food_entry_create",
      "food_entries_get",
    ]);
    expect(fatsecretCall.mock.calls[0]?.[1]).toMatchObject({
      food_id: "25856420",
      serving_id: "23931789",
      number_of_units: 1,
      meal: "snack",
      date: "2026-04-22",
    });
  });

  it("preserves Wellness DB match details when unit conversion needs FatSecret serving repair", async () => {
    const wellnessDbPath = createWellnessDb([
      {
        name: "White Rice",
        fatsecret_food_id: "64",
        fatsecret_serving_id: "6401",
        serving_size: "100 g",
        grams_per_serving: 100,
        calories: 130,
        protein_g: 2.4,
        carbs_g: 28,
        fat_g: 0.3,
        shorthand: ["white rice"].join(","),
      },
      {
        name: "Freeze-Dried Apple Crisps",
        brand: "Great Value",
        fatsecret_food_id: "25856420",
        fatsecret_serving_id: "23931789",
        serving_size: "",
        grams_per_serving: 10,
        calories: 40,
        protein_g: 0,
        carbs_g: 10,
        fat_g: 0,
        fiber_g: 1,
        shorthand: ["freeze dried apples", "apple crisps"].join(","),
      },
      {
        name: "Black Beans",
        fatsecret_food_id: "11748",
        fatsecret_serving_id: "9911",
        serving_size: "130 g",
        grams_per_serving: 130,
        calories: 132,
        protein_g: 8.9,
        carbs_g: 23.7,
        fat_g: 0.5,
        fiber_g: 8.7,
        shorthand: ["black beans"].join(","),
      },
    ]);
    const fatsecretCall = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "food_entry_create") {
        return {
          success: true,
          food_entry_id: `${params.food_id}-entry`,
        };
      }
      if (method === "food_entries_get") {
        return {
          lunch: [{ food_entry_id: "25856420-entry" }],
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    });

    const result = await executeNutritionLogItems(
      {
        items: [
          { name: "white rice", quantity: "2 tablespoons" },
          { name: "freeze dried apples", quantity: "1 package" },
          { name: "black beans", quantity: "1 cup" },
        ],
        meal: "lunch",
        date: "2026-04-22",
        strict: false,
      },
      {
        wellnessDbPath,
        fatsecretCall,
      },
    );

    expect(result).toMatchObject({
      action: "nutrition_log_items",
      status: "partial_success",
      meal: "lunch",
      date: "2026-04-22",
      totals: {
        calories: 40,
        protein: 0,
        carbs: 10,
        fat: 0,
        fiber: 1,
      },
    });
    expect(result.logged).toHaveLength(1);
    expect(result.logged[0]).toMatchObject({
      item: "freeze dried apples",
      food_id: "25856420",
      serving_id: "23931789",
      number_of_units: 1,
    });
    expect(result.unresolved).toMatchObject([
      {
        item: "white rice",
        quantity: "2 tablespoons",
        resolution: "Wellness DB match found: White Rice (food_id 64, serving_id 6401, grams_per_serving 100)",
        wellnessdb_match: {
          name: "White Rice",
          food_id: "64",
          serving_id: "6401",
          calories: 130,
          grams_per_serving: 100,
        },
      },
      {
        item: "black beans",
        quantity: "1 cup",
        resolution: "Wellness DB match found: Black Beans (food_id 11748, serving_id 9911, grams_per_serving 130)",
        wellnessdb_match: {
          name: "Black Beans",
          food_id: "11748",
          serving_id: "9911",
          calories: 132,
          grams_per_serving: 130,
        },
      },
    ]);
    expect(result.unresolved[0]).toMatchObject({
      reason: expect.stringContaining("Use fatsecret_api food_get with food_id 64"),
    });
    expect(result.unresolved[0]).toMatchObject({
      reason: expect.stringContaining("Wellness DB matched White Rice (food_id 64). Wellness DB calories are 130 per product serving."),
    });
    expect(result.unresolved[1]).toMatchObject({
      reason: expect.stringContaining("Use fatsecret_api food_get with food_id 11748"),
    });
    expect(result.unresolved[1]).toMatchObject({
      reason: expect.stringContaining("Wellness DB matched Black Beans (food_id 11748). Wellness DB calories are 132 per product serving."),
    });
    expect(fatsecretCall.mock.calls.map(([method]) => method)).toEqual([
      "food_entry_create",
      "food_entries_get",
    ]);
  });

  it("rejects weak Wellness DB token overlap instead of writing the wrong ingredient", async () => {
    const wellnessDbPath = createWellnessDb([
      {
        name: "Frozen Mixed Fruit",
        fatsecret_food_id: "1001",
        fatsecret_serving_id: "2001",
        serving_size: "140 g",
        grams_per_serving: 140,
        shorthand: ["mixed fruit"].join(","),
      },
    ]);
    const fatsecretCall = vi.fn();

    const result = await executeNutritionLogItems(
      {
        items: [{ name: "garden lettuce (mixed varieties)", quantity: "100g" }],
        meal: "lunch",
        date: "2026-04-09",
      },
      {
        wellnessDbPath,
        fatsecretCall,
      },
    );

    expect(result).toMatchObject({
      action: "nutrition_log_items",
      status: "needs_clarification",
      logged: [],
      unresolved: [
        {
          item: "garden lettuce (mixed varieties)",
          quantity: "100g",
          reason: "No active wellness.db product or recipe match found. Use low-level FatSecret search for this item.",
        },
      ],
    });
    expect(fatsecretCall).not.toHaveBeenCalled();
  });
});

function recipeFixture() {
  const wellnessDbPath = createWellnessDb([
    { id: 1, name: "Yogurt", shorthand: "plain cultured yogurt, tangy base", serving_size: "1 cup",
      grams_per_serving: 200, fatsecret_food_id: "101", fatsecret_serving_id: "201",
      calories: 120, protein_g: 20, carbs_g: 8, fat_g: 1, fiber_g: 0 },
    { id: 2, name: "Lime", serving_size: "100g", grams_per_serving: 100,
      fatsecret_food_id: "102", fatsecret_serving_id: "202", calories: 30, fiber_g: 2 },
  ]);
  const db = new DatabaseSync(wellnessDbPath);
  db.exec(`
    INSERT INTO recipes (id, name, shorthand, servings, yield_g) VALUES
      (10, 'Garden Tex-Mex Power Salad', 'power salad', 2, NULL),
      (11, 'Lime Yogurt Crema', 'crema', 1, 50);
    INSERT INTO recipe_aliases (recipe_id, alias) VALUES (10, 'garden lunch');
    INSERT INTO recipe_ingredients (recipe_id, ingredient_name, product_id, sub_recipe_id, quantity_g) VALUES
      (10, 'Lime Yogurt Crema', NULL, 11, 100),
      (11, 'Yogurt', 1, NULL, 35),
      (11, 'Lime', 2, NULL, 15);
  `);
  db.close();
  let id = 0;
  const fatsecretCall = vi.fn(async (method: string, _params: Record<string, unknown>) =>
    method === "food_entry_create" ? { success: true, food_entry_id: String(++id) } : []);
  return { wellnessDbPath, fatsecretCall };
}

function mutateFixture(dbPath: string, sql: string) {
  const db = new DatabaseSync(dbPath);
  try { db.exec(sql); } finally { db.close(); }
}

const recipeInput = (name: string, quantity: string, strict = false) => ({
  items: [{ name, quantity }], meal: "lunch", date: "2026-09-04", strict,
});

describe("wellness.db recipe expansion", () => {
  it.each([
    ["Garden Tex-Mex Power Salad", "1", 35],
    ["GARDEN LUNCH", "2 servings", 70],
    ["POWER SALAD", "3 tacos", 105],
    ["power salad", "half", 17.5],
  ])("expands %s / %s by servings and nested component yield", async (name, quantity, grams) => {
    const deps = recipeFixture();
    const result = await executeNutritionLogItems(recipeInput(name, quantity), deps);
    expect(result).toMatchObject({ status: "confirmed", unresolved: [], skipped: [],
      logged: [
        { food_id: "101", number_of_units: grams / 200, recipe_id: 10, source: "wellnessdb",
          estimated_macros: { calories: Math.round(120 * grams / 200) } },
        { food_id: "102", number_of_units: 15 * grams / 35, recipe_id: 10 },
      ], totals: { totals_source: "wellnessdb_estimate" } });
    const db = new DatabaseSync(deps.wellnessDbPath);
    expect(db.prepare("SELECT date, meal, recipe_id, food_entry_id FROM fatsecret_entry_links ORDER BY id").all())
      .toEqual([
        { date: "2026-09-04", meal: "lunch", recipe_id: 10, food_entry_id: "1" },
        { date: "2026-09-04", meal: "lunch", recipe_id: 10, food_entry_id: "2" },
      ]);
    db.close();
  });

  it.each(["150g", "150 g"])("scales a component recipe by %s", async (quantity) => {
    const deps = recipeFixture();
    const result = await executeNutritionLogItems(recipeInput("LIME YOGURT CREMA", quantity), deps);
    expect(result).toMatchObject({ status: "confirmed", logged: [
      { number_of_units: 105 / 200, recipe_id: 11 }, { number_of_units: 45, recipe_id: 11 },
    ] });
  });

  it("expands a direct product row using recipe servings", async () => {
    const deps = recipeFixture();
    mutateFixture(deps.wellnessDbPath, "UPDATE recipe_ingredients SET product_id = 1, sub_recipe_id = NULL WHERE recipe_id = 10");
    const result = await executeNutritionLogItems(recipeInput("power salad", "1 serving"), deps);
    expect(result).toMatchObject({ logged: [{ number_of_units: 50 / 200, recipe_id: 10 }] });
  });

  it("rejects gram quantities on a recipe without yield_g", async () => {
    const deps = recipeFixture();
    const result = await executeNutritionLogItems(recipeInput("power salad", "150g"), deps);
    expect(result).toMatchObject({ status: "needs_clarification", logged: [],
      unresolved: [{ item: "power salad", reason: expect.stringContaining("yield_g") }] });
    expect(deps.fatsecretCall).not.toHaveBeenCalled();
  });

  it("rejects cycles without writing earlier expanded products", async () => {
    const deps = recipeFixture();
    mutateFixture(deps.wellnessDbPath, `UPDATE recipes SET yield_g = 100 WHERE id = 10;
      INSERT INTO recipe_ingredients (recipe_id, ingredient_name, sub_recipe_id, quantity_g)
      VALUES (11, 'Cycle', 10, 20)`);
    const result = await executeNutritionLogItems(recipeInput("power salad", "1"), deps);
    expect(result).toMatchObject({ status: "needs_clarification", logged: [],
      unresolved: [{ item: "power salad", reason: expect.stringContaining("cycle") }] });
    expect(deps.fatsecretCall).not.toHaveBeenCalled();
  });

  it("enforces depth 6 and permits a six-recipe chain", async () => {
    const deps = recipeFixture();
    mutateFixture(deps.wellnessDbPath, `DELETE FROM recipe_ingredients;
      INSERT INTO recipes (id, name, servings, yield_g) VALUES
        (12, 'Layer 3', 1, 50), (13, 'Layer 4', 1, 50), (14, 'Layer 5', 1, 50),
        (15, 'Layer 6', 1, 50), (16, 'Layer 7', 1, 50);
      INSERT INTO recipe_ingredients (recipe_id, ingredient_name, sub_recipe_id, quantity_g) VALUES
        (10, 'Layer 2', 11, 50), (11, 'Layer 3', 12, 50), (12, 'Layer 4', 13, 50),
        (13, 'Layer 5', 14, 50), (14, 'Layer 6', 15, 50);
      INSERT INTO recipe_ingredients (recipe_id, ingredient_name, product_id, quantity_g) VALUES (15, 'Yogurt', 1, 35);`);
    expect(await executeNutritionLogItems(recipeInput("power salad", "1"), deps)).toMatchObject({ status: "confirmed" });
    deps.fatsecretCall.mockClear();
    mutateFixture(deps.wellnessDbPath, `UPDATE recipe_ingredients SET product_id = NULL, sub_recipe_id = 16 WHERE recipe_id = 15;
      INSERT INTO recipe_ingredients (recipe_id, ingredient_name, product_id, quantity_g) VALUES (16, 'Yogurt', 1, 35)`);
    expect(await executeNutritionLogItems(recipeInput("power salad", "1"), deps)).toMatchObject({
      logged: [], unresolved: [{ reason: expect.stringContaining("depth limit 6") }],
    });
    expect(deps.fatsecretCall).not.toHaveBeenCalled();
  });

  it.each([false, true])("reports skipped rows and respects strict=%s", async (strict) => {
    const deps = recipeFixture();
    mutateFixture(deps.wellnessDbPath, `INSERT INTO recipe_ingredients (recipe_id, ingredient_name, product_id, quantity_g)
      VALUES (10, 'Unmeasured yogurt', 1, NULL), (10, 'Unmapped spice', NULL, 5)`);
    const result = await executeNutritionLogItems(recipeInput("power salad", "1", strict), deps);
    expect(result).toMatchObject({ status: strict ? "needs_clarification" : "partial_success", skipped: [
      { item: "Unmeasured yogurt", reason: expect.stringContaining("quantity_g") },
      { item: "Unmapped spice", reason: expect.stringContaining("product_id") },
    ] });
    expect(result.logged).toHaveLength(strict ? 0 : 2);
  });

  it("keeps successful diary writes when linking fails", async () => {
    const deps = recipeFixture();
    mutateFixture(deps.wellnessDbPath, "DROP TABLE fatsecret_entry_links");
    const result = await executeNutritionLogItems(recipeInput("power salad", "1"), deps);
    expect(result).toMatchObject({ status: "confirmed", errors: [], link_warnings: [expect.stringContaining("recipe links failed")] });
    expect(result.logged).toHaveLength(2);
  });

  it("links only successful batch entries to the top-level recipe", async () => {
    const deps = recipeFixture();
    const fatsecretBatchCall = vi.fn(async () => [
      { ok: true, result: { success: true, food_entry_id: "batch-yogurt" } },
      { ok: false, error: "write failed" }, { ok: true, result: [] },
    ]);
    const result = await executeNutritionLogItems(recipeInput("power salad", "1"), { ...deps, fatsecretBatchCall });
    expect(result).toMatchObject({ status: "partial_success" });
    const db = new DatabaseSync(deps.wellnessDbPath);
    expect(db.prepare("SELECT recipe_id, food_entry_id FROM fatsecret_entry_links").all()).toEqual([
      { recipe_id: 10, food_entry_id: "batch-yogurt" },
    ]);
    db.close();
    expect(deps.fatsecretCall).not.toHaveBeenCalled();
  });

  it("matches comma-separated product shorthand and excludes discontinued products", async () => {
    const deps = recipeFixture();
    expect(await executeNutritionLogItems(recipeInput("TANGY BASE", "35g"), deps)).toMatchObject({
      status: "confirmed", logged: [{ food_id: "101", number_of_units: 35 / 200 }],
    });
    mutateFixture(deps.wellnessDbPath, "UPDATE products SET discontinued_date = '2026-01-01' WHERE id = 1");
    deps.fatsecretCall.mockClear();
    expect(await executeNutritionLogItems(recipeInput("tangy base", "35g"), deps)).toMatchObject({ logged: [], status: "needs_clarification" });
    expect(deps.fatsecretCall).not.toHaveBeenCalled();
    expect(await executeNutritionLogItems(recipeInput("power salad", "1"), deps)).toMatchObject({
      logged: [], unresolved: [{ reason: expect.stringContaining("discontinued") }],
    });
  });

  it("excludes archived recipes by name, shorthand and alias", async () => {
    const deps = recipeFixture();
    mutateFixture(deps.wellnessDbPath, "UPDATE recipes SET archived_at = '2026-01-01' WHERE id = 10");
    for (const name of ["Garden Tex-Mex Power Salad", "power salad", "garden lunch"]) {
      expect(await executeNutritionLogItems(recipeInput(name, "1"), deps)).toMatchObject({ logged: [], status: "needs_clarification" });
    }
    expect(deps.fatsecretCall).not.toHaveBeenCalled();
  });

  it.each(["fatsecret_food_id", "fatsecret_serving_id", "grams_per_serving"])("names the product when %s is missing", async (column) => {
    const deps = recipeFixture();
    mutateFixture(deps.wellnessDbPath, `UPDATE products SET ${column} = NULL WHERE id = 1`);
    const result = await executeNutritionLogItems(recipeInput("tangy base", "35g"), deps);
    expect(result).toMatchObject({ logged: [], unresolved: [{ reason: expect.stringContaining("Product Yogurt") }] });
    expect(deps.fatsecretCall).not.toHaveBeenCalled();
  });

  it("uses safe serving counts for unparseable serving_size", async () => {
    const deps = recipeFixture();
    mutateFixture(deps.wellnessDbPath, "UPDATE products SET serving_size = 'unknown' WHERE id = 1");
    expect(await executeNutritionLogItems(recipeInput("Yogurt", "35g"), deps)).toMatchObject({
      logged: [{ number_of_units: 35 / 200 }],
    });
  });

  it("reports mixed totals when the diary confirms only one expanded entry", async () => {
    const deps = recipeFixture();
    deps.fatsecretCall.mockImplementation(async (method) => method === "food_entry_create"
      ? { success: true, food_entry_id: String(deps.fatsecretCall.mock.calls.length) }
      : [{ food_entry_id: "1", calories: "90", protein: "10", carbohydrate: "5", fat: "2", fiber: "0" }]);
    const result = await executeNutritionLogItems(recipeInput("power salad", "1"), deps);
    expect(result).toMatchObject({ totals: { calories: 95, totals_source: "mixed" } });
  });
});
