import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createWellnessDbTools,
  wellnessDbToolLooksReadOnly,
} from "../src/wellness-db-tools.js";
import { ensureWellnessDb } from "../src/wellness-db-migrations.js";

const tempFiles: string[] = [];

function makeToolMap(dbPath: string): Map<string, (input: Record<string, unknown>) => Promise<unknown>> {
  const tools = createWellnessDbTools({
    dbPath,
    supplementBatchShortcuts: {
      combo: ["batch-a", "batch-b", "batch-c"],
    },
  });
  return new Map(tools.map((tool) => [tool.name, tool.handler]));
}

function seedTestDb(dbPath: string): void {
  ensureWellnessDb(dbPath);
  const db = new DatabaseSync(dbPath);
  db.prepare(
    `INSERT INTO products (id, name, shorthand, calories, protein_g, carbs_g, fat_g)
     VALUES (1, 'Core Power Chocolate', 'core power', 170, 26, 8, 3),
            (2, 'Discontinued Bar', 'old bar', 100, 5, 10, 2)`,
  ).run();
  db.prepare("UPDATE products SET discontinued_date = '2026-01-01' WHERE id = 2").run();

  db.prepare(
    `INSERT INTO supplements (id, name, shorthand, calories, protein_g, carbs_g, fat_g)
     VALUES (11, 'Daily Supplement', 'daily', 0, 0, 0, 0),
            (26, 'Batch Supplement A', 'batch-a', 0, 0, 0, 0),
            (27, 'Batch Supplement B', 'batch-b', 0, 0, 0, 0),
            (28, 'Batch Supplement C', 'batch-c', 0, 0, 0, 0),
            (99, 'Stopped Supplement', 'stopped', 0, 0, 0, 0)`,
  ).run();
  db.prepare("UPDATE supplements SET stopped_date = '2026-01-01' WHERE id = 99").run();

  db.prepare(
    `INSERT INTO recipes (id, name, shorthand, servings, total_calories, total_protein_g, total_carbs_g, total_fat_g)
     VALUES (1, 'Vegetarian Chili', 'chili', 4, 800, 40, 80, 20)`,
  ).run();
  db.prepare(
    `INSERT INTO recipe_ingredients (recipe_id, product_id, ingredient_name, quantity, calories, protein_g, carbs_g, fat_g)
     VALUES (1, 1, 'Core Power Chocolate', '1 bottle', 170, 26, 8, 3)`,
  ).run();
  db.prepare("INSERT INTO recipe_aliases (recipe_id, alias) VALUES (1, 'veggie chili')").run();
}

describe("wellnessDbToolLooksReadOnly", () => {
  it("marks read tools as read-only", () => {
    expect(wellnessDbToolLooksReadOnly("wellnessdb_search_product")).toBe(true);
    expect(wellnessDbToolLooksReadOnly("wellnessdb_log_meal")).toBe(false);
  });
});

