/**
 * One-time migration: legacy Atlas ingredients → wellness.db products.
 *
 * The legacy `~/atlas/atlas.db` ingredients table (88 rows, outside the repo,
 * raw-SQL access only) is the old food catalog. This copies every row into
 * wellness.db `products` — macros + fiber, FatSecret food/serving IDs,
 * grams_per_serving — and creates a `product_listings` stub per row so the
 * Walmart item-ID backfill has somewhere to land. The legacy DB is opened
 * read-only and never modified.
 *
 * Dry-run by default; `--apply` writes.
 *
 *   node --import tsx scripts/migrate-atlas-ingredients.ts
 *   node --import tsx scripts/migrate-atlas-ingredients.ts -- --apply
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { ensureWellnessDb } from "../packages/discord/src/wellness-db-migrations.js";
import { resolveWellnessDbPath } from "../packages/discord/src/wellness-db-tools.js";

type IngredientRow = {
  id: number;
  name: string;
  brand: string | null;
  product: string | null;
  food_id: number | null;
  serving_id: number | null;
  serving_description: string | null;
  serving_size: string | null;
  grams_per_serving: number | null;
  calories: number | null;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  fiber: number | null;
  store: string | null;
  notes: string | null;
};

const apply = process.argv.includes("--apply");
const atlasPath =
  process.env.ATLAS_DB_PATH?.trim() || path.join(os.homedir(), "atlas", "atlas.db");

if (!fs.existsSync(atlasPath)) {
  console.error(`Legacy Atlas DB not found: ${atlasPath}`);
  process.exit(1);
}

const wellnessPath = resolveWellnessDbPath(process.env.WELLNESS_DB_PATH);
if (apply) {
  ensureWellnessDb(wellnessPath);
}

const atlas = new DatabaseSync(atlasPath, { readOnly: true });
const rows = atlas
  .prepare(
    `SELECT id, name, brand, product, food_id, serving_id, serving_description,
            serving_size, grams_per_serving, calories, protein, carbs, fat, fiber,
            store, notes
     FROM ingredients ORDER BY name`,
  )
  .all() as IngredientRow[];
atlas.close();

function retailerFor(store: string | null): "walmart" | "amazon" | null {
  const normalized = (store ?? "").trim().toLowerCase();
  if (normalized.includes("walmart")) return "walmart";
  if (normalized.includes("amazon")) return "amazon";
  return null;
}

let inserted = 0;
let skipped = 0;
let listings = 0;

const wellness = apply
  ? new DatabaseSync(wellnessPath)
  : fs.existsSync(wellnessPath)
    ? new DatabaseSync(wellnessPath, { readOnly: true })
    : null;
if (apply) {
  wellness!.exec("PRAGMA busy_timeout = 5000");
  wellness!.exec("BEGIN");
}

for (const row of rows) {
  const label = `${row.name}${row.brand ? ` (${row.brand})` : ""}`;
  const retailer = retailerFor(row.store);
  const existing = wellness
    ?.prepare("SELECT id FROM products WHERE lower(name) = lower(?) LIMIT 1")
    .get(row.name) as { id: number } | undefined;
  if (existing) {
    skipped += 1;
    console.log(`skip   ${label} — already in products (id ${existing.id})`);
    continue;
  }
  if (!apply) {
    inserted += 1;
    if (retailer) listings += 1;
    console.log(`would insert ${label}${retailer ? ` + ${retailer} listing stub` : ""}`);
    continue;
  }
  const result = wellness!
    .prepare(
      `INSERT INTO products
         (name, brand, category, serving_size, calories, protein_g, carbs_g, fat_g,
          fiber_g, grams_per_serving, fatsecret_food_id, fatsecret_serving_id,
          notes, source, serving_unit)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'atlas-migration', 'per_serving')`,
    )
    .run(
      row.name,
      row.brand,
      row.serving_description ?? row.serving_size,
      row.calories === null ? null : Math.round(row.calories),
      row.protein,
      row.carbs,
      row.fat,
      row.fiber,
      row.grams_per_serving,
      row.food_id === null ? null : String(row.food_id),
      row.serving_id === null ? null : String(row.serving_id),
      row.notes,
    );
  inserted += 1;
  if (retailer) {
    wellness!
      .prepare(
        "INSERT INTO product_listings (product_id, retailer, preferred) VALUES (?, ?, 1)",
      )
      .run(Number(result.lastInsertRowid), retailer);
    listings += 1;
  }
  console.log(`insert ${label}${retailer ? ` + ${retailer} listing stub` : ""}`);
}

if (apply) {
  wellness!.exec("COMMIT");
}
wellness?.close();

console.log(
  `\n${apply ? "Applied" : "Dry run"}: ${inserted} inserted, ${skipped} skipped, ${listings} listing stubs` +
    `\n  from ${atlasPath} (read-only)` +
    `\n  into ${wellnessPath}${apply ? "" : "\nRe-run with --apply to write."}`,
);
