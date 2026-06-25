import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTangoTools } from "../src/tango-agent-tools.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createAgentsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-agent-docs-"));
  tempDirs.push(dir);
  return dir;
}

function createOverlayDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-profile-overlay-"));
  tempDirs.push(dir);
  return dir;
}

describe("agent_docs tool", () => {
  it("lists nested assistant directories by explicit path", async () => {
    const agentsDir = createAgentsDir();
    const assistantDir = path.join(agentsDir, "assistants", "watson");
    fs.mkdirSync(assistantDir, { recursive: true });
    fs.writeFileSync(path.join(assistantDir, "soul.md"), "watson soul");
    fs.writeFileSync(path.join(assistantDir, "knowledge.md"), "watson knowledge");

    const tool = createTangoTools({ agentsDir }).find((entry) => entry.name === "agent_docs");
    const result = await tool?.handler({
      operation: "list",
      path: "assistants/watson",
    });

    expect(result).toMatchObject({
      files: expect.arrayContaining(["soul.md", "knowledge.md"]),
    });
  });

  it("resolves nested agent directories by agent id", async () => {
    const agentsDir = createAgentsDir();
    const workerDir = path.join(agentsDir, "workers", "research-assistant");
    fs.mkdirSync(workerDir, { recursive: true });
    fs.writeFileSync(path.join(workerDir, "soul.md"), "research assistant soul");

    const tool = createTangoTools({ agentsDir }).find((entry) => entry.name === "agent_docs");
    const result = await tool?.handler({
      operation: "list",
      agent: "research-assistant",
    });

    expect(result).toMatchObject({
      files: ["soul.md"],
    });
  });

  it("appends the profile overlay when reading a shared skill doc", async () => {
    const agentsDir = createAgentsDir();
    const profileSkillsDir = createOverlayDir();
    const skillsDir = path.join(agentsDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillsDir, "finance-review.md"),
      "# Finance Review\n\nGeneric workflow.\n",
    );
    fs.writeFileSync(
      path.join(profileSkillsDir, "finance-review.md"),
      "Sinking funds: House SB, Vehicles SB.",
    );

    const tool = createTangoTools({ agentsDir, profileSkillsDir }).find(
      (entry) => entry.name === "agent_docs",
    );
    const result = (await tool?.handler({
      operation: "read",
      path: "skills/finance-review.md",
    })) as { content?: string };

    expect(result.content).toContain("Generic workflow.");
    expect(result.content).toContain("profile overlay: finance-review.md");
    expect(result.content).toContain("Sinking funds: House SB, Vehicles SB.");
  });

  it("returns only the repo base when no overlay is present", async () => {
    const agentsDir = createAgentsDir();
    const profileToolsDir = createOverlayDir();
    const toolsDir = path.join(agentsDir, "tools");
    fs.mkdirSync(toolsDir, { recursive: true });
    fs.writeFileSync(path.join(toolsDir, "atlas-sql.md"), "# Atlas SQL\n\nGeneric.\n");

    const tool = createTangoTools({ agentsDir, profileToolsDir }).find(
      (entry) => entry.name === "agent_docs",
    );
    const result = (await tool?.handler({
      operation: "read",
      path: "tools/atlas-sql.md",
    })) as { content?: string };

    expect(result.content).toBe("# Atlas SQL\n\nGeneric.\n");
    expect(result.content).not.toContain("profile overlay");
  });

  it("serves an overlay-only skill doc when the repo base is absent", async () => {
    const agentsDir = createAgentsDir();
    const profileSkillsDir = createOverlayDir();
    fs.mkdirSync(path.join(agentsDir, "skills"), { recursive: true });
    fs.writeFileSync(
      path.join(profileSkillsDir, "private-workflow.md"),
      "Installation-only skill.",
    );

    const tool = createTangoTools({ agentsDir, profileSkillsDir }).find(
      (entry) => entry.name === "agent_docs",
    );
    const result = (await tool?.handler({
      operation: "read",
      path: "skills/private-workflow.md",
    })) as { content?: string; error?: string };

    expect(result.error).toBeUndefined();
    expect(result.content).toContain("Installation-only skill.");
  });

  it("merges overlay-only docs into a skills listing", async () => {
    const agentsDir = createAgentsDir();
    const profileSkillsDir = createOverlayDir();
    const skillsDir = path.join(agentsDir, "skills");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, "deep-research.md"), "generic");
    fs.writeFileSync(path.join(profileSkillsDir, "my-private-skill.md"), "personal");

    const tool = createTangoTools({ agentsDir, profileSkillsDir }).find(
      (entry) => entry.name === "agent_docs",
    );
    const result = (await tool?.handler({
      operation: "list",
      path: "skills",
    })) as { files?: string[] };

    expect(result.files).toEqual(
      expect.arrayContaining(["deep-research.md", "my-private-skill.md"]),
    );
  });
});
