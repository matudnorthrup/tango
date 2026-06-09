/**
 * Wellness Agent Tools — Tool definitions and handlers for wellness MCP access.
 *
 * Converts the existing shell scripts (nutrition-helper, health-query, atlas, workout)
 * into AgentTool definitions that V2 runtimes can call through the wellness MCP server.
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
  fatsecretBatchScript?: string;
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

export function resolveWellnessToolPaths(overrides?: WellnessToolPaths) {
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
    fatsecretBatchScript: overrides?.fatsecretBatchScript ?? path.join(
      tangoHome,
      "packages/discord/scripts/fatsecret-batch.py",
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
  const paths = resolveWellnessToolPaths(overrides);
  const stdout = await runPythonScript(paths.fatsecretApiScript, [method, JSON.stringify(params)]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { result: stdout };
  }
  return normalizeFatsecretResult(method, parsed);
}

export async function callFatsecretApiBatch(
  calls: Array<{ method: string; params?: Record<string, unknown> }>,
  overrides?: WellnessToolPaths,
): Promise<Array<{ ok: boolean; result?: unknown; error?: string }>> {
  const paths = resolveWellnessToolPaths(overrides);
  for (const call of calls) {
    validateFatsecretParams(call.method, call.params ?? {});
  }

  const stdout = await runPythonScript(paths.fatsecretBatchScript, [JSON.stringify(calls)]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`FatSecret batch returned invalid JSON: ${stdout}`);
  }

  const results = asRecord(parsed)?.results;
  if (!Array.isArray(results)) {
    throw new Error(`FatSecret batch returned an invalid payload: ${stdout}`);
  }

  return results.map((entry, index) => {
    const record = asRecord(entry);
    if (!record) {
      return { ok: false, error: `Batch entry ${index + 1} was not an object.` };
    }
    if (record.ok !== true) {
      return {
        ok: false,
        error: typeof record.error === "string" ? record.error : `Batch entry ${index + 1} failed.`,
      };
    }

    const call = calls[index];
    return {
      ok: true,
      result: normalizeFatsecretResult(call?.method ?? "", record.result),
    };
  });
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

function normalizeFatsecretResult(method: string, parsed: unknown): unknown {
  if (FATSECRET_WRITE_METHODS_SET.has(method)) {
    if (parsed && typeof parsed === "object" && "value" in (parsed as Record<string, unknown>)) {
      return { success: true, method, food_entry_id: (parsed as Record<string, unknown>).value };
    }
    if (parsed == null || (typeof parsed === "object" && Object.keys(parsed as object).length === 0)) {
      return { success: true, method };
    }
  }
  return parsed;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export async function callRecipeWrite(
  name: string,
  content: string,
  overrides?: WellnessToolPaths,
): Promise<unknown> {
  const paths = resolveWellnessToolPaths(overrides);
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
  const paths = resolveWellnessToolPaths(overrides);

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
              callFatsecretApi(method, params, {
                fatsecretApiScript: paths.fatsecretApiScript,
                fatsecretBatchScript: paths.fatsecretBatchScript,
              }),
            fatsecretBatchCall: (calls) =>
              callFatsecretApiBatch(calls, {
                fatsecretApiScript: paths.fatsecretApiScript,
                fatsecretBatchScript: paths.fatsecretBatchScript,
              }),
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
   - Usually \`number_of_units\` means "how many selected servings to log."
   - For non-gram servings such as \`1 cup\` or \`2 tbsp\`, derive serving count from the target amount.
   - Special case: if FatSecret marks the serving itself in grams, such as \`serving_description = 100 g\` with \`measurement_description = g\`, send raw grams. Example: \`140 g\` should use \`number_of_units = 140\`, not \`1.4\`.
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
  const paths = resolveWellnessToolPaths(overrides);

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
        "  source_breakdown — Diagnostic source totals/freshness for a day. Use when a tracker disagrees or a source looks stale; do not add sources into canonical totals blindly.",
        "",
        "Parameters:",
        "  command (required): One of: recovery, date, morning, checkin, trend, sleep, compare, source_breakdown",
        "  date (optional): YYYY-MM-DD, 'today', or 'yesterday'. Used by: date, sleep, compare, source_breakdown. Defaults vary by command.",
        "  days (optional): Number of days for trend command. Default: 7.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "Query command: recovery, date, morning, checkin, trend, sleep, compare, source_breakdown",
            enum: ["recovery", "date", "morning", "checkin", "trend", "sleep", "compare", "source_breakdown"],
          },
          date: { type: "string", description: "Date in YYYY-MM-DD format, or 'today'/'yesterday'. Used by date, sleep, compare, and source_breakdown commands." },
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
            args.push("--date", input.date ? String(input.date) : new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }));
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
          case "source_breakdown":
            args.push("--source-breakdown", input.date ? String(input.date) : "today");
            break;
          default:
            return { error: `Unknown command: ${command}. Use: recovery, date, morning, checkin, trend, sleep, compare, source_breakdown` };
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
  const paths = resolveWellnessToolPaths(overrides);

  return [
    {
      name: "workout_sql",
      description: [
        "Run SQL against the workout Postgres database — reads and writes.",
        "",
        "PREFERRED for logging a workout: action:'log_workout' — pass structured params and the",
        "tool builds all the SQL for you (creates the workout, resolves the routine + each exercise",
        "by name/alias, inserts every set). You do NOT write SQL or look up ids. Shape:",
        "  { action:'log_workout', routine?:'Push Day A', date?:'today'|'YYYY-MM-DD', notes?:'...',",
        "    exercises:[ { exercise:'Bench Press', sets:[ {weight:135, reps:12, rpe?:8}, {weight:135, reps:10} ] }, ... ] }",
        "Returns workout_id, sets_logged, and unmatched_exercises (names that didn't resolve — fix the",
        "name or create the exercise first). Use raw `sql` only for reads or edits log_workout can't express.",
        "",
        "Schema (for raw `sql`):",
        "  workouts (id serial, date date, workout_type text family, routine_id int FK workout_routines.id, started_at timestamptz, ended_at timestamptz, bodyweight_lbs numeric, notes text)",
        "  sets (id serial, workout_id int FK, exercise_id int FK, exercise_order int, set_number int, weight_lbs numeric, reps int, rpe numeric 1-10, volume numeric GENERATED weight*reps, notes text)",
        "  exercises (id serial, name text UNIQUE, muscle_group text, movement_pattern text, equipment text, aliases text[])",
        "  workout_routines (id serial, name text UNIQUE, workout_type text, aliases text[], notes text)",
        "  workout_routine_exercises (routine_id int FK, exercise_id int FK, position int)",
        "Common patterns:",
        "  Resolve named routine: SELECT wr.id, wr.name, wr.workout_type FROM workout_routines wr WHERE wr.name ILIKE 'Push Day A' OR EXISTS (SELECT 1 FROM unnest(wr.aliases) alias WHERE alias ILIKE '%push day a%');",
        "  Start named workout: INSERT INTO workouts (date, workout_type, routine_id) SELECT CURRENT_DATE, wr.workout_type, wr.id FROM workout_routines wr WHERE wr.name = 'Push Day A' RETURNING id, routine_id;",
        "  Historical workout: INSERT INTO workouts (date, workout_type, routine_id, notes) SELECT DATE '2024-01-15', wr.workout_type, wr.id, 'historical entry' FROM workout_routines wr WHERE wr.name = 'Leg Day Large' RETURNING id;",
        "  Find exercise: SELECT id, name FROM exercises WHERE name ILIKE '%bench%';",
        "  Named routine sequence: SELECT wr.name, string_agg(e.name, ' -> ' ORDER BY wre.position) FROM workout_routines wr JOIN workout_routine_exercises wre ON wre.routine_id = wr.id JOIN exercises e ON e.id = wre.exercise_id WHERE wr.name = 'Pull Day B' GROUP BY wr.id, wr.name;",
        "  Log a set: INSERT INTO sets (workout_id, exercise_id, exercise_order, set_number, weight_lbs, reps) VALUES (11, 22, 1, 1, 135, 12) RETURNING id, volume;",
        "  End workout: UPDATE workouts SET ended_at = now() WHERE id = 11;",
        "  End latest active workout safely: WITH target AS (SELECT id FROM workouts WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1) UPDATE workouts w SET ended_at = now() FROM target WHERE w.id = target.id RETURNING w.id, w.ended_at;",
        "  Active workout: SELECT w.*, wr.name AS routine_name FROM workouts w LEFT JOIN workout_routines wr ON wr.id = w.routine_id WHERE w.ended_at IS NULL ORDER BY w.started_at DESC LIMIT 1;",
        "Safety: DROP, ALTER, CREATE, and TRUNCATE are blocked. Do not use ORDER BY or LIMIT directly inside UPDATE statements in Postgres. workout_type is the broad family only; use workout_routines/workout_routine_exercises for named templates.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["log_workout"], description: "Set to 'log_workout' to use the structured logging path instead of raw SQL." },
          sql: { type: "string", description: "Raw SQL to run (reads, or edits log_workout can't express). Omit when action='log_workout'." },
          routine: { type: "string", description: "For log_workout: routine name (e.g. 'Push Day A'); resolved by name or alias. Optional." },
          date: { type: "string", description: "For log_workout: 'today' (default), 'yesterday', or 'YYYY-MM-DD'." },
          notes: { type: "string", description: "For log_workout: optional workout notes." },
          exercises: {
            type: "array",
            description: "For log_workout: [{ exercise:'Bench Press', sets:[{weight,reps,rpe?}] }]",
            items: {
              type: "object",
              properties: {
                exercise: { type: "string" },
                sets: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      weight: { type: "number" },
                      reps: { type: "number" },
                      rpe: { type: "number" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      handler: async (input) => {
        // Structured logging path: build the multi-table SQL server-side so the model
        // never has to hand-write INSERTs, resolve routine_id, or look up exercise_ids.
        // One call: create the workout, resolve each exercise by name/alias, insert all
        // sets, report sets logged + any unmatched exercise names.
        if (String(input.action ?? "").trim().toLowerCase() === "log_workout") {
          const built = buildLogWorkoutSql(input);
          if ("error" in built) return built;
          const stdout = await runShellCommand(paths.workoutScript, ["sql", built.sql]);
          return { result: stdout, logged: true };
        }

        const query = String(input.sql).trim();
        if (!query) {
          return { error: "Provide 'sql', or action:'log_workout' with structured params." };
        }
        if (/^\s*(DROP|ALTER|CREATE|TRUNCATE)/i.test(query)) {
          return { error: "Schema modifications are not allowed." };
        }
        const stdout = await runShellCommand(paths.workoutScript, ["sql", query]);
        return { result: stdout };
      },
    },
  ];
}

// SQL-string and number escaping for the structured log_workout builder (the workout
// script takes a raw SQL string, so values must be escaped, not parameterized).
function workoutSqlStr(value: unknown): string {
  return `'${String(value).replace(/'/g, "''")}'`;
}
function workoutSqlNum(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : "NULL";
}

// Build one CTE statement that logs a full workout: insert the workout (resolving a named
// routine via LATERAL LIMIT 1 so an ambiguous/absent name still yields exactly one row),
// resolve each set's exercise by name/alias, insert matched sets, and return a summary
// row (workout_id, sets_logged, unmatched_exercises). No stdout parsing needed.
function buildLogWorkoutSql(
  input: Record<string, unknown>,
): { sql: string } | { error: string } {
  const exercises = Array.isArray(input.exercises) ? input.exercises : [];
  if (exercises.length === 0) {
    return { error: "log_workout needs 'exercises': [{ exercise, sets: [{ weight, reps, rpe? }] }]." };
  }

  const dateRaw = typeof input.date === "string" ? input.date.trim().toLowerCase() : "";
  const dateExpr = !dateRaw || dateRaw === "today"
    ? "CURRENT_DATE"
    : dateRaw === "yesterday"
      ? "CURRENT_DATE - 1"
      : /^\d{4}-\d{2}-\d{2}$/.test(dateRaw)
        ? `DATE ${workoutSqlStr(dateRaw)}`
        : "CURRENT_DATE";

  const routine = typeof input.routine === "string" && input.routine.trim() ? input.routine.trim() : null;
  const notes = typeof input.notes === "string" && input.notes.trim() ? input.notes.trim() : null;

  const rows: string[] = [];
  exercises.forEach((exRaw, exIdx) => {
    const ex = (exRaw && typeof exRaw === "object" ? exRaw : {}) as Record<string, unknown>;
    const name = String(ex.exercise ?? ex.name ?? "").trim();
    if (!name) return;
    const sets = Array.isArray(ex.sets) ? ex.sets : [];
    sets.forEach((setRaw, setIdx) => {
      const s = (setRaw && typeof setRaw === "object" ? setRaw : {}) as Record<string, unknown>;
      rows.push(
        `(${workoutSqlStr(name)}, ${exIdx + 1}, ${setIdx + 1}, ` +
        `${workoutSqlNum(s.weight ?? s.weight_lbs)}, ${workoutSqlNum(s.reps)}, ` +
        `${s.rpe != null ? workoutSqlNum(s.rpe) : "NULL"})`,
      );
    });
  });
  if (rows.length === 0) {
    return { error: "log_workout: each exercise needs a non-empty 'sets' array (e.g. sets:[{weight:135,reps:12}])." };
  }

  const routineLateral = routine
    ? `LEFT JOIN LATERAL (SELECT id, workout_type FROM workout_routines ` +
      `WHERE name ILIKE ${workoutSqlStr(routine)} OR ${workoutSqlStr(routine)} ILIKE ANY(aliases) LIMIT 1) wr ON TRUE`
    : `LEFT JOIN LATERAL (SELECT NULL::int AS id, NULL::text AS workout_type) wr ON TRUE`;

  const sql = `
WITH nw AS (
  INSERT INTO workouts (date, workout_type, routine_id, notes)
  SELECT ${dateExpr}, COALESCE(wr.workout_type, 'general'), wr.id, ${notes ? workoutSqlStr(notes) : "NULL"}
  FROM (SELECT 1) one
  ${routineLateral}
  RETURNING id
),
sd (ex_name, ex_order, set_num, weight, reps, rpe) AS ( VALUES ${rows.join(", ")} ),
resolved AS (
  SELECT sd.*, e.id AS exercise_id
  FROM sd
  LEFT JOIN exercises e ON e.name ILIKE sd.ex_name OR sd.ex_name ILIKE ANY(e.aliases)
),
ins AS (
  INSERT INTO sets (workout_id, exercise_id, exercise_order, set_number, weight_lbs, reps, rpe)
  SELECT nw.id, r.exercise_id, r.ex_order, r.set_num, r.weight, r.reps, r.rpe
  FROM resolved r CROSS JOIN nw
  WHERE r.exercise_id IS NOT NULL
  RETURNING id
)
SELECT (SELECT id FROM nw) AS workout_id,
       (SELECT count(*) FROM ins) AS sets_logged,
       COALESCE((SELECT string_agg(DISTINCT ex_name, ', ') FROM resolved WHERE exercise_id IS NULL), '') AS unmatched_exercises
`.trim();

  return { sql };
}

// ---------------------------------------------------------------------------
// Recipe tools
// ---------------------------------------------------------------------------

export interface RecipeReadMatch {
  title: string;
  content: string;
}

export function findRecipeMatchesByQuery(
  query: string,
  overrides?: WellnessToolPaths,
): RecipeReadMatch[] {
  const paths = resolveWellnessToolPaths(overrides);
  const lookupText = extractRecipeLookupText(query);
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

  return matches
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .map(({ title, content }) => ({ title, content }));
}

export function createRecipeTools(overrides?: WellnessToolPaths): AgentTool[] {
  const paths = resolveWellnessToolPaths(overrides);

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
        const matches = findRecipeMatchesByQuery(String(input.name), overrides);
        if (matches.length === 0) return { found: false, matches: [] };
        return {
          found: true,
          matches,
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
        "date: 2026-01-28",
        "created: 2026-01-28",
        "types:",
        "  - \"[[Recipes]]\"",
        "areas:",
        "  - \"[[Health]]\"",
        "meal: [lunch]",
        "calories: 430",
        "protein: 46",
        "carbs: 35",
        "fat: 14",
        "fiber: 12",
        "prep_minutes: 3",
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
// Wellness bounded wellness file tool
// ---------------------------------------------------------------------------

const WELLNESS_FILES_READ_LIMIT = 50_000;
const WELLNESS_FILES_READONLY_SUBDIRS = ["healing-library"];

export interface WellnessFilesToolOptions {
  rootDir?: string;
}

export function resolveWellnessWellnessFilesRoot(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const home = os.homedir();
  const configured = env.WELLNESS_FILES_ROOT?.trim()
    || path.join(resolveTangoProfileDir(), "wellness");
  return path.resolve(configured.replace(/^~/, home));
}

export function isWellnessWellnessPathAllowed(resolvedPath: string, rootDir: string): boolean {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(resolvedPath);
  const relative = path.relative(root, resolved);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function isWellnessWellnessPathReadOnly(resolvedPath: string, rootDir: string): boolean {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(resolvedPath);

  for (const subdir of WELLNESS_FILES_READONLY_SUBDIRS) {
    const readonlyRoot = path.join(root, subdir);
    if (resolved === readonlyRoot || resolved.startsWith(`${readonlyRoot}${path.sep}`)) {
      return true;
    }
  }

  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }

  return relative.split(path.sep).includes("source");
}

function resolveWellnessFilesInputPath(filePath: string, rootDir: string): string {
  const home = os.homedir();
  const normalized = filePath.trim().replace(/^~/, home);
  if (path.isAbsolute(normalized)) {
    return path.resolve(normalized);
  }
  return path.resolve(rootDir, normalized);
}

export function createWellnessFilesTools(options?: WellnessFilesToolOptions): AgentTool[] {
  const rootDir = path.resolve(options?.rootDir ?? resolveWellnessWellnessFilesRoot());
  const rootLabel = rootDir.replace(os.homedir(), "~");

  return [
    {
      name: "wellness_files",
      description: [
        "Bounded file operations for Wellness's wellness workspace.",
        "",
        `Allowed root: ${rootLabel}`,
        "Read-only areas: healing-library/ and any path containing /source/",
        "",
        "Actions:",
        "  list — List files in a directory",
        "    path (required): directory path relative to the wellness root, or absolute within it",
        "    pattern: glob filter (e.g. '*.md')",
        "",
        "  read — Read a text file (returns first 50KB)",
        "    path (required): file path",
        "",
        "  copy — Copy a file to a new location",
        "    path (required): source file path",
        "    destination (required): destination file path",
        "",
        "  move — Move/rename a file",
        "    path (required): source file path",
        "    destination (required): destination file path",
        "",
        "  append — Append text to the end of a text file",
        "    path (required): file path",
        "    content (required): text to append",
        "",
        "  write — Overwrite a text file with new content",
        "    path (required): file path",
        "    content (required): full replacement text",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["list", "read", "copy", "move", "append", "write"],
            description: "File operation to perform",
          },
          path: {
            type: "string",
            description: "File or directory path",
          },
          destination: {
            type: "string",
            description: "For copy/move: destination path",
          },
          pattern: {
            type: "string",
            description: "For list: glob filter (e.g. '*.md')",
          },
          content: {
            type: "string",
            description: "For append/write: text content to write",
          },
        },
        required: ["action", "path"],
      },
      handler: async (input) => {
        const action = String(input.action);
        const filePath = String(input.path);
        const resolved = resolveWellnessFilesInputPath(filePath, rootDir);

        if (!isWellnessWellnessPathAllowed(resolved, rootDir)) {
          return {
            error: `Access denied: ${filePath}. Allowed root: ${rootLabel}`,
          };
        }

        const requiresWritable = action === "write" || action === "append" || action === "move" || action === "copy";
        if (requiresWritable && isWellnessWellnessPathReadOnly(resolved, rootDir)) {
          return {
            error: `Read-only area: ${filePath}. healing-library/ and /source/ paths cannot be modified.`,
          };
        }

        switch (action) {
          case "list": {
            if (!fs.existsSync(resolved)) {
              return { error: `Directory not found: ${filePath}` };
            }
            const stat = fs.statSync(resolved);
            if (!stat.isDirectory()) {
              return { error: `Not a directory: ${filePath}` };
            }
            const entries = fs.readdirSync(resolved, { withFileTypes: true });
            let items = entries.map((entry) => ({
              name: entry.name,
              type: entry.isDirectory() ? "directory" as const : "file" as const,
              size: entry.isFile() ? fs.statSync(path.join(resolved, entry.name)).size : undefined,
              readOnly: entry.isDirectory()
                ? isWellnessWellnessPathReadOnly(path.join(resolved, entry.name), rootDir)
                : isWellnessWellnessPathReadOnly(path.join(resolved, entry.name), rootDir),
            }));

            if (input.pattern) {
              const pattern = String(input.pattern);
              const regex = new RegExp(
                `^${pattern.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".")}$`,
                "i",
              );
              items = items.filter((item) => item.type === "directory" || regex.test(item.name));
            }

            return { path: filePath, items, count: items.length };
          }

          case "read": {
            if (!fs.existsSync(resolved)) {
              return { error: `File not found: ${filePath}` };
            }
            const content = fs.readFileSync(resolved, "utf8");
            if (content.length > WELLNESS_FILES_READ_LIMIT) {
              return {
                content: content.slice(0, WELLNESS_FILES_READ_LIMIT),
                truncated: true,
                totalLength: content.length,
              };
            }
            return { content };
          }

          case "copy":
          case "move": {
            if (!input.destination) {
              return { error: `${action} requires 'destination'` };
            }
            const destPath = String(input.destination);
            const destResolved = resolveWellnessFilesInputPath(destPath, rootDir);

            if (!isWellnessWellnessPathAllowed(destResolved, rootDir)) {
              return {
                error: `Access denied for destination: ${destPath}. Allowed root: ${rootLabel}`,
              };
            }
            if (isWellnessWellnessPathReadOnly(destResolved, rootDir)) {
              return {
                error: `Read-only area: ${destPath}. healing-library/ and /source/ paths cannot be modified.`,
              };
            }
            if (!fs.existsSync(resolved)) {
              return { error: `Source not found: ${filePath}` };
            }

            const destDir = path.dirname(destResolved);
            if (!fs.existsSync(destDir)) {
              fs.mkdirSync(destDir, { recursive: true });
            }

            if (action === "copy") {
              fs.copyFileSync(resolved, destResolved);
              return { success: true, action: "copy", from: filePath, to: destPath };
            }

            fs.renameSync(resolved, destResolved);
            return { success: true, action: "move", from: filePath, to: destPath };
          }

          case "append":
          case "write": {
            if (typeof input.content !== "string") {
              return { error: `${action} requires 'content'` };
            }
            const nextContent = String(input.content);
            const dir = path.dirname(resolved);
            if (!fs.existsSync(dir)) {
              fs.mkdirSync(dir, { recursive: true });
            }
            if (action === "append") {
              const prefix = fs.existsSync(resolved) && fs.statSync(resolved).size > 0 ? "\n" : "";
              fs.appendFileSync(resolved, `${prefix}${nextContent}`, "utf8");
              return { success: true, action: "append", path: filePath, appended: nextContent.length };
            }
            fs.writeFileSync(resolved, nextContent, "utf8");
            return { success: true, action: "write", path: filePath, bytes: nextContent.length };
          }

          default:
            return { error: `Unknown action: ${action}` };
        }
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
    ...createWellnessFilesTools(),
  ];
}
