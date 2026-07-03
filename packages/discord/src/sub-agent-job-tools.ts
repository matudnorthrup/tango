import type { AgentTool } from "@tango/core";

export const START_SUB_AGENT_JOB_TOOL_NAME = "start_sub_agent_job";
export const GET_SUB_AGENT_JOB_TOOL_NAME = "get_sub_agent_job";
export const LIST_SUB_AGENT_JOBS_TOOL_NAME = "list_sub_agent_jobs";
export const CANCEL_SUB_AGENT_JOB_TOOL_NAME = "cancel_sub_agent_job";
export const SEND_SUB_AGENT_JOB_UPDATE_TOOL_NAME = "send_sub_agent_job_update";

const DEFAULT_SUB_AGENT_JOB_BRIDGE_URL = "http://127.0.0.1:9200/sub-agent-jobs";
const HIDDEN_FIELDS = new Set([
  "_coordinator_agent_id",
  "_coordinator_principal_id",
  "_coordinator_capability_tool_ids",
]);

export interface SubAgentJobToolOptions {
  bridgeUrl?: string;
  bridgeToken?: string;
  fetchImpl?: typeof fetch;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    const single = normalizeString(value);
    return single ? [single] : [];
  }
  return [...new Set(
    value
      .map((item) => normalizeString(item))
      .filter((item) => item.length > 0),
  )];
}

function normalizeRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizePositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(1, Math.trunc(value));
}

function publicInput(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!HIDDEN_FIELDS.has(key)) {
      output[key] = value;
    }
  }
  return output;
}

function hiddenCoordinatorAgentId(input: Record<string, unknown>): string | null {
  const value = normalizeString(input._coordinator_agent_id);
  return value || null;
}

function hiddenCapabilityToolIds(input: Record<string, unknown>): string[] | null {
  if (!Array.isArray(input._coordinator_capability_tool_ids)) {
    return null;
  }
  return normalizeStringList(input._coordinator_capability_tool_ids);
}

