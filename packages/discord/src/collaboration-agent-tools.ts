import {
  listAgentCollaborationRoutes,
  type AgentCollaborationRoute,
  type AgentTool,
  type V2AgentConfig,
} from "@tango/core";

const DEFAULT_COLLABORATION_BRIDGE_URL = "http://127.0.0.1:9200/collaboration/request";

export interface CollaborationToolOptions {
  bridgeUrl?: string;
  bridgeToken?: string;
  fetchImpl?: typeof fetch;
}

export interface CollaborationToolPresentation {
  description: string;
  inputSchema: Record<string, unknown>;
}

function resolveRequesterAgentId(input: Record<string, unknown>): string | null {
  const hidden = typeof input._requester_agent_id === "string" ? input._requester_agent_id.trim() : "";
  return hidden || null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function renderConfiguredRoutes(routes: readonly AgentCollaborationRoute[]): string[] {
  return routes.flatMap((route) =>
    route.purposes.map((purpose) => `- target_agent_id=${route.targetAgentId}; purpose=${purpose}`),
  );
}

/**
 * Tailor the generic collaboration tool contract to the caller's configured
 * routes. This keeps the model from inventing plausible but invalid purposes.
 */
export function buildCollaborationToolPresentation(
  tool: Pick<AgentTool, "description" | "inputSchema">,
  requesterAgentId: string | null,
  v2Configs: ReadonlyMap<string, V2AgentConfig>,
): CollaborationToolPresentation {
  const routes = requesterAgentId
    ? listAgentCollaborationRoutes(requesterAgentId, v2Configs)
    : [];
  if (routes.length === 0) {
    return {
      description: [
        tool.description,
        "No concrete outbound collaboration routes are configured for this caller. Do not invoke this tool.",
      ].join("\n"),
      inputSchema: tool.inputSchema,
    };
  }

  const exactRoutes = routes.flatMap((route) =>
    route.purposes.map((purpose) => ({ targetAgentId: route.targetAgentId, purpose })),
  );
  const targetAgentIds = [...new Set(routes.map((route) => route.targetAgentId))];
  const purposes = [...new Set(exactRoutes.map((route) => route.purpose))].sort();
  const inputSchema = asRecord(tool.inputSchema);
  const properties = asRecord(inputSchema.properties);
  const targetSchema = asRecord(properties.target_agent_id);
  const purposeSchema = asRecord(properties.purpose);
  const existingAllOf = Array.isArray(inputSchema.allOf) ? inputSchema.allOf : [];

  return {
    description: [
      tool.description,
      "Configured outbound collaboration routes for this caller (enforced):",
      ...renderConfiguredRoutes(routes),
      "Use a listed target/purpose pair exactly. Do not invent a purpose label.",
    ].join("\n"),
    inputSchema: {
      ...inputSchema,
      properties: {
        ...properties,
        target_agent_id: {
          ...targetSchema,
          enum: targetAgentIds,
          description: `${typeof targetSchema.description === "string" ? `${targetSchema.description} ` : ""}Use a configured target agent.`,
        },
        purpose: {
          ...purposeSchema,
          enum: purposes,
          description: `${typeof purposeSchema.description === "string" ? `${purposeSchema.description} ` : ""}Use a configured purpose exactly as listed.`,
        },
      },
      allOf: [
        ...existingAllOf,
        {
          oneOf: exactRoutes.map((route) => ({
            properties: {
              target_agent_id: { const: route.targetAgentId },
              purpose: { const: route.purpose },
            },
            required: ["target_agent_id", "purpose"],
          })),
        },
      ],
    },
  };
}

export function createCollaborationTools(options: CollaborationToolOptions = {}): AgentTool[] {
  const fetchFn = options.fetchImpl ?? fetch;
  const bridgeUrl =
    options.bridgeUrl
    ?? process.env.TANGO_COLLABORATION_BRIDGE_URL
    ?? DEFAULT_COLLABORATION_BRIDGE_URL;
  const bridgeToken =
    options.bridgeToken
    ?? process.env.TANGO_COLLABORATION_BRIDGE_TOKEN;

  return [
    {
      name: "collaborate_with_agent",
      description: [
        "Ask another named Tango agent for bounded help. This is request/result collaboration, not open-ended chat.",
        "Use only when the target agent has an explicit responsibility that fits the requested purpose.",
        "The target uses its own tools, governance, memory scope, and profile overlays. This does not give you access to the target's tools.",
        "Always include a concrete objective, purpose, context_summary, constraints, deliverable contract, visibility, and budget.",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          target_agent_id: {
            type: "string",
            description: "Named Tango agent to ask for help.",
          },
          purpose: {
            type: "string",
            description: "Configured collaboration purpose, such as source-check or receipt-status-check.",
          },
          objective: {
            type: "string",
            description: "Specific bounded goal for the target agent.",
          },
          context_summary: {
            type: "string",
            description: "Minimum context needed by the target. Do not paste unrelated private transcript.",
          },
          deliverable: {
            type: "object",
            description: "Result contract: format, required_fields, max_words.",
          },
          constraints: {
            type: "array",
            items: { type: "string" },
          },
          visibility: {
            type: "string",
            enum: ["summary", "digest", "thread", "transcript", "silent"],
          },
          budget: {
            type: "object",
            properties: {
              max_turns: { type: "number" },
              max_duration_seconds: { type: "number" },
              max_tool_calls: { type: "number" },
            },
          },
        },
        required: ["target_agent_id", "purpose", "objective"],
      },
      handler: async (input) => {
        const requesterAgentId = resolveRequesterAgentId(input);
        if (!requesterAgentId) {
          return {
            status: "failed",
            error: "requester_agent_id unavailable; collaboration tool must run inside a governed agent runtime",
          };
        }

        const publicInput: Record<string, unknown> = { ...input };
        delete publicInput._requester_agent_id;
        delete publicInput.requester_agent_id;
        delete publicInput.requesterAgentId;
        const body = {
          ...publicInput,
          requester_agent_id: requesterAgentId,
          initiator_kind: input.initiator_kind ?? "agent",
        };

        const response = await fetchFn(bridgeUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(bridgeToken ? { "X-Tango-Collaboration-Token": bridgeToken } : {}),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(305_000),
        });
        const text = await response.text();
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { result: text };
        }

        if (!response.ok) {
          const detail = parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : undefined;
          return {
            status: detail?.status === "denied" ? "denied" : "failed",
            error: detail?.error
              ? `Collaboration denied: ${String(detail.error)}. Use one of the available_routes and retry.`
              : `collaboration bridge HTTP ${response.status}`,
            ...(Array.isArray(detail?.availableRoutes) ? { available_routes: detail.availableRoutes } : {}),
            detail: parsed,
          };
        }

        return parsed;
      },
    },
  ];
}
