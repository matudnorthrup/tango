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
  fs.mkdirSync(path.join(dir, "shared"), { recursive: true });
  return dir;
}

describe("assembleAgentPrompt", () => {
  it("assembles soul, shared rules, user context, and knowledge into one string", () => {
    const agentsDir = createAgentsDir();
    const agentDir = path.join(agentsDir, "assistants", "watson");
    fs.mkdirSync(agentDir, { recursive: true });

    fs.writeFileSync(path.join(agentsDir, "shared", "AGENTS.md"), "shared agents");
    fs.writeFileSync(path.join(agentsDir, "shared", "RULES.md"), "shared rules");
    fs.writeFileSync(path.join(agentsDir, "shared", "USER.md"), "shared user");
    fs.writeFileSync(path.join(agentDir, "soul.md"), "watson soul");
    fs.writeFileSync(path.join(agentDir, "knowledge.md"), "watson knowledge");
    fs.writeFileSync(path.join(agentDir, "workers.md"), "watson workers");
    fs.mkdirSync(path.join(agentsDir, "tools"), { recursive: true });
    fs.mkdirSync(path.join(agentsDir, "skills"), { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "tools", "atlas-sql.md"), "atlas tool doc");
    fs.writeFileSync(path.join(agentsDir, "tools", "fatsecret.md"), "fatsecret tool doc");
    fs.writeFileSync(path.join(agentsDir, "skills", "recipe-format.md"), "recipe format skill");
    fs.writeFileSync(path.join(agentsDir, "skills", "health-baselines.md"), "health baselines skill");

    const prompt = assembleAgentPrompt(agentDir, {
      agentsRootDir: agentsDir,
    });

    expect(typeof prompt).toBe("string");
    expect(prompt).toBe("watson soul\n\nshared rules\n\nshared user\n\nwatson knowledge");
    expect(prompt).toContain("watson soul");
    expect(prompt).toContain("shared rules");
    expect(prompt).toContain("shared user");
    expect(prompt).toContain("watson knowledge");
    expect(prompt).not.toContain("shared agents");
    expect(prompt).not.toContain("watson workers");
    expect(prompt).not.toContain("atlas tool doc");
    expect(prompt).not.toContain("fatsecret tool doc");
    expect(prompt).not.toContain("recipe format skill");
    expect(prompt).not.toContain("health baselines skill");
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
    fs.writeFileSync(path.join(agentsDir, "shared", "RULES.md"), "shared rules");
    fs.writeFileSync(path.join(agentDir, "soul.md"), "dispatch soul");

    const prompt = assembleAgentPrompt(agentDir);

    expect(prompt).toContain("dispatch soul");
    expect(prompt).toContain("shared rules");
    expect(prompt).not.toContain("shared agents");
  });

  it("appends profile overlay prompt sections after the base prompt", () => {
    const agentsDir = createAgentsDir();
    const agentDir = path.join(agentsDir, "assistants", "watson");
    const overlayDir = path.join(agentsDir, "profile-overrides", "agents", "watson");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(overlayDir, { recursive: true });

    fs.writeFileSync(path.join(agentDir, "soul.md"), "base soul");
    fs.writeFileSync(path.join(agentDir, "knowledge.md"), "base knowledge");
    fs.writeFileSync(path.join(overlayDir, "persona.md"), "profile persona");
    fs.writeFileSync(path.join(overlayDir, "knowledge.md"), "profile knowledge");
    fs.writeFileSync(path.join(overlayDir, "workers.md"), "profile worker overlay");

    const prompt = assembleAgentPrompt(agentDir, {
      agentsRootDir: agentsDir,
      overlayDir,
    });

    expect(prompt).toContain("base soul");
    expect(prompt).toContain("base knowledge");
    expect(prompt).toContain("profile persona");
    expect(prompt).toContain("profile knowledge");
    expect(prompt).not.toContain("profile worker overlay");
    expect(prompt.indexOf("profile persona")).toBeGreaterThan(prompt.indexOf("base knowledge"));
  });
});
