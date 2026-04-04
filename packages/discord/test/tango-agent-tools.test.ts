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
});
