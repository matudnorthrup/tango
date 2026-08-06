import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  executeNutritionLogItems,
  resolveAtlasDbPath,
} from "../src/nutrition-log-executor.js";

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

function createAtlasDb(rows: Array<Record<string, unknown>>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-atlas-db-"));
  tempDirs.push(dir);
  const dbPath = path.join(dir, "atlas.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE ingredients (
      name TEXT,
      brand TEXT,
      product TEXT,
      food_id TEXT,
      serving_id TEXT,
      serving_description TEXT,
      serving_size TEXT,
      grams_per_serving REAL,
      calories REAL,
      protein REAL,
      carbs REAL,
      fat REAL,
      fiber REAL,
      aliases TEXT
    );
  `);
  const statement = db.prepare(`
    INSERT INTO ingredients (
      name, brand, product, food_id, serving_id, serving_description, serving_size,
      grams_per_serving, calories, protein, carbs, fat, fiber, aliases
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    statement.run(
      row.name ?? null,
      row.brand ?? null,
      row.product ?? null,
      row.food_id ?? null,
      row.serving_id ?? null,
      row.serving_description ?? null,
      row.serving_size ?? null,
      row.grams_per_serving ?? null,
      row.calories ?? null,
      row.protein ?? null,
      row.carbs ?? null,
      row.fat ?? null,
      row.fiber ?? null,
      row.aliases ?? null,
    );
  }
  db.close();
  return dbPath;
}

