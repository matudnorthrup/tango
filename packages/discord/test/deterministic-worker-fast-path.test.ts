import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { tryExecuteDeterministicWorkerFastPath } from "../src/deterministic-worker-fast-path.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("tryExecuteDeterministicWorkerFastPath", () => {
  it("returns null for non-deterministic tasks", async () => {
    const result = await tryExecuteDeterministicWorkerFastPath({
      workerId: "nutrition-logger",
      task: "Log my lunch please.",
      toolIds: ["nutrition_log_items"],
    });

    expect(result).toBeNull();
  });

  it("executes structured log_food tasks directly", async () => {
    const fixture = createWellnessFixture({
      ingredients: [
        atlasIngredient("Black Beans", 1001, 2001, 125),
        atlasIngredient("Mango Peach Salsa", 1002, 2002, 120),
      ],
    });
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];

    const result = await tryExecuteDeterministicWorkerFastPath({
      workerId: "nutrition-logger",
      task: [
        "Handle this request in your domain now.",
        "Intent contract: nutrition.log_food",
        "Intent mode: write",
        "User message: Log 125g black beans and 120g mango peach salsa for lunch.",
        "Extracted entities: {\"items\":[{\"name\":\"Black Beans\",\"quantity\":\"125g\"},{\"name\":\"Mango Peach Salsa\",\"quantity\":\"120g\"}],\"meal\":\"lunch\"}",
      ].join("\n"),
      toolIds: ["recipe_read", "nutrition_log_items", "fatsecret_api"],
      wellnessToolPaths: fixture.paths,
      fatsecretExecutor: async ({ method, params }) => {
        calls.push({ method, params });
        if (method === "food_entry_create") {
          return { success: true, food_entry_id: `${calls.length}` };
        }
        if (method === "food_entries_get") {
          return [{ food_entry_id: 1 }];
        }
        throw new Error(`Unexpected method: ${method}`);
      },
    });

    expect(result).not.toBeNull();
    expect(result?.toolCalls[0]?.name).toBe("nutrition_log_items");
    const payload = JSON.parse(result?.text ?? "{}") as Record<string, unknown>;
    expect(payload.status).toBe("confirmed");
    expect(payload.verifiedWriteOutcome).toBe(true);
    expect(Array.isArray(payload.logged)).toBe(true);
    expect((payload.logged as Array<Record<string, unknown>>).map((item) => item.quantity)).toEqual([
      "125g",
      "120g",
    ]);
    expect(calls.map((call) => call.method)).toEqual([
      "food_entry_create",
      "food_entry_create",
      "food_entries_get",
    ]);
  });

  it("executes recipe logs directly and applies gram overrides from the user message", async () => {
    const fixture = createWellnessFixture({
      ingredients: [
        atlasIngredient("garden lettuce (mixed varieties)", 1001, 2001, 100),
        atlasIngredient("Canned Chicken Breast", 1002, 2002, 200),
        atlasIngredient("Black Beans (canned, drained)", 1003, 2003, 95),
        atlasIngredient("Mango Peach Salsa", 1004, 2004, 40),
        atlasIngredient("Olive Oil", 1005, 2005, 5),
        atlasIngredient("Light Vanilla Greek Yogurt (lime crema)", 1006, 2006, 35),
      ],
      recipes: [
        {
          name: "Garden Tex-Mex Power Salad",
          content: [
            "# Garden Tex-Mex Power Salad",
            "",
            "## Ingredients",
            "- 100g garden lettuce (mixed varieties) — 14 cal",
            "- 200g Canned Chicken Breast — 160 cal, 47g P",
            "- 95g Black Beans (canned, drained) — 80 cal, 5g P",
            "- 40g Mango Peach Salsa — 26 cal",
            "- 5g Olive Oil — 44 cal",
            "- 35g Light Vanilla Greek Yogurt (lime crema) — 21 cal, 3g P",
            "",
            "## Instructions",
            "1. Assemble and eat.",
          ].join("\n"),
        },
      ],
    });
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];

    const result = await tryExecuteDeterministicWorkerFastPath({
      workerId: "nutrition-logger",
      task: [
        "Execute workflow 'wellness.log_recipe_meal' for the owning worker now.",
        "Intent contract: nutrition.log_recipe",
        "Intent mode: write",
        "User message: Log my lunch: tex mex salad, but modify it to use 125g of black beans and 120g of peach mango salsa.",
        "Extracted inputs: {\"recipe_query\":\"Garden Tex-Mex Power Salad\",\"meal\":\"lunch\"}",
      ].join("\n"),
      toolIds: ["recipe_read", "nutrition_log_items", "fatsecret_api"],
      wellnessToolPaths: fixture.paths,
      fatsecretExecutor: async ({ method, params }) => {
        calls.push({ method, params });
        if (method === "food_entry_create") {
          return { success: true, food_entry_id: `${calls.length}` };
        }
        if (method === "food_entries_get") {
          return [{ food_entry_id: 1 }];
        }
        throw new Error(`Unexpected method: ${method}`);
      },
    });

    expect(result).not.toBeNull();
    const payload = JSON.parse(result?.text ?? "{}") as Record<string, unknown>;
    const logged = payload.logged as Array<Record<string, unknown>>;
    expect(payload.status).toBe("confirmed");
    expect(payload.verifiedWriteOutcome).toBe(true);
    expect(logged).toHaveLength(6);
    expect(logged.find((item) => item.item === "Black Beans (canned, drained)")?.quantity).toBe("125g");
    expect(logged.find((item) => item.item === "Mango Peach Salsa")?.quantity).toBe("120g");
    expect(calls.filter((call) => call.method === "food_entry_create")).toHaveLength(6);
    expect(calls.at(-1)?.method).toBe("food_entries_get");
  });
});

