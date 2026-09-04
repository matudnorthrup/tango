import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  WELLNESS_DB_VERSION,
  ensureWellnessDb,
} from "../src/wellness-db-migrations.js";
import { createWellnessDbSchema } from "../src/wellness-db-tools.js";

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wellness-mig-"));
  tempDirs.push(dir);
  return path.join(dir, "nested", "wellness.db");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function tableNames(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')")
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

describe("ensureWellnessDb", () => {
  it("materializes a fresh DB at the current version, creating directories", () => {
    const dbPath = tempDbPath();
    const report = ensureWellnessDb(dbPath);
    expect(report.created).toBe(true);
    expect(report.fromVersion).toBe(0);
    expect(report.toVersion).toBe(WELLNESS_DB_VERSION);

    const db = new DatabaseSync(dbPath);
    const names = tableNames(db);
    for (const expected of [
      "products",
      "recipes",
      "meal_log",
      "product_listings",
      "price_history",
      "meal_plans",
      "meal_plan_entries",
      "fatsecret_entry_links",
      "product_current_price",
      "product_price",
      "recipe_cost",
      "recipe_summary",
      "plan_summary",
      "shopping_list",
    ]) {
      expect(names).toContain(expected);
    }
    const version = db.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(version.user_version).toBe(WELLNESS_DB_VERSION);
    db.close();
  });

  it("upgrades a legacy v1 DB in place, preserving data", () => {
    const dbPath = tempDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const legacy = new DatabaseSync(dbPath);
    createWellnessDbSchema(legacy);
    legacy
      .prepare("INSERT INTO products (id, name, calories, protein_g) VALUES (1, 'Black Beans', 110, 7)")
      .run();
    legacy.close();

    const report = ensureWellnessDb(dbPath);
    expect(report.created).toBe(false);
    expect(report.toVersion).toBe(WELLNESS_DB_VERSION);

    const db = new DatabaseSync(dbPath);
    const row = db
      .prepare("SELECT name, calories, fiber_g, fatsecret_food_id FROM products WHERE id = 1")
      .get() as { name: string; calories: number; fiber_g: number | null };
    expect(row.name).toBe("Black Beans");
    expect(row.calories).toBe(110);
    expect(row.fiber_g).toBeNull();
    db.close();
  });

  it("is idempotent", () => {
    const dbPath = tempDbPath();
    ensureWellnessDb(dbPath);
    const second = ensureWellnessDb(dbPath);
    expect(second.created).toBe(false);
    expect(second.fromVersion).toBe(WELLNESS_DB_VERSION);
    expect(second.toVersion).toBe(WELLNESS_DB_VERSION);
  });

  it("computes price-per-serving, recipe cost, plan cost, and shopping list", () => {
    const dbPath = tempDbPath();
    ensureWellnessDb(dbPath);
    const db = new DatabaseSync(dbPath);

    // Black beans: $1.12/can, 3.5 servings of 130g each (455g net).
    db.prepare(
      `INSERT INTO products (id, name, calories, protein_g, carbs_g, fat_g, fiber_g, grams_per_serving)
       VALUES (1, 'Black Beans', 110, 7, 20, 0.5, 7, 130)`,
    ).run();
    db.prepare(
      `INSERT INTO product_listings (id, product_id, retailer, retailer_item_id, package_grams, servings_per_container, preferred)
       VALUES (10, 1, 'walmart', '10315394', 455, 3.5, 1)`,
    ).run();
    db.prepare(
      "INSERT INTO price_history (listing_id, price, observed_at) VALUES (10, 2.00, '2026-08-01T00:00:00')",
    ).run();
    db.prepare(
      "INSERT INTO price_history (listing_id, price, observed_at) VALUES (10, 1.12, '2026-09-01T00:00:00')",
    ).run();

    const price = db
      .prepare("SELECT price, price_per_serving, price_per_gram FROM product_price WHERE product_id = 1")
      .get() as { price: number; price_per_serving: number; price_per_gram: number };
    expect(price.price).toBe(1.12); // latest observation wins
    expect(price.price_per_serving).toBeCloseTo(0.32, 2);
    expect(price.price_per_gram).toBeCloseTo(1.12 / 455, 5);

    // Tacos: 4 servings, 260g of beans total.
    db.prepare("INSERT INTO recipes (id, name, servings, total_calories, total_fiber_g) VALUES (1, 'Tacos', 4, 880, 14)").run();
    db.prepare(
      `INSERT INTO recipe_ingredients (recipe_id, product_id, ingredient_name, quantity, quantity_g, calories, protein_g, fiber_g)
       VALUES (1, 1, 'Black Beans', '2 cups', 260, 220, 14, 14)`,
    ).run();

    const recipe = db
      .prepare("SELECT per_serving_cost, per_serving_fiber, unpriced_ingredients FROM recipe_summary WHERE id = 1")
      .get() as { per_serving_cost: number; per_serving_fiber: number; unpriced_ingredients: number };
    // 260g × ($1.12 / 455g) = $0.64 total → $0.16/serving
    expect(recipe.per_serving_cost).toBeCloseTo(0.16, 2);
    expect(recipe.per_serving_fiber).toBeCloseTo(3.5, 1);
    expect(recipe.unpriced_ingredients).toBe(0);

    // Plan: taco dinner, 4 total portions on day 0 (servings are per-meal).
    db.prepare("INSERT INTO meal_plans (id, name) VALUES (1, 'Test Week')").run();
    db.prepare(
      "INSERT INTO meal_plan_entries (plan_id, day_index, meal, recipe_id, servings) VALUES (1, 0, 'dinner', 1, 4)",
    ).run();

    const plan = db
      .prepare("SELECT servings, calories, cost_total FROM plan_summary WHERE plan_id = 1 AND day_index = 0")
      .get() as { servings: number; calories: number; cost_total: number };
    expect(plan.servings).toBe(4);
    expect(plan.calories).toBe(880); // 4 portions × 220 cal/serving
    expect(plan.cost_total).toBeCloseTo(0.64, 2);

    // Shopping list: 4 portions × 65g/recipe-serving = 260g → 1 can.
    const list = db
      .prepare("SELECT grams_needed, containers_to_buy, est_cost FROM shopping_list WHERE plan_id = 1 AND product_id = 1")
      .get() as { grams_needed: number; containers_to_buy: number; est_cost: number };
    expect(list.grams_needed).toBeCloseTo(260, 1);
    expect(list.containers_to_buy).toBe(1);
    expect(list.est_cost).toBeCloseTo(1.12, 2);
    db.close();
  });

  it("v3 accepts costco listings and preserves listing ids through the rebuild", () => {
    const dbPath = tempDbPath();
    ensureWellnessDb(dbPath);
    const db = new DatabaseSync(dbPath);
    db.prepare("INSERT INTO products (id, name) VALUES (1, 'Olive Oil')").run();
    db.prepare("INSERT INTO product_listings (id, product_id, retailer, retailer_item_id) VALUES (7, 1, 'costco', 'kirkland-evoo')").run();
    db.prepare("INSERT INTO price_history (listing_id, price) VALUES (7, 24.99)").run();
    const row = db.prepare("SELECT retailer, price FROM product_price WHERE product_id = 1").get() as { retailer: string; price: number };
    expect(row.retailer).toBe("costco");
    expect(row.price).toBe(24.99);
    expect(() => db.prepare("INSERT INTO product_listings (product_id, retailer) VALUES (1, 'target')").run()).toThrow();
    db.close();
  });

  it("v2 → v3 rebuild succeeds with populated listings and price history", () => {
    const dbPath = tempDbPath();
    ensureWellnessDb(dbPath);
    const db = new DatabaseSync(dbPath);
    db.prepare("INSERT INTO products (id, name) VALUES (1, 'Black Beans')").run();
    db.prepare("INSERT INTO product_listings (id, product_id, retailer, retailer_item_id) VALUES (3, 1, 'walmart', '10534038')").run();
    db.prepare("INSERT INTO price_history (listing_id, price) VALUES (3, 0.92)").run();
    db.exec("PRAGMA user_version = 2"); // pretend we're pre-v3 with real data
    db.close();

    const report = ensureWellnessDb(dbPath);
    expect(report.fromVersion).toBe(2);
    expect(report.toVersion).toBe(WELLNESS_DB_VERSION);
    const check = new DatabaseSync(dbPath);
    const row = check.prepare("SELECT price FROM product_price WHERE product_id = 1").get() as { price: number };
    expect(row.price).toBe(0.92);
    check.close();
  });

  it("rolls a component recipe's cost into the parent by grams used", () => {
    const dbPath = tempDbPath();
    ensureWellnessDb(dbPath);
    const db = new DatabaseSync(dbPath);
    // yogurt: $3.00 per 900g → $0.003333/g
    db.prepare("INSERT INTO products (id, name, grams_per_serving) VALUES (1, 'Yogurt', 150)").run();
    db.prepare("INSERT INTO product_listings (id, product_id, retailer, package_grams, servings_per_container, preferred) VALUES (1, 1, 'walmart', 900, 6, 1)").run();
    db.prepare("INSERT INTO price_history (listing_id, price) VALUES (1, 3.00)").run();
    // crema: 35g yogurt → 50g batch = $0.1167/batch → $0.002333/g
    db.prepare("INSERT INTO recipes (id, name, servings, yield_g) VALUES (10, 'Crema', 1, 50)").run();
    db.prepare("INSERT INTO recipe_ingredients (recipe_id, product_id, ingredient_name, quantity_g) VALUES (10, 1, 'Yogurt', 35)").run();
    // salad: 100g yogurt directly + 50g of crema, 2 servings
    db.prepare("INSERT INTO recipes (id, name, servings) VALUES (20, 'Salad', 2)").run();
    db.prepare("INSERT INTO recipe_ingredients (recipe_id, product_id, ingredient_name, quantity_g) VALUES (20, 1, 'Yogurt', 100)").run();
    db.prepare("INSERT INTO recipe_ingredients (recipe_id, sub_recipe_id, ingredient_name, quantity_g) VALUES (20, 10, 'Crema', 50)").run();
    const row = db.prepare("SELECT total_cost, cost_per_serving, unpriced_ingredients FROM recipe_cost WHERE recipe_id = 20").get() as { total_cost: number; cost_per_serving: number; unpriced_ingredients: number };
    // 100g × 0.003333 = 0.3333 ; crema 50g × (0.1167/50) = 0.1167 → 0.45 total, 0.225/srv
    expect(row.total_cost).toBeCloseTo(0.45, 3);
    expect(row.cost_per_serving).toBeCloseTo(0.225, 3);
    expect(row.unpriced_ingredients).toBe(0);
    // a component with no yield counts as unpriced rather than silently $0
    db.prepare("UPDATE recipes SET yield_g = NULL WHERE id = 10").run();
    const noYield = db.prepare("SELECT unpriced_ingredients FROM recipe_cost WHERE recipe_id = 20").get() as { unpriced_ingredients: number };
    expect(noYield.unpriced_ingredients).toBe(1);
    db.close();
  });

  it("recipe writes touch updated_at without error on a fresh DB", () => {
    // recalculateRecipeTotals writes recipes.updated_at, which the base v1
    // schema never created; v2 adds it. Guard against regression.
    const dbPath = tempDbPath();
    ensureWellnessDb(dbPath);
    const db = new DatabaseSync(dbPath);
    const cols = db.prepare("PRAGMA table_info(recipes)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("updated_at");
    expect(cols.map((c) => c.name)).toContain("total_fiber_g");
    expect(cols.map((c) => c.name)).toContain("yield_g");
    expect(cols.map((c) => c.name)).toContain("archived_at");
    const ricols = db.prepare("PRAGMA table_info(recipe_ingredients)").all() as Array<{ name: string }>;
    expect(ricols.map((c) => c.name)).toContain("sub_recipe_id");
    db.close();
  });
});
