import fs from "node:fs";
import path from "node:path";
import {
  resolveTangoCurrentTurnProvenancePath,
  resolveTangoTurnProvenancePath,
} from "./runtime-paths.js";

export const DISCORD_TURN_PROVENANCE_ENV_KEYS = [
  "TANGO_CONVERSATION_KEY",
  "TANGO_DISCORD_CHANNEL_ID",
  "TANGO_DISCORD_THREAD_ID",
  "TANGO_AGENT_ID",
  "TANGO_CAPTURED_BY",
  "TANGO_REQUESTED_BY_USER_ID",
  "TANGO_SAVE_TRIGGER",
  "TANGO_TURN_TIMEZONE",
] as const;

const ENV_KEY_TO_HEADER: Record<(typeof DISCORD_TURN_PROVENANCE_ENV_KEYS)[number], string> = {
  TANGO_CONVERSATION_KEY: "x-tango-conversation-key",
  TANGO_DISCORD_CHANNEL_ID: "x-tango-discord-channel-id",
  TANGO_DISCORD_THREAD_ID: "x-tango-discord-thread-id",
  TANGO_AGENT_ID: "x-tango-agent-id",
  TANGO_CAPTURED_BY: "x-tango-captured-by",
  TANGO_REQUESTED_BY_USER_ID: "x-tango-requested-by-user-id",
  TANGO_SAVE_TRIGGER: "x-tango-save-trigger",
  TANGO_TURN_TIMEZONE: "x-tango-turn-timezone",
};

const HEADER_TO_ENV_KEY = Object.fromEntries(
  Object.entries(ENV_KEY_TO_HEADER).map(([envKey, header]) => [header, envKey]),
) as Record<string, (typeof DISCORD_TURN_PROVENANCE_ENV_KEYS)[number]>;

export function pickDiscordTurnProvenanceEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const key of DISCORD_TURN_PROVENANCE_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) {
      picked[key] = value;
    }
  }
  return picked;
}

function resolveTurnProvenanceSnapshotPath(env: NodeJS.ProcessEnv): string {
  const explicit = env.TANGO_TURN_PROVENANCE_FILE?.trim();
  if (explicit) {
    return explicit;
  }
  const conversationKey = env.TANGO_CONVERSATION_KEY?.trim();
  if (conversationKey) {
    return resolveTangoTurnProvenancePath(conversationKey);
  }
  return resolveTangoCurrentTurnProvenancePath();
}

export function resolveDiscordTurnProvenanceEnv(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const filePath = resolveTurnProvenanceSnapshotPath(env);
  let fromFile: Record<string, string> = {};
  try {
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        fromFile = pickDiscordTurnProvenanceEnv(parsed as NodeJS.ProcessEnv);
      }
    }
  } catch {
    // Fall back to process env only.
  }
  return {
    ...pickDiscordTurnProvenanceEnv(env),
    ...fromFile,
  };
}

export function writeDiscordTurnProvenanceSnapshot(
  provenance: Record<string, string>,
  options: { filePath?: string; conversationKey?: string } = {},
): string {
  const conversationKey =
    options.conversationKey?.trim() ?? provenance.TANGO_CONVERSATION_KEY?.trim();
  const filePath =
    options.filePath?.trim()
    ?? (conversationKey
      ? resolveTangoTurnProvenancePath(conversationKey)
      : resolveTangoCurrentTurnProvenancePath());
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = pickDiscordTurnProvenanceEnv(provenance as NodeJS.ProcessEnv);
  fs.writeFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
  return filePath;
}

export function discordTurnProvenanceToHttpHeaders(
  env: Record<string, string>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const key of DISCORD_TURN_PROVENANCE_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) {
      headers[ENV_KEY_TO_HEADER[key]] = value;
    }
  }
  return headers;
}

export function httpHeadersToDiscordTurnProvenanceEnv(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [headerName, envKey] of Object.entries(HEADER_TO_ENV_KEY)) {
    const raw = headers[headerName] ?? headers[headerName.toLowerCase()];
    const value = Array.isArray(raw) ? raw[0] : raw;
    const trimmed = value?.trim();
    if (trimmed) {
      env[envKey] = trimmed;
    }
  }
  return env;
}
