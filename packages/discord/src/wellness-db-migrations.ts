/**
 * Wellness DB materialization + versioned migrations.
 *
 * The wellness schema (createWellnessDbSchema) was historically only applied
 * by hand, and openDb() throws when the file is absent — so on profiles where
 * the DB was never materialized, every wellnessdb_* tool fails. ensureWellnessDb()
 * closes that gap: it creates the file on first use and upgrades existing DBs
 * in place using PRAGMA user_version.
 *
 * Version history:
 *   1 — base schema (createWellnessDbSchema)
 *   2 — food tracker (docs/specs/food-tracker.md §3): fiber + FatSecret IDs +
 *       grams_per_serving on products, canonical gram quantities on recipe
 *       ingredients, product_listings / price_history / meal_plans /
 *       meal_plan_entries / fatsecret_entry_links, and cost-aware views.
 *   3 — product_listings.retailer accepts 'costco' and 'other' (table rebuild)
 *   4 — recipes.archived_at: retire recipes without deleting (products use
 *       discontinued_date for the same purpose)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { createWellnessDbSchema, resolveWellnessDbPath } from "./wellness-db-tools.js";

export const WELLNESS_DB_VERSION = 4;

export interface EnsureWellnessDbReport {
  path: string;
  created: boolean;
  fromVersion: number;
  toVersion: number;
}

function getUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return Number(row.user_version ?? 0);
}

function setUserVersion(db: DatabaseSync, version: number): void {
  db.exec(`PRAGMA user_version = ${version}`);
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?")
      .get(name) !== undefined
  );
}

function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function addColumnIfMissing(db: DatabaseSync, table: string, column: string, decl: string): void {
  if (!columnExists(db, table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}

function applyFoodTrackerMigration(db: DatabaseSync): void {
  // Existing tables. Column checks (not bare ALTERs) so a DB that predates
  // versioning but already carries some of these columns upgrades cleanly.
  addColumnIfMissing(db, "products", "fiber_g", "REAL");
  addColumnIfMissing(db, "products", "fatsecret_food_id", "TEXT");
  addColumnIfMissing(db, "products", "fatsecret_serving_id", "TEXT");
  addColumnIfMissing(db, "products", "grams_per_serving", "REAL");
  addColumnIfMissing(db, "recipes", "total_fiber_g", "REAL");
  // recalculateRecipeTotals writes recipes.updated_at, which the base schema
  // never created — every recipe write on a freshly materialized DB threw.
  addColumnIfMissing(db, "recipes", "updated_at", "TEXT");
  // yield_g: batch output in grams; set on component recipes (e.g. a sauce)
  // so other recipes can use them by the gram — per-gram macros/cost are
  // batch totals / yield_g.
  addColumnIfMissing(db, "recipes", "yield_g", "REAL");
  addColumnIfMissing(db, "recipe_ingredients", "quantity_g", "REAL");
  addColumnIfMissing(db, "recipe_ingredients", "fiber_g", "REAL");
  // sub_recipe_id: nested recipes — an ingredient row may reference another
  // recipe instead of a product. Rollups recurse in application code
  // (recalculateRecipeTotals and the UI), which must reject cycles at write
  // time; the SQL views treat sub-recipe rows like any other macro/cost row.
  addColumnIfMissing(db, "recipe_ingredients", "sub_recipe_id", "INTEGER REFERENCES recipes(id)");

  db.exec(`
    CREATE TABLE IF NOT EXISTS product_listings (
      id INTEGER PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id),
      retailer TEXT NOT NULL CHECK(retailer IN ('walmart','amazon')),
      retailer_item_id TEXT,
      url TEXT,
      package_description TEXT,
      package_grams REAL,
      servings_per_container REAL,
      active INTEGER NOT NULL DEFAULT 1,
      preferred INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS price_history (
      id INTEGER PRIMARY KEY,
      listing_id INTEGER NOT NULL REFERENCES product_listings(id),
      observed_at TEXT NOT NULL DEFAULT (datetime('now')),
      price REAL NOT NULL,
      unit_price TEXT,
      in_stock INTEGER,
      source TEXT NOT NULL DEFAULT 'manual'
    );
    CREATE INDEX IF NOT EXISTS idx_price_history_listing
      ON price_history(listing_id, observed_at);

    CREATE TABLE IF NOT EXISTS meal_plans (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      start_date TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS meal_plan_entries (
      id INTEGER PRIMARY KEY,
      plan_id INTEGER NOT NULL REFERENCES meal_plans(id),
      day_index INTEGER NOT NULL DEFAULT 0,
      meal TEXT NOT NULL CHECK(meal IN ('breakfast','lunch','snack','dinner')),
      recipe_id INTEGER REFERENCES recipes(id),
      product_id INTEGER REFERENCES products(id),
      -- total portions eaten at this meal (per-meal, not per-week: e.g.
      -- dinner ×2 while a school-day lunch is ×1)
      servings REAL NOT NULL DEFAULT 1.0,
      CHECK (recipe_id IS NOT NULL OR product_id IS NOT NULL)
    );

    CREATE TABLE IF NOT EXISTS fatsecret_entry_links (
      id INTEGER PRIMARY KEY,
      date TEXT NOT NULL,
      meal TEXT,
      recipe_id INTEGER REFERENCES recipes(id),
      food_entry_id TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_fatsecret_entry_links_date
      ON fatsecret_entry_links(date);
  `);

  createFoodTrackerViews(db);
}

/** Views. Dropped and recreated wholesale so any migration can rebuild them. */
function createFoodTrackerViews(db: DatabaseSync): void {
  db.exec(`
    DROP VIEW IF EXISTS product_current_price;
    CREATE VIEW product_current_price AS
    SELECT
      pl.product_id,
      pl.id AS listing_id,
      pl.retailer,
      pl.retailer_item_id,
      pl.package_description,
      pl.package_grams,
      pl.servings_per_container,
      ph.price,
      ph.observed_at,
      ph.in_stock,
      CASE WHEN pl.servings_per_container > 0
           THEN ph.price / pl.servings_per_container END AS price_per_serving,
      CASE WHEN pl.package_grams > 0
           THEN ph.price / pl.package_grams END AS price_per_gram
    FROM product_listings pl
    JOIN price_history ph ON ph.id = (
      SELECT ph2.id FROM price_history ph2
      WHERE ph2.listing_id = pl.id
      ORDER BY ph2.observed_at DESC, ph2.id DESC
      LIMIT 1
    )
    WHERE pl.active = 1;

    DROP VIEW IF EXISTS product_price;
    CREATE VIEW product_price AS
    SELECT pcp.* FROM product_current_price pcp
    WHERE pcp.listing_id = (
      SELECT pl.id FROM product_listings pl
      WHERE pl.product_id = pcp.product_id AND pl.active = 1
      ORDER BY pl.preferred DESC, (pl.retailer = 'walmart') DESC, pl.id
      LIMIT 1
    );

    DROP VIEW IF EXISTS recipe_cost;
    CREATE VIEW recipe_cost AS
    SELECT
      r.id AS recipe_id,
      SUM(ri.quantity_g * pp.price_per_gram) AS total_cost,
      CASE WHEN r.servings > 0
           THEN SUM(ri.quantity_g * pp.price_per_gram) / r.servings END AS cost_per_serving,
      SUM(CASE WHEN ri.quantity_g IS NULL OR pp.price_per_gram IS NULL
               THEN 1 ELSE 0 END) AS unpriced_ingredients
    FROM recipes r
    LEFT JOIN recipe_ingredients ri ON ri.recipe_id = r.id
    LEFT JOIN product_price pp ON pp.product_id = ri.product_id
    GROUP BY r.id;

    DROP VIEW IF EXISTS recipe_summary;
    CREATE VIEW recipe_summary AS
    SELECT
      r.id,
      r.name,
      r.shorthand,
      r.servings,
      r.total_calories,
      r.total_protein_g,
      r.total_carbs_g,
      r.total_fat_g,
      r.total_fiber_g,
      CASE WHEN r.servings > 0 THEN ROUND(r.total_calories * 1.0 / r.servings) ELSE r.total_calories END AS per_serving_cal,
      CASE WHEN r.servings > 0 THEN ROUND(r.total_protein_g / r.servings, 1) ELSE r.total_protein_g END AS per_serving_prot,
      CASE WHEN r.servings > 0 THEN ROUND(r.total_carbs_g / r.servings, 1) ELSE r.total_carbs_g END AS per_serving_carb,
      CASE WHEN r.servings > 0 THEN ROUND(r.total_fat_g / r.servings, 1) ELSE r.total_fat_g END AS per_serving_fat,
      CASE WHEN r.servings > 0 THEN ROUND(r.total_fiber_g / r.servings, 1) ELSE r.total_fiber_g END AS per_serving_fiber,
      ROUND(rc.cost_per_serving, 2) AS per_serving_cost,
      rc.unpriced_ingredients,
      r.instructions,
      r.notes
    FROM recipes r
    LEFT JOIN recipe_cost rc ON rc.recipe_id = r.id;

    DROP VIEW IF EXISTS plan_summary;
    CREATE VIEW plan_summary AS
    SELECT
      mp.id AS plan_id,
      mp.name,
      e.day_index,
      ROUND(SUM(e.servings)) AS servings,
      ROUND(SUM(e.servings * COALESCE(rs.per_serving_cal, p.calories, 0))) AS calories,
      ROUND(SUM(e.servings * COALESCE(rs.per_serving_prot, p.protein_g, 0)), 1) AS protein_g,
      ROUND(SUM(e.servings * COALESCE(rs.per_serving_fiber, p.fiber_g, 0)), 1) AS fiber_g,
      ROUND(SUM(e.servings * COALESCE(rs.per_serving_fat, p.fat_g, 0)), 1) AS fat_g,
      ROUND(SUM(e.servings * COALESCE(rs.per_serving_cost, pp.price_per_serving)), 2) AS cost_total
    FROM meal_plans mp
    JOIN meal_plan_entries e ON e.plan_id = mp.id
    LEFT JOIN recipe_summary rs ON rs.id = e.recipe_id
    LEFT JOIN products p ON p.id = e.product_id
    LEFT JOIN product_price pp ON pp.product_id = e.product_id
    GROUP BY mp.id, e.day_index;

    DROP VIEW IF EXISTS shopping_list;
    CREATE VIEW shopping_list AS
    WITH needs AS (
      SELECT e.plan_id, ri.product_id,
             (ri.quantity_g / NULLIF(r.servings, 0)) * e.servings AS grams
      FROM meal_plan_entries e
      JOIN recipes r ON r.id = e.recipe_id
      JOIN recipe_ingredients ri ON ri.recipe_id = r.id
      WHERE ri.product_id IS NOT NULL
      UNION ALL
      SELECT e.plan_id, e.product_id,
             p.grams_per_serving * e.servings AS grams
      FROM meal_plan_entries e
      JOIN products p ON p.id = e.product_id
      WHERE e.product_id IS NOT NULL
    ),
    totals AS (
      SELECT n.plan_id, n.product_id, SUM(n.grams) AS grams_needed
      FROM needs n
      GROUP BY n.plan_id, n.product_id
    )
    SELECT
      t.plan_id,
      t.product_id,
      pr.name AS product_name,
      ROUND(t.grams_needed, 1) AS grams_needed,
      pp.package_grams,
      CASE WHEN pp.package_grams > 0 THEN
        CAST(t.grams_needed / pp.package_grams AS INTEGER)
          + (t.grams_needed > CAST(t.grams_needed / pp.package_grams AS INTEGER) * pp.package_grams)
      END AS containers_to_buy,
      CASE WHEN pp.package_grams > 0 THEN
        ROUND((CAST(t.grams_needed / pp.package_grams AS INTEGER)
          + (t.grams_needed > CAST(t.grams_needed / pp.package_grams AS INTEGER) * pp.package_grams)) * pp.price, 2)
      END AS est_cost
    FROM totals t
    JOIN products pr ON pr.id = t.product_id
    LEFT JOIN product_price pp ON pp.product_id = t.product_id;
  `);
}

