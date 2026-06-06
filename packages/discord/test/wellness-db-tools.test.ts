import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createWellnessDbSchema,
  createWellnessDbTools,
  wellnessDbToolLooksReadOnly,
} from "../src/wellness-db-tools.js";

const tempFiles: string[] = [];

function makeToolMap(dbPath: string): Map<string, (input: Record<string, unknown>) => Promise<unknown>> {
  const tools = createWellnessDbTools({ dbPath });
  return new Map(tools.map((tool) => [tool.name, tool.handler]));
}

function seedTestDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  createWellnessDbSchema(db);
  db.prepare(
    `INSERT INTO products (id, name, shorthand, calories, protein_g, carbs_g, fat_g)
     VALUES (1, 'Core Power Chocolate', 'core power', 170, 26, 8, 3),
            (2, 'Discontinued Bar', 'old bar', 100, 5, 10, 2)`,
  ).run();
  db.prepare("UPDATE products SET discontinued_date = '2026-01-01' WHERE id = 2").run();

  db.prepare(
    `INSERT INTO supplements (id, name, shorthand, calories, protein_g, carbs_g, fat_g)
     VALUES (11, 'Testosterone Cream', 'testosterone', 0, 0, 0, 0),
            (26, 'Estradiol Patch', 'patch', 0, 0, 0, 0),
            (27, 'Estradiol Vaginal Pill', 'pill', 0, 0, 0, 0),
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

  it("logs HRT as three supplement rows", async () => {
    const result = await tools.get("wellnessdb_log_supplement")!({
      date: "2026-05-30",
      supplements: "HRT",
    });
    expect(result).toMatchObject({
      logged: [
        expect.objectContaining({ supplement: "Estradiol Patch" }),
        expect.objectContaining({ supplement: "Estradiol Vaginal Pill" }),
        expect.objectContaining({ supplement: "Testosterone Cream" }),
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
});
