import { describe, expect, it } from "vitest";
import type { AgentRuntimeConfig } from "../src/agent-runtime.js";
import { selectMcpServersForTurn } from "../src/mcp-mounting.js";

function createConfig(): AgentRuntimeConfig {
  return {
    agentId: "watson",
    systemPrompt: "You are Watson.",
    mcpServers: [
      {
        name: "memory",
        command: "node",
        args: ["memory.js"],
      },
    ],
    availableMcpServers: [
      {
        name: "attachments",
        command: "node",
        args: ["mcp-proxy.js", "attachments"],
      },
      {
        name: "send-image",
        command: "node",
        args: ["mcp-proxy.js", "send-image"],
      },
    ],
    runtimePreferences: {
      model: "claude-sonnet-4-6",
    },
  };
}

describe("selectMcpServersForTurn", () => {
  it("keeps only default MCP servers when no conditional capability is needed", () => {
    const result = selectMcpServersForTurn(createConfig(), {
      message: "Morning Watson",
    });

    expect(result.config.mcpServers.map((server) => server.name)).toEqual(["memory"]);
    expect(result.selection).toMatchObject({
      defaultServerNames: ["memory"],
      availableServerNames: ["attachments", "send-image"],
      mountedServerNames: ["memory"],
      activatedServerNames: [],
    });
  });

  it("promotes attachments when the turn references an uploaded file", () => {
    const result = selectMcpServersForTurn(createConfig(), {
      message: "Can you read the PDF I uploaded?",
    });

    expect(result.config.mcpServers.map((server) => server.name)).toEqual([
      "memory",
      "attachments",
    ]);
    expect(result.selection.triggerReasons.attachments).toContain("turn-keyword");
  });

  it("promotes send-image when the turn asks to show a screenshot", () => {
    const result = selectMcpServersForTurn(createConfig(), {
      message: "Please send a screenshot of the map.",
    });

    expect(result.config.mcpServers.map((server) => server.name)).toEqual([
      "memory",
      "send-image",
    ]);
    expect(result.selection.triggerReasons["send-image"]).toContain("turn-keyword");
  });

  it("promotes attachments when inline images are present", () => {
    const result = selectMcpServersForTurn(createConfig(), {
      message: "What do you see?",
      sendOptions: {
        images: [
          {
            mediaType: "image/png",
            dataBase64: Buffer.from("fake").toString("base64"),
          },
        ],
      },
    });

    expect(result.config.mcpServers.map((server) => server.name)).toEqual([
      "memory",
      "attachments",
    ]);
    expect(result.selection.triggerReasons.attachments).toContain("images-present");
  });

  it("promotes fleet-log when save pass context is present", () => {
    const config: AgentRuntimeConfig = {
      ...createConfig(),
      availableMcpServers: [
        ...(createConfig().availableMcpServers ?? []),
        {
          name: "fleet-log",
          command: "node",
          args: ["mcp-proxy.js", "fleet-log"],
        },
      ],
    };

    const result = selectMcpServersForTurn(config, {
      message: "go",
      sendOptions: {
        context: [
          "Save pass (requested via /tango save):",
          "Daily log: call daily_log_append with 1–3 outcome bullets for fleet peers.",
        ].join("\n"),
      },
    });

    expect(result.config.mcpServers.map((server) => server.name)).toEqual([
      "memory",
      "fleet-log",
    ]);
    expect(result.selection.triggerReasons["fleet-log"]).toContain("turn-keyword");
  });

  it("promotes wellness-db when the turn asks about supplements", () => {
    const config: AgentRuntimeConfig = {
      ...createConfig(),
      availableMcpServers: [
        ...(createConfig().availableMcpServers ?? []),
        {
          name: "wellness-db",
          command: "node",
          args: ["mcp-proxy.js", "wellness-db"],
        },
      ],
    };

    const result = selectMcpServersForTurn(config, {
      message: "Can you check the supplement list in the wellness database?",
    });

    expect(result.config.mcpServers.map((server) => server.name)).toEqual([
      "memory",
      "wellness-db",
    ]);
    expect(result.selection.triggerReasons["wellness-db"]).toContain("turn-keyword");
  });
});