function applyRetailerMigration(db: DatabaseSync): void {
  // SQLite can't alter a CHECK constraint: rebuild product_listings with the
  // widened retailer set, preserving ids (price_history references them).
  // price_history's FK would fail the DROP while rows exist; ensureWellnessDb
  // disables foreign_keys around the migration transaction (SQLite's
  // documented rebuild procedure) and runs foreign_key_check before COMMIT.
  for (const view of ['shopping_list', 'plan_summary', 'recipe_summary', 'recipe_cost', 'product_price', 'product_current_price']) {
    db.exec(`DROP VIEW IF EXISTS ${view}`);
  }
  db.exec(`
    CREATE TABLE product_listings_v3 (
      id INTEGER PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id),
      retailer TEXT NOT NULL CHECK(retailer IN ('walmart','amazon','costco','other')),
      retailer_item_id TEXT,
      url TEXT,
      package_description TEXT,
      package_grams REAL,
      servings_per_container REAL,
      active INTEGER NOT NULL DEFAULT 1,
      preferred INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
    INSERT INTO product_listings_v3 SELECT id, product_id, retailer, retailer_item_id, url, package_description,
      package_grams, servings_per_container, active, preferred, created_at FROM product_listings;
    DROP TABLE product_listings;
    ALTER TABLE product_listings_v3 RENAME TO product_listings;
  `);
  createFoodTrackerViews(db);
}

