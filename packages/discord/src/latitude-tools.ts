/**
 * Latitude Remote MCP bridge.
 *
 * The Claude runtime reaches the Latitude remote MCP (Notion, etc.) by spawning
 * `mcp-remote <url>` as a stdio MCP server per the agent's `mcp_servers` config.
 * The Ollama runtime never spawns those stdio servers — it reaches tools ONLY
 * through the persistent :9100 HTTP wellness server. So Notion was invisible to
 * every -ollama clone.
 *
 * This bridge closes that gap: it exposes the Latitude remote MCP as a single
 * in-process `latitude_run` tool on the :9100 server. On first use it lazily
 * spawns its OWN `mcp-remote` child (the :9100 process is separate from the
 * Claude CLI's child) and proxies tool calls to it. Auth is delegated entirely
 * to mcp-remote, which reuses the host OAuth cache at ~/.mcp-auth — no new
 * credential. Governance still gates it: the tool name `latitude_run` matches
 * the existing governance capability, so a clone only reaches it if granted.
 */

import type { AgentTool } from "@tango/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const LATITUDE_MCP_URL =
  process.env.LATITUDE_MCP_URL?.trim() || "https://mcp.preview.aidungeon.com/oauth/mcp";
const CALL_TIMEOUT_MS = 60_000;

let clientPromise: Promise<Client> | null = null;

/** Lazily connect (once) to a spawned mcp-remote child; reconnect on failure. */
async function getClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const transport = new StdioClientTransport({
        command: "mcp-remote",
        args: [LATITUDE_MCP_URL],
      });
      const client = new Client(
        { name: "tango-latitude-bridge", version: "0.1.0" },
        { capabilities: {} },
      );
      await client.connect(transport);
      return client;
    })().catch((err) => {
      clientPromise = null; // allow the next call to retry a fresh connection
      throw err;
    });
  }
  return clientPromise;
}

/** Flatten an MCP CallToolResult into something readable for the model. */
function flatten(res: unknown): unknown {
  const r = res as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  if (r && Array.isArray(r.content)) {
    const text = r.content
      .map((c) => (c?.type === "text" ? c.text : JSON.stringify(c)))
      .filter(Boolean)
      .join("\n");
    // Prefer parsed JSON when the remote returned a JSON string.
    try {
      return { isError: r.isError ?? false, result: JSON.parse(text) };
    } catch {
      return { isError: r.isError ?? false, result: text };
    }
  }
  return res;
}

export function createLatitudeTools(): AgentTool[] {
  return [
    {
      name: "latitude_run",
      description: [
        "Latitude gateway to the user's connected services — primarily NOTION (read AND write the user's Notion workspace).",
        "",
        "Call pattern — a single { category, tool, params } request:",
        "  category: the service. Use \"notion\" for the Notion workspace. (Other categories exist: slack, github, postgres, sentry, etc.)",
        "  tool:     the operation within the category. Confirmed Notion ops: \"search\" (find pages/databases by query) and \"fetch\" (get a page's content by id or url). Create/update pages and comments follow the same { category:\"notion\", tool:\"<op>\", params } shape.",
        "  params:   parameters for the operation. e.g. search → { query: \"...\" }; fetch → { id: \"...\" } or { url: \"...\" }.",
        "",
        "Optional universal filters (place inside params): _limit (max items), _fields ([\"id\",\"title\"]), _jq (a JQ expression to transform the output).",
        "Example: latitude_run({ category: \"notion\", tool: \"search\", params: { query: \"offsite\", _limit: 5 } }).",
        "Pass Notion page ids/urls exactly as the user gives them. Results come back as JSON.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description: "Service category. Use \"notion\" for the Notion workspace.",
          },
          tool: {
            type: "string",
            description: "Operation within the category, e.g. \"search\" or \"fetch\".",
          },
          params: {
            type: "object",
            description:
              "Parameters for the operation (may include universal _limit / _fields / _jq filters).",
          },
        },
        required: ["category", "tool"],
      },
      handler: async (input) => {
        const category = String(input.category ?? "").trim();
        const tool = String(input.tool ?? "").trim();
        const params = (input.params as Record<string, unknown>) ?? {};
        if (!category || !tool) {
          return {
            error:
              "latitude_run requires 'category' (e.g. \"notion\") and 'tool' (e.g. \"search\"). " +
              "Example: { category: \"notion\", tool: \"search\", params: { query: \"...\" } }.",
          };
        }
        try {
          const client = await getClient();
          const res = await client.callTool(
            { name: "run", arguments: { category, tool, params } },
            undefined,
            { timeout: CALL_TIMEOUT_MS },
          );
          return flatten(res);
        } catch (err) {
          clientPromise = null; // reset so a later call reconnects (e.g. after re-auth)
          return {
            error: `latitude bridge error: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
    },
  ];
}
