/**
 * Audit every Atlas ingredient row against the FatSecret serving it points at.
 *
 * Atlas stores its own macro columns, but FatSecret's numbers are what actually
 * land in the diary. When the two disagree the log is still correct and the
 * *report* is wrong, so drift is silent — it shows up as the coach quoting a
 * calorie count the diary does not contain.
 *
 * Read-only by default. `--fix` rewrites the drifted Atlas columns to match the
 * FatSecret serving each row points at (backing the database up first).
 *
 *   npm run diag:nutrition-catalog
 *   npm run diag:nutrition-catalog -- --fix
 *   npm run diag:nutrition-catalog -- --json
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { resolveConfiguredPath, resolveTangoHome } from "@tango/core";

type AtlasRow = {
  id: number;
  name: string;
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
};

type FatSecretServing = {
  serving_id?: string;
  serving_description?: string;
  measurement_description?: string;
  metric_serving_amount?: string;
  metric_serving_unit?: string;
  calories?: string;
  protein?: string;
  carbohydrate?: string;
  fat?: string;
  fiber?: string;
};

type FatSecretFood = {
  food_id?: string;
  food_name?: string;
  servings?: { serving?: FatSecretServing | FatSecretServing[] };
  servings_list?: FatSecretServing[];
};

/** Atlas column ← FatSecret serving field. */
const MACRO_FIELDS = [
  { column: "calories", fsKey: "calories", digits: 0 },
  { column: "protein", fsKey: "protein", digits: 2 },
  { column: "carbs", fsKey: "carbohydrate", digits: 2 },
  { column: "fat", fsKey: "fat", digits: 2 },
  { column: "fiber", fsKey: "fiber", digits: 2 },
] as const;

type Finding = {
  id: number;
  name: string;
  foodId: number | null;
  servingId: number | null;
  kind: "serving_missing" | "food_missing" | "drift" | "unmapped";
  detail: string[];
  updates: Record<string, string | number | null>;
};

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

function resolveAtlasDbPath(): string {
  const configured = process.env.TANGO_ATLAS_DB_PATH?.trim();
  if (configured) {
    return resolveConfiguredPath(configured);
  }
  const atlasCommand = process.env.TANGO_ATLAS_COMMAND?.trim()
    ? resolveConfiguredPath(process.env.TANGO_ATLAS_COMMAND)
    : path.join(os.homedir(), "bin/atlas");
  let resolved = atlasCommand;
  try {
    resolved = fs.realpathSync(atlasCommand);
  } catch {
    // Fall through to the unresolved path; the open below reports the failure.
  }
  return path.join(path.dirname(resolved), "atlas.db");
}

/**
 * Same resolution order the wellness tools use: explicit env override, then the
 * profile-managed location, then the legacy `~/clawd` checkout. Picking the
 * first path that exists keeps this runnable standalone, without the bot's
 * environment loaded.
 */
function resolveFirstExisting(configured: string | undefined, candidates: string[]): string {
  if (configured?.trim()) {
    return resolveConfiguredPath(configured);
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]!;
}

