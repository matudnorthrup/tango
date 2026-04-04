import fs from "node:fs";
import type { ChatProvider, ProviderRequest, ProviderResponse } from "@tango/core";
import { describe, expect, it } from "vitest";
import {
  buildWorkerProviderTools,
  executeAgentWorker,
  workerAgentResultToReport,
} from "../src/agent-worker-bridge.js";
import { SPAWN_SUB_AGENTS_TOOL_FULL_NAME } from "../src/sub-agent-tool.js";

const MALIBU_HARVESTED_REGRESSIONS = JSON.parse(
  fs.readFileSync(new URL("./fixtures/malibu-recent-regressions.json", import.meta.url), "utf8"),
) as Array<{
  turnId: string;
  requestText: string;
  workerText: string | null;
}>;

class ScriptedProvider implements ChatProvider {
  readonly calls: ProviderRequest[] = [];

  constructor(
    private readonly impl: (callNumber: number, request: ProviderRequest) => ProviderResponse | Error,
  ) {}

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    this.calls.push(request);
    const result = this.impl(this.calls.length, request);
    if (result instanceof Error) {
      throw result;
    }
    return result;
  }
}

describe("buildWorkerProviderTools", () => {
  it("builds allowlisted worker MCP config with proxy support", () => {
    const tools = buildWorkerProviderTools({
      workerId: "nutrition-logger",
      mcpServerScript: "/tmp/mcp-wellness-server.js",
      mcpServerName: "wellness",
      persistentMcpPort: 9100,
      toolIds: ["atlas_sql", "fatsecret_api", "fatsecret_api"],
      additionalMcpServers: {
        extra: {
          command: "node",
          args: ["/tmp/extra-server.js"],
          env: { EXTRA_TOKEN: "secret" },
        },
        remote: {
          type: "url",
          url: "https://example.com/mcp",
        },
      },
    });

    expect(tools.mode).toBe("allowlist");
    expect(tools.allowlist).toEqual([
      "mcp__wellness__atlas_sql",
      "mcp__wellness__fatsecret_api",
    ]);
    expect(tools.permissionMode).toBe("bypass");
    expect(tools.mcpServers).toMatchObject({
      wellness: {
        command: process.execPath,
        env: {
          MCP_SERVER_PORT: "9100",
          ALLOWED_TOOL_IDS: "atlas_sql,fatsecret_api",
          WORKER_ID: "nutrition-logger",
        },
      },
      extra: {
        command: "node",
        args: ["/tmp/extra-server.js"],
        env: { EXTRA_TOKEN: "secret" },
      },
    });
    expect(tools.mcpServers?.wellness?.args?.[0]).toContain("packages/core/dist/mcp-proxy.js");
    expect(tools.mcpServers?.remote).toBeUndefined();
  });

  it("marks read-only worker steps in the MCP server environment", () => {
    const tools = buildWorkerProviderTools({
      workerId: "nutrition-logger",
      mcpServerScript: "/tmp/mcp-wellness-server.js",
      mcpServerName: "wellness",
      readOnlyStep: true,
      toolIds: ["fatsecret_api", "atlas_sql"],
    });

    expect(tools).toMatchObject({
      mode: "allowlist",
      allowlist: ["mcp__wellness__fatsecret_api", "mcp__wellness__atlas_sql"],
      mcpServers: {
        wellness: {
          env: {
            ALLOWED_TOOL_IDS: "fatsecret_api,atlas_sql",
            WORKER_ID: "nutrition-logger",
            READ_ONLY_STEP: "1",
          },
        },
      },
    });
  });

  it("can allow additional MCP tools while hiding the primary wellness toolset", () => {
    const tools = buildWorkerProviderTools({
      workerId: "research-coordinator",
      mcpServerScript: "/tmp/mcp-wellness-server.js",
      mcpServerName: "wellness",
      additionalAllowedToolNames: [SPAWN_SUB_AGENTS_TOOL_FULL_NAME],
      additionalMcpServers: {
        subagents: {
          command: "node",
          args: ["/tmp/mcp-sub-agent-server.js"],
        },
      },
    });

    expect(tools).toMatchObject({
      mode: "allowlist",
      allowlist: [SPAWN_SUB_AGENTS_TOOL_FULL_NAME],
      mcpServers: {
        wellness: {
          env: {
            ALLOWED_TOOL_IDS: "__none__",
            WORKER_ID: "research-coordinator",
          },
        },
        subagents: {
          command: "node",
          args: ["/tmp/mcp-sub-agent-server.js"],
        },
      },
    });
  });
});

