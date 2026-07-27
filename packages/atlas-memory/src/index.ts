#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { pathToFileURL } from "node:url";
import { mergeDiscordProvenanceIntoMemoryAddArgs } from "./discord-provenance.js";
import { openAtlasMemoryDatabase } from "./schema.js";
import { createAtlasMemoryTools } from "./tools.js";

export * from "./context-read.js";
export * from "./discord-provenance.js";
export * from "./obsidian-sync.js";
export * from "./origin.js";
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

interface ProcessMemoryScope {
  runtimeAgentId: string;
  canonicalAgentId: string;
  aliasAgentIds: string[];
}

function uniqueAgentIds(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const agentIds: string[] = [];
  for (const value of values) {
    const agentId = value?.trim();
    if (!agentId || seen.has(agentId)) {
      continue;
    }
    seen.add(agentId);
    agentIds.push(agentId);
  }
  return agentIds;
}

function resolveProcessMemoryScope(): ProcessMemoryScope | null {
  const runtimeAgentId = process.env.WORKER_ID?.trim();
  const configuredCanonical = process.env.TANGO_MEMORY_CANONICAL_AGENT_ID?.trim();
  if (!runtimeAgentId && !configuredCanonical) {
    return null;
  }

  const canonicalAgentId = configuredCanonical || runtimeAgentId;
  if (!canonicalAgentId) {
    return null;
  }

  const configuredAliases = (process.env.TANGO_MEMORY_ALIAS_AGENT_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return {
    runtimeAgentId: runtimeAgentId || canonicalAgentId,
    canonicalAgentId,
    aliasAgentIds: uniqueAgentIds([canonicalAgentId, runtimeAgentId, ...configuredAliases]),
  };
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueAgentIds(value.filter((item): item is string => typeof item === "string"));
}

function applyProcessMemoryScopeToToolArgs(
  toolName: string,
  args: Record<string, unknown>,
  memoryScope: ProcessMemoryScope | null,
): Record<string, unknown> {
  if (!memoryScope) {
    if (toolName === "memory_add") {
      return mergeDiscordProvenanceIntoMemoryAddArgs(args);
    }
    return args;
  }

  const agentId = normalizeOptionalString(args.agent_id);
  const currentScopeAgent =
    !agentId || agentId === memoryScope.runtimeAgentId || memoryScope.aliasAgentIds.includes(agentId);
  if (!currentScopeAgent) {
    return args;
  }

  if (toolName === "memory_search") {
    const agentIds = normalizeStringArray(args.agent_ids);
    const onlyCurrentScope =
      agentIds.length === 0 ||
      agentIds.every((id) => id === memoryScope.runtimeAgentId || memoryScope.aliasAgentIds.includes(id));
    if (!onlyCurrentScope) {
      return args;
    }
    return {
      ...args,
      agent_id: memoryScope.canonicalAgentId,
      agent_ids: memoryScope.aliasAgentIds,
    };
  }

  if (toolName === "memory_add") {
    return mergeDiscordProvenanceIntoMemoryAddArgs(
      {
        ...args,
        agent_id: memoryScope.canonicalAgentId,
      },
      memoryScope.runtimeAgentId,
    );
  }

  if (toolName === "memory_reflect") {
    return {
      ...args,
      agent_id: memoryScope.canonicalAgentId,
    };
  }

  return args;
}

export async function startAtlasMemoryServer(): Promise<void> {
  const { db, path } = openAtlasMemoryDatabase();
  const tools = createAtlasMemoryTools({ db });
  const toolMap = new Map(tools.map((tool) => [tool.name, tool]));
  const memoryScope = resolveProcessMemoryScope();
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
      const scopedArgs = applyProcessMemoryScopeToToolArgs(
        name,
        (args ?? {}) as Record<string, unknown>,
        memoryScope,
      );
      const result = await tool.handler(scopedArgs);
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