function resolveFatSecretRunner(): { python: string; script: string } {
  const tangoHome = resolveTangoHome();
  const home = os.homedir();
  return {
    python: resolveFirstExisting(process.env.TANGO_FATSECRET_PYTHON, [
      path.join(tangoHome, "tools/nutrition-coach/venv/bin/python"),
      path.join(home, "clawd/fatsecret-venv/bin/python"),
    ]),
    script: resolveFirstExisting(process.env.TANGO_FATSECRET_API_SCRIPT, [
      path.join(tangoHome, "tools/nutrition-coach/scripts/fatsecret-api.py"),
      path.join(home, "clawd/scripts/fatsecret-api.py"),
    ]),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** FatSecret throttles bursts ("Error 12"); back off rather than reporting a
 *  reachable food as missing. */
function isRateLimited(message: string): boolean {
  return /too many actions|error 12\b/iu.test(message);
}

async function queryFatSecret(foodId: number): Promise<FatSecretFood | null> {
  const { python, script } = resolveFatSecretRunner();
  let lastError = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let stdout = "";
    try {
      stdout = await runCommand(python, [script, "food_get", JSON.stringify({ food_id: foodId })]);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (!isRateLimited(lastError)) {
        throw new Error(lastError);
      }
      await sleep(1500 * (attempt + 1));
      continue;
    }
    if (!stdout) {
      return null;
    }
    const parsed = JSON.parse(stdout) as FatSecretFood & { error?: string };
    if (!parsed.error) {
      return parsed;
    }
    lastError = parsed.error;
    if (!isRateLimited(lastError)) {
      throw new Error(lastError);
    }
    await sleep(1500 * (attempt + 1));
  }
  throw new Error(lastError || "FatSecret lookup failed");
}

function listServings(food: FatSecretFood | null): FatSecretServing[] {
  if (!food) {
    return [];
  }
  const serving = food.servings?.serving;
  if (Array.isArray(serving)) {
    return serving;
  }
  if (serving && typeof serving === "object") {
    return [serving];
  }
  return Array.isArray(food.servings_list) ? food.servings_list : [];
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

function round(value: number, digits: number): number {
  return Number.parseFloat(value.toFixed(digits));
}

/**
 * Atlas may express a row per-gram (grams_per_serving = 1) rather than per
 * FatSecret serving. That is self-consistent for reporting, so compare on a
 * per-gram basis and only flag a genuine nutritional disagreement.
 */
function perGram(value: number | null, gramsPerServing: number | null): number | null {
  if (value === null || !gramsPerServing) {
    return null;
  }
  return value / gramsPerServing;
}

function auditRow(row: AtlasRow, food: FatSecretFood | null): Finding | null {
  if (row.food_id === null || row.serving_id === null) {
    return {
      id: row.id,
      name: row.name,
      foodId: row.food_id,
      servingId: row.serving_id,
      kind: "unmapped",
      detail: ["row has no food_id/serving_id, so it cannot be logged to FatSecret"],
      updates: {},
    };
  }
  if (!food) {
    return {
      id: row.id,
      name: row.name,
      foodId: row.food_id,
      servingId: row.serving_id,
      kind: "food_missing",
      detail: ["FatSecret returned no food for this food_id"],
      updates: {},
    };
  }

  const servings = listServings(food);
  const serving = servings.find((entry) => String(entry.serving_id) === String(row.serving_id));
  if (!serving) {
    const available = servings
      .map((entry) => `${entry.serving_id} (${entry.serving_description ?? "?"})`)
      .join(", ");
    return {
      id: row.id,
      name: row.name,
      foodId: row.food_id,
      servingId: row.serving_id,
      kind: "serving_missing",
      detail: [
        `serving_id ${row.serving_id} no longer exists on "${food.food_name ?? "?"}"`,
        `available: ${available || "(none)"}`,
      ],
      updates: {},
    };
  }

  const detail: string[] = [];
  const updates: Record<string, string | number | null> = {};

  const metricAmount = parseFiniteNumber(serving.metric_serving_amount);
  const metricUnit = (serving.metric_serving_unit ?? "").trim().toLowerCase();
  const isGramServing = metricUnit === "g";

  // grams_per_serving drives both the write amount and the macro scaling, so a
  // wrong value silently changes how much food gets logged.
  if (isGramServing && metricAmount !== null && row.grams_per_serving !== null) {
    const consistentPerGram = Math.abs(row.grams_per_serving - metricAmount) > 0.51
      && Math.abs((row.calories ?? 0) / row.grams_per_serving
        - (parseFiniteNumber(serving.calories) ?? 0) / metricAmount) < 0.005;
    if (Math.abs(row.grams_per_serving - metricAmount) > 0.51 && !consistentPerGram) {
      detail.push(`grams_per_serving ${row.grams_per_serving} vs FatSecret ${metricAmount}g`);
      updates.grams_per_serving = metricAmount;
    }
  }

  // Compare per gram so a per-gram row is not reported as drift against a
  // per-100g serving. Scale FatSecret's values onto the row's own serving basis
  // when writing the fix, so the row's representation is preserved.
  const basis = updates.grams_per_serving !== undefined
    ? (updates.grams_per_serving as number)
    : row.grams_per_serving;
  for (const field of MACRO_FIELDS) {
    const atlasValue = row[field.column as keyof AtlasRow] as number | null;
    const fsValue = parseFiniteNumber(serving[field.fsKey as keyof FatSecretServing]);
    if (fsValue === null) {
      continue;
    }
    if (!isGramServing || metricAmount === null || !basis) {
      // No gram basis to normalise on: compare the serving values directly.
      if (atlasValue !== null && Math.abs(atlasValue - fsValue) > 0.051) {
        detail.push(`${field.column} ${atlasValue} vs FatSecret ${fsValue}`);
        updates[field.column] = round(fsValue, field.digits);
      }
      continue;
    }
    const atlasPerGram = perGram(atlasValue, basis);
    const fsPerGram = perGram(fsValue, metricAmount);
    if (fsPerGram === null) {
      continue;
    }
    if (atlasPerGram === null) {
      detail.push(`${field.column} missing (FatSecret ${fsValue} per ${metricAmount}g)`);
      updates[field.column] = round(fsPerGram * basis, field.digits);
      continue;
    }
    const tolerance = Math.max(Math.abs(fsPerGram) * 0.02, 0.0005);
    if (Math.abs(atlasPerGram - fsPerGram) > tolerance) {
      const line = `${field.column} ${round(atlasPerGram * 100, 2)}/100g vs FatSecret ${round(fsPerGram * 100, 2)}/100g`;
      // A FatSecret zero against a substantial Atlas value is far more often an
      // incomplete community submission than a real zero (chia seeds listing
      // 0 g carbohydrate, say). Report it, but never overwrite real data with
      // it — that needs a human deciding whether to repoint the food.
      if (fsPerGram === 0 && atlasPerGram > 0.005) {
        detail.push(`${line}  [suspect FatSecret zero — review, not auto-synced]`);
        continue;
      }
      detail.push(line);
      updates[field.column] = round(fsPerGram * basis, field.digits);
    }
  }

  // A blank serving_description leaves the gram-unit check with nothing to read,
  // so the writer has to assume a serving count. Fill it from FatSecret.
  const atlasDesc = (row.serving_description ?? "").trim();
  const fsDesc = (serving.serving_description ?? "").trim();
  if (fsDesc && !atlasDesc) {
    detail.push(`serving_description blank (FatSecret "${fsDesc}")`);
    updates.serving_description = fsDesc;
  }

  if (detail.length === 0) {
    return null;
  }
  return {
    id: row.id,
    name: row.name,
    foodId: row.food_id,
    servingId: row.serving_id,
    kind: "drift",
    detail,
    updates,
  };
}

function backupDatabase(dbPath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const backupPath = `${dbPath}.bak-catalog-${stamp}`;
  fs.copyFileSync(dbPath, backupPath);
  return backupPath;
}

async function main(): Promise<void> {
  const applyFixes = process.argv.includes("--fix");
  const asJson = process.argv.includes("--json");
  const dbPath = resolveAtlasDbPath();

  const db = new DatabaseSync(dbPath, { readOnly: !applyFixes });
  const rows = db
    .prepare(
      `SELECT id, name, food_id, serving_id, serving_description, serving_size,
              grams_per_serving, calories, protein, carbs, fat, fiber
       FROM ingredients ORDER BY name`,
    )
    .all() as unknown as AtlasRow[];

  const foodCache = new Map<number, FatSecretFood | null>();
  const lookupErrors = new Map<number, string>();
  const findings: Finding[] = [];

  for (const row of rows) {
    let food: FatSecretFood | null = null;
    if (row.food_id !== null) {
      if (!foodCache.has(row.food_id)) {
        try {
          foodCache.set(row.food_id, await queryFatSecret(row.food_id));
        } catch (error) {
          foodCache.set(row.food_id, null);
          lookupErrors.set(row.food_id, error instanceof Error ? error.message : String(error));
        }
      }
      food = foodCache.get(row.food_id) ?? null;
    }
    const finding = auditRow(row, food);
    if (finding) {
      if (finding.kind === "food_missing" && row.food_id !== null && lookupErrors.has(row.food_id)) {
        finding.detail.push(`lookup error: ${lookupErrors.get(row.food_id)}`);
      }
      findings.push(finding);
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ dbPath, rows: rows.length, findings }, null, 2));
  } else {
    for (const finding of findings) {
      console.error(`- [${finding.kind}] ${finding.name} (id ${finding.id}, food_id ${finding.foodId})`);
      for (const line of finding.detail) {
        console.error(`    ${line}`);
      }
    }
  }

  const fixable = findings.filter((finding) => Object.keys(finding.updates).length > 0);

  if (applyFixes && fixable.length > 0) {
    const backupPath = backupDatabase(dbPath);
    console.error(`[nutrition-audit] backed up ${dbPath} -> ${backupPath}`);
    for (const finding of fixable) {
      const columns = Object.keys(finding.updates);
      const assignments = columns.map((column) => `${column} = ?`).join(", ");
      db.prepare(`UPDATE ingredients SET ${assignments}, updated_at = datetime('now') WHERE id = ?`)
        .run(...columns.map((column) => finding.updates[column] as never), finding.id as never);
    }
    console.error(`[nutrition-audit] updated ${fixable.length} row(s)`);
  }

  db.close();

  if (findings.length > 0) {
    const unfixable = findings.length - fixable.length;
    console.error(
      `[nutrition-audit] ${findings.length} of ${rows.length} rows drifted`
        + (applyFixes ? ` (${fixable.length} repaired, ${unfixable} need manual review)` : "")
        + (!applyFixes ? " — re-run with --fix to sync them to FatSecret" : ""),
    );
    process.exitCode = applyFixes && findings.length === fixable.length ? 0 : 1;
    return;
  }

  console.log(`[nutrition-audit] ok: ${rows.length} catalog rows matched Atlas and FatSecret`);
}

void main().catch((error) => {
  console.error(`[nutrition-audit] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
