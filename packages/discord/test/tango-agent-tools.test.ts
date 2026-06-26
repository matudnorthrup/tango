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

function createProfileRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-profile-state-"));
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

  it("reads, lists, writes, and patches scoped profile state docs", async () => {
    const agentsDir = createAgentsDir();
    const profileStateRoot = createProfileRoot();
    fs.mkdirSync(path.join(profileStateRoot, "threads"), { recursive: true });
    fs.writeFileSync(path.join(profileStateRoot, "threads", "launch.md"), "old quick read");

    const tool = createTangoTools({ agentsDir, profileStateRoot }).find(
      (entry) => entry.name === "agent_docs",
    );

    const listed = (await tool?.handler({
      operation: "state_list",
      path: "threads",
    })) as { files?: string[]; path?: string };
    expect(listed.path).toBe("profile:threads");
    expect(listed.files).toEqual(["launch.md"]);

    const read = (await tool?.handler({
      operation: "state_read",
      path: "threads/launch.md",
    })) as { content?: string; path?: string; layer?: string };
    expect(read).toMatchObject({
      content: "old quick read",
      path: "profile:threads/launch.md",
      layer: "profile",
    });

    await tool?.handler({
      operation: "state_write",
      path: "collab/handoff.md",
      content: "handoff body",
    });
    expect(fs.readFileSync(path.join(profileStateRoot, "collab", "handoff.md"), "utf8"))
      .toBe("handoff body");

    const patched = await tool?.handler({
      operation: "state_patch",
      path: "collab/handoff.md",
      old: "handoff",
      new: "updated",
    });
    expect(patched).toMatchObject({
      success: true,
      path: "profile:collab/handoff.md",
      layer: "profile",
    });
    expect(fs.readFileSync(path.join(profileStateRoot, "collab", "handoff.md"), "utf8"))
      .toBe("updated body");
  });

  it("blocks unsafe profile state paths and source-kind mutations", async () => {
    const agentsDir = createAgentsDir();
    const profileStateRoot = createProfileRoot();
    fs.mkdirSync(path.join(profileStateRoot, "reference"), { recursive: true });
    fs.writeFileSync(
      path.join(profileStateRoot, "reference", "source.md"),
      "---\nsource_kind: source\n---\n\nProtected",
    );

    const tool = createTangoTools({ agentsDir, profileStateRoot }).find(
      (entry) => entry.name === "agent_docs",
    );

    const traversal = await tool?.handler({
      operation: "state_read",
      path: "../reference/source.md",
    });
    expect(traversal).toMatchObject({ error: expect.stringMatching(/traverse/i) });

    const blocked = await tool?.handler({
      operation: "state_patch",
      path: "reference/source.md",
      old: "Protected",
      new: "changed",
    });
    expect(blocked).toMatchObject({ error: expect.stringMatching(/source_kind: source/i) });

    const forced = await tool?.handler({
      operation: "state_patch",
      path: "reference/source.md",
      old: "Protected",
      new: "changed",
      force: true,
    });
    expect(forced).toMatchObject({ success: true });
    expect(fs.readFileSync(path.join(profileStateRoot, "reference", "source.md"), "utf8"))
      .toContain("changed");
  });

  it("blocks profile state writes through a symlinked subdirectory", async () => {
    const agentsDir = createAgentsDir();
    const profileStateRoot = createProfileRoot();
    const outsideRoot = createProfileRoot();
    fs.mkdirSync(path.join(profileStateRoot, "threads"), { recursive: true });
    fs.symlinkSync(outsideRoot, path.join(profileStateRoot, "threads", "outside"));

    const tool = createTangoTools({ agentsDir, profileStateRoot }).find(
      (entry) => entry.name === "agent_docs",
    );
    const result = await tool?.handler({
      operation: "state_write",
      path: "threads/outside/new.md",
      content: "should not write outside",
    });

    expect(result).toMatchObject({ error: expect.stringMatching(/escapes/i) });
    expect(fs.existsSync(path.join(outsideRoot, "new.md"))).toBe(false);
  });
});
