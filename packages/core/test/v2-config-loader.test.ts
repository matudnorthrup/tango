import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  isV2AgentEnabled,
  isV2RuntimeEnabled,
  loadAllV2AgentConfigs,
  loadLayeredV2AgentConfigs,
  loadV2AgentConfig,
} from "../src/v2-config-loader.js";

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
      enabled: false,
      displayName: "Malibu",
      type: "wellness",
      systemPromptFile: "agents/assistants/malibu/soul.md",
      runtime: {
        mode: "persistent",
        provider: "claude-code-v2",
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
        smokeTestChannelId: "100000000000001002",
      },
      discord: {
        defaultChannelId: "100000000000000002",
        smokeTestChannelId: "100000000000001002",
      },
    });
    expect(config.mcpServers.length).toBeGreaterThanOrEqual(5);
    expect(config.mcpServers[0]).toEqual({
      name: "memory",
      command: "node",
      args: ["packages/atlas-memory/dist/index.js"],
    });
  });

  it("loads Victor as an operations agent with Linear and Obsidian access but no dev MCP surface", () => {
    const config = loadV2AgentConfig(path.join(repoRoot, "config", "v2", "agents", "victor.yaml"));

    expect(config).toMatchObject({
      id: "victor",
      type: "operations",
      defaultProject: "operations",
      tools: {
        mode: "off",
      },
    });
    expect(config.orchestration).toBeUndefined();

    const serverNames = config.mcpServers.map((server) => server.name);
    expect(serverNames).toEqual(expect.arrayContaining(["memory", "linear", "obsidian"]));
    expect(serverNames).not.toEqual(expect.arrayContaining(["tango-dev", "discord-manage", "agent-docs"]));

    const linearServer = config.mcpServers.find((server) => server.name === "linear");
    expect(linearServer).toMatchObject({
      command: "node",
      args: ["packages/core/dist/mcp-proxy.js", "linear"],
      env: {
        ALLOWED_TOOL_IDS: "linear",
      },
    });
  });

  it("loads Porter as an LDS companion with direct governed tool access", () => {
    const config = loadV2AgentConfig(path.join(repoRoot, "config", "v2", "agents", "porter.yaml"));

    expect(config).toMatchObject({
      id: "porter",
      displayName: "Porter",
      type: "lds-companion",
      avatarPath: "agents/assistants/porter/avatar.png",
      systemPromptFile: "agents/assistants/porter/soul.md",
      runtime: {
        provider: "claude-code-v2",
        reasoningEffort: "high",
        timeoutSeconds: 2700,
      },
      voice: {
        callSigns: ["Porter", "Brother Porter"],
        kokoroVoice: "am_liam",
        defaultChannelId: "100000000000000006",
        smokeTestChannelId: "100000000000001006",
      },
      discord: {
        defaultChannelId: "100000000000000006",
        smokeTestChannelId: "100000000000001006",
      },
    });

    const serverNames = config.mcpServers.map((server) => server.name);
    expect(serverNames).toEqual(expect.arrayContaining(["memory", "google", "obsidian", "browser", "gospel-library", "onepassword"]));
    expect(serverNames).not.toContain("agent-docs");

    const gospelLibraryServer = config.mcpServers.find((server) => server.name === "gospel-library");
    expect(gospelLibraryServer).toMatchObject({
      command: "node",
      args: ["packages/core/dist/mcp-proxy.js", "gospel-library"],
      env: {
        ALLOWED_TOOL_IDS: "gospel_library",
        WORKER_ID: "church-assistant",
      },
    });

    const onePasswordServer = config.mcpServers.find((server) => server.name === "onepassword");
    expect(onePasswordServer).toMatchObject({
      command: "node",
      args: ["packages/core/dist/mcp-proxy.js", "onepassword"],
      env: {
        ALLOWED_TOOL_IDS: "onepassword",
        WORKER_ID: "church-assistant",
      },
    });
  });

  it("allows voice configs to use the app-level Kokoro default", () => {
    const tempDir = createTempDir("tango-v2-default-voice-");
    const configPath = path.join(tempDir, "default-voice.yaml");
    fs.writeFileSync(
      configPath,
      [
        "id: default-voice",
        "display_name: Default Voice",
        "type: test",
        "system_prompt_file: agents/assistants/default-voice/soul.md",
        "mcp_servers:",
        "  - name: memory",
        "    command: node",
        "runtime:",
        "  mode: persistent",
        "  provider: claude-code-v2",
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
        "voice:",
        "  call_signs:",
        "    - Default Voice",
        "  default_channel_id: \"123\"",
      ].join("\n"),
    );

    const config = loadV2AgentConfig(configPath);

    expect(config.voice).toMatchObject({
      callSigns: ["Default Voice"],
      defaultChannelId: "123",
    });
    expect(config.voice?.kokoroVoice).toBeUndefined();
  });

  it("maps optional current-turn metadata preferences", () => {
    const tempDir = createTempDir("tango-v2-current-turn-");
    const configPath = path.join(tempDir, "time-aware.yaml");
    fs.writeFileSync(
      configPath,
      [
        "id: time-aware",
        "display_name: Time Aware",
        "type: test",
        "system_prompt_file: agents/assistants/time-aware/soul.md",
        "mcp_servers:",
        "  - name: memory",
        "    command: node",
        "runtime:",
        "  mode: persistent",
        "  provider: claude-code-v2",
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
        "current_turn_metadata:",
        "  timezone: America/Denver",
        "  locale: en-US",
        "  time_format: 24h",
      ].join("\n"),
    );

    const config = loadV2AgentConfig(configPath);

    expect(config.currentTurnMetadata).toEqual({
      timeZone: "America/Denver",
      locale: "en-US",
      timeFormat: "24h",
    });
  });
});

