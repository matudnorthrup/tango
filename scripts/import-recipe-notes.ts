/**
 * One-time import: markdown recipe notes → wellness.db recipes.
 *
 * Parses the Obsidian-style recipe notes (YAML frontmatter with per-serving
 * macros, an "## Ingredients" section with gram-annotated lines like
 * "- 200g Canned Chicken Breast — 160 cal, 47g P") and writes recipes +
 * recipe_ingredients with canonical quantity_g. Ingredient rows are matched
 * to products by name when possible. wellness.db becomes the canonical
 * recipe store; the markdown notes stay untouched as an archive.
 *
 * Dry-run by default; `--apply` writes.
 *
 *   node --import tsx scripts/import-recipe-notes.ts [--dir <path>] [--apply]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ensureWellnessDb } from "../packages/discord/src/wellness-db-migrations.js";
import { resolveWellnessDbPath } from "../packages/discord/src/wellness-db-tools.js";

const apply = process.argv.includes("--apply");
const dirFlag = process.argv.indexOf("--dir");
const recipesDir =
  dirFlag >= 0
    ? process.argv[dirFlag + 1]
    : process.env.TANGO_RECIPES_DIR?.trim() ||
      path.join(os.homedir(), "Documents", "main", "Records", "Nutrition", "Recipes");

if (!fs.existsSync(recipesDir)) {
  console.error(`Recipes directory not found: ${recipesDir}`);
  process.exit(1);
}

interface ParsedIngredient {
  name: string;
  quantity: string;
  quantity_g: number | null;
  calories: number | null;
  protein_g: number | null;
}

interface ParsedRecipe {
  file: string;
  name: string;
  servings: number;
  meal: string | null;
  perServing: { calories: number; protein: number; carbs: number; fat: number; fiber: number | null };
  ingredients: ParsedIngredient[];
  body: string;
}

function parseFrontmatterNumber(fm: string, key: string): number | null {
  const m = fm.match(new RegExp(`^${key}:\\s*([\\d.]+)\\s*$`, "m"));
  return m ? Number(m[1]) : null;
}

function parseRecipe(file: string): ParsedRecipe | null {
  const raw = fs.readFileSync(file, "utf8");
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!fmMatch) return null;
  const fm = fmMatch[1];
  const calories = parseFrontmatterNumber(fm, "calories");
  if (calories === null) return null; // guides and non-recipe notes
  const body = raw.slice(fmMatch[0].length);
  const title = body.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(file, ".md");
  const mealMatch = fm.match(/^meal:\n\s*-\s*(\S+)/m) || fm.match(/^meal:\s*(\S+)\s*$/m);

  const ingredients: ParsedIngredient[] = [];
  const ingSection = body.match(/^##\s+Ingredients\b[^\n]*$([\s\S]*?)(?=^##\s|\n*$(?![\s\S]))/m);
  if (ingSection) {
    for (const line of ingSection[1].split("\n")) {
      // Table rows: | Ingredient | Amount | Cal | Protein |
      const cells = line.trim().startsWith("|") ? line.split("|").map((c) => c.trim()).filter(Boolean) : null;
      if (cells && cells.length >= 2 && !/^-+$/.test(cells[0] ?? "") && !/^ingredient$/i.test(cells[0] ?? "") && !/total/i.test(cells[0] ?? "")) {
        const amount = cells[1] ?? "";
        const gramsInAmount = amount.match(/([\d,.]+)\s*g\b/i);
        const cal = cells[2]?.match(/[\d.]+/);
        const prot = cells[3]?.match(/[\d.]+/);
        ingredients.push({
          name: (cells[0] ?? "").replace(/\*/g, "").trim(),
          quantity: amount,
          quantity_g: gramsInAmount ? Number(gramsInAmount[1].replace(/,/g, "")) : null,
          calories: cal ? Number(cal[0]) : null,
          protein_g: prot ? Number(prot[0]) : null,
        });
        continue;
      }
      const item = line.match(/^\s*-\s+(.*)$/)?.[1]?.trim();
      if (!item) continue;
      const [desc, annotation = ""] = item.split(/\s+—\s+/);
      const grams = desc.match(/^([\d,.]+)\s*g\s+(.+)$/i);
      const cal = annotation.match(/([\d.]+)\s*cal/i);
      const prot = annotation.match(/([\d.]+)\s*g\s*P\b/i);
      ingredients.push({
        name: (grams ? grams[2] : desc).replace(/\(.*?\)/g, "").trim(),
        quantity: desc,
        quantity_g: grams ? Number(grams[1].replace(/,/g, '')) : null,
        calories: cal ? Number(cal[1]) : null,
        protein_g: prot ? Number(prot[1]) : null,
      });
    }
  }

  return {
    file,
    name: title,
    servings: parseFrontmatterNumber(fm, "servings") ?? 1,
    meal: mealMatch ? mealMatch[1] : null,
    perServing: {
      calories,
      protein: parseFrontmatterNumber(fm, "protein") ?? 0,
      carbs: parseFrontmatterNumber(fm, "carbs") ?? 0,
      fat: parseFrontmatterNumber(fm, "fat") ?? 0,
      fiber: parseFrontmatterNumber(fm, "fiber"),
    },
    ingredients,
    body: body.trim(),
  };
}

