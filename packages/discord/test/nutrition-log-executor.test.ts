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

afterEach(() => {
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
      number_of_units: 1,
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
          number_of_units: 1,
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
      number_of_units: 1,
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
