import type { ProviderToolCall } from "@tango/core";
import type { WorkerDispatchDescriptor } from "./worker-report.js";

export const DISPATCH_MCP_SERVER_NAME = "dispatch";
export const DISPATCH_TOOL_NAME = "dispatch_worker";
export const DISPATCH_TOOL_FULL_NAME = `mcp__${DISPATCH_MCP_SERVER_NAME}__${DISPATCH_TOOL_NAME}`;

function parseDispatchInput(value: Record<string, unknown> | undefined): WorkerDispatchDescriptor | null {
  if (!value) return null;

  const workerId = typeof value.worker_id === "string" ? value.worker_id.trim() : "";
  const task = typeof value.task === "string" ? value.task.trim() : "";
  const taskId = typeof value.task_id === "string" ? value.task_id.trim() : "";

  if (!workerId || !task) {
    return null;
  }

  return {
    workerId,
    task,
    ...(taskId ? { taskId } : {}),
  };
}

export function extractDispatchToolCalls(
  toolCalls: readonly ProviderToolCall[] | undefined,
): WorkerDispatchDescriptor[] {
  if (!toolCalls || toolCalls.length === 0) {
    return [];
  }

  return toolCalls.flatMap((toolCall) => {
    const normalizedName = toolCall.name.trim();
    if (normalizedName !== DISPATCH_TOOL_FULL_NAME && normalizedName !== DISPATCH_TOOL_NAME) {
      return [];
    }

    const dispatch = parseDispatchInput(toolCall.input);
    return dispatch ? [dispatch] : [];
  });
}
