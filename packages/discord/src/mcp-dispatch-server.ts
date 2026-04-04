#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { pathToFileURL } from "node:url";
import {
  DISPATCH_MCP_SERVER_NAME,
  DISPATCH_TOOL_NAME,
} from "./dispatch-extractor.js";
import { getMcpToolAnnotations } from "./mcp-tool-metadata.js";

export interface DispatchWorkerDefinition {
  id: string;
  label?: string;
}

const debug = (...args: unknown[]): void => {
  console.error("[mcp-dispatch]", ...args);
};

function normalizeCsv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function parseDispatchWorkersFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DispatchWorkerDefinition[] {
  const workerIds = normalizeCsv(env.DISPATCH_WORKER_IDS);
  const labels = normalizeCsv(env.DISPATCH_WORKER_LABELS);
  const seen = new Set<string>();

  return workerIds.flatMap((id, index) => {
    if (seen.has(id)) {
      return [];
    }
    seen.add(id);
    return [{
      id,
      label: labels[index],
    }];
  });
}

export function buildDispatchToolDescription(
  workers: readonly DispatchWorkerDefinition[],
): string {
  const lines = [
    "Dispatch a worker task request.",
    "In the full Tango turn executor, this tool call is intercepted and the worker runs synchronously before your next visible reply.",
    "If this tool is exposed without that executor, it may only acknowledge dispatch. Do not speculate about outcomes in that environment.",
  ];

  if (workers.length > 0) {
    lines.push("Available workers:");
    for (const worker of workers) {
      lines.push(
        worker.label && worker.label.length > 0
          ? `- ${worker.id}: ${worker.label}`
          : `- ${worker.id}`,
      );
    }
  } else {
    lines.push("No workers are configured for this orchestrator.");
  }

  lines.push("After calling this tool in the full Tango runtime, do not send a progress update to the user.");
  lines.push("The Tango runtime will run the worker immediately and send you an internal follow-up message with the worker execution results in the same turn.");
  lines.push("Wait for that internal worker-results message, then compose the final user-visible reply.");
  return lines.join("\n");
}

export function buildDispatchToolDefinition(
  workers: readonly DispatchWorkerDefinition[],
): {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ReturnType<typeof getMcpToolAnnotations>;
} {
  return {
    name: DISPATCH_TOOL_NAME,
    description: buildDispatchToolDescription(workers),
    inputSchema: {
      type: "object",
      properties: {
        worker_id: {
          type: "string",
          description: "Worker ID to dispatch.",
        },
        task: {
          type: "string",
          description: "Explicit instructions for the worker.",
        },
        task_id: {
          type: "string",
          description: "Optional short label for readability when dispatching multiple tasks.",
        },
      },
      required: ["worker_id", "task"],
      additionalProperties: false,
    },
    annotations: getMcpToolAnnotations(DISPATCH_TOOL_NAME, "read"),
  };
}

function encodeResult(payload: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {}),
  };
}

export function handleDispatchToolCall(
  workers: readonly DispatchWorkerDefinition[],
  input: Record<string, unknown>,
) {
  const allowedWorkerIds = new Set(workers.map((worker) => worker.id));
  const workerId = typeof input.worker_id === "string" ? input.worker_id.trim() : "";
  const task = typeof input.task === "string" ? input.task.trim() : "";
  const taskId = typeof input.task_id === "string" ? input.task_id.trim() : "";

  if (!workerId) {
    return encodeResult({ error: "worker_id is required" }, true);
  }
  if (!task) {
    return encodeResult({ error: "task is required" }, true);
  }
  if (!allowedWorkerIds.has(workerId)) {
    return encodeResult(
      {
        error: `Unknown worker_id: ${workerId}`,
        allowed_worker_ids: [...allowedWorkerIds],
      },
      true,
    );
  }

  return encodeResult({
    status: "dispatched",
    worker_id: workerId,
    ...(taskId ? { task_id: taskId } : {}),
    note: "Dispatch accepted by Tango. Do not reply to the user yet. Tango will send an internal follow-up message with worker execution results in the same turn. Answer only after that message arrives.",
  });
}

export async function startDispatchMcpServer(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const workers = parseDispatchWorkersFromEnv(env);
  const tool = buildDispatchToolDefinition(workers);
  const server = new Server(
    { name: DISPATCH_MCP_SERVER_NAME, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    debug(`tools/list requested — returning ${workers.length} worker(s)`);
    return { tools: [tool] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    debug(`tools/call: ${name}`, JSON.stringify(args ?? {}));

    if (name !== DISPATCH_TOOL_NAME) {
      return encodeResult({ error: `Unknown tool: ${name}` }, true);
    }

    return handleDispatchToolCall(
      workers,
      (args ?? {}) as Record<string, unknown>,
    );
  });

  debug(`Starting MCP ${DISPATCH_MCP_SERVER_NAME} server via stdio transport`);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  debug("MCP dispatch server connected");
}

const isEntrypoint =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  await startDispatchMcpServer();
}
