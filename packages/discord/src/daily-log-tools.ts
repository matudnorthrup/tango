import {
  appendFleetDailyLogBlock,
  formatFleetDailyLogCalendarDate,
  formatFleetDailyLogTimestamp,
  patchFleetDailyLog,
  resolveDiscordTurnProvenanceEnv,
  type FleetDailyLogCapturedBy,
  type AgentTool,
} from "@tango/core";
import type { DiscordCapturedBy } from "./discord-memory-provenance.js";
import { readDiscordTurnProvenanceFromContext } from "./discord-turn-provenance-context.js";

/** Gate 2 scope (T-B-010): supervised corrections — Cod-E canary only until fleet review. */
export const DAILY_LOG_PATCH_ALLOWED_AGENT_IDS = new Set(["cod-e"]);

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
  const resolved = {
    ...resolveDiscordTurnProvenanceEnv(env),
    ...fromContext,
  };
  return {
    conversationKey: resolved.TANGO_CONVERSATION_KEY,
    channelId: resolved.TANGO_DISCORD_CHANNEL_ID,
    threadId: resolved.TANGO_DISCORD_THREAD_ID,
    agentId: resolved.TANGO_AGENT_ID ?? (env.TANGO_AGENT_ID?.trim() || env.WORKER_ID?.trim()),
    capturedBy: resolved.TANGO_CAPTURED_BY as DiscordCapturedBy | undefined,
    requestedByUserId: resolved.TANGO_REQUESTED_BY_USER_ID,
    trigger: resolved.TANGO_SAVE_TRIGGER,
    timeZone: resolved.TANGO_TURN_TIMEZONE,
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

function normalizeCapturedBy(value: DiscordCapturedBy | undefined): FleetDailyLogCapturedBy {
  return value === "save_pass" ? "save_pass" : "agent_save";
}

function isDailyLogPatchAllowed(agentId: string | undefined): boolean {
  const normalized = agentId?.trim().toLowerCase();
  return normalized !== undefined && DAILY_LOG_PATCH_ALLOWED_AGENT_IDS.has(normalized);
}

export function createDailyLogTools(
  envOverride?: DailyLogToolEnv,
): AgentTool[] {
  const appendTool: AgentTool = {
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
  };

  const patchTool: AgentTool = {
    name: "daily_log_patch",
    description: [
      "Apply a supervised search-and-replace correction to an existing fleet daily log file.",
      "Use for attribution fixes or correction blocks — not routine saves (use daily_log_append).",
      "Cod-E only for now; append-only guard stays the default for other agents.",
      "",
      "Fields:",
      "  date (required) — YYYY-MM-DD log file to edit",
      "  old_string (required) — exact text to replace",
      "  new_string (required) — replacement text (may be empty to delete a span)",
      "  replace_all (optional) — replace every occurrence (default: first only)",
    ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description: "Calendar date of the daily log file (YYYY-MM-DD)",
        },
        old_string: {
          type: "string",
          description: "Exact text to replace in the daily log",
        },
        new_string: {
          type: "string",
          description: "Replacement text",
        },
        replace_all: {
          type: "boolean",
          description: "Replace all occurrences (default false)",
        },
      },
      required: ["date", "old_string", "new_string"],
    },
    handler: async (input) => {
      const env = envOverride ?? readDailyLogToolEnv();
      const agentId = env.agentId?.trim();
      if (!isDailyLogPatchAllowed(agentId)) {
        return {
          error:
            "daily_log_patch is restricted to Cod-E during the canary phase. "
            + "Use daily_log_append and append a correction block instead.",
        };
      }

      const date = typeof input.date === "string" ? input.date.trim() : "";
      const oldString = typeof input.old_string === "string" ? input.old_string : "";
      const newString = typeof input.new_string === "string" ? input.new_string : "";
      const replaceAll = input.replace_all === true;

      try {
        const result = await patchFleetDailyLog({
          date,
          oldString,
          newString,
          replaceAll,
        });
        return {
          path: result.path,
          date: result.date,
          replacements: result.replacements,
          agent_id: agentId,
        };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };

  return [appendTool, patchTool];
}
