import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assembleAgentPrompt } from "../src/prompt-assembly.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createAgentsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-prompt-assembly-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "tools"), { recursive: true });
  fs.mkdirSync(path.join(dir, "skills"), { recursive: true });
  fs.mkdirSync(path.join(dir, "shared"), { recursive: true });
  return dir;
}

describe("assembleAgentPrompt", () => {
  it("loads shared files, knowledge, workers, and deduplicated tool and skill docs", () => {
    const agentsDir = createAgentsDir();
    const agentDir = path.join(agentsDir, "assistants", "watson");
    fs.mkdirSync(agentDir, { recursive: true });

    fs.writeFileSync(path.join(agentsDir, "shared", "AGENTS.md"), "shared agents");
    fs.writeFileSync(path.join(agentsDir, "shared", "RULES.md"), "shared rules");
    fs.writeFileSync(path.join(agentsDir, "shared", "USER.md"), "shared user");
    fs.writeFileSync(path.join(agentDir, "soul.md"), "watson soul");
    fs.writeFileSync(path.join(agentDir, "knowledge.md"), "watson knowledge");
    fs.writeFileSync(path.join(agentDir, "workers.md"), "watson workers");
    fs.writeFileSync(path.join(agentsDir, "tools", "atlas-sql.md"), "atlas tool doc");
    fs.writeFileSync(path.join(agentsDir, "tools", "fatsecret.md"), "fatsecret tool doc");
    fs.writeFileSync(path.join(agentsDir, "skills", "recipe-format.md"), "recipe format skill");
    fs.writeFileSync(path.join(agentsDir, "skills", "health-baselines.md"), "health baselines skill");

    const prompt = assembleAgentPrompt(agentDir, {
      toolIds: ["atlas_sql", "fatsecret_api", "atlas_sql"],
      skillIds: ["recipe_format", "health_baselines", "recipe_format"],
      agentsRootDir: agentsDir,
    });

    expect(prompt).toContain("watson soul");
    expect(prompt).toContain("shared agents");
    expect(prompt).toContain("shared rules");
    expect(prompt).toContain("shared user");
    expect(prompt).toContain("watson knowledge");
    expect(prompt).toContain("watson workers");
    expect(prompt).toContain("atlas tool doc");
    expect(prompt).toContain("fatsecret tool doc");
    expect(prompt).toContain("recipe format skill");
    expect(prompt).toContain("health baselines skill");
    expect(prompt.match(/atlas tool doc/gu)).toHaveLength(1);
    expect(prompt.match(/recipe format skill/gu)).toHaveLength(1);
  });

  it("falls back to a minimal prompt when no prompt files exist", () => {
    const agentsDir = createAgentsDir();
    const agentDir = path.join(agentsDir, "workers", "missing-agent");
    fs.mkdirSync(agentDir, { recursive: true });

    expect(assembleAgentPrompt(agentDir)).toBe(
      "You are the missing-agent agent. Execute the task using your available tools.",
    );
  });

  it("finds the agents root for nested system agents without an override", () => {
    const agentsDir = createAgentsDir();
    const agentDir = path.join(agentsDir, "system", "dispatch");
    fs.mkdirSync(agentDir, { recursive: true });

    fs.writeFileSync(path.join(agentsDir, "shared", "AGENTS.md"), "shared agents");
    fs.writeFileSync(path.join(agentDir, "soul.md"), "dispatch soul");

    const prompt = assembleAgentPrompt(agentDir);

    expect(prompt).toContain("dispatch soul");
    expect(prompt).toContain("shared agents");
  });

  it("appends profile overlay prompt sections after the base prompt", () => {
    const agentsDir = createAgentsDir();
    const agentDir = path.join(agentsDir, "assistants", "watson");
    const overlayRootDir = path.join(agentsDir, "profile-overrides");
    const overlayDir = path.join(overlayRootDir, "agents", "watson");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(overlayDir, { recursive: true });
    fs.mkdirSync(path.join(overlayRootDir, "tools"), { recursive: true });
    fs.mkdirSync(path.join(overlayRootDir, "skills"), { recursive: true });

    fs.writeFileSync(path.join(agentDir, "soul.md"), "base soul");
    fs.writeFileSync(path.join(agentDir, "knowledge.md"), "base knowledge");
    fs.writeFileSync(path.join(agentsDir, "tools", "exa.md"), "base tool");
    fs.writeFileSync(path.join(agentsDir, "skills", "deep-research.md"), "base skill");
    fs.writeFileSync(path.join(overlayRootDir, "tools", "exa.md"), "profile tool overlay");
    fs.writeFileSync(path.join(overlayRootDir, "skills", "deep-research.md"), "profile skill overlay");
    fs.writeFileSync(path.join(overlayDir, "persona.md"), "profile persona");
    fs.writeFileSync(path.join(overlayDir, "knowledge.md"), "profile knowledge");

    const prompt = assembleAgentPrompt(agentDir, {
      agentsRootDir: agentsDir,
      overlayDir,
      overlayRootDir,
      toolIds: ["exa_search"],
      skillIds: ["deep_research"],
    });

    expect(prompt).toContain("base soul");
    expect(prompt).toContain("base knowledge");
    expect(prompt).toContain("base tool");
    expect(prompt).toContain("profile tool overlay");
    expect(prompt).toContain("base skill");
    expect(prompt).toContain("profile skill overlay");
    expect(prompt).toContain("profile persona");
    expect(prompt).toContain("profile knowledge");
    expect(prompt.indexOf("profile persona")).toBeGreaterThan(prompt.indexOf("base knowledge"));
  });
});
