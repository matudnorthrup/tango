import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assembleSoulPrompt } from "../src/prompt-assembly.js";
import { loadV2AgentConfig } from "../src/v2-config-loader.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8").trim();
}

function firstNonEmptyLine(content: string): string {
  return content.split("\n").find((line) => line.trim().length > 0) ?? "";
}

describe("assembleSoulPrompt", () => {
  it("assembles Malibu's system prompt from soul, shared files, and knowledge without workers or tool docs", () => {
    const config = loadV2AgentConfig(path.join(repoRoot, "config", "v2", "agents", "malibu.yaml"));
    const soul = readRepoFile("agents/assistants/malibu/soul.md");
    const rules = readRepoFile("agents/shared/RULES.md");
    const user = readRepoFile("agents/shared/USER.md");
    const knowledge = readRepoFile("agents/assistants/malibu/knowledge.md");
    const workers = readRepoFile("agents/assistants/malibu/workers.md");
    const fatsecretTool = readRepoFile("agents/tools/fatsecret.md");
    const atlasTool = readRepoFile("agents/tools/atlas-sql.md");

    const prompt = assembleSoulPrompt(config, { repoRoot });

    expect(typeof prompt).toBe("string");
    expect(prompt).toBe([soul, rules, user, knowledge].join("\n\n"));
    expect(prompt).toContain(soul);
    expect(prompt).toContain(rules);
    expect(prompt).toContain(user);
    expect(prompt).toContain(knowledge);
    expect(prompt).not.toContain(firstNonEmptyLine(workers));
    expect(prompt).not.toContain(firstNonEmptyLine(fatsecretTool));
    expect(prompt).not.toContain(firstNonEmptyLine(atlasTool));
  });
});
