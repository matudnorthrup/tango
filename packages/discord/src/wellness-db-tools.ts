/**
 * Jules Wellness DB Tools — structured MCP access to Darla's wellness.db.
 *
 * Workers call these tools instead of raw SQL. Database path comes from
 * JULES_WELLNESS_DB_PATH (falls back to the default profile wellness db).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveConfiguredPath, resolveTangoProfileDir, type AgentTool } from "@tango/core";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MEALS = new Set(["breakfast", "lunch", "dinner", "snack", "supplement"]);
const ACTIVITY_TYPES = new Set([
  "walk",
  "weights",
  "yoga",
  "stretching",
  "rebounder",
  "meditation",
  "journaling",
  "other",
]);
const HRT_BATCH_SHORTHANDS = ["patch", "pill", "testosterone"];
const READ_ONLY_WELLNESSDB_TOOLS = new Set([
  "wellnessdb_search_product",
  "wellnessdb_search_supplement",
  "wellnessdb_search_recipe",
  "wellnessdb_get_recipe_detail",
  "wellnessdb_day_summary",
  "wellnessdb_day_range",
  "wellnessdb_recent_meals",
  "wellnessdb_active_supplements",
  "wellnessdb_active_products",
]);

export interface WellnessDbToolOptions {
  dbPath?: string;
}

interface ProductRow {
  id: number;
  name: string;
  shorthand: string | null;
  brand: string | null;
  category: string | null;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  serving_size: string | null;
  serving_unit: string | null;
  discontinued_date: string | null;
}

interface SupplementRow {
  id: number;
  name: string;
  shorthand: string | null;
  brand: string | null;
  dosage: string | null;
  timing: string | null;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  stopped_date: string | null;
}

interface RecipeSummaryRow {
  id: number;
  name: string;
  shorthand: string | null;
  servings: number | null;
  per_serving_cal: number | null;
  per_serving_prot: number | null;
  per_serving_carb: number | null;
  per_serving_fat: number | null;
  total_calories: number | null;
  total_protein_g: number | null;
  total_carbs_g: number | null;
  total_fat_g: number | null;
  instructions: string | null;
  notes: string | null;
}

function defaultWellnessDbPath(): string {
  return path.join(resolveTangoProfileDir(), "wellness", "wellness.db");
}

export function resolveWellnessDbPath(override?: string): string {
  const configured = override?.trim() || process.env.JULES_WELLNESS_DB_PATH?.trim();
  if (configured) {
    return resolveConfiguredPath(configured);
  }
  return defaultWellnessDbPath();
}

function assertDate(date: string, field = "date"): string {
  const normalized = String(date).trim();
  if (!DATE_RE.test(normalized)) {
    throw new Error(`${field} must be YYYY-MM-DD`);
  }
  return normalized;
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function openDb(dbPath: string, readOnly: boolean): DatabaseSync {
  const resolved = path.resolve(dbPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Wellness database not found: ${resolved.replace(os.homedir(), "~")}`);
  }
  return new DatabaseSync(resolved, { readOnly });
}

function normalizeSearchTerm(value: string): string {
  return value.trim().toLowerCase();
}

function shorthandMatchSql(column: string): string {
  return `(',' || TRIM(REPLACE(${column}, ', ', ',')) || ',') LIKE ? COLLATE NOCASE`;
}

function shorthandLikePattern(term: string): string {
  return `%,${term},%`;
}

function queryAll<T>(db: DatabaseSync, sql: string, params: Array<string | number | null> = []): T[] {
  return db.prepare(sql).all(...params) as T[];
}

function queryOne<T>(db: DatabaseSync, sql: string, params: Array<string | number | null> = []): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

function findProduct(db: DatabaseSync, query: string, activeOnly = false): ProductRow | undefined {
  const term = normalizeSearchTerm(query);
  const activeClause = activeOnly ? " AND discontinued_date IS NULL" : "";
  const byShorthand = queryOne<ProductRow>(
    db,
    `SELECT id, name, shorthand, brand, category, calories, protein_g, carbs_g, fat_g,
            serving_size, serving_unit, discontinued_date
     FROM products
     WHERE ${shorthandMatchSql("shorthand")}${activeClause}
     LIMIT 1`,
    [shorthandLikePattern(term)],
  );
  if (byShorthand) return byShorthand;

  return queryOne<ProductRow>(
    db,
    `SELECT id, name, shorthand, brand, category, calories, protein_g, carbs_g, fat_g,
            serving_size, serving_unit, discontinued_date
     FROM products
     WHERE lower(name) LIKE ?${activeClause}
     LIMIT 1`,
    [`%${term}%`],
  );
}

function searchProducts(db: DatabaseSync, query: string, activeOnly = false): ProductRow[] {
  const term = normalizeSearchTerm(query);
  const activeClause = activeOnly ? " AND discontinued_date IS NULL" : "";
  return queryAll<ProductRow>(
    db,
    `SELECT id, name, shorthand, brand, category, calories, protein_g, carbs_g, fat_g,
            serving_size, serving_unit, discontinued_date
     FROM products
     WHERE (${shorthandMatchSql("shorthand")} OR lower(name) LIKE ?)${activeClause}
     ORDER BY name
     LIMIT 25`,
    [shorthandLikePattern(term), `%${term}%`],
  );
}

function findSupplement(db: DatabaseSync, query: string, activeOnly = false): SupplementRow | undefined {
  const term = normalizeSearchTerm(query);
  const activeClause = activeOnly ? " AND stopped_date IS NULL" : "";
  const byShorthand = queryOne<SupplementRow>(
    db,
    `SELECT id, name, shorthand, brand, dosage, timing, calories, protein_g, carbs_g, fat_g, stopped_date
     FROM supplements
     WHERE ${shorthandMatchSql("shorthand")}${activeClause}
     LIMIT 1`,
    [shorthandLikePattern(term)],
  );
  if (byShorthand) return byShorthand;

  return queryOne<SupplementRow>(
    db,
    `SELECT id, name, shorthand, brand, dosage, timing, calories, protein_g, carbs_g, fat_g, stopped_date
     FROM supplements
     WHERE lower(name) LIKE ?${activeClause}
     LIMIT 1`,
    [`%${term}%`],
  );
}

function searchSupplements(db: DatabaseSync, query: string, activeOnly = false): SupplementRow[] {
  const term = normalizeSearchTerm(query);
  const activeClause = activeOnly ? " AND stopped_date IS NULL" : "";
  return queryAll<SupplementRow>(
    db,
    `SELECT id, name, shorthand, brand, dosage, timing, calories, protein_g, carbs_g, fat_g, stopped_date
     FROM supplements
     WHERE (${shorthandMatchSql("shorthand")} OR lower(name) LIKE ?)${activeClause}
     ORDER BY name
     LIMIT 25`,
    [shorthandLikePattern(term), `%${term}%`],
  );
}

function findRecipeSummary(db: DatabaseSync, query: string): RecipeSummaryRow | undefined {
  const term = normalizeSearchTerm(query);
  const byShorthand = queryOne<RecipeSummaryRow>(
    db,
    `SELECT id, name, shorthand, servings, per_serving_cal, per_serving_prot, per_serving_carb, per_serving_fat,
            total_calories, total_protein_g, total_carbs_g, total_fat_g, instructions, notes
     FROM recipe_summary
     WHERE lower(shorthand) = ?
     LIMIT 1`,
    [term],
  );
  if (byShorthand) return byShorthand;

  const alias = queryOne<{ recipe_id: number }>(
    db,
    "SELECT recipe_id FROM recipe_aliases WHERE lower(alias) = ? LIMIT 1",
    [term],
  );
  if (alias) {
    return queryOne<RecipeSummaryRow>(
      db,
      `SELECT id, name, shorthand, servings, per_serving_cal, per_serving_prot, per_serving_carb, per_serving_fat,
              total_calories, total_protein_g, total_carbs_g, total_fat_g, instructions, notes
       FROM recipe_summary
       WHERE id = ?
       LIMIT 1`,
      [alias.recipe_id],
    );
  }

  return queryOne<RecipeSummaryRow>(
    db,
    `SELECT id, name, shorthand, servings, per_serving_cal, per_serving_prot, per_serving_carb, per_serving_fat,
            total_calories, total_protein_g, total_carbs_g, total_fat_g, instructions, notes
     FROM recipe_summary
     WHERE lower(name) LIKE ?
     LIMIT 1`,
    [`%${term}%`],
  );
}

function searchRecipes(db: DatabaseSync, query: string): RecipeSummaryRow[] {
  const term = normalizeSearchTerm(query);
  return queryAll<RecipeSummaryRow>(
    db,
    `SELECT DISTINCT rs.id, rs.name, rs.shorthand, rs.servings, rs.per_serving_cal, rs.per_serving_prot,
            rs.per_serving_carb, rs.per_serving_fat, rs.total_calories, rs.total_protein_g, rs.total_carbs_g,
            rs.total_fat_g, rs.instructions, rs.notes
     FROM recipe_summary rs
     LEFT JOIN recipe_aliases ra ON ra.recipe_id = rs.id
     WHERE lower(rs.shorthand) LIKE ?
        OR lower(rs.name) LIKE ?
        OR lower(ra.alias) LIKE ?
     ORDER BY rs.name
     LIMIT 25`,
    [`%${term}%`, `%${term}%`, `%${term}%`],
  );
}

function expandSupplementQueries(input: string | string[]): string[] {
  const rawItems = Array.isArray(input)
    ? input.flatMap((value) => String(value).split(","))
    : String(input).split(",");
  const expanded: string[] = [];
  for (const item of rawItems) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (trimmed.toUpperCase() === "HRT") {
      expanded.push(...HRT_BATCH_SHORTHANDS);
      continue;
    }
    expanded.push(trimmed);
  }
  return expanded;
}

function scaleMacro(value: number | null | undefined, servings: number): number {
  return Number(((value ?? 0) * servings).toFixed(1));
}

function scaleIntMacro(value: number | null | undefined, servings: number): number {
  return Math.round((value ?? 0) * servings);
}

function recalculateRecipeTotals(db: DatabaseSync, recipeId: number): void {
  const totals = queryOne<{
    calories: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
  }>(
    db,
    `SELECT
       COALESCE(SUM(calories), 0) AS calories,
       COALESCE(SUM(protein_g), 0) AS protein_g,
       COALESCE(SUM(carbs_g), 0) AS carbs_g,
       COALESCE(SUM(fat_g), 0) AS fat_g
     FROM recipe_ingredients
     WHERE recipe_id = ?`,
    [recipeId],
  );
  db.prepare(
    `UPDATE recipes
     SET total_calories = ?, total_protein_g = ?, total_carbs_g = ?, total_fat_g = ?,
         updated_at = datetime('now')
     WHERE id = ?`,
  ).run(
    Math.round(totals?.calories ?? 0),
    totals?.protein_g ?? 0,
    totals?.carbs_g ?? 0,
    totals?.fat_g ?? 0,
    recipeId,
  );
}

export function createWellnessDbSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE products (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      shorthand TEXT,
      brand TEXT,
      category TEXT,
      serving_size TEXT,
      calories INTEGER,
      protein_g REAL,
      carbs_g REAL,
      fat_g REAL,
      notes TEXT,
      source TEXT,
      verified_date TEXT,
      serving_unit TEXT DEFAULT 'per_item',
      started_date TEXT,
      discontinued_date TEXT,
      discontinued_reason TEXT
    );

    CREATE TABLE supplements (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      brand TEXT,
      dosage TEXT,
      timing TEXT,
      calories INTEGER DEFAULT 0,
      protein_g REAL DEFAULT 0,
      carbs_g REAL DEFAULT 0,
      fat_g REAL DEFAULT 0,
      notes TEXT,
      source TEXT,
      verified_date TEXT,
      shorthand TEXT,
      started_date TEXT,
      stopped_date TEXT,
      stop_reason TEXT
    );

    CREATE TABLE recipes (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      instructions TEXT,
      total_calories INTEGER,
      total_protein_g REAL,
      total_carbs_g REAL,
      total_fat_g REAL,
      notes TEXT,
      shorthand TEXT,
      servings REAL DEFAULT 1.0
    );

    CREATE TABLE recipe_ingredients (
      id INTEGER PRIMARY KEY,
      recipe_id INTEGER NOT NULL REFERENCES recipes(id),
      product_id INTEGER REFERENCES products(id),
      ingredient_name TEXT NOT NULL,
      quantity TEXT,
      calories INTEGER,
      protein_g REAL,
      carbs_g REAL,
      fat_g REAL
    );

    CREATE TABLE recipe_aliases (
      recipe_id INTEGER NOT NULL REFERENCES recipes(id),
      alias TEXT NOT NULL COLLATE NOCASE,
      PRIMARY KEY (recipe_id, alias)
    );

    CREATE TABLE meal_log (
      id INTEGER PRIMARY KEY,
      date TEXT NOT NULL,
      meal TEXT NOT NULL CHECK(meal IN ('breakfast','lunch','snack','dinner','supplement')),
      product_id INTEGER REFERENCES products(id),
      recipe_id INTEGER REFERENCES recipes(id),
      supplement_id INTEGER REFERENCES supplements(id),
      description TEXT,
      servings REAL DEFAULT 1.0,
      calories INTEGER,
      protein_g REAL,
      carbs_g REAL,
      fat_g REAL,
      notes TEXT,
      meal_time TEXT,
      logged_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE day_notes (
      date TEXT PRIMARY KEY,
      note TEXT NOT NULL
    );

    CREATE TABLE weight_log (
      id INTEGER PRIMARY KEY,
      date TEXT NOT NULL,
      weight_lbs REAL NOT NULL,
      notes TEXT,
      logged_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE activity_log (
      id INTEGER PRIMARY KEY,
      date TEXT NOT NULL,
      activity_type TEXT NOT NULL,
      duration_min INTEGER,
      distance_miles REAL,
      notes TEXT,
      logged_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE hydration_log (
      id INTEGER PRIMARY KEY,
      date TEXT NOT NULL,
      oz REAL,
      notes TEXT,
      logged_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE presence_checks (
      id INTEGER PRIMARY KEY,
      date TEXT NOT NULL,
      mental TEXT,
      physical TEXT,
      emotional TEXT,
      energetic TEXT,
      spiritual TEXT,
      care_action TEXT,
      notes TEXT,
      logged_at TEXT DEFAULT (datetime('now'))
    );

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
      CASE WHEN r.servings > 0 THEN ROUND(r.total_calories * 1.0 / r.servings) ELSE r.total_calories END AS per_serving_cal,
      CASE WHEN r.servings > 0 THEN ROUND(r.total_protein_g / r.servings, 1) ELSE r.total_protein_g END AS per_serving_prot,
      CASE WHEN r.servings > 0 THEN ROUND(r.total_carbs_g / r.servings, 1) ELSE r.total_carbs_g END AS per_serving_carb,
      CASE WHEN r.servings > 0 THEN ROUND(r.total_fat_g / r.servings, 1) ELSE r.total_fat_g END AS per_serving_fat,
      r.instructions,
      r.notes
    FROM recipes r;

    CREATE VIEW daily_wellness AS
    SELECT
      d.date,
      SUM(CASE WHEN m.meal != 'supplement' THEN m.calories ELSE 0 END) AS total_cal,
      SUM(CASE WHEN m.meal != 'supplement' THEN m.protein_g ELSE 0 END) AS total_protein,
      SUM(CASE WHEN m.meal = 'supplement' THEN 1 ELSE 0 END) AS supplements_taken,
      COUNT(CASE WHEN m.meal = 'breakfast' THEN 1 END) AS had_breakfast,
      w.weight_lbs,
      a.total_duration_min,
      a.total_distance_miles,
      h.total_oz,
      CASE WHEN p.id IS NOT NULL THEN 1 ELSE 0 END AS did_presence_check
    FROM (
      SELECT DISTINCT date FROM meal_log
      UNION SELECT DISTINCT date FROM weight_log
      UNION SELECT DISTINCT date FROM activity_log
      UNION SELECT DISTINCT date FROM hydration_log
      UNION SELECT DISTINCT date FROM presence_checks
    ) d
    LEFT JOIN meal_log m ON m.date = d.date
    LEFT JOIN (
      SELECT date, weight_lbs FROM weight_log GROUP BY date HAVING max(logged_at)
    ) w ON w.date = d.date
    LEFT JOIN (
      SELECT date, SUM(duration_min) AS total_duration_min, SUM(distance_miles) AS total_distance_miles
      FROM activity_log GROUP BY date
    ) a ON a.date = d.date
    LEFT JOIN (
      SELECT date, SUM(oz) AS total_oz FROM hydration_log GROUP BY date
    ) h ON h.date = d.date
    LEFT JOIN (
      SELECT date, id FROM presence_checks GROUP BY date HAVING max(logged_at)
    ) p ON p.date = d.date
    GROUP BY d.date;
  `);
}

export function wellnessDbToolLooksReadOnly(name: string): boolean {
  return READ_ONLY_WELLNESSDB_TOOLS.has(name);
}

export function createWellnessDbTools(options?: WellnessDbToolOptions): AgentTool[] {
  const dbPath = resolveWellnessDbPath(options?.dbPath);

  return [
    {
      name: "wellnessdb_search_product",
      description: "Search products in wellness.db by name or shorthand. Returns matching products with macros.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Product name or shorthand to search for" },
          active_only: { type: "boolean", description: "If true, exclude discontinued products" },
        },
        required: ["query"],
      },
      handler: async (input) => {
        const query = String(input.query ?? "").trim();
        if (!query) return { error: "query is required" };
        const db = openDb(dbPath, true);
        const products = searchProducts(db, query, Boolean(input.active_only));
        return { query, count: products.length, products };
      },
    },
    {
      name: "wellnessdb_search_supplement",
      description: "Search supplements in wellness.db by name or shorthand. Returns dosage and timing.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Supplement name or shorthand to search for" },
          active_only: { type: "boolean", description: "If true, exclude stopped supplements" },
        },
        required: ["query"],
      },
      handler: async (input) => {
        const query = String(input.query ?? "").trim();
        if (!query) return { error: "query is required" };
        const db = openDb(dbPath, true);
        const supplements = searchSupplements(db, query, Boolean(input.active_only));
        return { query, count: supplements.length, supplements };
      },
    },
    {
      name: "wellnessdb_search_recipe",
      description: "Search recipes by name, shorthand, or alias. Returns per-serving macros.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Recipe name, shorthand, or alias" },
        },
        required: ["query"],
      },
      handler: async (input) => {
        const query = String(input.query ?? "").trim();
        if (!query) return { error: "query is required" };
        const db = openDb(dbPath, true);
        const recipes = searchRecipes(db, query);
        return { query, count: recipes.length, recipes };
      },
    },
    {
      name: "wellnessdb_get_recipe_detail",
      description: "Get a recipe with full ingredient list and per-ingredient macros.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Recipe name, shorthand, alias, or numeric id" },
        },
        required: ["query"],
      },
      handler: async (input) => {
        const query = String(input.query ?? "").trim();
        if (!query) return { error: "query is required" };
        const db = openDb(dbPath, true);
        const recipe = /^\d+$/.test(query)
          ? queryOne<RecipeSummaryRow>(
            db,
            `SELECT id, name, shorthand, servings, per_serving_cal, per_serving_prot, per_serving_carb, per_serving_fat,
                    total_calories, total_protein_g, total_carbs_g, total_fat_g, instructions, notes
             FROM recipe_summary WHERE id = ?`,
            [Number(query)],
          )
          : findRecipeSummary(db, query);
        if (!recipe) return { error: `Recipe not found: ${query}` };

        const ingredients = queryAll(
          db,
          `SELECT ri.id, ri.ingredient_name, ri.quantity, ri.calories, ri.protein_g, ri.carbs_g, ri.fat_g,
                  p.id AS product_id, p.name AS product_name, p.shorthand AS product_shorthand
           FROM recipe_ingredients ri
           LEFT JOIN products p ON p.id = ri.product_id
           WHERE ri.recipe_id = ?
           ORDER BY ri.id`,
          [recipe.id],
        );
        const aliases = queryAll<{ alias: string }>(
          db,
          "SELECT alias FROM recipe_aliases WHERE recipe_id = ? ORDER BY alias",
          [recipe.id],
        );
        return { recipe, ingredients, aliases: aliases.map((row) => row.alias) };
      },
    },
    {
      name: "wellnessdb_day_summary",
      description: "Get all meals and supplements logged for a date, plus daily_wellness aggregates.",
      inputSchema: {
        type: "object",
        properties: {
          date: { type: "string", description: "Date in YYYY-MM-DD format (defaults to today)" },
        },
      },
      handler: async (input) => {
        const date = assertDate(String(input.date ?? todayDate()));
        const db = openDb(dbPath, true);
        const meals = queryAll(
          db,
          `SELECT id, date, meal, product_id, recipe_id, supplement_id, description, servings,
                  calories, protein_g, carbs_g, fat_g, notes, meal_time, logged_at
           FROM meal_log
           WHERE date = ?
           ORDER BY CASE meal
             WHEN 'breakfast' THEN 1 WHEN 'lunch' THEN 2 WHEN 'snack' THEN 3
             WHEN 'dinner' THEN 4 WHEN 'supplement' THEN 5 END,
             COALESCE(meal_time, logged_at)`,
          [date],
        );
        const summary = queryOne(db, "SELECT * FROM daily_wellness WHERE date = ?", [date]);
        const note = queryOne<{ note: string }>(db, "SELECT note FROM day_notes WHERE date = ?", [date]);
        const foodTotals = queryOne<{ calories: number; protein_g: number }>(
          db,
          `SELECT COALESCE(SUM(calories), 0) AS calories, COALESCE(SUM(protein_g), 0) AS protein_g
           FROM meal_log WHERE date = ? AND meal != 'supplement'`,
          [date],
        );
        return { date, meals, summary, note: note?.note ?? null, food_totals: foodTotals };
      },
    },
    {
      name: "wellnessdb_day_range",
      description: "Get daily_wellness view rows for a date range (inclusive).",
      inputSchema: {
        type: "object",
        properties: {
          start_date: { type: "string", description: "Start date YYYY-MM-DD" },
          end_date: { type: "string", description: "End date YYYY-MM-DD" },
        },
        required: ["start_date", "end_date"],
      },
      handler: async (input) => {
        const startDate = assertDate(String(input.start_date), "start_date");
        const endDate = assertDate(String(input.end_date), "end_date");
        const db = openDb(dbPath, true);
        const days = queryAll(
          db,
          "SELECT * FROM daily_wellness WHERE date >= ? AND date <= ? ORDER BY date",
          [startDate, endDate],
        );
        return { start_date: startDate, end_date: endDate, count: days.length, days };
      },
    },
    {
      name: "wellnessdb_recent_meals",
      description: "Get the most recent meal_log entries.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Number of entries to return (default 10, max 50)" },
        },
      },
      handler: async (input) => {
        const limit = Math.min(Math.max(Number(input.limit ?? 10) || 10, 1), 50);
        const db = openDb(dbPath, true);
        const meals = queryAll(
          db,
          `SELECT id, date, meal, description, servings, calories, protein_g, carbs_g, fat_g, notes, meal_time, logged_at
           FROM meal_log
           ORDER BY date DESC, COALESCE(meal_time, logged_at) DESC, id DESC
           LIMIT ?`,
          [limit],
        );
        return { limit, count: meals.length, meals };
      },
    },
    {
      name: "wellnessdb_active_supplements",
      description: "List supplements where stopped_date IS NULL.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const db = openDb(dbPath, true);
        const supplements = queryAll<SupplementRow>(
          db,
          `SELECT id, name, shorthand, brand, dosage, timing, calories, protein_g, carbs_g, fat_g, stopped_date
           FROM supplements
           WHERE stopped_date IS NULL
           ORDER BY name`,
        );
        return { count: supplements.length, supplements };
      },
    },
    {
      name: "wellnessdb_active_products",
      description: "List products where discontinued_date IS NULL.",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        const db = openDb(dbPath, true);
        const products = queryAll<ProductRow>(
          db,
          `SELECT id, name, shorthand, brand, category, calories, protein_g, carbs_g, fat_g,
                  serving_size, serving_unit, discontinued_date
           FROM products
           WHERE discontinued_date IS NULL
           ORDER BY name`,
        );
        return { count: products.length, products };
      },
    },
    {
      name: "wellnessdb_log_meal",
      description: "Log a meal entry for a product or recipe. Resolves item by shorthand or name.",
      inputSchema: {
        type: "object",
        properties: {
          date: { type: "string", description: "Date YYYY-MM-DD (defaults to today)" },
          meal: { type: "string", enum: ["breakfast", "lunch", "dinner", "snack"] },
          item_type: { type: "string", enum: ["product", "recipe"] },
          item: { type: "string", description: "Product or recipe shorthand/name" },
          servings: { type: "number", description: "Number of servings (default 1)" },
          notes: { type: "string" },
          meal_time: { type: "string", description: "Time as HH:MM" },
        },
        required: ["meal", "item_type", "item"],
      },
      handler: async (input) => {
        const date = assertDate(String(input.date ?? todayDate()));
        const meal = String(input.meal ?? "").trim().toLowerCase();
        const itemType = String(input.item_type ?? "").trim().toLowerCase();
        const item = String(input.item ?? "").trim();
        const servings = Number(input.servings ?? 1) || 1;
        if (!MEALS.has(meal) || meal === "supplement") {
          return { error: "meal must be breakfast, lunch, dinner, or snack" };
        }
        if (itemType !== "product" && itemType !== "recipe") {
          return { error: "item_type must be product or recipe" };
        }
        if (!item) return { error: "item is required" };

        const db = openDb(dbPath, false);
        if (itemType === "product") {
          const product = findProduct(db, item, true);
          if (!product) return { error: `Product not found: ${item}` };
          const result = db.prepare(
            `INSERT INTO meal_log (date, meal, product_id, description, servings, calories, protein_g, carbs_g, fat_g, notes, meal_time)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            date,
            meal,
            product.id,
            product.name,
            servings,
            scaleIntMacro(product.calories, servings),
            scaleMacro(product.protein_g, servings),
            scaleMacro(product.carbs_g, servings),
            scaleMacro(product.fat_g, servings),
            input.notes ? String(input.notes) : null,
            input.meal_time ? String(input.meal_time) : null,
          );
          return {
            id: Number(result.lastInsertRowid),
            date,
            meal,
            item_type: "product",
            item: product.name,
            servings,
            calories: scaleIntMacro(product.calories, servings),
            protein_g: scaleMacro(product.protein_g, servings),
          };
        }

        const recipe = findRecipeSummary(db, item);
        if (!recipe) return { error: `Recipe not found: ${item}` };
        const result = db.prepare(
          `INSERT INTO meal_log (date, meal, recipe_id, description, servings, calories, protein_g, carbs_g, fat_g, notes, meal_time)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          date,
          meal,
          recipe.id,
          recipe.name,
          servings,
          scaleIntMacro(recipe.per_serving_cal, servings),
          scaleMacro(recipe.per_serving_prot, servings),
          scaleMacro(recipe.per_serving_carb, servings),
          scaleMacro(recipe.per_serving_fat, servings),
          input.notes ? String(input.notes) : null,
          input.meal_time ? String(input.meal_time) : null,
        );
        return {
          id: Number(result.lastInsertRowid),
          date,
          meal,
          item_type: "recipe",
          item: recipe.name,
          servings,
          calories: scaleIntMacro(recipe.per_serving_cal, servings),
          protein_g: scaleMacro(recipe.per_serving_prot, servings),
        };
      },
    },
    {
      name: "wellnessdb_log_supplement",
      description: "Log one or more supplements taken. Supports comma-separated names and HRT batch expansion.",
      inputSchema: {
        type: "object",
        properties: {
          date: { type: "string", description: "Date YYYY-MM-DD (defaults to today)" },
          supplements: {
            oneOf: [
              { type: "string", description: "Comma-separated supplement shorthands/names, or HRT" },
              { type: "array", items: { type: "string" } },
            ],
          },
          notes: { type: "string", description: "Timing note such as AM or PM" },
          meal_time: { type: "string", description: "Time as HH:MM" },
        },
        required: ["supplements"],
      },
      handler: async (input) => {
        const date = assertDate(String(input.date ?? todayDate()));
        const queries = expandSupplementQueries(input.supplements as string | string[]);
        if (queries.length === 0) return { error: "supplements is required" };

        const db = openDb(dbPath, false);
        const logged: Array<Record<string, unknown>> = [];
        const errors: string[] = [];

        for (const query of queries) {
          const supplement = findSupplement(db, query, true);
          if (!supplement) {
            errors.push(`Supplement not found: ${query}`);
            continue;
          }
          const result = db.prepare(
            `INSERT INTO meal_log (date, meal, supplement_id, description, servings, calories, protein_g, carbs_g, fat_g, notes, meal_time)
             VALUES (?, 'supplement', ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
          ).run(
            date,
            supplement.id,
            supplement.name,
            supplement.calories ?? 0,
            supplement.protein_g ?? 0,
            supplement.carbs_g ?? 0,
            supplement.fat_g ?? 0,
            input.notes ? String(input.notes) : null,
            input.meal_time ? String(input.meal_time) : null,
          );
          logged.push({
            id: Number(result.lastInsertRowid),
            supplement: supplement.name,
            query,
          });
        }

        if (logged.length === 0) {
          return { error: errors.join("; ") };
        }
        return { date, logged, errors: errors.length > 0 ? errors : undefined };
      },
    },
    {
      name: "wellnessdb_log_weight",
      description: "Log weight for a date.",
      inputSchema: {
        type: "object",
        properties: {
          date: { type: "string" },
          weight_lbs: { type: "number" },
          notes: { type: "string" },
        },
        required: ["weight_lbs"],
      },
      handler: async (input) => {
        const date = assertDate(String(input.date ?? todayDate()));
        const weight = Number(input.weight_lbs);
        if (!Number.isFinite(weight) || weight <= 0) {
          return { error: "weight_lbs must be a positive number" };
        }
        const db = openDb(dbPath, false);
        const result = db.prepare(
          "INSERT INTO weight_log (date, weight_lbs, notes) VALUES (?, ?, ?)",
        ).run(date, weight, input.notes ? String(input.notes) : null);
        return { id: Number(result.lastInsertRowid), date, weight_lbs: weight };
      },
    },
    {
      name: "wellnessdb_log_activity",
      description: "Log movement or activity.",
      inputSchema: {
        type: "object",
        properties: {
          date: { type: "string" },
          activity_type: {
            type: "string",
            enum: ["walk", "weights", "yoga", "stretching", "rebounder", "meditation", "journaling", "other"],
          },
          duration_min: { type: "number" },
          distance_miles: { type: "number" },
          notes: { type: "string" },
        },
        required: ["activity_type"],
      },
      handler: async (input) => {
        const date = assertDate(String(input.date ?? todayDate()));
        const activityType = String(input.activity_type ?? "").trim().toLowerCase();
        if (!ACTIVITY_TYPES.has(activityType)) {
          return { error: "activity_type is invalid" };
        }
        const db = openDb(dbPath, false);
        const result = db.prepare(
          `INSERT INTO activity_log (date, activity_type, duration_min, distance_miles, notes)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(
          date,
          activityType,
          input.duration_min != null ? Number(input.duration_min) : null,
          input.distance_miles != null ? Number(input.distance_miles) : null,
          input.notes ? String(input.notes) : null,
        );
        return {
          id: Number(result.lastInsertRowid),
          date,
          activity_type: activityType,
          duration_min: input.duration_min != null ? Number(input.duration_min) : null,
          distance_miles: input.distance_miles != null ? Number(input.distance_miles) : null,
        };
      },
    },
    {
      name: "wellnessdb_log_hydration",
      description: "Log water intake in ounces.",
      inputSchema: {
        type: "object",
        properties: {
          date: { type: "string" },
          oz: { type: "number", description: "Ounces of water" },
          notes: { type: "string" },
        },
        required: ["oz"],
      },
      handler: async (input) => {
        const date = assertDate(String(input.date ?? todayDate()));
        const oz = Number(input.oz);
        if (!Number.isFinite(oz) || oz <= 0) {
          return { error: "oz must be a positive number" };
        }
        const db = openDb(dbPath, false);
        const result = db.prepare(
          "INSERT INTO hydration_log (date, oz, notes) VALUES (?, ?, ?)",
        ).run(date, oz, input.notes ? String(input.notes) : null);
        return { id: Number(result.lastInsertRowid), date, oz };
      },
    },
    {
      name: "wellnessdb_log_presence",
      description: "Record a five-body presence check.",
      inputSchema: {
        type: "object",
        properties: {
          date: { type: "string" },
          mental: { type: "string" },
          physical: { type: "string" },
          emotional: { type: "string" },
          energetic: { type: "string" },
          spiritual: { type: "string" },
          care_action: { type: "string" },
          notes: { type: "string" },
        },
      },
      handler: async (input) => {
        const date = assertDate(String(input.date ?? todayDate()));
        const db = openDb(dbPath, false);
        const result = db.prepare(
          `INSERT INTO presence_checks (date, mental, physical, emotional, energetic, spiritual, care_action, notes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          date,
          input.mental ? String(input.mental) : null,
          input.physical ? String(input.physical) : null,
          input.emotional ? String(input.emotional) : null,
          input.energetic ? String(input.energetic) : null,
          input.spiritual ? String(input.spiritual) : null,
          input.care_action ? String(input.care_action) : null,
          input.notes ? String(input.notes) : null,
        );
        return { id: Number(result.lastInsertRowid), date };
      },
    },
    {
      name: "wellnessdb_add_product",
      description: "Add a new product to the products table.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          shorthand: { type: "string" },
          brand: { type: "string" },
          category: { type: "string" },
          serving_size: { type: "string" },
          calories: { type: "number" },
          protein_g: { type: "number" },
          carbs_g: { type: "number" },
          fat_g: { type: "number" },
          notes: { type: "string" },
        },
        required: ["name"],
      },
      handler: async (input) => {
        const name = String(input.name ?? "").trim();
        if (!name) return { error: "name is required" };
        const db = openDb(dbPath, false);
        const result = db.prepare(
          `INSERT INTO products (name, shorthand, brand, category, serving_size, calories, protein_g, carbs_g, fat_g, notes, started_date)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, date('now'))`,
        ).run(
          name,
          input.shorthand ? String(input.shorthand) : null,
          input.brand ? String(input.brand) : null,
          input.category ? String(input.category) : null,
          input.serving_size ? String(input.serving_size) : null,
          input.calories != null ? Number(input.calories) : null,
          input.protein_g != null ? Number(input.protein_g) : null,
          input.carbs_g != null ? Number(input.carbs_g) : null,
          input.fat_g != null ? Number(input.fat_g) : null,
          input.notes ? String(input.notes) : null,
        );
        return { id: Number(result.lastInsertRowid), name };
      },
    },
    {
      name: "wellnessdb_update_product",
      description: "Update an existing product by id. Supports name, shorthand, brand, category, serving_size, calories, protein_g, carbs_g, fat_g, and notes.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "products row id" },
          name: { type: "string" },
          shorthand: { type: "string" },
          brand: { type: "string" },
          category: { type: "string" },
          serving_size: { type: "string" },
          calories: { type: "number" },
          protein_g: { type: "number" },
          carbs_g: { type: "number" },
          fat_g: { type: "number" },
          notes: { type: "string" },
        },
        required: ["id"],
      },
      handler: async (input) => {
        const id = Number(input.id);
        if (!Number.isInteger(id) || id <= 0) return { error: "id must be a positive integer" };
        const db = openDb(dbPath, false);
        const existing = queryOne<Record<string, unknown>>(
          db,
          `SELECT id, name, shorthand, brand, category, serving_size, calories, protein_g, carbs_g, fat_g, notes
           FROM products
           WHERE id = ?`,
          [id],
        );
        if (!existing) return { error: `Product not found: ${id}` };

        const updates: string[] = [];
        const values: Array<string | number | null> = [];
        const applyString = (field: string, value: unknown): void => {
          updates.push(`${field} = ?`);
          values.push(value == null ? null : String(value).trim());
        };
        const applyNumber = (field: string, value: unknown): void => {
          const numeric = Number(value);
          updates.push(`${field} = ?`);
          values.push(Number.isFinite(numeric) ? numeric : null);
        };

        if (input.name !== undefined) applyString("name", input.name);
        if (input.shorthand !== undefined) applyString("shorthand", input.shorthand);
        if (input.brand !== undefined) applyString("brand", input.brand);
        if (input.category !== undefined) applyString("category", input.category);
        if (input.serving_size !== undefined) applyString("serving_size", input.serving_size);
        if (input.calories !== undefined) applyNumber("calories", input.calories);
        if (input.protein_g !== undefined) applyNumber("protein_g", input.protein_g);
        if (input.carbs_g !== undefined) applyNumber("carbs_g", input.carbs_g);
        if (input.fat_g !== undefined) applyNumber("fat_g", input.fat_g);
        if (input.notes !== undefined) applyString("notes", input.notes);

        if (updates.length === 0) {
          return { error: "At least one update field is required" };
        }

        db.prepare(`UPDATE products SET ${updates.join(", ")} WHERE id = ?`).run(...values, id);
        const product = queryOne<Record<string, unknown>>(
          db,
          `SELECT id, name, shorthand, brand, category, serving_size, calories, protein_g, carbs_g, fat_g, notes
           FROM products
           WHERE id = ?`,
          [id],
        );
        return { updated: true, product };
      },
    },
    {
      name: "wellnessdb_add_recipe",
      description: "Create a recipe with ingredients. Totals are calculated from ingredient macros.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          shorthand: { type: "string" },
          servings: { type: "number" },
          instructions: { type: "string" },
          notes: { type: "string" },
          aliases: { type: "array", items: { type: "string" } },
          ingredients: {
            type: "array",
            items: {
              type: "object",
              properties: {
                product: { type: "string", description: "Product shorthand or name" },
                ingredient_name: { type: "string", description: "Override ingredient label" },
                quantity: { type: "string" },
                servings: { type: "number", description: "Multiplier against product macros (default 1)" },
              },
              required: ["product"],
            },
          },
        },
        required: ["name", "ingredients"],
      },
      handler: async (input) => {
        const name = String(input.name ?? "").trim();
        if (!name) return { error: "name is required" };
        const ingredients = Array.isArray(input.ingredients) ? input.ingredients : [];
        if (ingredients.length === 0) return { error: "ingredients is required" };

        const db = openDb(dbPath, false);
        const servings = Number(input.servings ?? 1) || 1;
        const recipeResult = db.prepare(
          `INSERT INTO recipes (name, shorthand, servings, instructions, notes)
           VALUES (?, ?, ?, ?, ?)`,
        ).run(
          name,
          input.shorthand ? String(input.shorthand) : null,
          servings,
          input.instructions ? String(input.instructions) : null,
          input.notes ? String(input.notes) : null,
        );
        const recipeId = Number(recipeResult.lastInsertRowid);

        for (const ingredient of ingredients) {
          const productQuery = String((ingredient as Record<string, unknown>).product ?? "").trim();
          if (!productQuery) return { error: "Each ingredient requires product" };
          const product = findProduct(db, productQuery, false);
          if (!product) return { error: `Ingredient product not found: ${productQuery}` };
          const ingredientServings = Number((ingredient as Record<string, unknown>).servings ?? 1) || 1;
          db.prepare(
            `INSERT INTO recipe_ingredients (recipe_id, product_id, ingredient_name, quantity, calories, protein_g, carbs_g, fat_g)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            recipeId,
            product.id,
            String((ingredient as Record<string, unknown>).ingredient_name ?? product.name),
            (ingredient as Record<string, unknown>).quantity ? String((ingredient as Record<string, unknown>).quantity) : null,
            scaleIntMacro(product.calories, ingredientServings),
            scaleMacro(product.protein_g, ingredientServings),
            scaleMacro(product.carbs_g, ingredientServings),
            scaleMacro(product.fat_g, ingredientServings),
          );
        }

        for (const alias of Array.isArray(input.aliases) ? input.aliases : []) {
          const aliasText = String(alias).trim();
          if (!aliasText) continue;
          db.prepare("INSERT OR IGNORE INTO recipe_aliases (recipe_id, alias) VALUES (?, ?)").run(recipeId, aliasText);
        }

        recalculateRecipeTotals(db, recipeId);
        const recipe = findRecipeSummary(db, String(recipeId));
        return { id: recipeId, recipe };
      },
    },
    {
      name: "wellnessdb_update_recipe",
      description: "Replace a recipe's ingredients and recalculate totals.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Recipe id, shorthand, alias, or name" },
          servings: { type: "number" },
          instructions: { type: "string" },
          notes: { type: "string" },
          ingredients: {
            type: "array",
            items: {
              type: "object",
              properties: {
                product: { type: "string" },
                ingredient_name: { type: "string" },
                quantity: { type: "string" },
                servings: { type: "number" },
              },
              required: ["product"],
            },
          },
        },
        required: ["query", "ingredients"],
      },
      handler: async (input) => {
        const query = String(input.query ?? "").trim();
        const ingredients = Array.isArray(input.ingredients) ? input.ingredients : [];
        if (!query) return { error: "query is required" };
        if (ingredients.length === 0) return { error: "ingredients is required" };

        const db = openDb(dbPath, false);
        const recipe = /^\d+$/.test(query)
          ? findRecipeSummary(db, query)
          : findRecipeSummary(db, query);
        if (!recipe) return { error: `Recipe not found: ${query}` };

        if (input.servings != null) {
          db.prepare("UPDATE recipes SET servings = ? WHERE id = ?").run(Number(input.servings), recipe.id);
        }
        if (input.instructions != null) {
          db.prepare("UPDATE recipes SET instructions = ? WHERE id = ?").run(String(input.instructions), recipe.id);
        }
        if (input.notes != null) {
          db.prepare("UPDATE recipes SET notes = ? WHERE id = ?").run(String(input.notes), recipe.id);
        }

        db.prepare("DELETE FROM recipe_ingredients WHERE recipe_id = ?").run(recipe.id);
        for (const ingredient of ingredients) {
          const productQuery = String((ingredient as Record<string, unknown>).product ?? "").trim();
          if (!productQuery) return { error: "Each ingredient requires product" };
          const product = findProduct(db, productQuery, false);
          if (!product) return { error: `Ingredient product not found: ${productQuery}` };
          const ingredientServings = Number((ingredient as Record<string, unknown>).servings ?? 1) || 1;
          db.prepare(
            `INSERT INTO recipe_ingredients (recipe_id, product_id, ingredient_name, quantity, calories, protein_g, carbs_g, fat_g)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            recipe.id,
            product.id,
            String((ingredient as Record<string, unknown>).ingredient_name ?? product.name),
            (ingredient as Record<string, unknown>).quantity ? String((ingredient as Record<string, unknown>).quantity) : null,
            scaleIntMacro(product.calories, ingredientServings),
            scaleMacro(product.protein_g, ingredientServings),
            scaleMacro(product.carbs_g, ingredientServings),
            scaleMacro(product.fat_g, ingredientServings),
          );
        }

        recalculateRecipeTotals(db, recipe.id);
        return { id: recipe.id, recipe: findRecipeSummary(db, String(recipe.id)) };
      },
    },
    {
      name: "wellnessdb_add_day_note",
      description: "Add or append a note for a date.",
      inputSchema: {
        type: "object",
        properties: {
          date: { type: "string" },
          note: { type: "string" },
        },
        required: ["note"],
      },
      handler: async (input) => {
        const date = assertDate(String(input.date ?? todayDate()));
        const note = String(input.note ?? "").trim();
        if (!note) return { error: "note is required" };
        const db = openDb(dbPath, false);
        const existing = queryOne<{ note: string }>(db, "SELECT note FROM day_notes WHERE date = ?", [date]);
        const nextNote = existing?.note ? `${existing.note}\n${note}` : note;
        db.prepare("INSERT OR REPLACE INTO day_notes (date, note) VALUES (?, ?)").run(date, nextNote);
        return { date, note: nextNote, appended: Boolean(existing) };
      },
    },
    {
      name: "wellnessdb_update_supplement",
      description: "Update an existing supplement by id. Supports name, shorthand, dosage, and notes.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "supplements row id" },
          name: { type: "string" },
          shorthand: { type: "string" },
          dosage: { type: "string" },
          notes: { type: "string" },
        },
        required: ["id"],
      },
      handler: async (input) => {
        const id = Number(input.id);
        if (!Number.isInteger(id) || id <= 0) return { error: "id must be a positive integer" };
        const db = openDb(dbPath, false);
        const existing = queryOne<Record<string, unknown>>(
          db,
          `SELECT id, name, shorthand, dosage, notes
           FROM supplements
           WHERE id = ?`,
          [id],
        );
        if (!existing) return { error: `Supplement not found: ${id}` };

        const updates: string[] = [];
        const values: Array<string | null> = [];
        const applyString = (field: string, value: unknown): void => {
          updates.push(`${field} = ?`);
          values.push(value == null ? null : String(value).trim());
        };

        if (input.name !== undefined) applyString("name", input.name);
        if (input.shorthand !== undefined) applyString("shorthand", input.shorthand);
        if (input.dosage !== undefined) applyString("dosage", input.dosage);
        if (input.notes !== undefined) applyString("notes", input.notes);

        if (updates.length === 0) {
          return { error: "At least one update field is required" };
        }

        db.prepare(`UPDATE supplements SET ${updates.join(", ")} WHERE id = ?`).run(...values, id);
        const supplement = queryOne<Record<string, unknown>>(
          db,
          `SELECT id, name, shorthand, dosage, notes
           FROM supplements
           WHERE id = ?`,
          [id],
        );
        return { updated: true, supplement };
      },
    },
    {
      name: "wellnessdb_delete_meal_entry",
      description: "Delete a specific meal_log entry by id (for corrections only).",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "meal_log row id" },
        },
        required: ["id"],
      },
      handler: async (input) => {
        const id = Number(input.id);
        if (!Number.isInteger(id) || id <= 0) return { error: "id must be a positive integer" };
        const db = openDb(dbPath, false);
        const existing = queryOne(db, "SELECT id, date, meal, description FROM meal_log WHERE id = ?", [id]);
        if (!existing) return { error: `Meal entry not found: ${id}` };
        db.prepare("DELETE FROM meal_log WHERE id = ?").run(id);
        return { deleted: true, entry: existing };
      },
    },
    {
      name: "wellnessdb_delete_product",
      description: "Delete a product by id (for duplicate/incorrect entries only).",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "products row id" },
        },
        required: ["id"],
      },
      handler: async (input) => {
        const id = Number(input.id);
        if (!Number.isInteger(id) || id <= 0) return { error: "id must be a positive integer" };
        const db = openDb(dbPath, false);
        const existing = queryOne(db, "SELECT id, name, shorthand FROM products WHERE id = ?", [id]);
        if (!existing) return { error: `Product not found: ${id}` };
        db.prepare("DELETE FROM products WHERE id = ?").run(id);
        return { deleted: true, product: existing };
      },
    },
    {
      name: "wellnessdb_delete_supplement",
      description: "Delete a supplement by id (for duplicate/incorrect entries only).",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "number", description: "supplements row id" },
        },
        required: ["id"],
      },
      handler: async (input) => {
        const id = Number(input.id);
        if (!Number.isInteger(id) || id <= 0) return { error: "id must be a positive integer" };
        const db = openDb(dbPath, false);
        const existing = queryOne(db, "SELECT id, name, shorthand FROM supplements WHERE id = ?", [id]);
        if (!existing) return { error: `Supplement not found: ${id}` };
        db.prepare("DELETE FROM supplements WHERE id = ?").run(id);
        return { deleted: true, supplement: existing };
      },
    },
  ];
}
