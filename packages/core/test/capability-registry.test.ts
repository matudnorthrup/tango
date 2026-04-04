import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CapabilityRegistry,
  loadAgentConfigs,
  loadIntentContractConfigs,
  loadProjectConfigs,
  loadToolContractConfigs,
  loadWorkflowConfigs,
  loadWorkerConfigs,
} from "../src/index.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempConfigDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-capability-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "agents"), { recursive: true });
  fs.mkdirSync(path.join(dir, "projects"), { recursive: true });
  fs.mkdirSync(path.join(dir, "workers"), { recursive: true });
  fs.mkdirSync(path.join(dir, "worker-prompts"), { recursive: true });
  fs.mkdirSync(path.join(dir, "tool-contracts"), { recursive: true });
  fs.mkdirSync(path.join(dir, "intent-contracts"), { recursive: true });
  fs.mkdirSync(path.join(dir, "workflows"), { recursive: true });
  return dir;
}

describe("CapabilityRegistry", () => {
  it("builds a planner catalog from workers, workflows, tools, and adjacent TOOLS.md", () => {
    const dir = createTempConfigDir();
    fs.writeFileSync(
      path.join(dir, "agents", "malibu.yaml"),
      [
        "id: malibu",
        "type: wellness",
        "provider:",
        "  default: claude-oauth",
        "orchestration:",
        "  worker_ids:",
        "    - nutrition-logger",
        "prompt_file: ../agent-prompts/malibu.md",
      ].join("\n"),
    );
    fs.mkdirSync(path.join(dir, "agent-prompts"), { recursive: true });
    fs.writeFileSync(path.join(dir, "agent-prompts", "malibu.md"), "You are Malibu.");
    fs.writeFileSync(
      path.join(dir, "agent-prompts", "TOOLS.md"),
      [
        "# Agent Tools",
        "- Delegate recurring meal logging to the nutrition logger.",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(dir, "projects", "wellness.yaml"),
      [
        "id: wellness",
        "default_agent: malibu",
        "worker_ids:",
        "  - nutrition-logger",
      ].join("\n"),
    );
    const promptPath = path.join(dir, "worker-prompts", "nutrition-logger.md");
    fs.writeFileSync(promptPath, "You are nutrition logger.");
    fs.writeFileSync(
      path.join(dir, "worker-prompts", "TOOLS.md"),
      [
        "# Tools",
        "- Use recipe notes before asking the user to restate a recurring meal.",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(dir, "workers", "nutrition-logger.yaml"),
      [
        "id: nutrition-logger",
        "type: logger",
        "owner_agent: malibu",
        "display_name: Nutrition Logger",
        "description: Handles food logging and nutrition reads.",
        "provider:",
        "  default: claude-oauth",
        "prompt_file: ../worker-prompts/nutrition-logger.md",
        "tool_contract_ids:",
        "  - obsidian.recipe_notes.read",
        "  - fatsecret.log_food",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(dir, "tool-contracts", "obsidian.recipe_notes.read.yaml"),
      [
        "id: obsidian.recipe_notes.read",
        "family: obsidian.recipe_notes",
        "description: Read a structured recipe note.",
        "owner_worker: nutrition-logger",
        "mode: read",
        "integration:",
        "  system: obsidian",
        "  target: recipes",
        "input_fields:",
        "  - recipe_query",
        "output_fields:",
        "  - frontmatter",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(dir, "tool-contracts", "fatsecret.log_food.yaml"),
      [
        "id: fatsecret.log_food",
        "family: fatsecret",
        "description: Log a food entry.",
        "owner_worker: nutrition-logger",
        "mode: write",
        "integration:",
        "  system: fatsecret",
        "  target: food-diary",
        "input_fields:",
        "  - food_id",
        "  - serving_id",
        "  - number_of_units",
        "  - meal",
        "output_fields:",
        "  - food_entry_id",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(dir, "workflows", "wellness.log_recipe_meal.yaml"),
      [
        "id: wellness.log_recipe_meal",
        "display_name: Log Recipe Meal",
        "description: Log a recurring recipe meal by reading the recipe note first.",
        "owner_worker: nutrition-logger",
        "mode: write",
        "status: implemented",
        "handler: log_recipe_meal",
        "tool_contract_ids:",
        "  - obsidian.recipe_notes.read",
        "  - fatsecret.log_food",
        "input_fields:",
        "  - recipe_query",
        "  - meal",
        "examples:",
        "  - Can you log my protein yogurt bowl for breakfast this morning?",
        "planning:",
        "  summary: Look up the recipe note and log it without asking for ingredients when possible.",
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(dir, "intent-contracts", "nutrition.log_recipe.yaml"),
      [
        "id: nutrition.log_recipe",
        "domain: wellness",
        "display_name: Log Recipe Meal",
        "description: Log a recurring recipe meal.",
        "mode: write",
        "route:",
        "  kind: workflow",
        "  target_id: wellness.log_recipe_meal",
        "slots:",
        "  - name: recipe_query",
        "    required: true",
        "examples:",
        "  - Can you log my protein yogurt bowl for breakfast this morning?",
      ].join("\n"),
    );

    const registry = new CapabilityRegistry({
      agents: loadAgentConfigs(dir),
      projects: loadProjectConfigs(dir),
      workers: loadWorkerConfigs(dir),
      toolContracts: loadToolContractConfigs(dir),
      workflows: loadWorkflowConfigs(dir),
      intentContracts: loadIntentContractConfigs(dir),
    });

    const catalog = registry.getPlannerCatalog("malibu", "wellness");
    expect(catalog).toMatchObject({
      agentId: "malibu",
      projectId: "wellness",
    });
    expect(catalog.agentToolsDoc).toContain(
      "Delegate recurring meal logging to the nutrition logger.",
    );
    expect(catalog.workflows).toHaveLength(1);
    expect(catalog.workflows[0]).toMatchObject({
      id: "wellness.log_recipe_meal",
      ownerWorkerId: "nutrition-logger",
      ownerWorkerDisplayName: "Nutrition Logger",
      inputFields: ["recipe_query", "meal"],
      toolContracts: [
        {
          id: "obsidian.recipe_notes.read",
        },
        {
          id: "fatsecret.log_food",
        },
      ],
    });
    expect(catalog.workflows[0]?.workerToolsDoc).toContain(
      "Use recipe notes before asking the user to restate a recurring meal.",
    );

    const workerCatalog = registry.getWorkerCatalog("malibu", "wellness");
    expect(workerCatalog).toMatchObject({
      agentId: "malibu",
      projectId: "wellness",
    });
    expect(workerCatalog.agentToolsDoc).toContain(
      "Delegate recurring meal logging to the nutrition logger.",
    );
    expect(workerCatalog.workers).toHaveLength(1);
    expect(workerCatalog.workers[0]).toMatchObject({
      id: "nutrition-logger",
      displayName: "Nutrition Logger",
      description: "Handles food logging and nutrition reads.",
      toolContracts: [
        {
          id: "obsidian.recipe_notes.read",
        },
        {
          id: "fatsecret.log_food",
        },
      ],
    });
    expect(workerCatalog.workers[0]?.promptText).toContain("You are nutrition logger.");
    expect(workerCatalog.workers[0]?.workerToolsDoc).toContain(
      "Use recipe notes before asking the user to restate a recurring meal.",
    );

    const intentCatalog = registry.getIntentCatalog("malibu", "wellness", { domain: "wellness" });
    expect(intentCatalog).toEqual([
      expect.objectContaining({
        id: "nutrition.log_recipe",
        route: {
          kind: "workflow",
          targetId: "wellness.log_recipe_meal",
        },
      }),
    ]);
  });
});
