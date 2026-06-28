import { AsyncLocalStorage } from "node:async_hooks";

/** Per HTTP MCP request — Discord turn env forwarded from mcp-proxy headers. */
export const discordTurnProvenanceContext = new AsyncLocalStorage<
  Readonly<Record<string, string>>
>();

export function readDiscordTurnProvenanceFromContext(): Record<string, string> {
  return discordTurnProvenanceContext.getStore() ?? {};
}