describe("createWellnessDbTools", () => {
  let dbPath: string;
  let tools: Map<string, (input: Record<string, unknown>) => Promise<unknown>>;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `wellness-db-tools-${Date.now()}-${Math.random()}.db`);
    tempFiles.push(dbPath);
    seedTestDb(dbPath);
    tools = makeToolMap(dbPath);
  });

  afterEach(() => {
    while (tempFiles.length > 0) {
      const file = tempFiles.pop();
      if (file && fs.existsSync(file)) {
        fs.rmSync(file, { force: true });
      }
    }
  });

  it("excludes archived recipe matches unless include_archived is true", async () => {
    const db = new DatabaseSync(dbPath);
    db.exec("UPDATE recipes SET archived_at = '2026-09-01' WHERE id = 1");
    db.close();
    for (const query of ["Vegetarian", "chili", "veggie chili"]) {
      expect(await tools.get("wellnessdb_search_recipe")!({ query })).toMatchObject({ count: 0 });
      expect(await tools.get("wellnessdb_search_recipe")!({ query, include_archived: true }))
        .toMatchObject({ count: 1, recipes: [{ archived_at: "2026-09-01" }] });
    }
    // Detail is still available for inspecting a retired recipe.
    expect(await tools.get("wellnessdb_get_recipe_detail")!({ query: "1" }))
      .toMatchObject({ recipe: { archived_at: "2026-09-01" } });
  });

  it("returns canonical grams, product mappings, component names and per-100g macros", async () => {
    const db = new DatabaseSync(dbPath);
    db.exec(`UPDATE products SET grams_per_serving = 100, fiber_g = 4,
        fatsecret_food_id = '101', fatsecret_serving_id = '201' WHERE id = 1;
      UPDATE recipes SET yield_g = 400, total_fiber_g = 16 WHERE id = 1;
      UPDATE recipe_ingredients SET quantity_g = 50, calories = NULL, protein_g = NULL,
        carbs_g = NULL, fat_g = NULL WHERE recipe_id = 1;
      INSERT INTO recipes (id, name, yield_g, total_calories, total_protein_g, total_carbs_g, total_fat_g, total_fiber_g)
        VALUES (2, 'Component Sauce', 50, 100, 10, 8, 3, 2);
      INSERT INTO recipe_ingredients (recipe_id, ingredient_name, sub_recipe_id, quantity_g)
        VALUES (1, 'Sauce', 2, 25);`);
    db.close();
    for (const query of ["1", "chili", "veggie chili", "Vegetarian Chili"]) {
      expect(await tools.get("wellnessdb_get_recipe_detail")!({ query })).toMatchObject({
        recipe: { yield_g: 400, archived_at: null, per_100g_cal: 200, per_100g_prot: 10,
          per_100g_carb: 20, per_100g_fat: 5, per_100g_fiber: 4 },
        ingredients: [
          { quantity_g: 50, fiber_g: 2, calories: 85, protein_g: 13, carbs_g: 4, fat_g: 1.5,
            product_id: 1, product_name: "Core Power Chocolate", fatsecret_food_id: "101",
            fatsecret_serving_id: "201", grams_per_serving: 100, sub_recipe_id: null, sub_recipe_name: null },
          { quantity_g: 25, sub_recipe_id: 2, sub_recipe_name: "Component Sauce", product_id: null,
            calories: 50, protein_g: 5, carbs_g: 4, fat_g: 1.5, fiber_g: 1 },
        ],
      });
    }
  });

  it("searches products by shorthand and by name", async () => {
    const byShorthand = await tools.get("wellnessdb_search_product")!({ query: "core power" });
    expect(byShorthand).toMatchObject({
      count: 1,
      products: [expect.objectContaining({ name: "Core Power Chocolate" })],
    });

    const byName = await tools.get("wellnessdb_search_product")!({ query: "Chocolate" });
    expect(byName).toMatchObject({ count: 1 });
  });

  it("searches active supplements only when requested", async () => {
    const all = await tools.get("wellnessdb_search_supplement")!({ query: "stop" });
    expect(all).toMatchObject({ count: 1 });

    const activeOnly = await tools.get("wellnessdb_search_supplement")!({
      query: "stop",
      active_only: true,
    });
    expect(activeOnly).toMatchObject({ count: 0 });
  });

  it("searches recipes by alias", async () => {
    const result = await tools.get("wellnessdb_search_recipe")!({ query: "veggie chili" });
    expect(result).toMatchObject({
      count: 1,
      recipes: [expect.objectContaining({ name: "Vegetarian Chili" })],
    });
  });

  it("logs a meal and returns it in day_summary", async () => {
    const logged = await tools.get("wellnessdb_log_meal")!({
      date: "2026-05-30",
      meal: "breakfast",
      item_type: "product",
      item: "core power",
      servings: 1,
    });
    expect(logged).toMatchObject({
      id: expect.any(Number),
      item: "Core Power Chocolate",
      calories: 170,
      protein_g: 26,
    });

    const summary = await tools.get("wellnessdb_day_summary")!({ date: "2026-05-30" });
    expect(summary).toMatchObject({
      date: "2026-05-30",
      meals: [expect.objectContaining({ description: "Core Power Chocolate" })],
      food_totals: { calories: 170, protein_g: 26 },
    });
  });

  it("logs a configured batch shortcut as separate supplement rows", async () => {
    const result = await tools.get("wellnessdb_log_supplement")!({
      date: "2026-05-30",
      supplements: "combo",
    });
    expect(result).toMatchObject({
      logged: [
        expect.objectContaining({ supplement: "Batch Supplement A" }),
        expect.objectContaining({ supplement: "Batch Supplement B" }),
        expect.objectContaining({ supplement: "Batch Supplement C" }),
      ],
    });

    const summary = await tools.get("wellnessdb_day_summary")!({ date: "2026-05-30" });
    expect((summary as { meals: unknown[] }).meals).toHaveLength(3);
  });

  it("returns day range aggregates", async () => {
    await tools.get("wellnessdb_log_meal")!({
      date: "2026-05-29",
      meal: "lunch",
      item_type: "product",
      item: "core power",
    });
    await tools.get("wellnessdb_log_meal")!({
      date: "2026-05-30",
      meal: "dinner",
      item_type: "product",
      item: "core power",
      servings: 2,
    });

    const range = await tools.get("wellnessdb_day_range")!({
      start_date: "2026-05-29",
      end_date: "2026-05-30",
    });
    expect(range).toMatchObject({ count: 2 });
    expect((range as { days: Array<{ date: string; total_cal: number }> }).days).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ date: "2026-05-29", total_cal: 170 }),
        expect.objectContaining({ date: "2026-05-30", total_cal: 340 }),
      ]),
    );
  });

  it("deletes only the requested meal entry", async () => {
    const first = await tools.get("wellnessdb_log_meal")!({
      date: "2026-05-30",
      meal: "breakfast",
      item_type: "product",
      item: "core power",
    });
    await tools.get("wellnessdb_log_meal")!({
      date: "2026-05-30",
      meal: "lunch",
      item_type: "product",
      item: "core power",
    });

    await tools.get("wellnessdb_delete_meal_entry")!({ id: (first as { id: number }).id });

    const summary = await tools.get("wellnessdb_day_summary")!({ date: "2026-05-30" });
    expect((summary as { meals: unknown[] }).meals).toHaveLength(1);
  });

  it("updates product fields by id", async () => {
    const updated = await tools.get("wellnessdb_update_product")!({
      id: 1,
      name: "Core Power Elite Chocolate",
      calories: 180,
      protein_g: 30,
      notes: "Updated from label",
    });

    expect(updated).toMatchObject({
      updated: true,
      product: expect.objectContaining({
        id: 1,
        name: "Core Power Elite Chocolate",
        calories: 180,
        protein_g: 30,
        notes: "Updated from label",
      }),
    });
  });

  it("updates supplement fields by id", async () => {
    const updated = await tools.get("wellnessdb_update_supplement")!({
      id: 11,
      dosage: "500mg, 1 capsule",
      notes: "Updated dosage format",
    });

    expect(updated).toMatchObject({
      updated: true,
      supplement: expect.objectContaining({
        id: 11,
        dosage: "500mg, 1 capsule",
        notes: "Updated dosage format",
      }),
    });
  });

  it("deletes a product by id", async () => {
    const deleted = await tools.get("wellnessdb_delete_product")!({ id: 2 });
    expect(deleted).toMatchObject({
      deleted: true,
      product: expect.objectContaining({ id: 2, name: "Discontinued Bar" }),
    });

    const search = await tools.get("wellnessdb_search_product")!({ query: "Discontinued Bar" });
    expect(search).toMatchObject({ count: 0 });
  });

  it("deletes a supplement by id", async () => {
    const deleted = await tools.get("wellnessdb_delete_supplement")!({ id: 99 });
    expect(deleted).toMatchObject({
      deleted: true,
      supplement: expect.objectContaining({ id: 99, name: "Stopped Supplement" }),
    });

    const search = await tools.get("wellnessdb_search_supplement")!({ query: "Stopped Supplement" });
    expect(search).toMatchObject({ count: 0 });
  });

  it("returns an error for unknown product names", async () => {
    await expect(
      tools.get("wellnessdb_log_meal")!({
        date: "2026-05-30",
        meal: "breakfast",
        item_type: "product",
        item: "nonexistent food",
      }),
    ).resolves.toEqual({ error: "Product not found: nonexistent food" });
  });

  it("updates recipe metadata and aliases without touching ingredient rows", async () => {
    const db = new DatabaseSync(dbPath);
    db.exec(`UPDATE products SET grams_per_serving = 100, fiber_g = 4 WHERE id = 1;
      UPDATE recipe_ingredients SET quantity_g = 50 WHERE recipe_id = 1;
      INSERT INTO recipes (id, name, yield_g, total_calories, total_protein_g, total_carbs_g, total_fat_g, total_fiber_g)
        VALUES (2, 'Component Sauce', 50, 100, 10, 8, 3, 2);
      INSERT INTO recipe_ingredients (recipe_id, ingredient_name, sub_recipe_id, quantity_g, calories, protein_g, carbs_g, fat_g, fiber_g)
        VALUES (1, 'Sauce', 2, 25, 50, 5, 4, 1.5, 1);`);
    db.close();

    await expect(tools.get("wellnessdb_update_recipe")!({ query: "chili" }))
      .resolves.toMatchObject({ error: expect.stringContaining("Nothing to update") });
    await expect(tools.get("wellnessdb_update_recipe")!({ query: "chili", ingredients: [] }))
      .resolves.toMatchObject({ error: expect.stringContaining("omit it to keep the current rows") });

    const updated = await tools.get("wellnessdb_update_recipe")!({
      query: "veggie chili",
      notes: "baseline\nsmoke marker",
      aliases: ["vc", " "],
    });
    expect(updated).toMatchObject({ id: 1, ingredients_replaced: false, recipe: { notes: "baseline\nsmoke marker" } });

    const detail = (await tools.get("wellnessdb_get_recipe_detail")!({ query: "vc" })) as {
      recipe: { total_calories: number };
      ingredients: Array<Record<string, unknown>>;
      aliases: string[];
    };
    expect(detail.ingredients).toHaveLength(2);
    expect(detail.ingredients).toEqual(expect.arrayContaining([
      expect.objectContaining({ product_id: 1, quantity_g: 50 }),
      expect.objectContaining({ sub_recipe_id: 2, quantity_g: 25 }),
    ]));
    expect(detail.aliases).toEqual(expect.arrayContaining(["veggie chili", "vc"]));
    // Totals were not recalculated (no ingredient change), so the seeded value stands.
    expect(detail.recipe.total_calories).toBe(800);
  });

  it("writes gram quantities and component rows when replacing ingredients", async () => {
    const db = new DatabaseSync(dbPath);
    db.exec(`UPDATE products SET grams_per_serving = 100, fiber_g = 4 WHERE id = 1;
      INSERT INTO recipes (id, name, shorthand, yield_g, total_calories, total_protein_g, total_carbs_g, total_fat_g, total_fiber_g)
        VALUES (2, 'Component Sauce', 'sauce', 50, 100, 10, 8, 3, 2);`);
    db.close();

    // Component rows need grams; products without grams fall back to the servings multiplier.
    await expect(tools.get("wellnessdb_update_recipe")!({
      query: "chili",
      ingredients: [{ sub_recipe: "sauce" }],
    })).resolves.toMatchObject({ error: expect.stringContaining("requires quantity_g") });

    const updated = await tools.get("wellnessdb_update_recipe")!({
      query: "chili",
      servings: 2,
      ingredients: [
        { product: "core power", quantity: "50 g" },
        { product: "core power", ingredient_name: "Extra bottle", servings: 2 },
        { sub_recipe: "sauce", quantity_g: 25 },
      ],
    });
    // 50 g of a 100 g/170 cal product = 85; two servings = 340; half the 100 cal sauce = 50.
    expect(updated).toMatchObject({
      id: 1,
      ingredients_replaced: true,
      recipe: { servings: 2, total_calories: 475, total_protein_g: 70, total_fiber_g: 11 },
    });
    const detail = (await tools.get("wellnessdb_get_recipe_detail")!({ query: "1" })) as {
      ingredients: Array<Record<string, unknown>>;
    };
    expect(detail.ingredients).toEqual([
      expect.objectContaining({ product_id: 1, quantity_g: 50, calories: 85, protein_g: 13, fiber_g: 2 }),
      expect.objectContaining({ product_id: 1, ingredient_name: "Extra bottle", quantity_g: null, calories: 340 }),
      expect.objectContaining({ sub_recipe_id: 2, quantity_g: 25, calories: 50, protein_g: 5, fiber_g: 1 }),
    ]);
  });

  it("creates component recipes with yield_g and rolls back on bad ingredients", async () => {
    const db = new DatabaseSync(dbPath);
    db.exec("UPDATE products SET grams_per_serving = 100, fiber_g = 4 WHERE id = 1;");
    db.close();

    await expect(tools.get("wellnessdb_add_recipe")!({
      name: "Broken",
      ingredients: [{ product: "no such product" }],
    })).resolves.toMatchObject({ error: "Ingredient product not found: no such product" });
    expect(await tools.get("wellnessdb_search_recipe")!({ query: "Broken" })).toMatchObject({ count: 0 });

    const created = (await tools.get("wellnessdb_add_recipe")!({
      name: "Crema",
      shorthand: "crema",
      yield_g: 200,
      ingredients: [{ product: "core power", quantity_g: 200 }],
    })) as { id: number; recipe: Record<string, unknown> };
    expect(created.recipe).toMatchObject({ yield_g: 200, total_calories: 340, per_100g_cal: 170, per_100g_fiber: 4 });

    const parent = await tools.get("wellnessdb_add_recipe")!({
      name: "Bowl",
      servings: 1,
      ingredients: [{ sub_recipe: "crema", quantity: "50 g" }],
    });
    expect(parent).toMatchObject({ recipe: { total_calories: 85, total_protein_g: 13, yield_g: null } });
  });
});