describe("isV2RuntimeEnabled", () => {
  it("returns false for legacy or disabled configs and true for enabled claude-code-v2 configs", () => {
    const tempDir = createTempDir("tango-v2-config-");

    const legacyPath = path.join(tempDir, "legacy-agent.yaml");
    fs.writeFileSync(
      legacyPath,
      [
        "id: legacy-agent",
        "display_name: Legacy Agent",
        "type: test",
        "system_prompt_file: agents/assistants/test-agent/soul.md",
        "mcp_servers:",
        "  - name: memory",
        "    command: node",
        "runtime:",
        "  mode: persistent",
        "  provider: legacy",
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
    expect(isV2RuntimeEnabled(loadV2AgentConfig(legacyPath))).toBe(false);

    const v2Path = path.join(tempDir, "v2-agent.yaml");
    fs.writeFileSync(
      v2Path,
      [
        "id: v2-agent",
        "display_name: V2 Agent",
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
    expect(isV2RuntimeEnabled(loadV2AgentConfig(v2Path))).toBe(true);

    const disabledPath = path.join(tempDir, "disabled-agent.yaml");
    fs.writeFileSync(
      disabledPath,
      [
        "id: disabled-agent",
        "enabled: false",
        "display_name: Disabled Agent",
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
    const disabledConfig = loadV2AgentConfig(disabledPath);
    expect(isV2AgentEnabled(disabledConfig)).toBe(false);
    expect(isV2RuntimeEnabled(disabledConfig)).toBe(false);
  });
});

describe("loadAllV2AgentConfigs", () => {
  it("loads every YAML config in the target directory and keys them by agent id", () => {
    const tempDir = createTempDir("tango-v2-config-dir-");

    fs.writeFileSync(
      path.join(tempDir, "bravo.yaml"),
      [
        "id: bravo",
        "display_name: Bravo",
        "type: test",
        "system_prompt_file: agents/assistants/bravo/soul.md",
        "mcp_servers:",
        "  - name: memory",
        "    command: node",
        "runtime:",
        "  mode: persistent",
        "  provider: legacy",
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
    fs.writeFileSync(
      path.join(tempDir, "alpha.yaml"),
      [
        "id: alpha",
        "display_name: Alpha",
        "type: test",
        "system_prompt_file: agents/assistants/alpha/soul.md",
        "mcp_servers:",
        "  - name: memory",
        "    command: node",
        "runtime:",
        "  mode: persistent",
        "  provider: claude-code-v2",
        "  model: claude-sonnet-4-6",
        "  reasoning_effort: high",
        "  idle_timeout_hours: 12",
        "  context_reset_threshold: 0.7",
        "memory:",
        "  post_turn_extraction: disabled",
        "  extraction_model: claude-haiku-4-5",
        "  importance_threshold: 0.5",
        "  scheduled_reflection: disabled",
        "discord:",
        "  default_channel_id: \"456\"",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(tempDir, "README.md"), "ignored");

    const configs = loadAllV2AgentConfigs(tempDir);

    expect([...configs.keys()]).toEqual(["alpha", "bravo"]);
    expect(configs.get("alpha")).toMatchObject({
      id: "alpha",
      runtime: {
        provider: "claude-code-v2",
      },
    });
    expect(configs.get("bravo")).toMatchObject({
      id: "bravo",
      runtime: {
        provider: "legacy",
      },
    });
  });
});

describe("loadLayeredV2AgentConfigs", () => {
  it("merges repo v2 configs with profile v2 overrides", () => {
    const repoRoot = createTempDir("tango-v2-layered-repo-");
    const homeDir = createTempDir("tango-v2-layered-home-");
    const originalCwd = process.cwd();
    const originalEnv = { ...process.env };
    process.chdir(repoRoot);
    const resolvedRepoRoot = process.cwd();
    process.env.TANGO_HOME = homeDir;
    process.env.TANGO_PROFILE = "default";

    try {
      fs.mkdirSync(path.join(resolvedRepoRoot, "config", "defaults"), { recursive: true });
      fs.mkdirSync(path.join(resolvedRepoRoot, "config", "v2", "agents"), { recursive: true });
      fs.writeFileSync(
        path.join(resolvedRepoRoot, "config", "v2", "agents", "alpha.yaml"),
        [
          "id: alpha",
          "enabled: false",
          "display_name: Alpha",
          "type: test",
          "system_prompt_file: agents/assistants/alpha/soul.md",
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
          "  timeout_seconds: 1800",
          "memory:",
          "  post_turn_extraction: enabled",
          "  extraction_model: claude-haiku-4-5",
          "  importance_threshold: 0.4",
          "  scheduled_reflection: enabled",
          "discord:",
          "  default_channel_id: \"repo-channel\"",
          "voice:",
          "  call_signs:",
          "    - Alpha",
          "  kokoro_voice: am_adam",
          "  default_channel_id: \"repo-channel\"",
        ].join("\n"),
      );
      const profileV2Dir = path.join(
        homeDir,
        "profiles",
        "default",
        "config",
        "v2",
        "agents",
      );
      fs.mkdirSync(profileV2Dir, { recursive: true });
      fs.writeFileSync(
        path.join(profileV2Dir, "alpha.yaml"),
        [
          "id: alpha",
          "enabled: true",
          "voice:",
          "  default_channel_id: \"profile-channel\"",
          "  smoke_test_channel_id: \"profile-smoke\"",
          "discord:",
          "  default_channel_id: \"profile-channel\"",
          "  smoke_test_channel_id: \"profile-smoke\"",
        ].join("\n"),
      );

      const configs = loadLayeredV2AgentConfigs(path.join(resolvedRepoRoot, "config", "defaults"));

      expect(configs.get("alpha")).toMatchObject({
        id: "alpha",
        enabled: true,
        displayName: "Alpha",
        runtime: {
          provider: "claude-code-v2",
          timeoutSeconds: 1800,
        },
        voice: {
          callSigns: ["Alpha"],
          defaultChannelId: "profile-channel",
          smokeTestChannelId: "profile-smoke",
        },
        discord: {
          defaultChannelId: "profile-channel",
          smokeTestChannelId: "profile-smoke",
        },
      });
    } finally {
      process.chdir(originalCwd);
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
    }
  });
});