const files = fs
  .readdirSync(recipesDir)
  .filter((f) => f.endsWith(".md"))
  .map((f) => path.join(recipesDir, f));

const parsed: ParsedRecipe[] = [];
const skipped: string[] = [];
for (const file of files) {
  const recipe = parseRecipe(file);
  if (recipe) parsed.push(recipe);
  else skipped.push(path.basename(file));
}

const wellnessPath = resolveWellnessDbPath(process.env.WELLNESS_DB_PATH);
let db: DatabaseSync | null = null;
if (apply) {
  ensureWellnessDb(wellnessPath);
  db = new DatabaseSync(wellnessPath);
  db.exec("PRAGMA busy_timeout = 5000");
} else if (fs.existsSync(wellnessPath)) {
  db = new DatabaseSync(wellnessPath, { readOnly: true });
}

let imported = 0;
let existing = 0;
for (const recipe of parsed) {
  const already = db
    ?.prepare("SELECT id FROM recipes WHERE lower(name) = lower(?)")
    .get(recipe.name) as { id: number } | undefined;
  if (already) {
    existing += 1;
    console.log(`skip   ${recipe.name} — already in recipes (id ${already.id})`);
    continue;
  }
  const gramsKnown = recipe.ingredients.filter((i) => i.quantity_g !== null).length;
  console.log(
    `${apply ? "import" : "would import"} ${recipe.name} — ${recipe.servings} srv, ` +
      `${recipe.perServing.calories} cal/srv, ${recipe.ingredients.length} ingredients ` +
      `(${gramsKnown} with grams)${recipe.perServing.fiber === null ? " · no fiber in note" : ""}`,
  );
  if (!apply) {
    imported += 1;
    continue;
  }
  const result = db!
    .prepare(
      `INSERT INTO recipes
         (name, servings, total_calories, total_protein_g, total_carbs_g, total_fat_g,
          total_fiber_g, instructions, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'imported from recipe note')`,
    )
    .run(
      recipe.name,
      recipe.servings,
      Math.round(recipe.perServing.calories * recipe.servings),
      recipe.perServing.protein * recipe.servings,
      recipe.perServing.carbs * recipe.servings,
      recipe.perServing.fat * recipe.servings,
      recipe.perServing.fiber === null ? null : recipe.perServing.fiber * recipe.servings,
      recipe.body,
    );
  const recipeId = Number(result.lastInsertRowid);
  for (const ing of recipe.ingredients) {
    const product = db!
      .prepare("SELECT id FROM products WHERE lower(name) = lower(?) OR lower(name) LIKE ? LIMIT 1")
      .get(ing.name, `%${ing.name.toLowerCase()}%`) as { id: number } | undefined;
    db!
      .prepare(
        `INSERT INTO recipe_ingredients
           (recipe_id, product_id, ingredient_name, quantity, quantity_g, calories, protein_g)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(recipeId, product?.id ?? null, ing.name, ing.quantity, ing.quantity_g, ing.calories, ing.protein_g);
  }
  imported += 1;
}
db?.close();

console.log(
  `\n${apply ? "Applied" : "Dry run"}: ${imported} imported, ${existing} already present, ` +
    `${skipped.length} non-recipe files skipped (${skipped.join(", ") || "none"})` +
    `\n  from ${recipesDir}\n  into ${wellnessPath}${apply ? "" : "\nRe-run with --apply to write."}`,
);
