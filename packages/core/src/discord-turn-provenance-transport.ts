/**
 * Forward Discord turn provenance from MCP proxy (stdio child) to the
 * persistent HTTP wellness server. Atlas-memory uses a direct stdio server;
 * mcp-proxy tools must pass provenance out-of-band via HTTP headers.
 */

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