describe("executeAgentWorker", () => {
  it("uses provider failover and normalizes provider tool calls into worker reports", async () => {
    const primary = new ScriptedProvider(() => new Error("claude unavailable"));
    const secondary = new ScriptedProvider(() => ({
      text: "Logged breakfast.",
      toolCalls: [
        {
          name: "mcp__wellness__fatsecret_api",
          serverName: "wellness",
          toolName: "fatsecret_api",
          input: { method: "food_entry_create" },
          output: { ok: true },
        },
      ],
    }));

    const report = await executeAgentWorker(
      "nutrition-logger",
      "Log protein yogurt bowl for breakfast.",
      "You are Malibu's nutrition worker.",
      {
        mcpServerScript: "/tmp/mcp-wellness-server.js",
        mcpServerName: "wellness",
        providerChain: [
          { providerName: "claude-oauth", provider: primary },
          { providerName: "codex", provider: secondary },
        ],
        providerRetryLimit: 0,
        toolIds: ["fatsecret_api"],
      },
    );

    expect(primary.calls).toHaveLength(1);
    expect(secondary.calls).toHaveLength(1);
    expect(secondary.calls[0]?.tools).toEqual({
      mode: "allowlist",
      allowlist: ["mcp__wellness__fatsecret_api"],
      permissionMode: "bypass",
      mcpServers: {
        wellness: {
          command: process.execPath,
          args: ["/tmp/mcp-wellness-server.js"],
          env: expect.objectContaining({
            WORKER_ID: "nutrition-logger",
          }),
        },
      },
    });
    expect(secondary.calls[0]?.prompt).toBe("Log protein yogurt bowl for breakfast.");
    expect(secondary.calls[0]?.systemPrompt).toBe("You are Malibu's nutrition worker.");
    expect(report.data?.workerText).toBe("Logged breakfast.");
    expect(report.hasWriteOperations).toBe(true);
    expect(report.operations).toEqual([
      {
        name: "fatsecret_api",
        toolNames: ["fatsecret_api"],
        input: { method: "food_entry_create" },
        output: { ok: true },
        mode: "write",
      },
    ]);
  });

  it("retries once when a worker narrates tool cancellation without recorded tool calls", async () => {
    const provider = new ScriptedProvider((callNumber) => {
      if (callNumber === 1) {
        return {
          text: JSON.stringify({
            action: "recipe.read",
            status: "blocked",
            errors: ["recipe_read('protein yogurt bowl') returned: user cancelled MCP tool call"],
          }),
          toolCalls: [],
        };
      }

      return {
        text: "Protein yogurt bowl recipe loaded.",
        toolCalls: [
          {
            name: "mcp__wellness__recipe_read",
            serverName: "wellness",
            toolName: "recipe_read",
            input: { recipe: "protein yogurt bowl" },
            output: { title: "Protein yogurt bowl" },
          },
        ],
      };
    });

    const report = await executeAgentWorker(
      "recipe-librarian",
      "Read the protein yogurt bowl recipe.",
      "You are Malibu's recipe worker.",
      {
        mcpServerScript: "/tmp/mcp-wellness-server.js",
        mcpServerName: "wellness",
        providerChain: [{ providerName: "codex", provider }],
        providerRetryLimit: 0,
        toolIds: ["recipe_read"],
      },
    );

    expect(provider.calls).toHaveLength(2);
    expect(report.operations).toEqual([
      {
        name: "recipe_read",
        toolNames: ["recipe_read"],
        input: { recipe: "protein yogurt bowl" },
        output: { title: "Protein yogurt bowl" },
        mode: "read",
      },
    ]);
    expect(report.data?.qualityWarnings).toEqual([]);
  });

  it("retries once when recorded MCP tool calls are cancelled and the worker returns a blocked result", async () => {
    const provider = new ScriptedProvider((callNumber) => {
      if (callNumber === 1) {
        return {
          text: JSON.stringify({
            action: "nutrition.log_recipe",
            status: "blocked",
            unresolved: ["FatSecret writes were cancelled by the provider."],
          }),
          toolCalls: [
            {
              name: "mcp__wellness__fatsecret_api",
              serverName: "wellness",
              toolName: "fatsecret_api",
              input: { method: "food_entry_create" },
              output: { message: "user cancelled MCP tool call" },
            },
          ],
        };
      }

      return {
        text: "Dinner logged.",
        toolCalls: [
          {
            name: "mcp__wellness__fatsecret_api",
            serverName: "wellness",
            toolName: "fatsecret_api",
            input: { method: "food_entry_create" },
            output: { ok: true },
          },
        ],
      };
    });

    const report = await executeAgentWorker(
      "nutrition-logger",
      "Log Taco Tuesday for dinner.",
      "You are Malibu's nutrition worker.",
      {
        mcpServerScript: "/tmp/mcp-wellness-server.js",
        mcpServerName: "wellness",
        providerChain: [{ providerName: "codex", provider }],
        providerRetryLimit: 0,
        toolIds: ["fatsecret_api", "recipe_read"],
      },
    );

    expect(provider.calls).toHaveLength(2);
    expect(report.operations).toEqual([
      {
        name: "fatsecret_api",
        toolNames: ["fatsecret_api"],
        input: { method: "food_entry_create" },
        output: { ok: true },
        mode: "write",
      },
    ]);
    expect(report.data?.qualityWarnings).toEqual([]);
  });

  it("retries once when a worker with only additional MCP tools records a cancelled tool call", async () => {
    const provider = new ScriptedProvider((callNumber) => {
      if (callNumber === 1) {
        return {
          text: JSON.stringify({
            action: "research.deep_research",
            status: "blocked",
            unresolved: ["Sub-agent orchestration was cancelled by the provider."],
          }),
          toolCalls: [
            {
              name: SPAWN_SUB_AGENTS_TOOL_FULL_NAME,
              serverName: "subagents",
              toolName: "spawn_sub_agents",
              input: {
                sub_tasks: [
                  { id: "t1", task: "Research it.", tools: ["web"] },
                ],
              },
              output: { message: "user cancelled MCP tool call" },
            },
          ],
        };
      }

      return {
        text: "Research synthesis complete.",
        toolCalls: [
          {
            name: SPAWN_SUB_AGENTS_TOOL_FULL_NAME,
            serverName: "subagents",
            toolName: "spawn_sub_agents",
            input: {
              sub_tasks: [
                { id: "t1", task: "Research it.", tools: ["web"] },
              ],
            },
            output: {
              batch_id: "batch-1",
              results: [
                { id: "t1", status: "completed", output: "ok" },
              ],
            },
          },
        ],
      };
    });

    const report = await executeAgentWorker(
      "research-coordinator",
      "Do a deep research pass.",
      "You are Sierra's research coordinator.",
      {
        mcpServerScript: "/tmp/mcp-wellness-server.js",
        mcpServerName: "wellness",
        providerChain: [{ providerName: "codex", provider }],
        providerRetryLimit: 0,
        additionalAllowedToolNames: [SPAWN_SUB_AGENTS_TOOL_FULL_NAME],
        additionalMcpServers: {
          subagents: {
            command: "node",
            args: ["/tmp/mcp-sub-agent-server.js"],
          },
        },
      },
    );

    expect(provider.calls).toHaveLength(2);
    expect(report.operations).toEqual([
      {
        name: "spawn_sub_agents",
        toolNames: ["spawn_sub_agents"],
        input: {
          sub_tasks: [
            { id: "t1", task: "Research it.", tools: ["web"] },
          ],
        },
        output: {
          batch_id: "batch-1",
          results: [
            { id: "t1", status: "completed", output: "ok" },
          ],
        },
        mode: "read",
      },
    ]);
  });

  it("recovers cancelled Sierra shopping bootstrap calls and reruns the worker with recovered context", async () => {
    const provider = new ScriptedProvider((callNumber, request) => {
      if (callNumber === 1) {
        return {
          text: JSON.stringify({
            action: "shopping.browser_order_action",
            status: "blocked",
            errors: [
              "walmart history_preferences returned: user cancelled MCP tool call",
              "browser launch returned: user cancelled MCP tool call",
              "browser open returned: user cancelled MCP tool call",
              "browser snapshot returned: user cancelled MCP tool call",
            ],
          }),
          toolCalls: [
            {
              name: "mcp__wellness__walmart",
              serverName: "wellness",
              toolName: "walmart",
              input: { action: "history_preferences" },
              output: { message: "user cancelled MCP tool call" },
            },
            {
              name: "mcp__wellness__browser",
              serverName: "wellness",
              toolName: "browser",
              input: { action: "launch", port: 9223 },
              output: { message: "user cancelled MCP tool call" },
            },
            {
              name: "mcp__wellness__browser",
              serverName: "wellness",
              toolName: "browser",
              input: { action: "open", url: "https://www.walmart.com/" },
              output: { message: "user cancelled MCP tool call" },
            },
            {
              name: "mcp__wellness__browser",
              serverName: "wellness",
              toolName: "browser",
              input: { action: "snapshot", interactive: true },
              output: { message: "user cancelled MCP tool call" },
            },
          ],
        };
      }

      expect(request.systemPrompt).toContain("safe bootstrap tool calls were recovered");
      expect(request.prompt).toContain("Recovered bootstrap context:");
      expect(request.prompt).toContain("history_preferences");
      expect(request.prompt).toContain("Likely Walmart history matches");
      expect(request.prompt).toContain("browser launch");
      expect(request.prompt).toContain("Recovered browser open");
      expect(request.prompt).toContain("Recovered browser snapshot");
      return {
        text: "Added six yogurts to Walmart cart.",
        toolCalls: [
          {
            name: "mcp__wellness__browser",
            serverName: "wellness",
            toolName: "browser",
            input: { action: "click", ref: 7 },
            output: { result: "Clicked Add to cart" },
          },
        ],
      };
    });

    const browserLaunchCalls: Array<{ port: number }> = [];
    const browserReadCalls: Array<{ action: string; url?: string; interactive?: boolean }> = [];
    const historyAnalyzeCalls: Array<{ daysBack?: number; topN?: number }> = [];
    const report = await executeAgentWorker(
      "research-assistant",
      [
        "Handle this request in your domain now.",
        "Intent contract: shopping.browser_order_action",
        "Intent mode: write",
        "User message: Add 6 of my usual light greek vanilla yogurt to my Walmart cart.",
        "Extracted entities: {\"item\":\"light greek vanilla yogurt\",\"quantity\":6,\"preference\":\"usual\"}",
      ].join("\n"),
      "You are Sierra's research worker.",
      {
        mcpServerScript: "/tmp/mcp-research-server.js",
        mcpServerName: "wellness",
        providerChain: [{ providerName: "codex", provider }],
        providerRetryLimit: 0,
        toolIds: ["walmart", "browser"],
        browserLaunchExecutor: async (input) => {
          browserLaunchCalls.push(input);
          return { result: `Connected on ${input.port}` };
        },
        browserReadExecutor: async (input) => {
          browserReadCalls.push(input);
          if (input.action === "status") {
            return { connected: true, url: "about:blank", title: "Blank" };
          }
          if (input.action === "open") {
            return { result: `Opened ${input.url}` };
          }
          return { result: "# Walmart\nURL: https://www.walmart.com/\n\n[1] button \"Add to cart - Great Value Light Greek Vanilla Yogurt\"" };
        },
        walmartHistoryPreferencesExecutor: async () => ({
          total: 1,
          preferences: [
            {
              query: "light greek vanilla yogurt",
              selected_item: "Great Value Light Greek Vanilla Yogurt",
              item_id: "12345",
              times_selected: 4,
              last_selected: "2026-03-15T00:00:00.000Z",
              auto_add_eligible: true,
            },
          ],
        }),
        walmartHistoryAnalyzeExecutor: async (input) => {
          historyAnalyzeCalls.push(input);
          return {
            total_receipts_items: 20,
            total_unique_items: 12,
            days_analyzed: input.daysBack ?? 365,
            items: [
              {
                name: "GV vanilla greek yogurt 32 oz",
                purchase_count: 2,
                total_spend: 11.96,
                avg_price: 5.98,
                avg_interval_days: 14,
                last_purchase: "2026-03-08",
                next_expected: "2026-03-22",
                days_until_next: -7,
                is_staple: true,
              },
            ],
          };
        },
      },
    );

    expect(provider.calls).toHaveLength(2);
    expect(browserLaunchCalls).toEqual([{ port: 9223 }, { port: 9223 }]);
    expect(historyAnalyzeCalls).toEqual([{ daysBack: 365, topN: 50 }]);
    expect(browserReadCalls).toEqual([
      { action: "open", url: "https://www.walmart.com/search?q=GV%20vanilla%20greek%20yogurt%2032%20oz" },
      { action: "open", url: "https://www.walmart.com/" },
      { action: "snapshot", interactive: true },
    ]);
    expect(report.hasWriteOperations).toBe(true);
    expect(report.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "walmart",
          input: { action: "history_preferences" },
          mode: "read",
        }),
        expect.objectContaining({
          name: "browser",
          input: { action: "launch", port: 9223 },
          mode: "read",
        }),
        expect.objectContaining({
          name: "browser",
          input: { action: "open", url: "https://www.walmart.com/" },
          mode: "read",
        }),
        expect.objectContaining({
          name: "browser",
          input: { action: "snapshot", interactive: true },
          mode: "read",
        }),
        expect.objectContaining({
          name: "browser",
          input: { action: "click", ref: 7 },
          mode: "write",
        }),
      ]),
    );
    expect(report.data?.qualityWarnings).toEqual([]);
  });

  it("recovers cancelled Sierra shopping cart mutations deterministically from the live page state", async () => {
    const provider = new ScriptedProvider(() => ({
      text: JSON.stringify({
        action: "browser_order_action",
        status: "blocked",
        results: [
          {
            retailer: "Walmart",
            target_item: "Great Value Vanilla Light Nonfat Greek Yogurt, 32 oz Tub",
            target_quantity: 3,
            page_context: {
              url: "https://www.walmart.com/search?q=GV%20vanilla%20greek%20yogurt%2032%20oz",
              cart_before: "0 items, $0.00",
            },
            mutation_outcome: "Not completed",
          },
        ],
        errors: [
          {
            tool: "browser",
            attempted_action: "click ref 38",
            outcome: "user cancelled MCP tool call",
          },
        ],
        follow_up: [
          "Cart state is unconfirmed after the blocked browser actions.",
        ],
      }),
      toolCalls: [
        {
          name: "mcp__wellness__browser",
          serverName: "wellness",
          toolName: "browser",
          input: { action: "click", ref: 38 },
          output: { message: "user cancelled MCP tool call" },
        },
        {
          name: "mcp__wellness__browser",
          serverName: "wellness",
          toolName: "browser",
          input: { action: "snapshot", interactive: true },
          output: { message: "user cancelled MCP tool call" },
        },
      ],
    }));

    let quantity = 0;
    const browserReadCalls: Array<{ action: string; url?: string; interactive?: boolean }> = [];
    const browserMutationCalls: Array<{ action: string; ref: number }> = [];

    const report = await executeAgentWorker(
      "research-assistant",
      [
        "Handle this request in your domain now.",
        "Intent contract: shopping.browser_order_action",
        "Intent mode: write",
        "User message: Add 3 of my usual light greek vanilla yogurt to my Walmart cart.",
        "Extracted entities: {\"item\":\"light greek vanilla yogurt\",\"quantity\":3,\"preference\":\"usual\"}",
      ].join("\n"),
      "You are Sierra's research worker.",
      {
        mcpServerScript: "/tmp/mcp-research-server.js",
        mcpServerName: "wellness",
        providerChain: [{ providerName: "codex", provider }],
        providerRetryLimit: 0,
        toolIds: ["walmart", "browser"],
        browserLaunchExecutor: async (input) => ({ result: `Connected on ${input.port}` }),
        browserReadExecutor: async (input) => {
          browserReadCalls.push(input);
          if (input.action === "open") {
            return { result: `Opened ${input.url}` };
          }
          if (input.action === "status") {
            return { connected: true, url: "about:blank", title: "Blank" };
          }
          const cartTotal = (quantity * 2.94).toFixed(2);
          if (quantity === 0) {
            return {
              result: [
                "# Walmart",
                "URL: https://www.walmart.com/search?q=GV%20vanilla%20greek%20yogurt%2032%20oz",
                "",
                "[8] button \"Cart contains 0 items Total Amount $0.00\"",
                "[38] button \"Add to cart - Great Value Vanilla Light Nonfat Greek Yogurt, 32 oz Tub\"",
                "",
                "--- 2 interactive elements ---",
              ].join("\n"),
            };
          }
          return {
            result: [
              "# Walmart",
              "URL: https://www.walmart.com/search?q=GV%20vanilla%20greek%20yogurt%2032%20oz",
              "",
              `[8] button \"Cart contains ${quantity} item${quantity === 1 ? "" : "s"} Total Amount $${cartTotal}\"`,
              `[38] button \"Decrease quantity Great Value Vanilla Light Nonfat Greek Yogurt, 32 oz Tub, Current Quantity ${quantity}\"`,
              `[39] button \"Increase quantity Great Value Vanilla Light Nonfat Greek Yogurt, 32 oz Tub, Current Quantity ${quantity}\"`,
              "",
              "--- 3 interactive elements ---",
            ].join("\n"),
          };
        },
        browserMutationExecutor: async (input) => {
          browserMutationCalls.push(input);
          if (input.ref === 38 && quantity === 0) {
            quantity = 1;
            return { result: "Clicked add to cart" };
          }
          if (input.ref === 39 && quantity > 0) {
            quantity += 1;
            return { result: `Increased quantity to ${quantity}` };
          }
          throw new Error(`Unexpected recovery click ref ${input.ref} at quantity ${quantity}`);
        },
      },
    );

    expect(provider.calls).toHaveLength(1);
    expect(quantity).toBe(3);
    expect(browserReadCalls).toEqual([
      { action: "open", url: "https://www.walmart.com/search?q=GV%20vanilla%20greek%20yogurt%2032%20oz" },
      { action: "status" },
      { action: "snapshot", interactive: true },
      { action: "snapshot", interactive: true },
      { action: "snapshot", interactive: true },
      { action: "snapshot", interactive: true },
      { action: "snapshot", interactive: true },
    ]);
    expect(browserMutationCalls).toEqual([
      { action: "click", ref: 38 },
      { action: "click", ref: 39 },
      { action: "click", ref: 39 },
    ]);
    expect(report.hasWriteOperations).toBe(true);
    expect(report.data?.qualityWarnings).toEqual([]);
    expect(report.data?.workerText).toContain("\"shoppingMutationRecovered\":true");
    expect(report.data?.workerText).toContain("\"finalQuantity\":3");
  });

  it("recovers Sierra shopping cart writes even when the worker only recorded cancelled browser reads", async () => {
    const provider = new ScriptedProvider(() => ({
      text: JSON.stringify({
        action: "shopping.browser_order_action",
        status: "blocked",
        results: [
          {
            retailer: "Walmart",
            requested_item: "usual light greek vanilla yogurt",
            target_item: "Great Value Vanilla Light Nonfat Greek Yogurt, 32 oz Tub",
            target_quantity: 2,
            page_context: {
              url: "https://www.walmart.com/search?q=GV%20vanilla%20greek%20yogurt%2032%20oz",
              cart_before: "0 items, $0.00",
            },
            mutation_outcome: "Cart not updated",
          },
        ],
        errors: [
          {
            tool: "browser",
            attempts: [
              { action: "snapshot", outcome: "user cancelled MCP tool call" },
              { action: "status", outcome: "user cancelled MCP tool call" },
            ],
            impact: "Could not inspect the live Walmart page or perform the add-to-cart action.",
          },
        ],
      }),
      toolCalls: [
        {
          name: "mcp__wellness__browser",
          serverName: "wellness",
          toolName: "browser",
          input: { action: "snapshot", interactive: true },
          output: { message: "user cancelled MCP tool call" },
        },
        {
          name: "mcp__wellness__browser",
          serverName: "wellness",
          toolName: "browser",
          input: { action: "status" },
          output: { message: "user cancelled MCP tool call" },
        },
      ],
    }));

    let quantity = 0;
    const browserMutationCalls: Array<{ action: string; ref: number }> = [];

    const report = await executeAgentWorker(
      "research-assistant",
      [
        "Handle this request in your domain now.",
        "Intent contract: shopping.browser_order_action",
        "Intent mode: write",
        "User message: Add 2 of my usual light greek vanilla yogurt to my Walmart cart.",
        "Extracted entities: {\"item\":\"light greek vanilla yogurt\",\"quantity\":2,\"preference\":\"usual\"}",
      ].join("\n"),
      "You are Sierra's research worker.",
      {
        mcpServerScript: "/tmp/mcp-research-server.js",
        mcpServerName: "wellness",
        providerChain: [{ providerName: "codex", provider }],
        providerRetryLimit: 0,
        toolIds: ["walmart", "browser"],
        browserLaunchExecutor: async (input) => ({ result: `Connected on ${input.port}` }),
        browserReadExecutor: async (input) => {
          if (input.action === "open") {
            return { result: `Opened ${input.url}` };
          }
          if (input.action === "status") {
            return { connected: true, url: "about:blank", title: "Blank" };
          }
          const cartTotal = (quantity * 2.94).toFixed(2);
          if (quantity === 0) {
            return {
              result: [
                "# Walmart",
                "URL: https://www.walmart.com/search?q=GV%20vanilla%20greek%20yogurt%2032%20oz",
                "",
                "[8] button \"Cart contains 0 items Total Amount $0.00\"",
                "[38] button \"Add to cart - Great Value Vanilla Light Nonfat Greek Yogurt, 32 oz Tub\"",
                "",
                "--- 2 interactive elements ---",
              ].join("\n"),
            };
          }
          return {
            result: [
              "# Walmart",
              "URL: https://www.walmart.com/search?q=GV%20vanilla%20greek%20yogurt%2032%20oz",
              "",
              `[8] button \"Cart contains ${quantity} item${quantity === 1 ? "" : "s"} Total Amount $${cartTotal}\"`,
              `[38] button \"Decrease quantity Great Value Vanilla Light Nonfat Greek Yogurt, 32 oz Tub, Current Quantity ${quantity}\"`,
              `[39] button \"Increase quantity Great Value Vanilla Light Nonfat Greek Yogurt, 32 oz Tub, Current Quantity ${quantity}\"`,
              "",
              "--- 3 interactive elements ---",
            ].join("\n"),
          };
        },
        browserMutationExecutor: async (input) => {
          browserMutationCalls.push(input);
          if (input.ref === 38 && quantity === 0) {
            quantity = 1;
            return { result: "Clicked add to cart" };
          }
          if (input.ref === 39 && quantity > 0) {
            quantity += 1;
            return { result: `Increased quantity to ${quantity}` };
          }
          throw new Error(`Unexpected recovery click ref ${input.ref} at quantity ${quantity}`);
        },
      },
    );

    expect(provider.calls).toHaveLength(2);
    expect(quantity).toBe(2);
    expect(browserMutationCalls).toEqual([
      { action: "click", ref: 38 },
      { action: "click", ref: 39 },
    ]);
    expect(report.hasWriteOperations).toBe(true);
    expect(report.data?.qualityWarnings).toEqual([]);
    expect(report.data?.workerText).toContain("\"shoppingMutationRecovered\":true");
    expect(report.data?.workerText).toContain("\"finalQuantity\":2");
  });

  it("recovers Sierra shopping cart writes from the live-style requested_mutation payload shape", async () => {
    const provider = new ScriptedProvider(() => ({
      text: JSON.stringify({
        action: "browser_order_action",
        status: "blocked",
        results: [
          {
            requested_mutation: "Add quantity 2 of usual light greek vanilla yogurt to Walmart cart",
            preflight_context_used: {
              active_page: "https://www.walmart.com/search?q=GV%20vanilla%20greek%20yogurt%2032%20oz",
              likely_history_match: "GV vanilla greek yogurt 32 oz",
              last_purchase: "2026-03-08",
            },
            mutation_outcome: "Unconfirmed. No cart change was completed in this run.",
          },
        ],
        errors: [
          {
            tool: "browser",
            attempts: 2,
            operation: "snapshot",
            evidence: "Both attempts returned: user cancelled MCP tool call",
          },
        ],
      }),
      toolCalls: [
        {
          name: "mcp__wellness__browser",
          serverName: "wellness",
          toolName: "browser",
          input: { action: "snapshot", interactive: true },
          output: { message: "user cancelled MCP tool call" },
        },
        {
          name: "mcp__wellness__walmart",
          serverName: "wellness",
          toolName: "walmart",
          input: { action: "queue_list" },
          output: { message: "user cancelled MCP tool call" },
        },
      ],
    }));

    let quantity = 0;
    const browserMutationCalls: Array<{ action: string; ref: number }> = [];

    const report = await executeAgentWorker(
      "research-assistant",
      [
        "Handle this request in your domain now.",
        "Intent contract: shopping.browser_order_action",
        "Intent mode: write",
        "User message: Add 2 of my usual light greek vanilla yogurt to my Walmart cart.",
        "Extracted entities: {\"retailer\":\"Walmart\",\"quantity\":2,\"item\":\"light greek vanilla yogurt\",\"preference\":\"usual\"}",
      ].join("\n"),
      "You are Sierra's research worker.",
      {
        mcpServerScript: "/tmp/mcp-research-server.js",
        mcpServerName: "wellness",
        providerChain: [{ providerName: "codex", provider }],
        providerRetryLimit: 0,
        toolIds: ["walmart", "browser"],
        browserLaunchExecutor: async (input) => ({ result: `Connected on ${input.port}` }),
        browserReadExecutor: async (input) => {
          if (input.action === "open") {
            return { result: `Opened ${input.url}` };
          }
          if (input.action === "status") {
            return { connected: true, url: "about:blank", title: "Blank" };
          }
          const cartTotal = (quantity * 2.94).toFixed(2);
          if (quantity === 0) {
            return {
              result: [
                "# Walmart",
                "URL: https://www.walmart.com/search?q=GV%20vanilla%20greek%20yogurt%2032%20oz",
                "",
                "[8] button \"Cart contains 0 items Total Amount $0.00\"",
                "[38] button \"Add to cart - Great Value Vanilla Light Nonfat Greek Yogurt, 32 oz Tub\"",
                "",
                "--- 2 interactive elements ---",
              ].join("\n"),
            };
          }
          return {
            result: [
              "# Walmart",
              "URL: https://www.walmart.com/search?q=GV%20vanilla%20greek%20yogurt%2032%20oz",
              "",
              `[8] button \"Cart contains ${quantity} item${quantity === 1 ? "" : "s"} Total Amount $${cartTotal}\"`,
              `[38] button \"Decrease quantity Great Value Vanilla Light Nonfat Greek Yogurt, 32 oz Tub, Current Quantity ${quantity}\"`,
              `[39] button \"Increase quantity Great Value Vanilla Light Nonfat Greek Yogurt, 32 oz Tub, Current Quantity ${quantity}\"`,
              "",
              "--- 3 interactive elements ---",
            ].join("\n"),
          };
        },
        browserMutationExecutor: async (input) => {
          browserMutationCalls.push(input);
          if (input.ref === 38 && quantity === 0) {
            quantity = 1;
            return { result: "Clicked add to cart" };
          }
          if (input.ref === 39 && quantity > 0) {
            quantity += 1;
            return { result: `Increased quantity to ${quantity}` };
          }
          throw new Error(`Unexpected recovery click ref ${input.ref} at quantity ${quantity}`);
        },
      },
    );

    expect(provider.calls).toHaveLength(1);
    expect(quantity).toBe(2);
    expect(browserMutationCalls).toEqual([
      { action: "click", ref: 38 },
      { action: "click", ref: 39 },
    ]);
    expect(report.hasWriteOperations).toBe(true);
    expect(report.data?.qualityWarnings).toEqual([]);
    expect(report.data?.workerText).toContain("\"shoppingMutationRecovered\":true");
    expect(report.data?.workerText).toContain("\"finalQuantity\":2");
  });

  it("uses quantity_requested from the live worker payload when recovering Sierra shopping cart writes", async () => {
    const provider = new ScriptedProvider(() => ({
      text: JSON.stringify({
        action: "browser_order_action",
        status: "blocked",
        results: [
          {
            retailer: "Walmart",
            target_item: "Great Value Vanilla Light Nonfat Greek Yogurt, 32 oz Tub",
            quantity_requested: 2,
            mutation_outcome: "Unconfirmed. Live browser mutation could not be executed.",
          },
        ],
        errors: [
          {
            tool: "browser",
            attempted_actions: ["status", "snapshot"],
            failure: "Live browser checks were cancelled before the cart update could finish.",
          },
        ],
      }),
      toolCalls: [
        {
          name: "mcp__wellness__browser",
          serverName: "wellness",
          toolName: "browser",
          input: { action: "status" },
          output: { message: "user cancelled MCP tool call" },
        },
        {
          name: "mcp__wellness__browser",
          serverName: "wellness",
          toolName: "browser",
          input: { action: "snapshot", interactive: true },
          output: { message: "user cancelled MCP tool call" },
        },
      ],
    }));

    let quantity = 1;
    let launchCalls = 0;
    const browserMutationCalls: Array<{ action: string; ref: number }> = [];
    const report = await executeAgentWorker(
      "research-assistant",
      [
        "Handle this request in your domain now.",
        "Intent contract: shopping.browser_order_action",
        "Intent mode: write",
        "User message: Add 2 of my usual light greek vanilla yogurt to my Walmart cart.",
        "Extracted entities: {\"retailer\":\"Walmart\",\"item\":\"light greek vanilla yogurt\",\"preference\":\"usual\"}",
      ].join("\n"),
      "You are Sierra's research worker.",
      {
        mcpServerScript: "/tmp/mcp-research-server.js",
        mcpServerName: "wellness",
        providerChain: [{ providerName: "codex", provider }],
        providerRetryLimit: 0,
        toolIds: ["walmart", "browser"],
        browserLaunchExecutor: async (input) => {
          launchCalls += 1;
          return { result: `Connected on ${input.port}` };
        },
        browserReadExecutor: async (input) => {
          if (input.action === "status") {
            return {
              connected: true,
              url: "https://www.walmart.com/search?q=GV%20vanilla%20greek%20yogurt%2032%20oz",
              title: "GV vanilla greek yogurt 32 oz - Walmart.com",
            };
          }
          return {
            result: [
              "# Walmart",
              "URL: https://www.walmart.com/search?q=GV%20vanilla%20greek%20yogurt%2032%20oz",
              "",
              `[8] button \"Cart contains ${quantity} item${quantity === 1 ? "" : "s"} Total Amount $2.94\"`,
              `[38] button \"Decrease quantity Great Value Vanilla Light Nonfat Greek Yogurt, 32 oz Tub, Current Quantity ${quantity}\"`,
              `[39] button \"Increase quantity Great Value Vanilla Light Nonfat Greek Yogurt, 32 oz Tub, Current Quantity ${quantity}\"`,
              "",
              "--- 3 interactive elements ---",
            ].join("\n"),
          };
        },
        browserMutationExecutor: async (input) => {
          browserMutationCalls.push(input);
          if (input.ref === 39 && quantity === 1) {
            quantity = 2;
            return { result: "Increased quantity to 2" };
          }
          throw new Error(`Unexpected recovery click ref ${input.ref} at quantity ${quantity}`);
        },
      },
    );

    expect(provider.calls).toHaveLength(2);
    expect(quantity).toBe(2);
    expect(browserMutationCalls).toEqual([{ action: "click", ref: 39 }]);
    expect(report.hasWriteOperations).toBe(true);
    expect(report.data?.workerText).toContain("\"shoppingMutationRecovered\":true");
    expect(report.data?.workerText).toContain("\"finalQuantity\":2");
  });

  it("falls back to results.item and task quantity when a Sierra shopping rerun only reports intended_mutation text", async () => {
    const provider = new ScriptedProvider(() => ({
      text: JSON.stringify({
        action: "browser_order_action",
        status: "blocked",
        results: [
          {
            target: "Walmart cart",
            item: "Great Value Vanilla Light Nonfat Greek Yogurt, 32 oz Tub",
            observed_state: "Quantity 1 already in cart.",
            intended_mutation: "Increase quantity by 1 so cart quantity becomes 2.",
          },
        ],
        errors: [
          {
            tool: "browser",
            attempted_action: "click ref 48 (Increase quantity Great Value Vanilla Light Nonfat Greek Yogurt, 32 oz Tub, Current Quantity 1)",
            result: "user cancelled MCP tool call",
          },
        ],
      }),
      toolCalls: [
        {
          name: "mcp__wellness__browser",
          serverName: "wellness",
          toolName: "browser",
          input: { action: "snapshot", interactive: true },
          output: {
            result: [
              "# Walmart",
              "URL: https://www.walmart.com/search?q=GV%20vanilla%20greek%20yogurt%2032%20oz",
              "",
              `[8] button \"Cart contains 1 item Total Amount $2.94\"`,
              `[47] button \"Decrease quantity Great Value Vanilla Light Nonfat Greek Yogurt, 32 oz Tub, Current Quantity 1\"`,
              `[48] button \"Increase quantity Great Value Vanilla Light Nonfat Greek Yogurt, 32 oz Tub, Current Quantity 1\"`,
              "",
              "--- 3 interactive elements ---",
            ].join("\n"),
          },
        },
        {
          name: "mcp__wellness__browser",
          serverName: "wellness",
          toolName: "browser",
          input: { action: "click", ref: 48 },
          output: { message: "user cancelled MCP tool call" },
        },
        {
          name: "mcp__wellness__browser",
          serverName: "wellness",
          toolName: "browser",
          input: { action: "status" },
          output: { message: "user cancelled MCP tool call" },
        },
      ],
    }));

    let quantity = 1;
    let launchCalls = 0;
    const browserMutationCalls: Array<{ action: string; ref: number }> = [];
    const report = await executeAgentWorker(
      "research-assistant",
      [
        "Handle this request in your domain now.",
        "Intent contract: shopping.browser_order_action",
        "Intent mode: write",
        "User message: Add 2 of my usual light greek vanilla yogurt to my Walmart cart.",
      ].join("\n"),
      "You are Sierra's research worker.",
      {
        mcpServerScript: "/tmp/mcp-research-server.js",
        mcpServerName: "wellness",
        providerChain: [{ providerName: "codex", provider }],
        providerRetryLimit: 0,
        toolIds: ["walmart", "browser"],
        browserLaunchExecutor: async (input) => {
          launchCalls += 1;
          return { result: `Connected on ${input.port}` };
        },
        browserReadExecutor: async (input) => {
          if (input.action === "status") {
            return {
              connected: true,
              url: "https://www.walmart.com/search?q=GV%20vanilla%20greek%20yogurt%2032%20oz",
              title: "GV vanilla greek yogurt 32 oz - Walmart.com",
            };
          }
          return {
            result: [
              "# Walmart",
              "URL: https://www.walmart.com/search?q=GV%20vanilla%20greek%20yogurt%2032%20oz",
              "",
              `[8] button \"Cart contains ${quantity} item${quantity === 1 ? "" : "s"} Total Amount $${quantity === 1 ? "2.94" : "5.88"}\"`,
              `[47] button \"Decrease quantity Great Value Vanilla Light Nonfat Greek Yogurt, 32 oz Tub, Current Quantity ${quantity}\"`,
              `[48] button \"Increase quantity Great Value Vanilla Light Nonfat Greek Yogurt, 32 oz Tub, Current Quantity ${quantity}\"`,
              "",
              "--- 3 interactive elements ---",
            ].join("\n"),
          };
        },
        browserMutationExecutor: async (input) => {
          browserMutationCalls.push(input);
          if (input.ref === 48 && quantity === 1) {
            quantity = 2;
            return { result: "Increased quantity to 2" };
          }
          throw new Error(`Unexpected recovery click ref ${input.ref} at quantity ${quantity}`);
        },
      },
    );

    expect(provider.calls).toHaveLength(1);
    expect(launchCalls).toBe(1);
    expect(quantity).toBe(2);
    expect(browserMutationCalls).toEqual([{ action: "click", ref: 48 }]);
    expect(report.hasWriteOperations).toBe(true);
    expect(report.data?.workerText).toContain("\"shoppingMutationRecovered\":true");
    expect(report.data?.workerText).toContain("\"finalQuantity\":2");
  });

  it("replays Sierra shopping browser clicks directly when the worker already chose the right quantity control", async () => {
    const provider = new ScriptedProvider(() => ({
      text: JSON.stringify({
        action: "browser_order_action",
        status: "blocked",
        results: [
          {
            item: "Great Value Vanilla Light Nonfat Greek Yogurt, 32 oz Tub",
            requested_quantity: 2,
            detected_state: "Search results showed the item already in cart at quantity 1 via button refs 45/46.",
            mutation_outcome: "Unconfirmed. Live browser mutation could not be executed.",
          },
        ],
        errors: [
          {
            tool: "browser",
            attempted_actions: ["click ref 46", "status"],
            failure: "Both live browser tool calls returned user cancelled MCP tool call.",
          },
        ],
      }),
      toolCalls: [
        {
          name: "mcp__wellness__browser",
          serverName: "wellness",
          toolName: "browser",
          input: { action: "status" },
          output: {
            connected: true,
            url: "https://www.walmart.com/search?q=GV%20vanilla%20greek%20yogurt%2032%20oz",
            title: "GV vanilla greek yogurt 32 oz - Walmart.com",
          },
        },
        {
          name: "mcp__wellness__browser",
          serverName: "wellness",
          toolName: "browser",
          input: { action: "snapshot", interactive: true },
          output: {
            result: [
              "# Walmart",
              "URL: https://www.walmart.com/search?q=GV%20vanilla%20greek%20yogurt%2032%20oz",
              "",
              "[8] button \"Cart contains 1 item Total Amount $2.94\"",
              "[45] button \"Decrease quantity Great Value Vanilla Light Nonfat Greek Yogurt, 32 oz Tub, Current Quantity 1\"",
              "[46] button \"Increase quantity Great Value Vanilla Light Nonfat Greek Yogurt, 32 oz Tub, Current Quantity 1\"",
              "",
              "--- 3 interactive elements ---",
            ].join("\n"),
          },
        },
        {
          name: "mcp__wellness__browser",
          serverName: "wellness",
          toolName: "browser",
          input: { action: "click", ref: 46 },
          output: { message: "user cancelled MCP tool call" },
        },
        {
          name: "mcp__wellness__browser",
          serverName: "wellness",
          toolName: "browser",
          input: { action: "wait", timeout: 2000 },
          output: { message: "user cancelled MCP tool call" },
        },
        {
          name: "mcp__wellness__browser",
          serverName: "wellness",
          toolName: "browser",
          input: { action: "status" },
          output: { message: "user cancelled MCP tool call" },
        },
      ],
    }));

    let quantity = 1;
    const browserMutationCalls: Array<{ action: string; ref: number }> = [];

    const report = await executeAgentWorker(
      "research-assistant",
      [
        "Handle this request in your domain now.",
        "Intent contract: shopping.browser_order_action",
        "Intent mode: write",
        "User message: Add 2 of my usual light greek vanilla yogurt to my Walmart cart.",
        "Extracted entities: {\"retailer\":\"Walmart\",\"quantity\":2,\"item\":\"light greek vanilla yogurt\",\"preference\":\"usual\"}",
      ].join("\n"),
      "You are Sierra's research worker.",
      {
        mcpServerScript: "/tmp/mcp-research-server.js",
        mcpServerName: "wellness",
        providerChain: [{ providerName: "codex", provider }],
        providerRetryLimit: 0,
        toolIds: ["walmart", "browser"],
        browserLaunchExecutor: async (input) => ({ result: `Connected on ${input.port}` }),
        browserReadExecutor: async (input) => {
          if (input.action === "open") {
            return { result: `Opened ${input.url}` };
          }
          if (input.action === "status") {
            return {
              connected: true,
              url: "https://www.walmart.com/search?q=GV%20vanilla%20greek%20yogurt%2032%20oz",
              title: "GV vanilla greek yogurt 32 oz - Walmart.com",
            };
          }
          const cartTotal = (quantity * 2.94).toFixed(2);
          return {
            result: [
              "# Walmart",
              "URL: https://www.walmart.com/search?q=GV%20vanilla%20greek%20yogurt%2032%20oz",
              "",
              `[8] button \"Cart contains ${quantity} item${quantity === 1 ? "" : "s"} Total Amount $${cartTotal}\"`,
              `[45] button \"Decrease quantity Great Value Vanilla Light Nonfat Greek Yogurt, 32 oz Tub, Current Quantity ${quantity}\"`,
              `[46] button \"Increase quantity Great Value Vanilla Light Nonfat Greek Yogurt, 32 oz Tub, Current Quantity ${quantity}\"`,
              "",
              "--- 3 interactive elements ---",
            ].join("\n"),
          };
        },
        browserMutationExecutor: async (input) => {
          browserMutationCalls.push(input);
          if (input.ref === 46 && quantity === 1) {
            quantity = 2;
            return { result: "Increased quantity to 2" };
          }
          throw new Error(`Unexpected recovery click ref ${input.ref} at quantity ${quantity}`);
        },
      },
    );

    expect(provider.calls).toHaveLength(1);
    expect(quantity).toBe(2);
    expect(browserMutationCalls).toEqual([{ action: "click", ref: 46 }]);
    expect(report.hasWriteOperations).toBe(true);
    expect(report.data?.qualityWarnings).toEqual([]);
    expect(report.data?.workerText).toContain("\"shoppingMutationRecovered\":true");
    expect(report.data?.workerText).toContain("\"finalQuantity\":2");
  });

  it("replays cancelled fatsecret writes deterministically after the worker still returns blocked results", async () => {
    const provider = new ScriptedProvider(() => ({
      text: JSON.stringify({
        action: "nutrition.log_recipe",
        status: "blocked",
        unresolved: ["FatSecret writes were cancelled by the provider."],
        errors: ["food_entry_create returned: user cancelled MCP tool call"],
      }),
      toolCalls: [
        {
          name: "mcp__wellness__fatsecret_api",
          serverName: "wellness",
          toolName: "fatsecret_api",
          input: {
            method: "food_entry_create",
            params: {
              food_id: "123",
              food_entry_name: "Taco Tuesday",
              serving_id: "456",
              number_of_units: 1,
              meal: "dinner",
            },
          },
          output: { message: "user cancelled MCP tool call" },
        },
      ],
    }));

    const replayCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const report = await executeAgentWorker(
      "nutrition-logger",
      "Log Taco Tuesday for dinner.",
      "You are Malibu's nutrition worker.",
      {
        mcpServerScript: "/tmp/mcp-wellness-server.js",
        mcpServerName: "wellness",
        providerChain: [{ providerName: "codex", provider }],
        providerRetryLimit: 0,
        toolIds: ["fatsecret_api", "recipe_read"],
        fatsecretReplayExecutor: async (input) => {
          replayCalls.push(input);
          return { ok: true, entry_id: "789" };
        },
      },
    );

    expect(provider.calls).toHaveLength(2);
    expect(replayCalls).toEqual([
      {
        method: "food_entry_create",
        params: {
          food_id: "123",
          food_entry_name: "Taco Tuesday",
          serving_id: "456",
          number_of_units: 1,
          meal: "dinner",
        },
      },
    ]);
    expect(report.operations).toEqual([
      {
        name: "fatsecret_api",
        toolNames: ["fatsecret_api"],
        input: {
          method: "food_entry_create",
          params: {
            food_id: "123",
            food_entry_name: "Taco Tuesday",
            serving_id: "456",
            number_of_units: 1,
            meal: "dinner",
          },
        },
        output: { ok: true, entry_id: "789" },
        mode: "write",
      },
    ]);
    expect(report.data?.qualityWarnings).toEqual([]);
  });

  it("clears stale blocked warnings when runtime replay recovers fatsecret writes from a broader blocked payload", async () => {
    const provider = new ScriptedProvider(() => ({
      text: JSON.stringify({
        action: "wellness.log_recipe_meal",
        status: "blocked",
        results: {
          lunch: { written: false },
        },
        errors: [
          "FatSecret calls were cancelled repeatedly in this run.",
          "Because FatSecret serving metadata and diary state could not be verified, no lunch diary writes were performed.",
        ],
        follow_up: [
          "Retry once FatSecret tool calls stop cancelling.",
        ],
      }),
      toolCalls: [
        {
          name: "mcp__wellness__fatsecret_api",
          serverName: "wellness",
          toolName: "fatsecret_api",
          input: { method: "food_entries_get", params: { date: "2026-03-30" } },
          output: { message: "user cancelled MCP tool call" },
        },
        {
          name: "mcp__wellness__fatsecret_api",
          serverName: "wellness",
          toolName: "fatsecret_api",
          input: {
            method: "food_entry_create",
            params: {
              food_id: "123",
              food_entry_name: "Eggs",
              serving_id: "456",
              number_of_units: 2,
              meal: "lunch",
              date: "2026-03-30",
            },
          },
          output: { message: "user cancelled MCP tool call" },
        },
      ],
    }));

    const report = await executeAgentWorker(
      "nutrition-logger",
      "Repair lunch diary writes.",
      "You are Malibu's nutrition worker.",
      {
        mcpServerScript: "/tmp/mcp-wellness-server.js",
        mcpServerName: "wellness",
        providerChain: [{ providerName: "codex", provider }],
        providerRetryLimit: 0,
        toolIds: ["fatsecret_api"],
        fatsecretReplayExecutor: async (input) => {
          if (input.method === "food_entries_get") {
            return [{ food_entry_name: "Eggs" }];
          }
          return { value: "created-entry-id" };
        },
      },
    );

    expect(report.data?.qualityWarnings).toEqual([]);
    expect(report.data?.workerText).toContain('"status":"completed"');
  });

  it("rewrites blocked payloads when runtime replay recovers fatsecret read metadata but no diary write occurred", async () => {
    const provider = new ScriptedProvider(() => ({
      text: JSON.stringify({
        action: "wellness.log_food_items",
        status: "blocked",
        logged: [],
        unresolved: [
          {
            item: "125g light yogurt",
            meal: "other",
            reason: "FatSecret serving metadata could not be verified in this run.",
          },
          {
            item: "70g raspberries",
            meal: "other",
            reason: "FatSecret serving metadata could not be verified in this run.",
          },
        ],
        totals: {
          date: "2026-03-31",
          status: "unconfirmed",
          reason: "Diary refresh was not possible because no verified FatSecret read or write succeeded.",
        },
        errors: [
          "mcp__wellness__fatsecret_api food_get(38834732) returned `user cancelled MCP tool call` twice.",
          "mcp__wellness__fatsecret_api food_get(61270) returned `user cancelled MCP tool call` twice.",
        ],
        follow_up: [
          "Retry once FatSecret network resolution is working again.",
        ],
      }),
      toolCalls: [
        {
          name: "mcp__wellness__fatsecret_api",
          serverName: "wellness",
          toolName: "fatsecret_api",
          input: { method: "food_get", params: { food_id: 38834732 } },
          output: { message: "user cancelled MCP tool call" },
        },
        {
          name: "mcp__wellness__fatsecret_api",
          serverName: "wellness",
          toolName: "fatsecret_api",
          input: { method: "food_get", params: { food_id: 61270 } },
          output: { message: "user cancelled MCP tool call" },
        },
      ],
    }));

    const report = await executeAgentWorker(
      "nutrition-logger",
      "Log snack. 125g light yogurt, 70g raspberries.",
      "You are Malibu's nutrition worker.",
      {
        mcpServerScript: "/tmp/mcp-wellness-server.js",
        mcpServerName: "wellness",
        providerChain: [{ providerName: "codex", provider }],
        providerRetryLimit: 0,
        toolIds: ["fatsecret_api", "atlas_sql"],
        fatsecretReplayExecutor: async (input) => ({
          food_id: String(input.params.food_id),
          food_name: input.params.food_id === 38834732 ? "Light Greek Vanilla Yogurt" : "Frozen Red Raspberries",
        }),
      },
    );

    expect(report.hasWriteOperations).toBe(false);
    expect(report.operations.filter((operation) => operation.name === "fatsecret_api")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          input: { method: "food_get", params: { food_id: 38834732 } },
          mode: "read",
        }),
        expect.objectContaining({
          input: { method: "food_get", params: { food_id: 61270 } },
          mode: "read",
        }),
      ]),
    );
    expect(report.data?.workerText).toContain('"readMetadataRecovered":true');
    expect(report.data?.workerText).toContain(
      "FatSecret serving metadata was recovered after runtime replay, but the diary write was not attempted in the original run.",
    );
    expect(report.data?.workerText).not.toContain("user cancelled MCP tool call");
    expect(report.data?.qualityWarnings).toEqual([
      "Worker reported blocked result.",
      "FatSecret serving metadata was recovered after runtime replay, but the diary write was not attempted in the original run.",
    ]);
  });

  it("synthesizes missing fatsecret diary writes when replay recovers enough serving metadata", async () => {
    const provider = new ScriptedProvider(() => ({
      text: JSON.stringify({
        action: "wellness.log_food_items",
        status: "blocked",
        logged: [],
        unresolved: [
          {
            item: "125g light yogurt",
            atlas_match: {
              name: "Light Greek Yogurt",
              brand: "Great Value",
              product: "Light Greek Vanilla Yogurt",
              food_id: 38834732,
              serving_id: 34139206,
              serving_description: "2/3 cup",
              grams_per_serving: 170,
            },
            reason: "FatSecret serving metadata could not be verified in this run.",
          },
          {
            item: "70g raspberries",
            atlas_match: {
              name: "Raspberries",
              food_id: 61270,
              serving_id: 103603,
              serving_size: "140g",
            },
            reason: "FatSecret serving metadata could not be verified in this run.",
          },
        ],
        totals: null,
        errors: [
          "mcp__wellness__fatsecret_api food_get(38834732) returned `user cancelled MCP tool call` twice.",
          "mcp__wellness__fatsecret_api food_get(61270) returned `user cancelled MCP tool call` twice.",
        ],
        follow_up: [
          "Meal mapping is resolved as `snack -> other` in the runtime.",
        ],
      }),
      toolCalls: [
        {
          name: "mcp__wellness__fatsecret_api",
          serverName: "wellness",
          toolName: "fatsecret_api",
          input: { method: "food_get", params: { food_id: 38834732 } },
          output: { message: "user cancelled MCP tool call" },
        },
        {
          name: "mcp__wellness__fatsecret_api",
          serverName: "wellness",
          toolName: "fatsecret_api",
          input: { method: "food_get", params: { food_id: 61270 } },
          output: { message: "user cancelled MCP tool call" },
        },
      ],
    }));

    const replayCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const report = await executeAgentWorker(
      "nutrition-logger",
      "Finish that snack entry.",
      "You are Malibu's nutrition worker.",
      {
        mcpServerScript: "/tmp/mcp-wellness-server.js",
        mcpServerName: "wellness",
        providerChain: [{ providerName: "codex", provider }],
        providerRetryLimit: 0,
        toolIds: ["fatsecret_api", "atlas_sql"],
        fatsecretReplayExecutor: async (input) => {
          replayCalls.push(input);
          if (input.method === "food_get") {
            return input.params.food_id === 38834732
              ? {
                  food_id: "38834732",
                  food_name: "Light Greek Vanilla Yogurt",
                  servings: {
                    serving: {
                      serving_id: "34139206",
                      metric_serving_amount: "170.000",
                      number_of_units: "1.000",
                    },
                  },
                }
              : {
                  food_id: "61270",
                  food_name: "Frozen Red Raspberries",
                  servings: {
                    serving: {
                      serving_id: "103603",
                      metric_serving_amount: "140.000",
                      number_of_units: "1.000",
                    },
                  },
                };
          }
          if (input.method === "food_entry_create") {
            return { value: `created-${input.params.food_id}` };
          }
          return [{ food_entry_name: "Light Greek Vanilla Yogurt" }];
        },
      },
    );

    expect(replayCalls).toEqual(
      expect.arrayContaining([
        { method: "food_get", params: { food_id: 38834732 } },
        { method: "food_get", params: { food_id: 61270 } },
        {
          method: "food_entry_create",
          params: {
            food_id: "38834732",
            food_entry_name: "Light Greek Vanilla Yogurt",
            serving_id: "34139206",
            number_of_units: 0.735294,
            meal: "other",
          },
        },
        {
          method: "food_entry_create",
          params: {
            food_id: "61270",
            food_entry_name: "Frozen Red Raspberries",
            serving_id: "103603",
            number_of_units: 0.5,
            meal: "other",
          },
        },
      ]),
    );
    expect(replayCalls.some((call) => call.method === "food_entries_get")).toBe(true);
    expect(report.hasWriteOperations).toBe(true);
    expect(report.operations.filter((operation) => operation.name === "fatsecret_api")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          input: { method: "food_get", params: { food_id: 38834732 } },
          mode: "read",
        }),
        expect.objectContaining({
          input: { method: "food_get", params: { food_id: 61270 } },
          mode: "read",
        }),
        expect.objectContaining({
          input: {
            method: "food_entry_create",
            params: {
              food_id: "38834732",
              food_entry_name: "Light Greek Vanilla Yogurt",
              serving_id: "34139206",
              number_of_units: 0.735294,
              meal: "other",
            },
          },
          mode: "write",
        }),
        expect.objectContaining({
          input: {
            method: "food_entry_create",
            params: {
              food_id: "61270",
              food_entry_name: "Frozen Red Raspberries",
              serving_id: "103603",
              number_of_units: 0.5,
              meal: "other",
            },
          },
          mode: "write",
        }),
      ]),
    );
    expect(report.data?.workerText).toContain('"status":"completed"');
    expect(report.data?.workerText).toContain('"synthesizedDiaryWrites":2');
    expect(report.data?.qualityWarnings).toEqual([]);
  });

  it("reconstructs atlas matches from atlas_sql output before synthesizing missing diary writes", async () => {
    const provider = new ScriptedProvider(() => ({
      text: JSON.stringify({
        action: "nutrition.log_food",
        status: "blocked",
        logged: [],
        unresolved: [
          {
            item: "125g light yogurt",
            reason: "Atlas match found (`Light Greek Yogurt`, food_id `38834732`, serving_id `34139206`, grams_per_serving `170`), but the diary write was not attempted after FatSecret serving verification failed at the environment level.",
          },
          {
            item: "70g raspberries",
            reason: "Atlas match found (`Raspberries`, food_id `61270`, serving_id `103603`), but this serving needed FatSecret verification before logging and that read failed at the environment level.",
          },
        ],
        totals: {
          meal: "other",
          date: "2026-03-31",
          refreshed_from_diary: false,
          status: "unconfirmed",
          reason: "FatSecret serving metadata was recovered after runtime replay, but no diary write was executed in the original run.",
        },
        errors: [],
        follow_up: [
          "When retried, normalize `snack` to FatSecret meal `other`.",
        ],
      }),
      toolCalls: [
        {
          name: "mcp__wellness__atlas_sql",
          serverName: "wellness",
          toolName: "atlas_sql",
          input: { sql: "SELECT ..." },
          output: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  result: JSON.stringify([
                    {
                      name: "Light Greek Yogurt",
                      brand: "Great Value",
                      product: "Light Greek Vanilla Yogurt",
                      food_id: 38834732,
                      serving_id: 34139206,
                      grams_per_serving: 170,
                      aliases: JSON.stringify(["light yogurt", "vanilla yogurt"]),
                    },
                    {
                      name: "Raspberries",
                      food_id: 61270,
                      serving_id: 103603,
                      serving_size: "140g",
                      aliases: JSON.stringify(["raspberries", "frozen raspberries"]),
                    },
                  ]),
                }),
              },
            ],
          },
        },
        {
          name: "mcp__wellness__fatsecret_api",
          serverName: "wellness",
          toolName: "fatsecret_api",
          input: { method: "food_get", params: { food_id: 38834732 } },
          output: { message: "user cancelled MCP tool call" },
        },
        {
          name: "mcp__wellness__fatsecret_api",
          serverName: "wellness",
          toolName: "fatsecret_api",
          input: { method: "food_get", params: { food_id: 61270 } },
          output: { message: "user cancelled MCP tool call" },
        },
      ],
    }));

    const replayCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const report = await executeAgentWorker(
      "nutrition-logger",
      "go ahead and finish that snack entry",
      "You are Malibu's nutrition worker.",
      {
        mcpServerScript: "/tmp/mcp-wellness-server.js",
        mcpServerName: "wellness",
        providerChain: [{ providerName: "codex", provider }],
        providerRetryLimit: 0,
        toolIds: ["fatsecret_api", "atlas_sql"],
        fatsecretReplayExecutor: async (input) => {
          replayCalls.push(input);
          if (input.method === "food_get") {
            return input.params.food_id === 38834732
              ? {
                  food_id: "38834732",
                  food_name: "Light Greek Vanilla Yogurt",
                  servings: {
                    serving: {
                      serving_id: "34139206",
                      metric_serving_amount: "170.000",
                      number_of_units: "1.000",
                    },
                  },
                }
              : {
                  food_id: "61270",
                  food_name: "Frozen Red Raspberries",
                  servings: {
                    serving: {
                      serving_id: "103603",
                      metric_serving_amount: "140.000",
                      number_of_units: "1.000",
                    },
                  },
                };
          }
          if (input.method === "food_entry_create") {
            return { value: `created-${input.params.food_id}` };
          }
          return [{ food_entry_name: "Light Greek Vanilla Yogurt" }];
        },
      },
    );

    expect(replayCalls.map((call) => call.method)).toEqual([
      "food_get",
      "food_get",
      "food_entry_create",
      "food_entry_create",
      "food_entries_get",
    ]);
    expect(report.hasWriteOperations).toBe(true);
    expect(report.data?.workerText).toContain('"status":"completed"');
    expect(report.data?.qualityWarnings).toEqual([]);
  });

  it("synthesizes a banana diary write when runtime replay recovers FatSecret search results and can fetch serving metadata", async () => {
    const provider = new ScriptedProvider(() => ({
      text: JSON.stringify({
        action: "nutrition.log_food",
        status: "blocked",
        logged: [],
        unresolved: [
          {
            item: "one medium banana",
            meal: "other",
            date: "2026-04-01",
            reason: "Atlas lookup returned no banana match, and FatSecret search could not complete.",
          },
        ],
        totals: null,
        errors: [
          "atlas_sql returned no matching ingredient for banana.",
          "fatsecret_api foods_search(search_expression: \"banana medium\") returned `user cancelled MCP tool call` twice on this run, including the required retry.",
        ],
        follow_up: [
          "Retry the FatSecret lookup so the banana can be resolved and logged.",
        ],
      }),
      toolCalls: [
        {
          name: "mcp__wellness__fatsecret_api",
          serverName: "wellness",
          toolName: "fatsecret_api",
          input: { method: "foods_search", params: { search_expression: "banana medium", max_results: 10 } },
          output: { message: "user cancelled MCP tool call" },
        },
      ],
    }));

    const report = await executeAgentWorker(
      "nutrition-logger",
      "Finish logging one medium banana as other.",
      "You are Malibu's nutrition worker.",
      {
        mcpServerScript: "/tmp/mcp-wellness-server.js",
        mcpServerName: "wellness",
        providerChain: [{ providerName: "codex", provider }],
        providerRetryLimit: 0,
        toolIds: ["fatsecret_api", "atlas_sql"],
        fatsecretReplayExecutor: async (input) => {
          if (input.method === "foods_search") {
            return [
              {
                food_id: "5388",
                food_name: "Banana",
                food_description: "Per 1 medium - Calories: 105kcal | Fat: 0.39g | Carbs: 26.95g | Protein: 1.29g",
              },
            ];
          }
          if (input.method === "food_get") {
            return {
              food_id: "5388",
              food_name: "Banana",
              servings: {
                serving: [
                  {
                    serving_id: "19134",
                    serving_description: "1 medium",
                    metric_serving_amount: "118.000",
                    number_of_units: "1.000",
                  },
                ],
              },
            };
          }
          if (input.method === "food_entry_create") {
            return { value: "created-5388" };
          }
          if (input.method === "food_entries_get") {
            return [{ food_entry_name: "Banana" }];
          }
          throw new Error(`Unexpected FatSecret method ${input.method}`);
        },
      },
    );

    expect(report.hasWriteOperations).toBe(true);
    expect(report.operations.filter((operation) => operation.name === "fatsecret_api").length).toBeGreaterThanOrEqual(4);
    expect(report.operations.some((operation) =>
      operation.name === "fatsecret_api"
      && operation.mode === "write"
      && (operation.input.method === "food_entry_create")
    )).toBe(true);
    expect(report.data?.workerText).toContain("\"status\":\"completed\"");
    expect(report.data?.workerText).not.toContain("user cancelled MCP tool call");
    expect(report.data?.qualityWarnings).toEqual([]);
  });

  it("synthesizes a banana diary write even when the worker only returned read-only search results", async () => {
    const provider = new ScriptedProvider(() => ({
      text: JSON.stringify({
        action: "log_food_items",
        status: "ok",
        results: [
          {
            item: "one medium banana",
            meal: "other",
            date: "2026-04-02",
            atlas_lookup: "no match",
            fatsecret_lookup: "unconfirmed",
            diary_write: "unconfirmed",
          },
        ],
        unresolved: [],
        totals: {
          date: "2026-04-02",
          status: "unconfirmed",
        },
        errors: [],
        follow_up: [],
      }),
      toolCalls: [
        {
          name: "mcp__wellness__atlas_sql",
          serverName: "wellness",
          toolName: "atlas_sql",
          input: { sql: "SELECT ... banana ..." },
          output: { content: [{ type: "text", text: "{\"result\":\"[]\"}" }], structured_content: null },
        },
        {
          name: "mcp__wellness__fatsecret_api",
          serverName: "wellness",
          toolName: "fatsecret_api",
          input: { method: "food_entries_get", params: { date: "2026-04-02" } },
          output: [],
        },
        {
          name: "mcp__wellness__fatsecret_api",
          serverName: "wellness",
          toolName: "fatsecret_api",
          input: { method: "foods_search", params: { search_expression: "banana medium raw", max_results: 10 } },
          output: [
            {
              food_id: "5388",
              food_name: "Banana",
              food_description: "Per 1 medium - Calories: 105kcal | Fat: 0.39g | Carbs: 26.95g | Protein: 1.29g",
            },
          ],
        },
      ],
    }));

    const replayCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const report = await executeAgentWorker(
      "nutrition-logger",
      "Finish logging one medium banana as other for 2026-04-02.",
      "You are Malibu's nutrition worker.",
      {
        mcpServerScript: "/tmp/mcp-wellness-server.js",
        mcpServerName: "wellness",
        providerChain: [{ providerName: "codex", provider }],
        providerRetryLimit: 0,
        toolIds: ["fatsecret_api", "atlas_sql"],
        fatsecretReplayExecutor: async (input) => {
          replayCalls.push(input);
          if (input.method === "food_get") {
            return {
              food_id: "5388",
              food_name: "Banana",
              servings: {
                serving: [
                  {
                    serving_id: "19134",
                    serving_description: "1 medium",
                    metric_serving_amount: "118.000",
                    number_of_units: "1.000",
                  },
                ],
              },
            };
          }
          if (input.method === "food_entry_create") {
            return { value: "created-5388" };
          }
          if (input.method === "food_entries_get") {
            return [{ food_entry_name: "Banana" }];
          }
          throw new Error(`Unexpected FatSecret method ${input.method}`);
        },
      },
    );

    expect(replayCalls.map((call) => call.method)).toEqual(
      expect.arrayContaining(["food_get", "food_entry_create"]),
    );
    expect(report.hasWriteOperations).toBe(true);
    expect(report.data?.workerText).toContain("\"status\":\"completed\"");
    expect(report.data?.qualityWarnings).toEqual([]);
  });

  it("retries banana synthesis with a simplified supplemental FatSecret search when the first search only returns brand junk", async () => {
    const provider = new ScriptedProvider(() => ({
      text: JSON.stringify({
        action: "log_food_items",
        status: "ok",
        results: [
          {
            item: "one medium banana",
            meal: "other",
            date: "2026-04-02",
            atlas_lookup: "no match",
            fatsecret_lookup: "unconfirmed",
            diary_write: "unconfirmed",
          },
        ],
        unresolved: [],
        totals: {
          date: "2026-04-02",
          status: "unconfirmed",
        },
        errors: [],
        follow_up: [],
      }),
      toolCalls: [
        {
          name: "mcp__wellness__atlas_sql",
          serverName: "wellness",
          toolName: "atlas_sql",
          input: { sql: "SELECT ... banana ..." },
          output: { content: [{ type: "text", text: "{\"result\":\"[]\"}" }], structured_content: null },
        },
        {
          name: "mcp__wellness__fatsecret_api",
          serverName: "wellness",
          toolName: "fatsecret_api",
          input: { method: "food_entries_get", params: { date: "2026-04-02" } },
          output: [],
        },
        {
          name: "mcp__wellness__fatsecret_api",
          serverName: "wellness",
          toolName: "fatsecret_api",
          input: { method: "foods_search", params: { search_expression: "banana medium", max_results: 10 } },
          output: [
            {
              food_id: "73513198",
              food_name: "Banana - Shakes Medium",
              food_type: "Brand",
              brand_name: "Braum's",
            },
            {
              food_id: "68885534",
              food_name: "Banana Milkshake - Medium",
              food_type: "Brand",
              brand_name: "Sheetz",
            },
          ],
        },
      ],
    }));

    const replayCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const report = await executeAgentWorker(
      "nutrition-logger",
      "Finish logging one medium banana as other for 2026-04-02.",
      "You are Malibu's nutrition worker.",
      {
        mcpServerScript: "/tmp/mcp-wellness-server.js",
        mcpServerName: "wellness",
        providerChain: [{ providerName: "codex", provider }],
        providerRetryLimit: 0,
        toolIds: ["fatsecret_api", "atlas_sql"],
        fatsecretReplayExecutor: async (input) => {
          replayCalls.push(input);
          if (input.method === "foods_search") {
            return [
              {
                food_id: "5388",
                food_name: "Banana",
                food_type: "Generic",
                food_description: "Per 1 medium - Calories: 105kcal | Fat: 0.39g | Carbs: 26.95g | Protein: 1.29g",
              },
            ];
          }
          if (input.method === "food_get") {
            return {
              food_id: "5388",
              food_name: "Banana",
              servings: {
                serving: [
                  {
                    serving_id: "19134",
                    serving_description: "1 medium",
                    metric_serving_amount: "118.000",
                    number_of_units: "1.000",
                  },
                ],
              },
            };
          }
          if (input.method === "food_entry_create") {
            return { value: "created-5388" };
          }
          if (input.method === "food_entries_get") {
            return [{ food_entry_name: "Banana" }];
          }
          throw new Error(`Unexpected FatSecret method ${input.method}`);
        },
      },
    );

    expect(replayCalls.map((call) => `${call.method}:${String(call.params.search_expression ?? call.params.food_id ?? "")}`)).toEqual(
      expect.arrayContaining([
        "foods_search:banana",
        "foods_search:banana raw",
        "food_get:5388",
        "food_entry_create:5388",
      ]),
    );
    expect(report.hasWriteOperations).toBe(true);
    expect(report.data?.workerText).toContain("\"status\":\"completed\"");
    expect(report.data?.qualityWarnings).toEqual([]);
  });

  it("synthesizes recipe-derived diary writes when a blocked recipe log only preserves partial unresolved item names", async () => {
    const provider = new ScriptedProvider(() => ({
      text: JSON.stringify({
        action: "nutrition.log_food",
        status: "blocked",
        logged: [],
        unresolved: [
          {
            item: "La Abuela flour tortillas",
            reason: "FatSecret serving metadata was recovered after runtime replay, but the diary write was not attempted in the original run.",
          },
          {
            item: "Whole milk Greek yogurt",
            reason: "FatSecret serving metadata was recovered after runtime replay, but the diary write was not attempted in the original run.",
          },
        ],
        totals: null,
        errors: [
          "Recipe check succeeded: `Taco Tuesday`.",
          "Atlas resolved the Taco Tuesday ingredients.",
          "No diary writes were performed because required serving-unit verification remained unresolved.",
        ],
        follow_up: [
          "Need either a successful FatSecret serving lookup for the selected tortilla and yogurt rows, or explicit confirmation to use the Atlas assumptions despite the conflicting/missing serving metadata.",
        ],
      }),
      toolCalls: [
        {
          name: "mcp__wellness__recipe_read",
          serverName: "wellness",
          toolName: "recipe_read",
          input: { name: "Taco Tuesday" },
          output: {
            found: true,
            matches: [
              {
                title: "Taco Tuesday",
                content: [
                  "# Taco Tuesday",
                  "",
                  "## Base Toppings (per taco)",
                  "| Ingredient | Amount | Cal |",
                  "|------------|--------|-----|",
                  "| Purple Cabbage | 20g | 6 |",
                  "| Whole Milk Greek Yogurt | 15g | 15 |",
                  "",
                  "## Protein Options (per taco)",
                  "| Protein | Amount | Cal |",
                  "|---------|--------|-----|",
                  "| Canned Chicken Breast | 75g | 60 |",
                  "| Fish | 50g | TBD |",
                  "",
                  "## Tortilla Options",
                  "| Tortilla | Serving | Cal |",
                  "|----------|---------|-----|",
                  "| La Abuela Flour Tortilla | 1 tortilla (30g) | 100 |",
                  "| Corn Tortilla | 2 tortillas | 46 |",
                ].join("\n"),
              },
            ],
          },
        },
        {
          name: "mcp__wellness__atlas_sql",
          serverName: "wellness",
          toolName: "atlas_sql",
          input: { sql: "SELECT ... taco ingredients ..." },
          output: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  result: JSON.stringify([
                    {
                      name: "Purple Cabbage",
                      product: "Red Cabbage",
                      food_id: 6236,
                      serving_id: 54916,
                    },
                    {
                      name: "Whole Milk Greek Yogurt",
                      food_id: 23761706,
                      serving_id: 22170245,
                    },
                    {
                      name: "Canned Chicken Breast",
                      product: "Canned Chunk Chicken Breast",
                      food_id: 4723234,
                      serving_id: 4597573,
                    },
                    {
                      name: "Flour Tortilla",
                      aliases: JSON.stringify(["la abuela flour tortilla", "flour tortilla"]),
                      brand: "La Abuela",
                      product: "Flour Tortillas",
                      food_id: 227272,
                      serving_id: 266753,
                    },
                  ]),
                }),
              },
            ],
          },
        },
        {
          name: "mcp__wellness__fatsecret_api",
          serverName: "wellness",
          toolName: "fatsecret_api",
          input: { method: "food_get", params: { food_id: 6236 } },
          output: { message: "user cancelled MCP tool call" },
        },
        {
          name: "mcp__wellness__fatsecret_api",
          serverName: "wellness",
          toolName: "fatsecret_api",
          input: { method: "food_get", params: { food_id: 23761706 } },
          output: { message: "user cancelled MCP tool call" },
        },
        {
          name: "mcp__wellness__fatsecret_api",
          serverName: "wellness",
          toolName: "fatsecret_api",
          input: { method: "food_get", params: { food_id: 4723234 } },
          output: { message: "user cancelled MCP tool call" },
        },
        {
          name: "mcp__wellness__fatsecret_api",
          serverName: "wellness",
          toolName: "fatsecret_api",
          input: { method: "food_get", params: { food_id: 227272 } },
          output: { message: "user cancelled MCP tool call" },
        },
      ],
    }));

    const replayCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const report = await executeAgentWorker(
      "nutrition-logger",
      "Great let's log dinner now. Today was Taco Tuesday again and I had three chicken tacos with the La Abuela flour tortillas.",
      "You are Malibu's nutrition worker.",
      {
        mcpServerScript: "/tmp/mcp-wellness-server.js",
        mcpServerName: "wellness",
        providerChain: [{ providerName: "codex", provider }],
        providerRetryLimit: 0,
        toolIds: ["fatsecret_api", "atlas_sql", "recipe_read"],
        fatsecretReplayExecutor: async (input) => {
          replayCalls.push(input);
          if (input.method === "food_get") {
            if (input.params.food_id === 6236) {
              return {
                food_id: "6236",
                food_name: "Red Cabbage",
                servings: { serving: { serving_id: "54916", metric_serving_amount: "100.000", number_of_units: "1.000" } },
              };
            }
            if (input.params.food_id === 23761706) {
              return {
                food_id: "23761706",
                food_name: "Whole Milk Greek Yogurt",
                servings: { serving: { serving_id: "22170245", metric_serving_amount: "227.000", number_of_units: "1.000" } },
              };
            }
            if (input.params.food_id === 4723234) {
              return {
                food_id: "4723234",
                food_name: "Canned Chunk Chicken Breast",
                servings: { serving: { serving_id: "4597573", metric_serving_amount: "56.000", number_of_units: "1.000" } },
              };
            }
            return {
              food_id: "227272",
              food_name: "Flour Tortillas",
              servings: { serving: { serving_id: "266753", metric_serving_amount: "31.000", number_of_units: "1.000" } },
            };
          }
          if (input.method === "food_entry_create") {
            return { value: `created-${input.params.food_id}` };
          }
          return [{ food_entry_name: "Flour Tortillas" }];
        },
      },
    );

    expect(replayCalls.map((call) => call.method)).toEqual([
      "food_get",
      "food_get",
      "food_get",
      "food_get",
      "food_entry_create",
      "food_entry_create",
      "food_entry_create",
      "food_entry_create",
      "food_entries_get",
    ]);
    expect(replayCalls.filter((call) => call.method === "food_entry_create")).toEqual([
      {
        method: "food_entry_create",
        params: {
          food_id: "6236",
          food_entry_name: "Red Cabbage",
          serving_id: "54916",
          number_of_units: 0.6,
          meal: "dinner",
        },
      },
      {
        method: "food_entry_create",
        params: {
          food_id: "23761706",
          food_entry_name: "Whole Milk Greek Yogurt",
          serving_id: "22170245",
          number_of_units: 0.198238,
          meal: "dinner",
        },
      },
      {
        method: "food_entry_create",
        params: {
          food_id: "4723234",
          food_entry_name: "Canned Chunk Chicken Breast",
          serving_id: "4597573",
          number_of_units: 4.017857,
          meal: "dinner",
        },
      },
      {
        method: "food_entry_create",
        params: {
          food_id: "227272",
          food_entry_name: "Flour Tortillas",
          serving_id: "266753",
          number_of_units: 2.903226,
          meal: "dinner",
        },
      },
    ]);
  expect(report.hasWriteOperations).toBe(true);
  expect(report.data?.workerText).toContain('"status":"completed"');
  expect(report.data?.qualityWarnings).toEqual([]);
  });

  it("synthesizes diary writes from blocked nutrition payloads that preserve unresolved name and quantity fields", async () => {
    const provider = new ScriptedProvider(() => ({
      text: JSON.stringify({
        action: "nutrition.log_food",
        status: "blocked",
        logged: [],
        unresolved: [
          {
            name: "light yogurt",
            quantity: "200g",
            resolution: "Atlas match found: Light Greek Yogurt (food_id 38834732, serving_id 34139206, grams_per_serving 170)",
            reason: "FatSecret serving verification could not be completed in this run, so the diary write was not confirmed.",
          },
          {
            name: "cocoa",
            quantity: "10g",
            resolution: "Atlas match found: Cocoa Powder (food_id 81066433, serving_id 65455423)",
            reason: "FatSecret serving verification could not be completed in this run, so the diary write was not confirmed.",
          },
          {
            name: "cacao nibs",
            quantity: "6g",
            resolution: "Atlas match found: Cocoa Nibs (food_id 18750682, serving_id 17670786, grams_per_serving 28)",
            reason: "FatSecret serving verification could not be completed in this run, so the diary write was not confirmed.",
          },
          {
            name: "pb powder",
            quantity: "1 tbsp",
            resolution: "Atlas match found: Peanut Butter Powder (food_id 45580247, serving_id 39194697)",
            reason: "FatSecret serving metadata was recovered after runtime replay, but the diary write was not attempted in the original run.",
          },
        ],
        totals: {
          date: "2026-04-01",
          meal: "snack",
          day_totals: "unresolved",
          status: "unconfirmed",
          reason: "FatSecret serving metadata was recovered after runtime replay, but no diary write was executed in the original run.",
        },
        errors: [],
        follow_up: [
          "Retry once to commit the diary write now that FatSecret metadata has been recovered.",
        ],
      }),
      toolCalls: [
        {
          name: "mcp__wellness__atlas_sql",
          serverName: "wellness",
          toolName: "atlas_sql",
          input: { sql: "SELECT snack ingredients ..." },
          output: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  result: JSON.stringify([
                    {
                      name: "Light Greek Yogurt",
                      product: "Light Greek Vanilla Yogurt",
                      aliases: JSON.stringify(["light yogurt", "vanilla yogurt"]),
                      food_id: 38834732,
                      serving_id: 34139206,
                      grams_per_serving: 170,
                    },
                    {
                      name: "Cocoa Powder",
                      aliases: JSON.stringify(["cocoa"]),
                      food_id: 81066433,
                      serving_id: 65455423,
                    },
                    {
                      name: "Cocoa Nibs",
                      product: "Organic Cacao Nibs",
                      aliases: JSON.stringify(["cacao nibs", "cocoa nibs"]),
                      food_id: 18750682,
                      serving_id: 17670786,
                      grams_per_serving: 28,
                    },
                    {
                      name: "Peanut Butter Powder",
                      aliases: JSON.stringify(["pb powder", "peanut butter powder"]),
                      food_id: 45580247,
                      serving_id: 39194697,
                    },
                  ]),
                }),
              },
            ],
          },
        },
        {
          name: "mcp__wellness__fatsecret_api",
          serverName: "wellness",
          toolName: "fatsecret_api",
          input: { method: "food_get", params: { food_id: 38834732 } },
          output: { message: "user cancelled MCP tool call" },
        },
        {
          name: "mcp__wellness__fatsecret_api",
          serverName: "wellness",
          toolName: "fatsecret_api",
          input: { method: "food_get", params: { food_id: 81066433 } },
          output: { message: "user cancelled MCP tool call" },
        },
        {
          name: "mcp__wellness__fatsecret_api",
          serverName: "wellness",
          toolName: "fatsecret_api",
          input: { method: "food_get", params: { food_id: 18750682 } },
          output: { message: "user cancelled MCP tool call" },
        },
        {
          name: "mcp__wellness__fatsecret_api",
          serverName: "wellness",
          toolName: "fatsecret_api",
          input: { method: "food_get", params: { food_id: 45580247 } },
          output: { message: "user cancelled MCP tool call" },
        },
      ],
    }));

    const replayCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const report = await executeAgentWorker(
      "nutrition-logger",
      "I'll probably have a yogurt snack. 200g light yogurt, 10g cocoa, 6g cacao nibs, 1 tbsp pb powder.",
      "You are Malibu's nutrition worker.",
      {
        mcpServerScript: "/tmp/mcp-wellness-server.js",
        mcpServerName: "wellness",
        providerChain: [{ providerName: "codex", provider }],
        providerRetryLimit: 0,
        toolIds: ["fatsecret_api", "atlas_sql"],
        fatsecretReplayExecutor: async (input) => {
          replayCalls.push(input);
          if (input.method === "food_get") {
            if (input.params.food_id === 38834732) {
              return {
                food_id: "38834732",
                food_name: "Light Greek Vanilla Yogurt",
                servings: { serving: { serving_id: "34139206", metric_serving_amount: "170.000", number_of_units: "1.000", serving_description: "2/3 cup" } },
              };
            }
            if (input.params.food_id === 81066433) {
              return {
                food_id: "81066433",
                food_name: "Cocoa Powder",
                servings: { serving: { serving_id: "65455423", metric_serving_amount: "6.000", number_of_units: "1.000", serving_description: "1 tbsp" } },
              };
            }
            if (input.params.food_id === 18750682) {
              return {
                food_id: "18750682",
                food_name: "Organic Cacao Nibs",
                servings: { serving: { serving_id: "17670786", metric_serving_amount: "28.000", number_of_units: "1.000", serving_description: "3 tbsp" } },
              };
            }
            return {
              food_id: "45580247",
              food_name: "Peanut Butter Powder",
              servings: { serving: { serving_id: "39194697", metric_serving_amount: "16.000", number_of_units: "1.000", serving_description: "2 tbsp" } },
            };
          }
          if (input.method === "food_entry_create") {
            return { value: `created-${input.params.food_id}` };
          }
          if (input.method === "food_entries_get") {
            return [{ food_entry_name: "Light Greek Vanilla Yogurt" }];
          }
          throw new Error(`Unexpected FatSecret method ${input.method}`);
        },
      },
    );

    expect(replayCalls.filter((call) => call.method === "food_entry_create")).toEqual([
      {
        method: "food_entry_create",
        params: {
          food_id: "38834732",
          food_entry_name: "Light Greek Vanilla Yogurt",
          serving_id: "34139206",
          number_of_units: 1.176471,
          meal: "other",
          date: "2026-04-01",
        },
      },
      {
        method: "food_entry_create",
        params: {
          food_id: "81066433",
          food_entry_name: "Cocoa Powder",
          serving_id: "65455423",
          number_of_units: 1.666667,
          meal: "other",
          date: "2026-04-01",
        },
      },
      {
        method: "food_entry_create",
        params: {
          food_id: "18750682",
          food_entry_name: "Organic Cacao Nibs",
          serving_id: "17670786",
          number_of_units: 0.214286,
          meal: "other",
          date: "2026-04-01",
        },
      },
      {
        method: "food_entry_create",
        params: {
          food_id: "45580247",
          food_entry_name: "Peanut Butter Powder",
          serving_id: "39194697",
          number_of_units: 0.5,
          meal: "other",
          date: "2026-04-01",
        },
      },
    ]);
    expect(report.hasWriteOperations).toBe(true);
    expect(report.data?.workerText).toContain('"status":"completed"');
    expect(report.data?.qualityWarnings).toEqual([]);
  });

  it("replays the harvested Malibu yogurt-snack regression fixture into a successful synthesized diary write", async () => {
    const fixture = MALIBU_HARVESTED_REGRESSIONS.find((entry) => entry.turnId === "21e2aa5b-4e7c-47b6-ac45-eee16d606dc1");
    expect(fixture?.workerText).toBeTruthy();

    const provider = new ScriptedProvider(() => ({
      text: fixture!.workerText!,
      toolCalls: [
        {
          name: "mcp__wellness__atlas_sql",
          serverName: "wellness",
          toolName: "atlas_sql",
          input: { sql: "SELECT snack ingredients ..." },
          output: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  result: JSON.stringify([
                    {
                      name: "Light Greek Yogurt",
                      product: "Light Greek Vanilla Yogurt",
                      aliases: JSON.stringify(["light yogurt", "vanilla yogurt"]),
                      food_id: 38834732,
                      serving_id: 34139206,
                      grams_per_serving: 170,
                    },
                    {
                      name: "Cocoa Powder",
                      aliases: JSON.stringify(["cocoa"]),
                      food_id: 81066433,
                      serving_id: 65455423,
                    },
                    {
                      name: "Cocoa Nibs",
                      product: "Organic Cacao Nibs",
                      aliases: JSON.stringify(["cacao nibs", "cocoa nibs"]),
                      food_id: 18750682,
                      serving_id: 17670786,
                      grams_per_serving: 28,
                    },
                    {
                      name: "Peanut Butter Powder",
                      aliases: JSON.stringify(["pb powder", "peanut butter powder"]),
                      food_id: 45580247,
                      serving_id: 39194697,
                    },
                  ]),
                }),
              },
            ],
          },
        },
        {
          name: "mcp__wellness__fatsecret_api",
          serverName: "wellness",
          toolName: "fatsecret_api",
          input: { method: "food_get", params: { food_id: 38834732 } },
          output: { message: "user cancelled MCP tool call" },
        },
        {
          name: "mcp__wellness__fatsecret_api",
          serverName: "wellness",
          toolName: "fatsecret_api",
          input: { method: "food_get", params: { food_id: 81066433 } },
          output: { message: "user cancelled MCP tool call" },
        },
        {
          name: "mcp__wellness__fatsecret_api",
          serverName: "wellness",
          toolName: "fatsecret_api",
          input: { method: "food_get", params: { food_id: 18750682 } },
          output: { message: "user cancelled MCP tool call" },
        },
        {
          name: "mcp__wellness__fatsecret_api",
          serverName: "wellness",
          toolName: "fatsecret_api",
          input: { method: "food_get", params: { food_id: 45580247 } },
          output: { message: "user cancelled MCP tool call" },
        },
      ],
    }));

    const replayCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const report = await executeAgentWorker(
      "nutrition-logger",
      fixture!.requestText,
      "You are Malibu's nutrition worker.",
      {
        mcpServerScript: "/tmp/mcp-wellness-server.js",
        mcpServerName: "wellness",
        providerChain: [{ providerName: "codex", provider }],
        providerRetryLimit: 0,
        toolIds: ["fatsecret_api", "atlas_sql"],
        fatsecretReplayExecutor: async (input) => {
          replayCalls.push(input);
          if (input.method === "food_get") {
            if (input.params.food_id === 38834732) {
              return {
                food_id: "38834732",
                food_name: "Light Greek Vanilla Yogurt",
                servings: { serving: { serving_id: "34139206", metric_serving_amount: "170.000", number_of_units: "1.000", serving_description: "2/3 cup" } },
              };
            }
            if (input.params.food_id === 81066433) {
              return {
                food_id: "81066433",
                food_name: "Cocoa Powder",
                servings: { serving: { serving_id: "65455423", metric_serving_amount: "6.000", number_of_units: "1.000", serving_description: "1 tbsp" } },
              };
            }
            if (input.params.food_id === 18750682) {
              return {
                food_id: "18750682",
                food_name: "Organic Cacao Nibs",
                servings: { serving: { serving_id: "17670786", metric_serving_amount: "28.000", number_of_units: "1.000", serving_description: "3 tbsp" } },
              };
            }
            return {
              food_id: "45580247",
              food_name: "Peanut Butter Powder",
              servings: { serving: { serving_id: "39194697", metric_serving_amount: "16.000", number_of_units: "1.000", serving_description: "2 tbsp" } },
            };
          }
          if (input.method === "food_entry_create") {
            return { value: `created-${input.params.food_id}` };
          }
          if (input.method === "food_entries_get") {
            return [{ food_entry_name: "Light Greek Vanilla Yogurt" }];
          }
          throw new Error(`Unexpected FatSecret method ${input.method}`);
        },
      },
    );

    expect(replayCalls.filter((call) => call.method === "food_entry_create")).toHaveLength(4);
    expect(report.hasWriteOperations).toBe(true);
    expect(report.data?.workerText).toContain('"status":"completed"');
    expect(report.data?.workerText).toContain('"synthesizedDiaryWrites":4');
    expect(report.data?.qualityWarnings).toEqual([]);
  });

  it("prefers resolved_items and results.date when replay repairing a partially recovered recipe dinner", async () => {
    const provider = new ScriptedProvider(() => ({
      text: JSON.stringify({
        action: "nutrition.log_food",
        status: "partial_success",
        results: {
          meal: "dinner",
          date: "2026-03-31",
          dish: "Taco Tuesday",
          resolved_items: [
            { item: "Canned Chicken Breast", amount: "225g", source: "recipe_read + atlas_sql" },
            { item: "La Abuela Flour Tortilla", amount: "3 tortillas", source: "recipe_read + atlas_sql" },
            { item: "Purple Cabbage", amount: "60g", source: "recipe_read + atlas_sql" },
            { item: "Whole Milk Greek Yogurt", amount: "45g", source: "recipe_read + atlas_sql" },
            { item: "Guacamole", amount: "30g", source: "recipe_read + atlas_sql" },
            { item: "Mango Peach Salsa", amount: "60g", source: "recipe_read + atlas_sql" },
          ],
        },
        unresolved: [
          "FatSecret serving verification could not be completed in this run",
          "FatSecret diary write for dinner on 2026-03-31",
        ],
        totals: {
          meal_estimate: { calories: 651, protein_g: 63 },
          day_totals: "unresolved",
          status: "unconfirmed",
        },
        follow_up: ["Retry the remaining diary writes now that FatSecret metadata has been recovered."],
      }),
      toolCalls: [
        {
          name: "mcp__wellness__recipe_read",
          serverName: "wellness",
          toolName: "recipe_read",
          input: { name: "Taco Tuesday" },
          output: {
            found: true,
            matches: [
              {
                title: "Taco Tuesday",
                content: [
                  "# Taco Tuesday",
                  "",
                  "## Base Toppings (per taco)",
                  "| Ingredient | Amount |",
                  "|------------|--------|",
                  "| Purple Cabbage | 20g |",
                  "| Whole Milk Greek Yogurt | 15g |",
                  "| Guacamole | 10g |",
                  "| Mango Peach Salsa | 20g |",
                  "",
                  "## Protein Options (per taco)",
                  "| Protein | Amount |",
                  "|---------|--------|",
                  "| Canned Chicken Breast | 75g |",
                  "| Fish (for fish tacos) | 50g |",
                  "",
                  "## Tortilla Options",
                  "| Tortilla | Serving |",
                  "|----------|---------|",
                  "| La Abuela Flour Tortilla | 1 tortilla (30g) |",
                  "| Corn Tortilla | 2 tortillas |",
                ].join("\n"),
              },
            ],
          },
        },
        {
          name: "mcp__wellness__atlas_sql",
          serverName: "wellness",
          toolName: "atlas_sql",
          input: { sql: "SELECT ... taco ingredients ..." },
          output: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  result: JSON.stringify([
                    {
                      name: "Canned Chicken Breast",
                      brand: "Great Value",
                      product: "Canned Chunk Chicken Breast",
                      food_id: 4723234,
                      serving_id: 4597573,
                    },
                    {
                      name: "Purple Cabbage",
                      product: "Red Cabbage",
                      food_id: 6236,
                      serving_id: 54916,
                    },
                    {
                      name: "Whole Milk Greek Yogurt",
                      food_id: 23761706,
                      serving_id: 22170245,
                    },
                    {
                      name: "Guacamole",
                      product: "Classic Guacamole",
                      food_id: 66951,
                      serving_id: 124427,
                    },
                    {
                      name: "Mango Peach Salsa",
                      product: "Organic Mango & Peach Salsa, 48 oz",
                      food_id: 2205961,
                      serving_id: 2159685,
                    },
                    {
                      name: "Flour Tortilla",
                      aliases: JSON.stringify(["la abuela flour tortilla", "flour tortilla"]),
                      brand: "La Abuela",
                      product: "Flour Tortillas",
                      food_id: 227272,
                      serving_id: 266753,
                    },
                  ]),
                }),
              },
            ],
          },
        },
        {
          name: "mcp__wellness__fatsecret_api",
          serverName: "wellness",
          toolName: "fatsecret_api",
          input: { method: "food_get", params: { food_id: 4723234 } },
          output: { message: "user cancelled MCP tool call" },
        },
        {
          name: "mcp__wellness__fatsecret_api",
          serverName: "wellness",
          toolName: "fatsecret_api",
          input: { method: "food_get", params: { food_id: 227272 } },
          output: { message: "user cancelled MCP tool call" },
        },
        {
          name: "mcp__wellness__fatsecret_api",
          serverName: "wellness",
          toolName: "fatsecret_api",
          input: { method: "food_get", params: { food_id: 66951 } },
          output: { message: "user cancelled MCP tool call" },
        },
        {
          name: "mcp__wellness__fatsecret_api",
          serverName: "wellness",
          toolName: "fatsecret_api",
          input: { method: "food_get", params: { food_id: 2205961 } },
          output: { message: "user cancelled MCP tool call" },
        },
        {
          name: "mcp__wellness__fatsecret_api",
          serverName: "wellness",
          toolName: "fatsecret_api",
          input: { method: "food_get", params: { food_id: 6236 } },
          output: { message: "user cancelled MCP tool call" },
        },
        {
          name: "mcp__wellness__fatsecret_api",
          serverName: "wellness",
          toolName: "fatsecret_api",
          input: { method: "food_get", params: { food_id: 23761706 } },
          output: { message: "user cancelled MCP tool call" },
        },
      ],
    }));

    const replayCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const report = await executeAgentWorker(
      "nutrition-logger",
      "go ahead and finish logging that Taco Tuesday dinner",
      "You are Malibu's nutrition worker.",
      {
        mcpServerScript: "/tmp/mcp-wellness-server.js",
        mcpServerName: "wellness",
        providerChain: [{ providerName: "codex", provider }],
        providerRetryLimit: 0,
        toolIds: ["fatsecret_api", "atlas_sql", "recipe_read"],
        fatsecretReplayExecutor: async (input) => {
          replayCalls.push(input);
          if (input.method === "food_get") {
            if (input.params.food_id === 4723234) {
              return {
                food_id: "4723234",
                food_name: "Canned Chunk Chicken Breast",
                servings: { serving: { serving_id: "4597573", metric_serving_amount: "56.000", number_of_units: "1.000", serving_description: "2 oz" } },
              };
            }
            if (input.params.food_id === 227272) {
              return {
                food_id: "227272",
                food_name: "Flour Tortillas",
                servings: { serving: { serving_id: "266753", metric_serving_amount: "31.000", number_of_units: "1.000", serving_description: "1 tortilla" } },
              };
            }
            if (input.params.food_id === 66951) {
              return {
                food_id: "66951",
                food_name: "Classic Guacamole",
                servings: { serving: { serving_id: "124427", metric_serving_amount: "30.000", number_of_units: "1.000", serving_description: "2 tbsp" } },
              };
            }
            if (input.params.food_id === 2205961) {
              return {
                food_id: "2205961",
                food_name: "Mango & Peach Salsa",
                servings: { serving: { serving_id: "2159685", metric_serving_amount: "31.000", number_of_units: "1.000", serving_description: "2 tbsp" } },
              };
            }
            if (input.params.food_id === 6236) {
              return {
                food_id: "6236",
                food_name: "Red Cabbage",
                servings: { serving: { serving_id: "54916", metric_serving_amount: "100.000", number_of_units: "100.000", serving_description: "100 g", measurement_description: "g" } },
              };
            }
            return {
              food_id: "23761706",
              food_name: "5% Whole Milk Plain Greek Yogurt",
              servings: { serving: { serving_id: "22170245", metric_serving_amount: "227.000", number_of_units: "1.000", serving_description: "1 cup" } },
            };
          }
          if (input.method === "food_entry_create") {
            return { value: `created-${input.params.food_id}` };
          }
          return [];
        },
      },
    );

    expect(replayCalls.filter((call) => call.method === "food_entry_create")).toEqual([
      {
        method: "food_entry_create",
        params: {
          food_id: "4723234",
          food_entry_name: "Canned Chunk Chicken Breast",
          serving_id: "4597573",
          number_of_units: 4.017857,
          meal: "dinner",
          date: "2026-03-31",
        },
      },
      {
        method: "food_entry_create",
        params: {
          food_id: "227272",
          food_entry_name: "Flour Tortillas",
          serving_id: "266753",
          number_of_units: 3,
          meal: "dinner",
          date: "2026-03-31",
        },
      },
      {
        method: "food_entry_create",
        params: {
          food_id: "6236",
          food_entry_name: "Red Cabbage",
          serving_id: "54916",
          number_of_units: 60,
          meal: "dinner",
          date: "2026-03-31",
        },
      },
      {
        method: "food_entry_create",
        params: {
          food_id: "23761706",
          food_entry_name: "5% Whole Milk Plain Greek Yogurt",
          serving_id: "22170245",
          number_of_units: 0.198238,
          meal: "dinner",
          date: "2026-03-31",
        },
      },
      {
        method: "food_entry_create",
        params: {
          food_id: "66951",
          food_entry_name: "Classic Guacamole",
          serving_id: "124427",
          number_of_units: 1,
          meal: "dinner",
          date: "2026-03-31",
        },
      },
      {
        method: "food_entry_create",
        params: {
          food_id: "2205961",
          food_entry_name: "Organic Mango & Peach Salsa, 48 oz",
          serving_id: "2159685",
          number_of_units: 1.935484,
          meal: "dinner",
          date: "2026-03-31",
        },
      },
    ]);
    expect(replayCalls.at(-1)).toEqual({
      method: "food_entries_get",
      params: { date: "2026-03-31" },
    });
    expect(report.hasWriteOperations).toBe(true);
    expect(report.data?.workerText).toContain('"status":"completed"');
    expect(report.data?.workerText).toContain('"date":"2026-03-31"');
    expect(report.data?.workerText).not.toContain("Fish (for fish tacos)");
    expect(report.data?.qualityWarnings).toEqual([]);
  });

  it("classifies read-only tool calls correctly for FatSecret and SQL-backed tools", () => {
    const report = workerAgentResultToReport(
      {
        text: "Read-only summary complete.",
        toolCalls: [
          {
            name: "fatsecret_api",
            input: { method: "food_entries_get" },
            output: { entries: [] },
            durationMs: 0,
          },
          {
            name: "workout_sql",
            input: { sql: "SELECT * FROM workouts ORDER BY date DESC LIMIT 1" },
            output: { result: "[]" },
            durationMs: 0,
          },
          {
            name: "atlas_sql",
            input: { sql: "WITH recent AS (SELECT * FROM ingredients) SELECT * FROM recent" },
            output: { result: "[]" },
            durationMs: 0,
          },
        ],
        durationMs: 123,
      },
      "nutrition-logger",
    );

    expect(report.hasWriteOperations).toBe(false);
    expect(report.operations.map((operation) => operation.mode)).toEqual(["read", "read", "read"]);
  });

  it("still marks real write tool calls as writes", () => {
    const report = workerAgentResultToReport(
      {
        text: "Updated recipe and logged food.",
        toolCalls: [
          {
            name: "fatsecret_api",
            input: { method: "food_entry_create" },
            output: { ok: true },
            durationMs: 0,
          },
          {
            name: "atlas_sql",
            input: { sql: "INSERT INTO ingredients(name) VALUES('Chicken')" },
            output: { result: "ok" },
            durationMs: 0,
          },
          {
            name: "recipe_write",
            input: { name: "Protein Bowl" },
            output: { ok: true },
            durationMs: 0,
          },
        ],
        durationMs: 123,
      },
      "recipe-librarian",
    );

    expect(report.hasWriteOperations).toBe(true);
    expect(report.operations.map((operation) => operation.mode)).toEqual(["write", "write", "write"]);
  });

  it("treats interactive browser actions as writes only on write steps", () => {
    const writeReport = workerAgentResultToReport(
      {
        text: "Added item to cart.",
        toolCalls: [
          {
            name: "browser",
            input: { action: "click", ref: 12 },
            output: { result: "Clicked Add to cart" },
            durationMs: 0,
          },
        ],
        durationMs: 123,
      },
      "research-assistant",
      "Intent mode: write\nWRITE step: perform the requested cart mutation now.",
    );

    const readReport = workerAgentResultToReport(
      {
        text: "Opened receipt details.",
        toolCalls: [
          {
            name: "browser",
            input: { action: "click", ref: 3 },
            output: { result: "Clicked receipt row" },
            durationMs: 0,
          },
        ],
        durationMs: 123,
      },
      "personal-assistant",
      "Intent mode: read\nREAD-ONLY step: do not create, edit, delete, or log anything.",
    );

    expect(writeReport.hasWriteOperations).toBe(true);
    expect(writeReport.operations[0]?.mode).toBe("write");
    expect(readReport.hasWriteOperations).toBe(false);
    expect(readReport.operations[0]?.mode).toBe("read");
  });

  it("normalizes MCP-prefixed tool names before inferring write operations", () => {
    const report = workerAgentResultToReport(
      {
        text: "Logged banana.",
        toolCalls: [
          {
            name: "mcp__wellness__fatsecret_api",
            input: {
              method: "food_entry_create",
              params: {
                food_id: 5388,
              },
            },
            output: { ok: true },
            durationMs: 0,
          },
        ],
        durationMs: 123,
      },
      "nutrition-logger",
    );

    expect(report.hasWriteOperations).toBe(true);
    expect(report.operations).toEqual([
      {
        name: "fatsecret_api",
        toolNames: ["fatsecret_api"],
        input: {
          method: "food_entry_create",
          params: {
            food_id: 5388,
          },
        },
        output: { ok: true },
        mode: "write",
      },
    ]);
  });

  it("treats Lunch Money mutating HTTP methods as writes", () => {
    const report = workerAgentResultToReport(
      {
        text: "Categorized a transaction.",
        toolCalls: [
          {
            name: "mcp__wellness__lunch_money",
            input: {
              method: "PUT",
              endpoint: "/transactions/123",
              body: {
                transaction: {
                  category_id: 456,
                  status: "cleared",
                },
              },
            },
            output: { transaction: { id: 123 } },
            durationMs: 0,
          },
        ],
        durationMs: 123,
      },
      "personal-assistant",
      "Intent mode: write\nWRITE step: categorize the transaction now.",
    );

    expect(report.hasWriteOperations).toBe(true);
    expect(report.operations).toEqual([
      {
        name: "lunch_money",
        toolNames: ["lunch_money"],
        input: {
          method: "PUT",
          endpoint: "/transactions/123",
          body: {
            transaction: {
              category_id: 456,
              status: "cleared",
            },
          },
        },
        output: { transaction: { id: 123 } },
        mode: "write",
      },
    ]);
  });

  it("treats Gmail thread archive commands as writes", () => {
    const report = workerAgentResultToReport(
      {
        text: "Archived notification threads.",
        toolCalls: [
          {
            name: "mcp__wellness__gog_email",
            input: {
              command: "gmail thread modify 19d49ca590ba5524 --remove INBOX --account work@example.com",
            },
            output: { result: "ok" },
            durationMs: 0,
          },
        ],
        durationMs: 123,
      },
      "personal-assistant",
      "Intent mode: mixed\nWRITE step: archive the handled notifications.",
    );

    expect(report.hasWriteOperations).toBe(true);
    expect(report.operations).toEqual([
      {
        name: "gog_email",
        toolNames: ["gog_email"],
        input: {
          command: "gmail thread modify 19d49ca590ba5524 --remove INBOX --account work@example.com",
        },
        output: { result: "ok" },
        mode: "write",
      },
    ]);
  });

  it("treats Google Docs mutation commands as writes", () => {
    const report = workerAgentResultToReport(
      {
        text: "Updated the doc.",
        toolCalls: [
          {
            name: "mcp__wellness__gog_docs",
            input: {
              command: "docs write 1abc123 --text \"Updated body\" --account work@example.com",
            },
            output: { result: "ok" },
            durationMs: 0,
          },
          {
            name: "mcp__wellness__gog_docs",
            input: {
              command: "docs find-replace 1abc123 \"old\" \"new\" --first --account work@example.com",
            },
            output: { result: "ok" },
            durationMs: 0,
          },
        ],
        durationMs: 123,
      },
      "personal-assistant",
      "Intent mode: write\nWRITE step: apply the requested Google Docs updates now.",
    );

    expect(report.hasWriteOperations).toBe(true);
    expect(report.operations.map((operation) => operation.mode)).toEqual(["write", "write"]);
  });

  it("treats Google Docs help commands as reads", () => {
    const report = workerAgentResultToReport(
      {
        text: "Checked the docs write help output.",
        toolCalls: [
          {
            name: "mcp__wellness__gog_docs",
            input: {
              command: "docs write --help",
            },
            output: { usage: "docs write <docId> ..." },
            durationMs: 0,
          },
        ],
        durationMs: 123,
      },
      "personal-assistant",
      "Intent mode: mixed\nMIXED step: inspect the available docs commands before updating anything.",
    );

    expect(report.hasWriteOperations).toBe(false);
    expect(report.operations[0]?.mode).toBe("read");
  });

  it("treats ramp reimbursement submissions and receipt registry upserts as writes", () => {
    const report = workerAgentResultToReport(
      {
        text: "Submitted Ramp reimbursement and updated the receipt note.",
        toolCalls: [
          {
            name: "mcp__wellness__ramp_reimbursement",
            input: {
              action: "submit_ramp_reimbursement",
              amount: 35.23,
              transaction_date: "03/20/2026",
            },
            output: {
              reviewUrl: "https://app.ramp.com/details/reimbursements/abc/review",
              rampReportId: "abc",
            },
            durationMs: 0,
          },
          {
            name: "mcp__wellness__receipt_registry",
            input: {
              action: "upsert_walmart_reimbursement",
              order_id: "2000142-13122385",
              status: "submitted",
            },
            output: { reimbursement: { status: "submitted" } },
            durationMs: 0,
          },
        ],
        durationMs: 123,
      },
      "personal-assistant",
      "Intent mode: write\nWRITE step: submit the reimbursement and record the result.",
    );

    expect(report.hasWriteOperations).toBe(true);
    expect(report.operations.map((operation) => operation.mode)).toEqual(["write", "write"]);
  });

  it("derives quality warnings for stale location data and partial worker results", () => {
    const report = workerAgentResultToReport(
      {
        text: "Last known fix is home, but it may be stale.",
        toolCalls: [
          {
            name: "location_read",
            input: {},
            output: {
              lat: 44.36,
              lon: -124.09,
              ageSec: 61_200,
            },
            durationMs: 0,
          },
        ],
        durationMs: 321,
        partial: true,
        partialReason: "inactivity timeout",
      },
      "research-assistant",
    );

    expect(report.hasWriteOperations).toBe(false);
    expect(report.data?.qualityWarnings).toEqual([
      "Worker returned partial results: inactivity timeout.",
      "Location data is stale (17h old).",
    ]);
  });

  it("falls back to worker text when tool outputs do not include structured warning fields", () => {
    const report = workerAgentResultToReport(
      {
        text: [
          "**status:** success (stale)",
          "**Last GPS update:** ~17.9 hours ago (`ageSec: 64293`)",
          "**⚠️ Warning:** Location data is significantly stale (>3600s threshold).",
        ].join("\n"),
        toolCalls: [
          {
            name: "location_read",
            input: {},
            durationMs: 0,
          },
        ],
        durationMs: 123,
      },
      "research-assistant",
    );

    expect(report.data?.qualityWarnings).toEqual([
      "Location data is stale (17.9h old).",
      "Location data is significantly stale (>3600s threshold).",
    ]);
  });

  it("extracts stale location warnings from MCP text envelopes", () => {
    const report = workerAgentResultToReport(
      {
        text: "Last known location only.",
        toolCalls: [
          {
            name: "location_read",
            input: {},
            output: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    lat: 44.36,
                    lon: -124.09,
                    ageSec: 46_416,
                  }),
                },
              ],
            },
            durationMs: 0,
          },
        ],
        durationMs: 123,
      },
      "research-assistant",
    );

    expect(report.data?.qualityWarnings).toEqual([
      "Location data is stale (12.9h old).",
    ]);
  });

  it("extracts stale location warnings from natural language worker text without ageSec", () => {
    const report = workerAgentResultToReport(
      {
        text: [
          "### Location",
          "Still Exampletown, Oregon.",
          "GPS is 2.5 days stale (last ping April 1st, 12:35 UTC) — open OwnTracks to push a fresh fix if you've moved.",
        ].join("\n"),
        toolCalls: [
          {
            name: "location_read",
            input: {},
            durationMs: 0,
          },
        ],
        durationMs: 123,
      },
      "research-assistant",
    );

    expect(report.data?.qualityWarnings).toEqual([
      "Location data is stale (2.5days old).",
    ]);
  });

  it("extracts nested warning fields from structured worker JSON", () => {
    const report = workerAgentResultToReport(
      {
        text: JSON.stringify({
          action: "travel.location_read",
          status: "partial_success",
          results: {
            location: {
              warning: "GPS fix is stale by about 12.9 hours, so this is last known location, not confirmed live position.",
            },
          },
        }),
        toolCalls: [],
        durationMs: 123,
      },
      "research-assistant",
    );

    expect(report.data?.qualityWarnings).toEqual([
      "Worker reported partial_success result.",
      "GPS fix is stale by about 12.9 hours, so this is last known location, not confirmed live position.",
    ]);
  });

  it("surfaces blocked structured worker JSON as quality warnings", () => {
    const report = workerAgentResultToReport(
      {
        text: JSON.stringify({
          action: "recipe.read",
          status: "blocked",
          unresolved: [
            "The recipe could not be read because the recipe vault read call was cancelled twice.",
          ],
          errors: [
            "recipe_read('protein yogurt bowl') returned: user cancelled MCP tool call",
          ],
        }),
        toolCalls: [],
        durationMs: 123,
      },
      "recipe-librarian",
    );

    expect(report.data?.qualityWarnings).toEqual([
      "Worker reported blocked result.",
      "The recipe could not be read because the recipe vault read call was cancelled twice.",
      "recipe_read('protein yogurt bowl') returned: user cancelled MCP tool call",
      "Worker described tool failure without recording any tool calls.",
    ]);
  });

  it("extracts clarification from markdown-style worker text when the worker needs input", () => {
    const report = workerAgentResultToReport(
      {
        text: [
          "action: `nutrition.log_food`",
          "status: `needs_clarification`",
          "logged: []",
          "follow_up:",
          "- Reply with the meal slot for the `522g + 28g + 50g + 10g` meal: `breakfast`, `lunch`, `dinner`, or `other`.",
          "- If breakfast should be logged in the same pass, say `log Protein Yogurt Bowl as breakfast`.",
        ].join("\n"),
        toolCalls: [],
        durationMs: 123,
      },
      "nutrition-logger",
    );

    expect(report.clarification).toBe(
      "Reply with the meal slot for the `522g + 28g + 50g + 10g` meal: `breakfast`, `lunch`, `dinner`, or `other`.",
    );
  });
});
