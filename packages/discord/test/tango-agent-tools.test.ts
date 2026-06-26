import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTangoTools } from "../src/tango-agent-tools.js";

const tempDirs: string[] = [];
const originalEnv = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createAgentsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-agent-docs-"));
  tempDirs.push(dir);
  fs.mkdirSync(path.join(dir, "shared"), { recursive: true });
  return dir;
}

function createProfileSharedDir(): string {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-profile-home-"));
  tempDirs.push(homeDir);
  const sharedDir = path.join(homeDir, "profiles", "default", "agents", "shared");
  fs.mkdirSync(sharedDir, { recursive: true });
  return sharedDir;
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

  it("reads shared USER.md from profile when profile override exists", async () => {
    const agentsDir = createAgentsDir();
    fs.writeFileSync(path.join(agentsDir, "shared", "USER.md"), "repo template user");
    const profileSharedDir = createProfileSharedDir();
    fs.writeFileSync(path.join(profileSharedDir, "USER.md"), "profile user");

    const tool = createTangoTools({
      agentsDir,
      profileSharedDirs: [profileSharedDir],
    }).find((entry) => entry.name === "agent_docs");

    const result = await tool?.handler({
      operation: "read",
      path: "shared/USER.md",
    });

    expect(result).toMatchObject({
      content: "profile user",
      source: "profile",
    });
    expect(result).not.toMatchObject({ content: "repo template user" });
  });

  it("writes shared RULES.md to profile, not repo", async () => {
    const agentsDir = createAgentsDir();
    fs.writeFileSync(path.join(agentsDir, "shared", "RULES.md"), "repo template rules");
    const profileSharedDir = createProfileSharedDir();

    const tool = createTangoTools({
      agentsDir,
      profileSharedDirs: [profileSharedDir],
    }).find((entry) => entry.name === "agent_docs");

    const result = await tool?.handler({
      operation: "write",
      path: "shared/RULES.md",
      content: "profile rules",
    });

    expect(result).toMatchObject({
      success: true,
      written_to: "profile",
    });
    expect(fs.readFileSync(path.join(profileSharedDir, "RULES.md"), "utf8")).toBe("profile rules");
    expect(fs.readFileSync(path.join(agentsDir, "shared", "RULES.md"), "utf8")).toBe(
      "repo template rules",
    );
  });

  it("reads assistants knowledge from profile when profile override exists", async () => {
    const agentsDir = createAgentsDir();
    const assistantDir = path.join(agentsDir, "assistants", "cod-e");
    fs.mkdirSync(assistantDir, { recursive: true });
    fs.writeFileSync(path.join(assistantDir, "knowledge.md"), "repo knowledge");

    const profileAgentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-profile-agents-"));
    tempDirs.push(profileAgentsDir);
    const profileAssistantDir = path.join(profileAgentsDir, "assistants", "cod-e");
    fs.mkdirSync(profileAssistantDir, { recursive: true });
    fs.writeFileSync(path.join(profileAssistantDir, "knowledge.md"), "profile knowledge");

    const tool = createTangoTools({
      agentsDir,
      profileAgentsDir,
    }).find((entry) => entry.name === "agent_docs");

    const result = await tool?.handler({
      operation: "read",
      path: "assistants/cod-e/knowledge.md",
    });

    expect(result).toMatchObject({
      content: "profile knowledge",
      source: "profile",
    });
  });

  it("writes assistants knowledge to profile, not repo", async () => {
    const agentsDir = createAgentsDir();
    const assistantDir = path.join(agentsDir, "assistants", "miles");
    fs.mkdirSync(assistantDir, { recursive: true });
    fs.writeFileSync(path.join(assistantDir, "knowledge.md"), "repo knowledge");

    const profileAgentsDir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-profile-agents-"));
    tempDirs.push(profileAgentsDir);

    const tool = createTangoTools({
      agentsDir,
      profileAgentsDir,
    }).find((entry) => entry.name === "agent_docs");

    const result = await tool?.handler({
      operation: "write",
      path: "assistants/miles/knowledge.md",
      content: "profile knowledge",
    });

    expect(result).toMatchObject({
      success: true,
      written_to: "profile",
    });
    expect(
      fs.readFileSync(path.join(profileAgentsDir, "assistants", "miles", "knowledge.md"), "utf8"),
    ).toBe("profile knowledge");
    expect(fs.readFileSync(path.join(assistantDir, "knowledge.md"), "utf8")).toBe("repo knowledge");
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