function createWellnessFixture(input: {
  ingredients: Array<{
    name: string;
    foodId: number;
    servingId: number;
    gramsPerServing: number;
  }>;
  recipes?: Array<{ name: string; content: string }>;
}): {
  paths: {
    atlasDbPath: string;
    recipesDir: string;
  };
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tango-fastpath-test-"));
  tempDirs.push(root);

  const recipesDir = path.join(root, "recipes");
  fs.mkdirSync(recipesDir, { recursive: true });
  for (const recipe of input.recipes ?? []) {
    fs.writeFileSync(path.join(recipesDir, `${recipe.name}.md`), recipe.content, "utf8");
  }

  const atlasDbPath = path.join(root, "atlas.db");
  const db = new DatabaseSync(atlasDbPath);
  try {
    db.exec(`
      CREATE TABLE ingredients (
        id INTEGER PRIMARY KEY,
        name TEXT,
        brand TEXT,
        product TEXT,
        food_id INTEGER,
        serving_id INTEGER,
        serving_description TEXT,
        serving_size TEXT,
        grams_per_serving REAL,
        calories REAL,
        protein REAL,
        carbs REAL,
        fat REAL,
        fiber REAL,
        aliases TEXT
      );
    `);
    const insert = db.prepare(`
      INSERT INTO ingredients (
        name,
        brand,
        product,
        food_id,
        serving_id,
        serving_description,
        serving_size,
        grams_per_serving,
        calories,
        protein,
        carbs,
        fat,
        fiber,
        aliases
      ) VALUES (?, '', '', ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, '[]')
    `);
    for (const ingredient of input.ingredients) {
      insert.run(
        ingredient.name,
        ingredient.foodId,
        ingredient.servingId,
        `${ingredient.gramsPerServing} g`,
        `${ingredient.gramsPerServing} g`,
        ingredient.gramsPerServing,
      );
    }
  } finally {
    db.close();
  }

  return {
    paths: {
      atlasDbPath,
      recipesDir,
    },
  };
}

function atlasIngredient(
  name: string,
  foodId: number,
  servingId: number,
  gramsPerServing: number,
): {
  name: string;
  foodId: number;
  servingId: number;
  gramsPerServing: number;
} {
  return { name, foodId, servingId, gramsPerServing };
}
