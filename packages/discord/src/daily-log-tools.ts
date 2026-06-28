import {
  appendFleetDailyLogBlock,
  formatFleetDailyLogCalendarDate,
  formatFleetDailyLogTimestamp,
  type FleetDailyLogCapturedBy,
  type AgentTool,
} from "@tango/core";
import type { DiscordCapturedBy } from "./discord-memory-provenance.js";
import { readDiscordTurnProvenanceFromContext } from "./discord-turn-provenance-context.js";

export interface DailyLogToolEnv {
  conversationKey?: string;
  channelId?: string;
  threadId?: string;
  agentId?: string;
  capturedBy?: DiscordCapturedBy;
  requestedByUserId?: string;
  trigger?: string;
  timeZone?: string;
}

export function readDailyLogToolEnv(
  env: NodeJS.ProcessEnv = process.env,
): DailyLogToolEnv {
  const fromContext = readDiscordTurnProvenanceFromContext();
  return {
    conversationKey: fromContext.TANGO_CONVERSATION_KEY ?? env.TANGO_CONVERSATION_KEY?.trim(),
    channelId: fromContext.TANGO_DISCORD_CHANNEL_ID ?? env.TANGO_DISCORD_CHANNEL_ID?.trim(),
    threadId: fromContext.TANGO_DISCORD_THREAD_ID ?? env.TANGO_DISCORD_THREAD_ID?.trim(),
    agentId: fromContext.TANGO_AGENT_ID ?? (env.TANGO_AGENT_ID?.trim() || env.WORKER_ID?.trim()),
    capturedBy: (fromContext.TANGO_CAPTURED_BY ?? env.TANGO_CAPTURED_BY?.trim()) as DiscordCapturedBy | undefined,
    requestedByUserId: fromContext.TANGO_REQUESTED_BY_USER_ID ?? env.TANGO_REQUESTED_BY_USER_ID?.trim(),
    trigger: fromContext.TANGO_SAVE_TRIGGER ?? env.TANGO_SAVE_TRIGGER?.trim(),
    timeZone: fromContext.TANGO_TURN_TIMEZONE ?? env.TANGO_TURN_TIMEZONE?.trim(),
  };
}

function normalizeBulletsInput(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function createDailyLogTools(
  envOverride?: DailyLogToolEnv,
): AgentTool[] {
  return [
    {
      name: "daily_log_append",
      description: [
        "Append a stamped block to today's fleet daily log (~/.tango/profiles/<profile>/memory/YYYY-MM-DD.md).",
        "Platform stamps agent id, timestamp, channel/thread, conversation_key, and captured_by from the current Discord turn.",
        "Pass bullets only (1-3 short lines) — do not author headers or metadata.",
        "",
        "Fields:",
        "  bullets (required) — string array or newline-separated summary lines",
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          bullets: {
            oneOf: [
              { type: "array", items: { type: "string" } },
              { type: "string" },
            ],
            description: "1-3 headline bullets for today's fleet log",
          },
        },
        required: ["bullets"],
      },
      handler: async (input) => {
        const env = envOverride ?? readDailyLogToolEnv();
        const bullets = normalizeBulletsInput(input.bullets);
        if (bullets.length === 0) {
          return { error: "daily_log_append requires at least one bullet" };
        }

        const agentId = env.agentId?.trim();
        const channelId = env.channelId?.trim();
        const conversationKey = env.conversationKey?.trim();
        if (!agentId || !channelId || !conversationKey) {
          return {
            error:
              "daily_log_append missing Discord turn context (agent, channel, conversation). "
              + "Run from a live Discord turn, not repo-only.",
          };
        }

        const now = new Date();
        const timeZone = env.timeZone?.trim() || "America/Denver";
        const capturedBy = normalizeCapturedBy(env.capturedBy);

        try {
          const result = await appendFleetDailyLogBlock({
            bullets,
            now,
            timeZone,
            metadata: {
              agent_id: agentId,
              date: formatFleetDailyLogCalendarDate(now, timeZone),
              time: formatFleetDailyLogTimestamp(now, timeZone),
              channel_id: channelId,
              ...(env.threadId ? { thread_id: env.threadId } : {}),
              conversation_key: conversationKey,
              captured_by: capturedBy,
              ...(env.requestedByUserId ? { requested_by_user_id: env.requestedByUserId } : {}),
              ...(env.trigger ? { trigger: env.trigger } : {}),
            },
          });

          return {
            path: result.path,
            date: result.date,
            created_file: result.createdFile,
            block: result.block,
            captured_by: capturedBy,
            conversation_key: conversationKey,
          };
        } catch (error) {
          return {
            error: error instanceof Error ? error.message : String(error),
          };
        }
      },
    },
  ];
}

function normalizeCapturedBy(value: DiscordCapturedBy | undefined): FleetDailyLogCapturedBy {
  return value === "save_pass" ? "save_pass" : "agent_save";
}
