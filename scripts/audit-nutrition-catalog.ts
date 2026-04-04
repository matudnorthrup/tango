import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { resolveConfiguredPath, resolveTangoHome } from "@tango/core";

type AuditItem = {
  label: string;
  foodId: number;
  atlasWhere: string;
};

type AtlasRow = {
  name?: string;
  brand?: string;
  product?: string;
  food_id?: number;
  serving_id?: number;
  serving_description?: string;
  grams_per_serving?: number;
  calories?: number;
  protein?: number;
  carbs?: number;
  fat?: number;
  fiber?: number;
};

type FatSecretServing = {
  serving_id?: string;
  serving_description?: string;
  metric_serving_amount?: string;
};

type FatSecretFood = {
  food_id?: string;
  food_name?: string;
  brand_name?: string;
  servings?: {
    serving?: FatSecretServing | FatSecretServing[];
  };
  servings_list?: FatSecretServing[];
  calories?: string;
  protein?: string;
  carbohydrate?: string;
  fat?: string;
  fiber?: string;
};

const AUDIT_ITEMS: AuditItem[] = [
  { label: "La Abuela Flour Tortillas", foodId: 227272, atlasWhere: "food_id = 227272" },
  { label: "Light Greek Yogurt", foodId: 38834732, atlasWhere: "food_id = 38834732" },
  { label: "PBfit Peanut Butter Powder", foodId: 45580247, atlasWhere: "id = 50" },
  { label: "Nunaturals Organic Cocoa Powder", foodId: 81066433, atlasWhere: "id = 25" },
  { label: "Anthony's Organic Cocoa Nibs", foodId: 18750682, atlasWhere: "id = 24" },
];

function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || stdout.trim() || error.message));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function queryAtlas(whereClause: string): Promise<AtlasRow | null> {
  const atlas = path.join(os.homedir(), "bin/atlas");
  const sql = [
    "SELECT",
    "  name,",
    "  brand,",
    "  product,",
    "  food_id,",
    "  serving_id,",
    "  serving_description,",
    "  grams_per_serving,",
    "  calories,",
    "  protein,",
    "  carbs,",
    "  fat,",
    "  fiber",
    "FROM ingredients",
    `WHERE ${whereClause}`,
    "LIMIT 1;",
  ].join(" ");
  const stdout = await runCommand(atlas, ["sql", sql]);
  const parsed = JSON.parse(stdout) as AtlasRow[] | { rows?: AtlasRow[] };
  if (Array.isArray(parsed)) {
    return parsed[0] ?? null;
  }
  return Array.isArray(parsed.rows) && parsed.rows[0] ? parsed.rows[0] : null;
}

async function queryFatSecret(foodId: number): Promise<FatSecretFood | null> {
  const tangoHome = resolveTangoHome();
  const python = process.env.TANGO_FATSECRET_PYTHON?.trim()
    ? resolveConfiguredPath(process.env.TANGO_FATSECRET_PYTHON)
    : path.join(tangoHome, "tools/nutrition-coach/venv/bin/python");
  const script = process.env.TANGO_FATSECRET_API_SCRIPT?.trim()
    ? resolveConfiguredPath(process.env.TANGO_FATSECRET_API_SCRIPT)
    : path.join(tangoHome, "tools/nutrition-coach/scripts/fatsecret-api.py");
  const stdout = await runCommand(python, [script, "food_get", JSON.stringify({ food_id: foodId })]);
  return stdout ? JSON.parse(stdout) as FatSecretFood : null;
}

function getPrimaryServing(food: FatSecretFood | null): FatSecretServing | null {
  if (!food) {
    return null;
  }
  const serving = food.servings?.serving;
  if (Array.isArray(serving)) {
    return serving[0] ?? null;
  }
  if (serving && typeof serving === "object") {
    return serving;
  }
  if (Array.isArray(food.servings_list)) {
    return food.servings_list[0] ?? null;
  }
  return null;
}

function parseFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseFloat(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function compareString(label: string, atlasValue: unknown, fatSecretValue: unknown, mismatches: string[]): void {
  const atlasText = typeof atlasValue === "string" ? atlasValue.trim() : "";
  const fatText = typeof fatSecretValue === "string" ? fatSecretValue.trim() : "";
  if (!atlasText || !fatText) {
    return;
  }
  if (atlasText !== fatText) {
    mismatches.push(`${label}: atlas="${atlasText}" fatsecret="${fatText}"`);
  }
}

function compareNumber(label: string, atlasValue: unknown, fatSecretValue: unknown, mismatches: string[]): void {
  const atlasNumber = parseFiniteNumber(atlasValue);
  const fatNumber = parseFiniteNumber(fatSecretValue);
  if (atlasNumber === null || fatNumber === null) {
    return;
  }
  if (Math.abs(atlasNumber - fatNumber) > 0.001) {
    mismatches.push(`${label}: atlas=${atlasNumber} fatsecret=${fatNumber}`);
  }
}

async function main(): Promise<void> {
  const mismatches: string[] = [];

  for (const item of AUDIT_ITEMS) {
    const atlasRow = await queryAtlas(item.atlasWhere);
    const fatSecret = await queryFatSecret(item.foodId);
    const serving = getPrimaryServing(fatSecret);

    if (!atlasRow) {
      mismatches.push(`${item.label}: atlas row missing`);
      continue;
    }
    if (!fatSecret || !serving) {
      mismatches.push(`${item.label}: fatsecret data missing`);
      continue;
    }

    compareString(`${item.label} serving_description`, atlasRow.serving_description, serving.serving_description, mismatches);
    compareNumber(`${item.label} grams_per_serving`, atlasRow.grams_per_serving, serving.metric_serving_amount, mismatches);
    compareNumber(`${item.label} calories`, atlasRow.calories, fatSecret.calories, mismatches);
    compareNumber(`${item.label} protein`, atlasRow.protein, fatSecret.protein, mismatches);
    compareNumber(`${item.label} carbs`, atlasRow.carbs, fatSecret.carbohydrate, mismatches);
    compareNumber(`${item.label} fat`, atlasRow.fat, fatSecret.fat, mismatches);
    compareNumber(`${item.label} fiber`, atlasRow.fiber, fatSecret.fiber, mismatches);
  }

  if (mismatches.length > 0) {
    console.error("[nutrition-audit] drift detected:");
    for (const mismatch of mismatches) {
      console.error(`- ${mismatch}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(`[nutrition-audit] ok: ${AUDIT_ITEMS.length} catalog items matched Atlas and FatSecret`);
}

void main().catch((error) => {
  console.error(`[nutrition-audit] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
