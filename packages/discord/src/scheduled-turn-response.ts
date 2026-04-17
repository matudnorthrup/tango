import type { DiscordTurnExecutionResult } from "./turn-executor.js";

export function selectScheduledTurnResponseText(
  intentIds: string[],
  turnResult: DiscordTurnExecutionResult,
): string {
  void intentIds;
  return turnResult.responseText;
}
