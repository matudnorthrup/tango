/**
 * Wellness Agent Tools — Tool definitions and handlers for wellness worker agents.
 *
 * Converts the existing shell scripts (nutrition-helper, health-query, atlas, workout)
 * into AgentTool definitions that LLM worker agents can call via the worker-agent framework.
 *
 * Each tool has:
 *   - A name matching the tool contract ID
 *   - A description the LLM can reason about
 *   - A JSON Schema for input parameters
 *   - A handler that calls the underlying script and returns structured output
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import {
  resolveConfiguredPath,
  resolveTangoHome,
  resolveTangoProfileDir,
  type AgentTool,
} from "@tango/core";
import {
  executeNutritionLogItems,
  resolveAtlasDbPath,
} from "./nutrition-log-executor.js";

// ---------------------------------------------------------------------------
// Command runner (shared by all tool handlers)
// ---------------------------------------------------------------------------

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

async function runScript(
  scriptPath: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<string> {
  const result = await execCommand(process.execPath, [scriptPath, ...args], timeoutMs);
  return result.stdout.trim();
}

async function runShellCommand(
  command: string,
  args: string[],
  timeoutMs = 30_000,
): Promise<string> {
  const result = await execCommand(command, args, timeoutMs);
  return result.stdout.trim();
}

function execCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 2000).unref();
    }, timeoutMs);
    timer.unref();

    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);

      if (timedOut) {
        reject(new Error(`Command timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`));
        return;
      }

      if (code !== 0) {
        const detail = stderr.trim() || stdout.trim() || `exit code ${code}`;
        reject(new Error(`Command failed: ${command} ${args.join(" ")} (${detail})`));
        return;
      }

      resolve({ stdout, stderr, code });
    });
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Script paths (configurable)
// ---------------------------------------------------------------------------

export interface WellnessToolPaths {
  healthScript?: string;
  nutritionScript?: string;
  fatsecretApiScript?: string;
  atlasCommand?: string;
  atlasDbPath?: string;
  workoutScript?: string;
  recipesDir?: string;
}

function resolveExistingOrFallback(candidates: string[], fallback: string): string {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return fallback;
}

function resolveConfiguredOrFallback(
  configured: string | undefined,
  candidates: string[],
  fallback: string,
): string {
  const normalized = configured?.trim();
  if (normalized && normalized.length > 0) {
    return resolveConfiguredPath(normalized);
  }
  return resolveExistingOrFallback(candidates, fallback);
}

function resolvePaths(overrides?: WellnessToolPaths) {
  const home = os.homedir();
  const tangoHome = resolveTangoHome();
  const profileDir = resolveTangoProfileDir();
  const genericHealthScript = path.join(tangoHome, "tools/health-data/scripts/health-query.js");
  const legacyHealthScript = path.join(home, "clawd/skills/health-data/scripts/health-query.js");
  const genericNutritionScript = path.join(tangoHome, "tools/nutrition-coach/scripts/nutrition-helper.js");
  const legacyNutritionScript = path.join(home, "clawd/skills/nutrition-coach/scripts/nutrition-helper.js");
  const genericFatsecretApiScript = path.join(tangoHome, "tools/nutrition-coach/scripts/fatsecret-api.py");
  const legacyFatsecretApiScript = path.join(home, "clawd/scripts/fatsecret-api.py");
  const genericWorkoutScript = path.join(tangoHome, "tools/workout-tracker/workout.sh");
  const legacyWorkoutScript = path.join(home, "clawd/workout-tracker/workout.sh");
  const genericRecipesDir = path.join(profileDir, "notes", "recipes");
  const legacyRecipesDir = path.join(home, "Documents/main/Records/Nutrition/Recipes");
  const resolvedAtlasCommand = overrides?.atlasCommand ?? resolveConfiguredOrFallback(
    process.env.TANGO_ATLAS_COMMAND,
    [path.join(home, "bin/atlas")],
    path.join(home, "bin/atlas"),
  );
  return {
    healthScript: overrides?.healthScript ?? resolveConfiguredOrFallback(
      process.env.TANGO_HEALTH_SCRIPT,
      [genericHealthScript, legacyHealthScript],
      genericHealthScript,
    ),
    nutritionScript: overrides?.nutritionScript ?? resolveConfiguredOrFallback(
      process.env.TANGO_NUTRITION_SCRIPT,
      [genericNutritionScript, legacyNutritionScript],
      genericNutritionScript,
    ),
    fatsecretApiScript: overrides?.fatsecretApiScript ?? resolveConfiguredOrFallback(
      process.env.TANGO_FATSECRET_API_SCRIPT,
      [genericFatsecretApiScript, legacyFatsecretApiScript],
      genericFatsecretApiScript,
    ),
    atlasCommand: resolvedAtlasCommand,
    atlasDbPath: overrides?.atlasDbPath ?? resolveConfiguredOrFallback(
      process.env.TANGO_ATLAS_DB_PATH,
      [resolveAtlasDbPath(resolvedAtlasCommand)],
      resolveAtlasDbPath(resolvedAtlasCommand),
    ),
    workoutScript: overrides?.workoutScript ?? resolveConfiguredOrFallback(
      process.env.TANGO_WORKOUT_SCRIPT,
      [genericWorkoutScript, legacyWorkoutScript],
      genericWorkoutScript,
    ),
    recipesDir: overrides?.recipesDir ?? resolveConfiguredOrFallback(
      process.env.TANGO_RECIPES_DIR,
      [genericRecipesDir, legacyRecipesDir],
      genericRecipesDir,
    ),
  };
}

const FATSECRET_WRITE_METHODS_SET = new Set([
  "food_entry_create",
  "food_entry_edit",
  "food_entry_delete",
]);
const FATSECRET_REQUIRED_PARAMS: Record<string, string[]> = {
  food_find_id_for_barcode: ["barcode"],
  foods_search: ["search_expression"],
  food_get: ["food_id"],
  food_entry_create: ["food_id", "food_entry_name", "serving_id", "number_of_units", "meal"],
  food_entry_edit: ["food_entry_id"],
  food_entry_delete: ["food_entry_id"],
};

export async function callFatsecretApi(
  method: string,
  params: Record<string, unknown> = {},
  overrides?: WellnessToolPaths,
): Promise<unknown> {
  const paths = resolvePaths(overrides);
  const stdout = await runPythonScript(paths.fatsecretApiScript, [method, JSON.stringify(params)]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { result: stdout };
  }

  // Normalize write responses so the LLM gets an unambiguous confirmation.
  // food_entry_create returns {"value": "<id>"} on success — which the LLM
  // can misread as inconclusive.
  if (FATSECRET_WRITE_METHODS_SET.has(method)) {
    if (parsed && typeof parsed === "object" && "value" in (parsed as Record<string, unknown>)) {
      return { success: true, method, food_entry_id: (parsed as Record<string, unknown>).value };
    }
    // Null/empty response from delete/edit also indicates success
    if (parsed == null || (typeof parsed === "object" && Object.keys(parsed as object).length === 0)) {
      return { success: true, method };
    }
  }

  return parsed;
}

function validateFatsecretParams(method: string, params: Record<string, unknown>): void {
  const required = FATSECRET_REQUIRED_PARAMS[method.trim()];
  if (!required || required.length === 0) {
    return;
  }
  const missing = required.filter((key) => {
    const value = params[key];
    if (value === null || value === undefined) {
      return true;
    }
    if (typeof value === "string") {
      return value.trim().length === 0;
    }
    return false;
  });
  if (missing.length > 0) {
    throw new Error(`fatsecret_api.${method} requires params: ${missing.join(", ")}`);
  }
}

export async function callRecipeWrite(
  name: string,
  content: string,
  overrides?: WellnessToolPaths,
): Promise<unknown> {
  const paths = resolvePaths(overrides);
  const filename = `${name}.md`;
  const filepath = path.join(paths.recipesDir, filename);
  const existed = fs.existsSync(filepath);
  fs.writeFileSync(filepath, content, "utf8");
  return { success: true, action: existed ? "updated" : "created", file: filename };
}

function normalizeRecipeSearchText(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => canonicalizeRecipeToken(token));
}

function canonicalizeRecipeToken(token: string): string {
  if (token.length <= 3) {
    return token;
  }
  if (token.endsWith("ies")) {
    return token;
  }
  if (token.endsWith("s") && !token.endsWith("ss")) {
    return token.slice(0, -1);
  }
  return token;
}

function extractRecipeLookupText(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("obsidian://")) {
    return trimmed;
  }

  try {
    const url = new URL(trimmed.split(/\s+/u, 1)[0] ?? trimmed);
    const fileParam = url.searchParams.get("file");
    if (!fileParam) {
      return trimmed;
    }
    const decoded = decodeURIComponent(fileParam);
    const filename = decoded.split("/").pop() ?? decoded;
    return filename.replace(/\.md$/iu, "");
  } catch {
    return trimmed;
  }
}

function buildRecipeSearchCorpus(title: string, content: string): Set<string> {
  return new Set(normalizeRecipeSearchText(`${title}\n${content}`));
}

function scoreRecipeMatch(
  queryWords: readonly string[],
  titleWords: readonly string[],
  corpusWords: ReadonlySet<string>,
): number {
  let score = 0;
  for (const word of queryWords) {
    if (titleWords.includes(word)) {
      score += 3;
      continue;
    }
    if (corpusWords.has(word)) {
      score += 1;
    }
  }
  return score;
}

async function runPythonScript(
  scriptPath: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<string> {
  const tangoHome = resolveTangoHome();
  const venvPython = resolveConfiguredOrFallback(
    process.env.TANGO_FATSECRET_PYTHON,
    [
      path.join(tangoHome, "tools/nutrition-coach/venv/bin/python"),
      path.join(os.homedir(), "clawd/fatsecret-venv/bin/python"),
    ],
    path.join(tangoHome, "tools/nutrition-coach/venv/bin/python"),
  );
  const result = await execCommand(venvPython, [scriptPath, ...args], timeoutMs);
  return result.stdout.trim();
}

// ---------------------------------------------------------------------------
// Nutrition tools
// ---------------------------------------------------------------------------

export function createNutritionTools(overrides?: WellnessToolPaths): AgentTool[] {
  const paths = resolvePaths(overrides);

  return [
    {
      name: "nutrition_log_items",
      description: [
        "Fast Atlas-backed nutrition diary logger for common meal entries.",
        "Use this as the primary write path when the food items are likely to exist in the Atlas ingredient catalog.",
        "It resolves Atlas matches, derives FatSecret units, writes the diary entries, and refreshes the day once.",
        "If an item is not in Atlas or the quantity cannot be derived safely, the tool returns unresolved items instead of guessing.",
        "",
        "Inputs:",
        "  items: [{ name, quantity }]",
        "  meal: breakfast|lunch|dinner|other",
        "  date?: YYYY-MM-DD (defaults to today)",
        "  strict?: when true, do not write anything if any item is unresolved",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                quantity: { type: "string" },
              },
              required: ["name", "quantity"],
            },
          },
          meal: {
            type: "string",
            enum: ["breakfast", "lunch", "dinner", "other"],
          },
          date: { type: "string", description: "Target date in YYYY-MM-DD format" },
          strict: { type: "boolean", description: "When true, skip all writes if any item is unresolved" },
        },
        required: ["items", "meal"],
      },
      handler: async (input) => {
        const items = Array.isArray(input.items) ? input.items : [];
        return executeNutritionLogItems(
          {
            items: items.map((item) => ({
              name: String((item as Record<string, unknown>).name ?? ""),
              quantity: String((item as Record<string, unknown>).quantity ?? ""),
            })),
            meal: String(input.meal),
            date: typeof input.date === "string" ? input.date : undefined,
            strict: typeof input.strict === "boolean" ? input.strict : undefined,
          },
          {
            atlasDbPath: paths.atlasDbPath,
            fatsecretCall: (method, params) =>
              callFatsecretApi(method, params, { fatsecretApiScript: paths.fatsecretApiScript }),
          },
        );
      },
    },

    {
      name: "fatsecret_api",
      description:
        `Universal FatSecret API tool. Calls any FatSecret REST API method and returns raw JSON.

## Usage
Provide a method name and a JSON params object. Returns the full API response.

## Common Methods

### Reading diary
- **food_entries_get(date?)** — Get all diary entries for a date. Returns array with food_entry_id, food_entry_name, calories, protein, carbohydrate, fat, meal, serving_id, number_of_units, food_id. Date format: YYYY-MM-DD (defaults to today).
- **food_entries_get_month(date?)** — Get entry summary for a whole month.

### Writing diary
- **food_entry_create(food_id, food_entry_name, serving_id, number_of_units, meal, date?)** — Log a food entry. meal: "breakfast"|"lunch"|"dinner"|"other". number_of_units is decimal (e.g. 1.818 for 100g when serving is 55g).
- **food_entry_edit(food_entry_id, entry_name?, serving_id?, num_units?, meal?)** — Edit an existing entry.
- **food_entry_delete(food_entry_id)** — Delete an entry by its food_entry_id.

### Searching foods
- **foods_search(search_expression, max_results?)** — Search by name. Returns food_id, food_name, food_description. NOTE: param is search_expression not query.
- **food_get(food_id)** — Get full food details including all servings with serving_id, serving_description, metric_serving_amount, calories, protein, fat, carbohydrate.
- **food_find_id_for_barcode(barcode)** — Look up food by barcode.
- **foods_get_most_eaten(meal?)** — Most frequently logged foods.
- **foods_get_recently_eaten(meal?)** — Recently logged foods.

## Workflow: Logging food
1. foods_search to find food_id
2. food_get to see servings (get serving_id, metric_serving_amount)
3. Calculate number_of_units from the selected serving definition:
   - If the serving is a single portion with \`number_of_units = 1\` and \`metric_serving_amount = 55 g\`, use \`target_grams / 55\`.
   - If the serving itself is gram-denominated, such as \`serving_description = 100 g\` with \`measurement_description = g\` and \`number_of_units = 100\`, pass grams directly. Example: \`140 g\` should use \`number_of_units = 140\`, not \`1.4\`.
4. food_entry_create to log

## Workflow: Deleting entries
1. food_entries_get with date to see all entries (includes food_entry_id)
2. food_entry_delete with the food_entry_id`,
      inputSchema: {
        type: "object",
        properties: {
          method: { type: "string", description: "FatSecret API method name (e.g. 'foods_search', 'food_entries_get', 'food_entry_create')" },
          params: { type: "object", description: "Method parameters as JSON object (e.g. {\"search_expression\": \"chicken\"})" },
        },
        required: ["method"],
      },
      handler: async (input) => {
        const method = String(input.method);
        let params: Record<string, unknown> =
          input.params && typeof input.params === "object" && !Array.isArray(input.params)
            ? input.params as Record<string, unknown>
            : {};
        // Fallback: if the LLM placed API parameters at the top level instead
        // of nesting them inside `params`, gather them so the call still works.
        if (Object.keys(params).length === 0) {
          const { method: _m, params: _p, ...rest } = input as Record<string, unknown>;
          if (Object.keys(rest).length > 0) {
            params = rest;
          }
        }
        validateFatsecretParams(method, params);
        return callFatsecretApi(method, params, {
          fatsecretApiScript: paths.fatsecretApiScript,
        });
      },
    },

  ];
}

// ---------------------------------------------------------------------------
// Health tools
// ---------------------------------------------------------------------------

export function createHealthTools(overrides?: WellnessToolPaths): AgentTool[] {
  const paths = resolvePaths(overrides);

  return [
    {
      name: "health_query",
      description: [
        "Query Apple Health data from MongoDB. One universal tool — pick the command that fits the question.",
        "",
        "Commands:",
        "  recovery  — Sleep + HRV + RHR + weight + 7-day trend comparison. Default for 'how did I sleep?' questions.",
        "  date      — Full day activity: steps, exercise, workouts, active/basal cal, TDEE, RHR, weight, BP.",
        "  morning   — Combined briefing: last night's sleep + yesterday's activity + today's vitals.",
        "  checkin   — Today's activity snapshot so far (steps, exercise, calories, TDEE).",
        "  trend     — Multi-day trends with averages. Use 'days' param (default 7). Any range is valid — use whatever the question requires.",
        "  sleep     — Detailed sleep stages + HRV + RHR for a specific night.",
        "  compare   — Side-by-side Apple Watch vs Zepp data for a night: sleep stages, HRV, RHR, overnight HR. Shows deltas.",
        "",
        "Parameters:",
        "  command (required): One of: recovery, date, morning, checkin, trend, sleep, compare",
        "  date (optional): YYYY-MM-DD, 'today', or 'yesterday'. Used by: recovery, date, sleep. Defaults vary by command.",
        "  days (optional): Number of days for trend command. Default: 7.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Query command: recovery, date, morning, checkin, trend, sleep, compare",
            enum: ["recovery", "date", "morning", "checkin", "trend", "sleep", "compare"],
          },
          date: { type: "string", description: "Date in YYYY-MM-DD format, or 'today'/'yesterday'. Used by recovery, date, sleep commands." },
          days: { type: "number", description: "Number of days for trend command (default: 7)." },
        },
        required: ["command"],
      },
      handler: async (input) => {
        const command = String(input.command);
        const args: string[] = [];

        switch (command) {
          case "recovery":
            args.push("--recovery");
            if (input.date) args.push("--date", String(input.date));
            break;
          case "date":
            args.push("--date", input.date ? String(input.date) : new Date().toISOString().slice(0, 10));
            break;
          case "morning":
            args.push("--morning");
            break;
          case "checkin":
            args.push("--checkin");
            break;
          case "trend": {
            const days = typeof input.days === "number" && input.days > 0 ? Math.round(input.days) : 7;
            args.push("--trend", String(days));
            break;
          }
          case "sleep":
            args.push("--sleep", input.date ? String(input.date) : "last-night");
            break;
          case "compare":
            args.push("--compare", input.date ? String(input.date) : "last-night");
            break;
          default:
            return { error: `Unknown command: ${command}. Use: recovery, date, morning, checkin, trend, sleep` };
        }

        const stdout = await runScript(paths.healthScript, args);
        return JSON.parse(stdout);
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Workout tools
// ---------------------------------------------------------------------------

export function createWorkoutTools(overrides?: WellnessToolPaths): AgentTool[] {
  const paths = resolvePaths(overrides);

  return [
    {
      name: "workout_sql",
      description: [
        "Run any SQL against the workout Postgres database — reads and writes.",
        "Schema:",
        "  workouts (id serial, date date, workout_type text, started_at timestamptz, ended_at timestamptz, bodyweight_lbs numeric, notes text)",
        "  sets (id serial, workout_id int FK, exercise_id int FK, exercise_order int, set_number int, weight_lbs numeric, reps int, rpe numeric 1-10, volume numeric GENERATED weight*reps, notes text)",
        "  exercises (id serial, name text UNIQUE, muscle_group text, movement_pattern text, equipment text, aliases text[])",
        "Common patterns:",
        "  Start workout: INSERT INTO workouts (date, workout_type) VALUES (CURRENT_DATE, 'push') RETURNING id;",
        "  Find exercise: SELECT id, name FROM exercises WHERE name ILIKE '%bench%';",
        "  Log a set: INSERT INTO sets (workout_id, exercise_id, exercise_order, set_number, weight_lbs, reps) VALUES (11, 22, 1, 1, 135, 12) RETURNING id, volume;",
        "  End workout: UPDATE workouts SET ended_at = now() WHERE id = 11;",
        "  Active workout: SELECT * FROM workouts WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1;",
        "Safety: DROP, ALTER, CREATE, and TRUNCATE are blocked.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          sql: { type: "string", description: "SQL query to run against the workout database" },
        },
        required: ["sql"],
      },
      handler: async (input) => {
        const query = String(input.sql).trim();
        if (/^\s*(DROP|ALTER|CREATE|TRUNCATE)/i.test(query)) {
          return { error: "Schema modifications are not allowed." };
        }
        const stdout = await runShellCommand(paths.workoutScript, ["sql", query]);
        return { result: stdout };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Recipe tools
// ---------------------------------------------------------------------------

export function createRecipeTools(overrides?: WellnessToolPaths): AgentTool[] {
  const paths = resolvePaths(overrides);

  return [
    {
      name: "atlas_sql",
      description: [
        "Run any SQL against the Atlas SQLite database — reads and writes.",
        "Schema:",
        "  ingredients (id INTEGER PK, name TEXT, brand TEXT, product TEXT, food_id INTEGER, serving_id INTEGER, serving_description TEXT, serving_size TEXT, grams_per_serving REAL, calories REAL, protein REAL, carbs REAL, fat REAL, fiber REAL, store TEXT, aliases TEXT JSON, tags TEXT JSON, notes TEXT, meta TEXT JSON, created_at TEXT, updated_at TEXT)",
        "Indexes: name, food_id, brand, store.",
        "aliases is a JSON array of strings — alternate names for the ingredient (e.g. '[\"vanilla yogurt\",\"light yogurt\"]').",
        "Common patterns:",
        "  Find ingredient: SELECT * FROM ingredients WHERE name LIKE '%chicken%' OR aliases LIKE '%chicken%';",
        "  Get food_id for logging: SELECT food_id, serving_id, grams_per_serving, calories, protein FROM ingredients WHERE name LIKE '%yogurt%';",
        "  Add ingredient: INSERT INTO ingredients (name, food_id, serving_id, grams_per_serving, calories, protein, carbs, fat, fiber, aliases) VALUES ('Greek Yogurt', 123, 456, 170, 100, 17, 6, 0.7, 0, '[\"greek yogurt\",\"plain yogurt\"]');",
        "  Portion calc: target_grams / grams_per_serving = number_of_units for FatSecret logging.",
        "Safety: DROP, ALTER, CREATE, and TRUNCATE are blocked.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          sql: { type: "string", description: "SQL query to run against the Atlas database" },
        },
        required: ["sql"],
      },
      handler: async (input) => {
        const query = String(input.sql).trim();
        if (/^\s*(DROP|ALTER|CREATE|TRUNCATE)/i.test(query)) {
          return { error: "Schema modifications are not allowed." };
        }
        const stdout = await runShellCommand(paths.atlasCommand, ["sql", query]);
        return { result: stdout };
      },
    },

    {
      name: "recipe_list",
      description: "List all saved recipe files. Returns an array of recipe names (without .md extension).",
      inputSchema: {
        type: "object",
        properties: {},
      },
      handler: async () => {
        const files = fs.readdirSync(paths.recipesDir).filter((f) => f.endsWith(".md"));
        return { recipes: files.map((f) => f.replace(/\.md$/, "")) };
      },
    },

    {
      name: "recipe_read",
      description: [
        "Read a saved recipe file by name. Returns the full markdown content including YAML frontmatter with macros, ingredient list with gram amounts, and instructions.",
        "Recipe format:",
        "  YAML frontmatter: calories, protein, carbs, fat, fiber, prep_minutes, meal, tags",
        "  Sections: Macros table, Pillars, Ingredients (with gram amounts), Instructions, Notes",
        "  Ingredient lines: '- 230g Canned Chicken Breast — 185 cal, 53g P'",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Recipe name (partial match supported, case-insensitive)" },
        },
        required: ["name"],
      },
      handler: async (input) => {
        const lookupText = extractRecipeLookupText(String(input.name));
        const queryWords = normalizeRecipeSearchText(lookupText);
        const files = fs.readdirSync(paths.recipesDir).filter((f) => f.endsWith(".md"));
        const matches: Array<{ title: string; content: string; score: number }> = [];

        for (const file of files) {
          const title = file.replace(/\.md$/, "");
          const content = fs.readFileSync(path.join(paths.recipesDir, file), "utf8");
          const titleWords = normalizeRecipeSearchText(title);
          const corpusWords = buildRecipeSearchCorpus(title, content);
          if (!queryWords.every((w) => corpusWords.has(w))) continue;
          matches.push({
            title,
            content,
            score: scoreRecipeMatch(queryWords, titleWords, corpusWords),
          });
        }

        if (matches.length === 0) return { found: false, matches: [] };
        return {
          found: true,
          matches: matches
            .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
            .map(({ title, content }) => ({ title, content })),
        };
      },
    },

    {
      name: "recipe_write",
      description: [
        "Write or update a recipe file. Provide the full markdown content including YAML frontmatter.",
        "Expected format:",
        "---",
        "source: [ai/watson]",
        "created: 2026-01-28",
        "meal: [lunch]",
        "calories: 430",
        "protein: 46",
        "carbs: 35",
        "fat: 14",
        "fiber: 12",
        "prep_minutes: 3",
        "tags: [health, recipe]",
        "type: [Nutrition, Recipes]",
        "areas: [Health]",
        "---",
        "# Recipe Name",
        "## Macros",
        "| Calories | Protein | Carbs | Fat | Fiber |",
        "## Ingredients",
        "- 230g Ingredient Name — cal, protein",
        "## Instructions",
        "## Notes",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Recipe file name (without .md extension)" },
          content: { type: "string", description: "Full markdown content of the recipe" },
        },
        required: ["name", "content"],
      },
      handler: async (input) => {
        return callRecipeWrite(String(input.name), String(input.content), overrides);
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// All tools combined
// ---------------------------------------------------------------------------

export function createAllWellnessTools(overrides?: WellnessToolPaths): AgentTool[] {
  return [
    ...createNutritionTools(overrides),
    ...createHealthTools(overrides),
    ...createWorkoutTools(overrides),
    ...createRecipeTools(overrides),
  ];
}