/**
 * Materialize the wellness DB if absent and bring it to WELLNESS_DB_VERSION.
 * Safe to call from multiple processes (bot startup, food-ui server, scripts):
 * WAL + busy_timeout + a version check inside the write transaction make the
 * upgrade race-free and idempotent.
 */
export function ensureWellnessDb(dbPathOverride?: string): EnsureWellnessDbReport {
  const dbPath = resolveWellnessDbPath(dbPathOverride);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const existed = fs.existsSync(dbPath);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    // Table rebuilds (v3) need FKs off; the pragma is a no-op inside a
    // transaction, so it has to be set here. foreign_key_check runs before
    // COMMIT so a bad rebuild can never land.
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN IMMEDIATE");
    try {
      let version = getUserVersion(db);
      if (!tableExists(db, "products")) {
        createWellnessDbSchema(db);
        version = 1;
      } else if (version === 0) {
        // A hand-applied schema that predates versioning.
        version = 1;
      }
      const fromVersion = existed ? getUserVersion(db) : 0;
      if (version < 2) {
        applyFoodTrackerMigration(db);
        version = 2;
      }
      if (version < 3) {
        applyRetailerMigration(db);
        version = 3;
      }
      if (version < 4) {
        addColumnIfMissing(db, "recipes", "archived_at", "TEXT");
        version = 4;
      }
      setUserVersion(db, version);
      const violations = db.prepare("PRAGMA foreign_key_check").all();
      if (violations.length > 0) {
        throw new Error(`wellness.db migration left ${violations.length} foreign key violation(s)`);
      }
      db.exec("COMMIT");
      return { path: dbPath, created: !existed, fromVersion, toVersion: version };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
    db.close();
  }
}