function normalizeChild(raw: unknown): Record<string, unknown> {
  const child = normalizeRecord(raw) ?? {};
  const metadata = {
    ...(normalizeRecord(child.metadata) ?? {}),
    ...(normalizeString(child.purpose) ? { purpose: normalizeString(child.purpose) } : {}),
    ...(normalizeString(child.context_summary) ? { contextSummary: normalizeString(child.context_summary) } : {}),
    ...(normalizeRecord(child.deliverable) ? { deliverable: normalizeRecord(child.deliverable) } : {}),
    ...(Array.isArray(child.constraints) ? { constraints: normalizeStringList(child.constraints) } : {}),
    ...(normalizeRecord(child.budget) ? { budget: normalizeRecord(child.budget) } : {}),
    ...(normalizeString(child.reasoning_effort) ? { reasoningEffort: normalizeString(child.reasoning_effort) } : {}),
  };

  return {
    id: normalizeString(child.id) || undefined,
    kind: normalizeString(child.kind) || "worker",
    task: normalizeString(child.task),
    agentId: normalizeString(child.agent_id ?? child.agentId) || undefined,
    workerId: normalizeString(child.worker_id ?? child.workerId) || undefined,
    providerName: normalizeString(child.provider_name ?? child.provider) || undefined,
    model: normalizeString(child.model) || undefined,
    conversationKey: normalizeString(child.conversation_key ?? child.conversationKey) || undefined,
    tools: normalizeStringList(child.tools ?? child.tool_ids ?? child.toolIds),
    dependsOn: normalizeStringList(child.depends_on ?? child.dependsOn),
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}

function normalizeBudget(raw: unknown): Record<string, unknown> | undefined {
  const budget = normalizeRecord(raw);
  if (!budget) {
    return undefined;
  }
  return {
    maxChildren: normalizePositiveInt(budget.max_children ?? budget.maxChildren),
    maxParallel: normalizePositiveInt(budget.max_parallel ?? budget.maxParallel),
    maxDurationMinutes: normalizePositiveInt(budget.max_duration_minutes ?? budget.maxDurationMinutes),
    maxDurationSeconds: normalizePositiveInt(budget.max_duration_seconds ?? budget.maxDurationSeconds),
  };
}

function normalizeNotificationPolicy(raw: unknown): Record<string, unknown> | undefined {
  const policy = normalizeRecord(raw);
  if (!policy) {
    return undefined;
  }
  return {
    mode: normalizeString(policy.mode) || "coordinator_mediated",
    periodicAfterMinutes: normalizePositiveInt(policy.periodic_after_minutes ?? policy.periodicAfterMinutes),
    notifyOn: normalizeStringList(policy.notify_on ?? policy.notifyOn),
  };
}

function normalizeStartRequest(input: Record<string, unknown>): Record<string, unknown> {
  const coordinatorAgentId = hiddenCoordinatorAgentId(input);
  if (!coordinatorAgentId) {
    throw new Error("coordinator_agent_id unavailable; start_sub_agent_job must run inside a governed agent runtime");
  }
  const body = publicInput(input);
  return {
    coordinatorAgentId,
    initiatorKind: normalizeString(body.initiator_kind ?? body.initiatorKind) || "agent",
    initiatorRef: normalizeString(body.initiator_ref ?? body.initiatorRef) || undefined,
    parentJobId: normalizeString(body.parent_job_id ?? body.parentJobId) || undefined,
    objective: normalizeString(body.objective),
    userSurface: normalizeRecord(body.user_surface ?? body.userSurface) ?? {},
    children: Array.isArray(body.children) ? body.children.map(normalizeChild) : [],
    priority: normalizePositiveInt(body.priority),
    visibilityMode: normalizeString(body.visibility ?? body.visibility_mode ?? body.visibilityMode) || "summary",
    notificationPolicy: normalizeNotificationPolicy(body.notification_policy ?? body.notificationPolicy),
    budget: normalizeBudget(body.budget),
    capabilityCeilingToolIds: hiddenCapabilityToolIds(input),
  };
}

async function bridgeFetch(
  fetchFn: typeof fetch,
  bridgeUrl: string,
  bridgeToken: string | undefined,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await fetchFn(`${bridgeUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(bridgeToken ? { "X-Tango-Collaboration-Token": bridgeToken } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(310_000),
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { result: text };
  }
  if (!response.ok) {
    return {
      status: "failed",
      error: `sub-agent job bridge HTTP ${response.status}`,
      detail: parsed,
    };
  }
  return parsed;
}

export function createSubAgentJobTools(options: SubAgentJobToolOptions = {}): AgentTool[] {
  const fetchFn = options.fetchImpl ?? fetch;
  const bridgeUrl = (
    options.bridgeUrl
    ?? process.env.TANGO_SUB_AGENT_JOB_BRIDGE_URL
    ?? DEFAULT_SUB_AGENT_JOB_BRIDGE_URL
  ).replace(/\/+$/u, "");
  const bridgeToken =
    options.bridgeToken
    ?? process.env.TANGO_COLLABORATION_BRIDGE_TOKEN;

  return [
    {
      name: START_SUB_AGENT_JOB_TOOL_NAME,
      description: [
        "Start a durable background sub-agent job.",
        "Use worker children for quick parallel swarms, named_agent children for isolated agent clones, and collaborator children for policy-governed peer help.",
        "The coordinator agent receives job events and decides what to tell the user; child agents do not message the user directly.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          objective: { type: "string" },
          user_surface: { type: "object" },
          children: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                kind: { type: "string", enum: ["worker", "named_agent", "collaborator", "external_session"] },
                task: { type: "string" },
                agent_id: { type: "string" },
                worker_id: { type: "string" },
                provider: { type: "string" },
                model: { type: "string" },
                tools: { type: "array", items: { type: "string" } },
                depends_on: { type: "array", items: { type: "string" } },
                purpose: { type: "string" },
                context_summary: { type: "string" },
                deliverable: { type: "object" },
                constraints: { type: "array", items: { type: "string" } },
                metadata: { type: "object" },
              },
              required: ["kind", "task"],
            },
          },
          notification_policy: { type: "object" },
          budget: { type: "object" },
        },
        required: ["objective", "children"],
      },
      handler: async (input) => {
        try {
          const body = normalizeStartRequest(input);
          return await bridgeFetch(fetchFn, bridgeUrl, bridgeToken, "/start", {
            method: "POST",
            body: JSON.stringify(body),
          });
        } catch (error) {
          return {
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    },
    {
      name: GET_SUB_AGENT_JOB_TOOL_NAME,
      description: "Get a durable sub-agent job snapshot, including children, events, and artifacts.",
      inputSchema: {
        type: "object",
        properties: {
          job_id: { type: "string" },
        },
        required: ["job_id"],
      },
      handler: async (input) => {
        const jobId = encodeURIComponent(normalizeString(input.job_id ?? input.jobId));
        return bridgeFetch(fetchFn, bridgeUrl, bridgeToken, `/${jobId}`, { method: "GET" });
      },
    },
    {
      name: LIST_SUB_AGENT_JOBS_TOOL_NAME,
      description: "List active or recent sub-agent jobs for the current coordinator.",
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string" },
          limit: { type: "number" },
        },
      },
      handler: async (input) => {
        const params = new URLSearchParams();
        const coordinatorAgentId = hiddenCoordinatorAgentId(input);
        if (coordinatorAgentId) params.set("coordinator_agent_id", coordinatorAgentId);
        const status = normalizeString(input.status);
        if (status) params.set("status", status);
        const limit = normalizePositiveInt(input.limit);
        if (limit) params.set("limit", String(limit));
        const suffix = params.toString() ? `?${params.toString()}` : "";
        return bridgeFetch(fetchFn, bridgeUrl, bridgeToken, suffix, { method: "GET" });
      },
    },
    {
      name: CANCEL_SUB_AGENT_JOB_TOOL_NAME,
      description: "Cancel an active sub-agent job and mark unfinished child runs canceled.",
      inputSchema: {
        type: "object",
        properties: {
          job_id: { type: "string" },
        },
        required: ["job_id"],
      },
      handler: async (input) => {
        const jobId = encodeURIComponent(normalizeString(input.job_id ?? input.jobId));
        return bridgeFetch(fetchFn, bridgeUrl, bridgeToken, `/${jobId}/cancel`, { method: "POST" });
      },
    },
    {
      name: SEND_SUB_AGENT_JOB_UPDATE_TOOL_NAME,
      description: [
        "Record that the coordinator is sending a user-facing update for a sub-agent job.",
        "Use this before or alongside the coordinator's visible Discord reply so Tango can tie the update to the job.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          job_id: { type: "string" },
          message: { type: "string" },
          visible_message_ref: { type: "string" },
          metadata: { type: "object" },
        },
        required: ["job_id", "message"],
      },
      handler: async (input) => {
        const jobId = encodeURIComponent(normalizeString(input.job_id ?? input.jobId));
        return bridgeFetch(fetchFn, bridgeUrl, bridgeToken, `/${jobId}/update`, {
          method: "POST",
          body: JSON.stringify({
            message: normalizeString(input.message),
            visible_message_ref: normalizeString(input.visible_message_ref ?? input.visibleMessageRef) || undefined,
            metadata: normalizeRecord(input.metadata) ?? {},
          }),
        });
      },
    },
  ];
}
