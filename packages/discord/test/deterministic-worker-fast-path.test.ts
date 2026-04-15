import { describe, expect, it } from "vitest";
import { tryExecuteDeterministicWorkerFastPath } from "../src/deterministic-worker-fast-path.js";

describe("tryExecuteDeterministicWorkerFastPath", () => {
  it("returns null for non-deterministic tasks", async () => {
    const result = await tryExecuteDeterministicWorkerFastPath({
      workerId: "nutrition-logger",
      task: "Log my lunch please.",
      toolIds: ["nutrition_log_items"],
    });

    expect(result).toBeNull();
  });

  it("returns null for deterministic nutrition.log_food worker tasks", async () => {
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
    });

    expect(result).toBeNull();
  });

  it("returns null for deterministic nutrition.log_recipe worker tasks", async () => {
    const result = await tryExecuteDeterministicWorkerFastPath({
      workerId: "nutrition-logger",
      task: [
        "Execute workflow 'wellness.log_recipe_meal' for the owning worker now.",
        "Intent contract: nutrition.log_recipe",
        "Intent mode: write",
        "User message: Continue the last recipe logging task.",
        "User follow-up message: Log my lunch: tex mex salad, but modify it to use 125g of black beans and 120g of peach mango salsa.",
        "Extracted inputs: {\"recipe_query\":\"Garden Tex-Mex Power Salad\",\"meal\":\"lunch\",\"date\":\"2026-04-18\"}",
      ].join("\n"),
      toolIds: ["recipe_read", "nutrition_log_items", "fatsecret_api"],
    });

    expect(result).toBeNull();
  });
});
