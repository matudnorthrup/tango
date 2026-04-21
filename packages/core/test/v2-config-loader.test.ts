import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { isV2RuntimeEnabled, loadV2AgentConfig } from "../src/v2-config-loader.js";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("loadV2AgentConfig", () => {
  it("loads the Malibu v2 YAML and maps required fields", () => {
    const config = loadV2AgentConfig(path.join(repoRoot, "config", "v2", "agents", "malibu.yaml"));

    expect(config).toMatchObject({
      id: "malibu",
      displayName: "Malibu",
      type: "wellness",
      systemPromptFile: "agents/assistants/malibu/soul.md",
      runtime: {
        mode: "persistent",
        provider: "legacy",
        fallback: "codex",
        model: "claude-sonnet-4-6",
        reasoningEffort: "medium",
        idleTimeoutHours: 24,
        contextResetThreshold: 0.8,
      },
      memory: {
        postTurnExtraction: "enabled",
        extractionModel: "claude-haiku-4-5",
        importanceThreshold: 0.4,
        scheduledReflection: "enabled",
      },
      voice: {
        callSigns: ["Malibu", "Malibooth", "Coach Malibu"],
        kokoroVoice: "am_puck",
        defaultChannelId: "100000000000000002",
      },
      discord: {
        defaultChannelId: "100000000000000002",
        smokeTestChannelId: "100000000000001002",
      },
    });
    expect(config.mcpServers).toEqual([
      {
        name: "memory",
        command: "node",
        args: ["packages/atlas-memory/dist/index.js"],
        env: undefined,
      },
      {
        name: "wellness",
        command: "node",
        args: ["packages/discord/dist/mcp-wellness-server.js", "--stdio"],
        env: undefined,
      },
      {
        name: "fatsecret",
        command: "node",
        args: ["packages/discord/dist/mcp-proxy.js", "fatsecret"],
        env: undefined,
      },
      {
        name: "atlas",
        command: "node",
        args: ["packages/discord/dist/mcp-proxy.js", "atlas"],
        env: undefined,
      },
      {
        name: "obsidian",
        command: "node",
        args: ["packages/discord/dist/mcp-proxy.js", "obsidian"],
        env: undefined,
      },
    ]);
  });
});

describe("isV2RuntimeEnabled", () => {
  it("returns false for legacy configs and true for claude-code-v2 configs", () => {
    const legacyConfig = loadV2AgentConfig(path.join(repoRoot, "config", "v2", "agents", "malibu.yaml"));
    expect(isV2RuntimeEnabled(legacyConfig)).toBe(false);

    const tempDir = createTempDir("tango-v2-config-");
    const configPath = path.join(tempDir, "agent.yaml");
    fs.writeFileSync(
      configPath,
      [
        "id: test-agent",
        "display_name: Test Agent",
        "type: test",
        "system_prompt_file: agents/assistants/test-agent/soul.md",
        "mcp_servers:",
        "  - name: memory",
        "    command: node",
        "runtime:",
        "  mode: persistent",
        "  provider: claude-code-v2",
        "  fallback: codex",
        "  model: claude-sonnet-4-6",
        "  reasoning_effort: medium",
        "  idle_timeout_hours: 24",
        "  context_reset_threshold: 0.8",
        "memory:",
        "  post_turn_extraction: enabled",
        "  extraction_model: claude-haiku-4-5",
        "  importance_threshold: 0.4",
        "  scheduled_reflection: enabled",
        "discord:",
        "  default_channel_id: \"123\"",
      ].join("\n"),
    );

    expect(isV2RuntimeEnabled(loadV2AgentConfig(configPath))).toBe(true);
  });
});