describe("executeNutritionLogItems", () => {
  it("resolves atlas.db relative to the real atlas binary path when the command is a symlink", () => {
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-atlas-real-"));
    const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-atlas-link-"));
    tempDirs.push(realDir, linkDir);
    const realCommand = path.join(realDir, "atlas.js");
    const linkCommand = path.join(linkDir, "atlas");
    fs.writeFileSync(realCommand, "console.log('atlas')\n", "utf8");
    fs.symlinkSync(realCommand, linkCommand);

    expect(fs.realpathSync(path.dirname(resolveAtlasDbPath(linkCommand)))).toBe(
      fs.realpathSync(realDir),
    );
    expect(path.basename(resolveAtlasDbPath(linkCommand))).toBe("atlas.db");
  });

  it("logs Atlas-backed items in one transaction and refreshes the diary once", async () => {
    const atlasDbPath = createAtlasDb([
      {
        name: "Light Vanilla Greek Yogurt",
        food_id: "1001",
        serving_id: "2001",
        serving_description: "100 g",
        serving_size: "100 g",
        grams_per_serving: 100,
        calories: 60,
        protein: 10,
        carbs: 5,
        fat: 0,
        aliases: JSON.stringify(["light vanilla greek yogurt", "greek yogurt"]),
      },
      {
        name: "PB Powder",
        food_id: "1002",
        serving_id: "2002",
        serving_description: "1 tbsp",
        serving_size: "1 tbsp",
        grams_per_serving: 6,
        calories: 25,
        protein: 3,
        carbs: 2,
        fat: 1,
        aliases: JSON.stringify(["pb powder", "peanut butter powder"]),
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
        atlasDbPath,
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

    const atlasDbPath = createAtlasDb([
      {
        name: "Light Vanilla Greek Yogurt",
        food_id: "1001",
        serving_id: "2001",
        serving_description: "100 g",
        serving_size: "100 g",
        grams_per_serving: 100,
        calories: 60,
        protein: 10,
        carbs: 5,
        fat: 0,
        aliases: JSON.stringify(["light vanilla greek yogurt"]),
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
        atlasDbPath,
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

  it("uses raw grams for Atlas servings whose unit is just grams", async () => {
    const atlasDbPath = createAtlasDb([
      {
        name: "Custom Protein Powder",
        food_id: "9001",
        serving_id: "9101",
        serving_description: "g",
        serving_size: "g",
        grams_per_serving: 1,
        calories: 4,
        protein: 0.8,
        carbs: 0.1,
        fat: 0.05,
        aliases: JSON.stringify(["custom protein powder"]),
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
        atlasDbPath,
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
  // is detected from serving_description "100g".
  it("sends raw grams for a numeric gram serving (sweet potato 140g)", async () => {
    const atlasDbPath = createAtlasDb([
      {
        name: "Sweet Potato",
        food_id: "36619",
        serving_id: "59350",
        serving_description: "100g",
        serving_size: null,
        grams_per_serving: 100,
        calories: 76,
        protein: 1.37,
        carbs: 17.72,
        fat: 0.14,
        fiber: 2.5,
        aliases: JSON.stringify(["sweet potato"]),
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
      { atlasDbPath, fatsecretCall },
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
  // unit lives in serving_description; serving_size is only the gram weight.
  it("does not treat a cup serving's gram weight as raw grams", async () => {
    const atlasDbPath = createAtlasDb([
      {
        name: "Whole Milk Greek Yogurt",
        food_id: "23761706",
        serving_id: "22170245",
        serving_description: "1 cup",
        serving_size: "227g",
        grams_per_serving: 227,
        calories: 230,
        protein: 22,
        carbs: 9,
        fat: 11,
        aliases: JSON.stringify(["whole milk greek yogurt", "greek yogurt"]),
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
      { atlasDbPath, fatsecretCall },
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
  // the Atlas row carries that weight in serving_size with no
  // serving_description. Reading serving_size as a gram UNIT sent 220 g as 220
  // servings. With the unit unknown, the serving-count path must win.
  it("does not treat serving_size grams as a gram unit when the description is missing", async () => {
    const atlasDbPath = createAtlasDb([
      {
        name: "Chicken Thighs",
        food_id: "1624102",
        serving_id: "1601782",
        serving_description: null,
        serving_size: "112g",
        grams_per_serving: 112,
        calories: 130,
        protein: 22,
        carbs: 0,
        fat: 4.5,
        aliases: JSON.stringify(["chicken thighs"]),
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
      { atlasDbPath, fatsecretCall },
    );

    const units = (fatsecretCall.mock.calls[0]?.[1] as { number_of_units: number }).number_of_units;
    expect(units).toBeCloseTo(220 / 112, 3);
    expect(units).not.toBe(220);
  });

  // Atlas rows drift from the FatSecret food they point at: Atlas carried
  // 180 cal per 112 g serving for chicken thighs while FatSecret's serving is
  // 130. Reporting the Atlas estimate told the user 354 cal for 220 g when the
  // diary actually held 255. The refreshed diary is authoritative.
  it("reports the diary's macros rather than the Atlas estimate", async () => {
    const atlasDbPath = createAtlasDb([
      {
        name: "Chicken Thighs",
        food_id: "1624102",
        serving_id: "1601782",
        serving_description: "4 oz",
        serving_size: "112g",
        grams_per_serving: 112,
        calories: 180,
        protein: 24,
        carbs: 0,
        fat: 9,
        aliases: JSON.stringify(["chicken thighs"]),
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
      { atlasDbPath, fatsecretCall },
    ) as {
      totals: Record<string, number | string>;
      logged: Array<Record<string, unknown>>;
    };

    // Atlas would have claimed 180 * (220/112) = 354 cal.
    expect(result.totals.calories).toBe(255);
    expect(result.totals.protein).toBe(43.2);
    expect(result.totals.totals_source).toBe("fatsecret");
    expect(result.logged[0]?.logged_macros).toMatchObject({ calories: 255 });
  });

  // A write the diary refresh cannot confirm still reports a number, but it is
  // labelled as the estimate it is rather than passed off as verified.
  it("falls back to the Atlas estimate when the diary cannot confirm the entry", async () => {
    const atlasDbPath = createAtlasDb([
      {
        name: "Chicken Thighs",
        food_id: "1624102",
        serving_id: "1601782",
        serving_description: "4 oz",
        serving_size: "112g",
        grams_per_serving: 112,
        calories: 180,
        protein: 24,
        carbs: 0,
        fat: 9,
        aliases: JSON.stringify(["chicken thighs"]),
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
      { atlasDbPath, fatsecretCall },
    ) as { totals: Record<string, number | string> };

    expect(result.totals.calories).toBe(354);
    expect(result.totals.totals_source).toBe("atlas_estimate");
  });

  it("uses the FatSecret batch path when available", async () => {
    const atlasDbPath = createAtlasDb([
      {
        name: "Light Vanilla Greek Yogurt",
        food_id: "1001",
        serving_id: "2001",
        serving_description: "100 g",
        serving_size: "100 g",
        grams_per_serving: 100,
        calories: 60,
        protein: 10,
        carbs: 5,
        fat: 0,
        aliases: JSON.stringify(["light vanilla greek yogurt", "greek yogurt"]),
      },
      {
        name: "PB Powder",
        food_id: "1002",
        serving_id: "2002",
        serving_description: "1 tbsp",
        serving_size: "1 tbsp",
        grams_per_serving: 6,
        calories: 25,
        protein: 3,
        carbs: 2,
        fat: 1,
        aliases: JSON.stringify(["pb powder", "peanut butter powder"]),
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
        atlasDbPath,
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
    const atlasDbPath = createAtlasDb([
      {
        name: "Light Vanilla Greek Yogurt",
        food_id: "1001",
        serving_id: "2001",
        serving_description: "100 g",
        serving_size: "100 g",
        grams_per_serving: 100,
        calories: 60,
        protein: 10,
        carbs: 5,
        fat: 0,
        aliases: JSON.stringify(["light vanilla greek yogurt", "greek yogurt"]),
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
        atlasDbPath,
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

  it("returns needs_clarification without writing when strict mode hits an Atlas miss", async () => {
    const atlasDbPath = createAtlasDb([
      {
        name: "Light Vanilla Greek Yogurt",
        food_id: "1001",
        serving_id: "2001",
        serving_description: "100 g",
        serving_size: "100 g",
        grams_per_serving: 100,
        aliases: JSON.stringify(["light vanilla greek yogurt"]),
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
        atlasDbPath,
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
        reason: "No Atlas ingredient match found. Use low-level FatSecret search for this item.",
      },
    ]);
    expect(fatsecretCall).not.toHaveBeenCalled();
  });

  it("logs resolved items when strict is omitted and another item misses Atlas", async () => {
    const atlasDbPath = createAtlasDb([
      {
        name: "Light Vanilla Greek Yogurt",
        food_id: "1001",
        serving_id: "2001",
        serving_description: "100 g",
        serving_size: "100 g",
        grams_per_serving: 100,
        calories: 60,
        protein: 10,
        carbs: 5,
        fat: 0,
        aliases: JSON.stringify(["light vanilla greek yogurt"]),
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
        atlasDbPath,
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
          reason: "No Atlas ingredient match found. Use low-level FatSecret search for this item.",
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

  it("treats branded package quantities as one serving when Atlas only exposes gram serving metadata", async () => {
    const atlasDbPath = createAtlasDb([
      {
        name: "Freeze-Dried Apple Crisps",
        brand: "Great Value",
        food_id: "25856420",
        serving_id: "23931789",
        serving_description: "",
        serving_size: "10g",
        grams_per_serving: 10,
        calories: 40,
        protein: 0,
        carbs: 10,
        fat: 0,
        fiber: 1,
        aliases: JSON.stringify(["freeze dried apples", "apple crisps"]),
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
        atlasDbPath,
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

  it("preserves Atlas match details when unit conversion needs FatSecret serving repair", async () => {
    const atlasDbPath = createAtlasDb([
      {
        name: "White Rice",
        food_id: "64",
        serving_id: "6401",
        serving_description: "100 g",
        serving_size: "100 g",
        grams_per_serving: 100,
        calories: 130,
        protein: 2.4,
        carbs: 28,
        fat: 0.3,
        aliases: JSON.stringify(["white rice"]),
      },
      {
        name: "Freeze-Dried Apple Crisps",
        brand: "Great Value",
        food_id: "25856420",
        serving_id: "23931789",
        serving_description: "",
        serving_size: "10g",
        grams_per_serving: 10,
        calories: 40,
        protein: 0,
        carbs: 10,
        fat: 0,
        fiber: 1,
        aliases: JSON.stringify(["freeze dried apples", "apple crisps"]),
      },
      {
        name: "Black Beans",
        food_id: "11748",
        serving_id: "9911",
        serving_description: "130 g",
        serving_size: "130 g",
        grams_per_serving: 130,
        calories: 132,
        protein: 8.9,
        carbs: 23.7,
        fat: 0.5,
        fiber: 8.7,
        aliases: JSON.stringify(["black beans"]),
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
        atlasDbPath,
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
        resolution: "Atlas match found: White Rice (food_id 64, serving_id 6401, grams_per_serving 100)",
        atlas_match: {
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
        resolution: "Atlas match found: Black Beans (food_id 11748, serving_id 9911, grams_per_serving 130)",
        atlas_match: {
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
      reason: expect.stringContaining("Atlas matched White Rice (food_id 64). Atlas calories are 130 per Atlas serving."),
    });
    expect(result.unresolved[1]).toMatchObject({
      reason: expect.stringContaining("Use fatsecret_api food_get with food_id 11748"),
    });
    expect(result.unresolved[1]).toMatchObject({
      reason: expect.stringContaining("Atlas matched Black Beans (food_id 11748). Atlas calories are 132 per Atlas serving."),
    });
    expect(fatsecretCall.mock.calls.map(([method]) => method)).toEqual([
      "food_entry_create",
      "food_entries_get",
    ]);
  });

  it("rejects weak Atlas token overlap instead of writing the wrong ingredient", async () => {
    const atlasDbPath = createAtlasDb([
      {
        name: "Frozen Mixed Fruit",
        food_id: "1001",
        serving_id: "2001",
        serving_description: "140 g",
        serving_size: "140 g",
        grams_per_serving: 140,
        aliases: JSON.stringify(["mixed fruit"]),
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
        atlasDbPath,
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
          reason: "No Atlas ingredient match found. Use low-level FatSecret search for this item.",
        },
      ],
    });
    expect(fatsecretCall).not.toHaveBeenCalled();
  });
});
