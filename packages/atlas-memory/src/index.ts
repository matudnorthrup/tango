#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { pathToFileURL } from "node:url";
import { openAtlasMemoryDatabase } from "./schema.js";
import { createAtlasMemoryTools } from "./tools.js";

export * from "./schema.js";
export * from "./tools.js";
export * from "./types.js";

const debug = (...args: unknown[]): void => {
  console.error("[atlas-memory]", ...args);
};

function encodePayload(payload: unknown, isError = false): {
  content: Array<{ type: "text"; text: string }>;
  isError?: true;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {}),
  };
}

export async function startAtlasMemoryServer(): Promise<void> {
  const { db, path } = openAtlasMemoryDatabase();
  const tools = createAtlasMemoryTools({ db });
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  const server = new Server(
    { name: "atlas-memory", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolMap.get(name);

    if (!tool) {
      return encodePayload({ error: `Unknown tool: ${name}` }, true);
    }

    try {
      const result = await tool.handler((args ?? {}) as Record<string, unknown>);
      return encodePayload(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return encodePayload({ error: message }, true);
    }
  });

  const shutdown = async (signal: string) => {
    debug(`Shutting down due to ${signal}`);
    try {
      await (server as unknown as { close?: () => Promise<void> | void }).close?.();
    } catch (error) {
      debug("Server close failed", error);
    }
    db.close();
    process.exit(0);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  debug(`Opening atlas-memory MCP server at ${path}`);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  debug("atlas-memory MCP server connected");
}

const isEntrypoint =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  await startAtlasMemoryServer();
}
