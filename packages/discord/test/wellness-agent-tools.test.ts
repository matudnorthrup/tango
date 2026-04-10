import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNutritionTools, createRecipeTools, createWorkoutTools } from "../src/wellness-agent-tools.js";

const tempDirs: string[] = [];

function makeScript(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-wellness-tools-"));
  tempDirs.push(dir);
  const scriptPath = path.join(dir, "fake-workout.sh");
  fs.writeFileSync(scriptPath, contents, "utf8");
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function makeRecipesDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-recipe-tools-"));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content, "utf8");
  }
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("createWorkoutTools", () => {
  it("returns stdout on success", async () => {
    const scriptPath = makeScript("#!/bin/bash\necho 'query ok'\n");
    const [tool] = createWorkoutTools({ workoutScript: scriptPath });

    const result = await tool!.handler({ sql: "SELECT 1;" });
    expect(result).toEqual({ result: "query ok" });
  });

  it("surfaces shell failures instead of pretending the result was empty", async () => {
    const scriptPath = makeScript("#!/bin/bash\necho 'container is not running' >&2\nexit 1\n");
    const [tool] = createWorkoutTools({ workoutScript: scriptPath });

    await expect(tool!.handler({ sql: "SELECT 1;" })).rejects.toThrow("container is not running");
  });
});

describe("createRecipeTools", () => {
  it("matches singular and plural recipe variants plus content hints", async () => {
    const recipesDir = makeRecipesDir({
      "Egg & Fries Hash.md": "# Egg & Fries Hash\n\n- 2 Eggs\n- 150g French Fries\n",
      "Taco Tuesday.md": "# Taco Tuesday\n\ntags: tacos\n\nProtein Options: Chicken\n",
    });
    const recipeRead = createRecipeTools({ recipesDir }).find((tool) => tool.name === "recipe_read");

    await expect(recipeRead!.handler({ name: "eggs and fries hash" })).resolves.toMatchObject({
      found: true,
      matches: [{ title: "Egg & Fries Hash" }],
    });
    await expect(recipeRead!.handler({ name: "chicken tacos" })).resolves.toMatchObject({
      found: true,
      matches: [{ title: "Taco Tuesday" }],
    });
  });

  it("extracts recipe names from obsidian links", async () => {
    const recipesDir = makeRecipesDir({
      "Egg & Fries Hash.md": "# Egg & Fries Hash\n",
    });
    const recipeRead = createRecipeTools({ recipesDir }).find((tool) => tool.name === "recipe_read");

    await expect(
      recipeRead!.handler({
        name: "obsidian://open?vault=main&file=Records%2FNutrition%2FRecipes%2FEgg%20%26%20Fries%20Hash here's the recipe link",
      }),
    ).resolves.toMatchObject({
      found: true,
      matches: [{ title: "Egg & Fries Hash" }],
    });
  });
});

describe("createNutritionTools", () => {
  it("fails fast when a FatSecret method is called without required params", async () => {
    const scriptPath = makeScript("#!/bin/bash\necho 'should not run'\n");
    const fatsecretTool = createNutritionTools({ fatsecretApiScript: scriptPath })
      .find((tool) => tool.name === "fatsecret_api");

    await expect(
      fatsecretTool!.handler({
        method: "foods_search",
        params: {},
      }),
    ).rejects.toThrow("fatsecret_api.foods_search requires params: search_expression");
  });
});
