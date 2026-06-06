import {
  DEFAULT_CONTEXT_PRESSURE_ALERT_THRESHOLD,
  formatContextUsageSummary,
  type LastContextUsageSnapshot,
} from "@tango/core";

export function buildContextPressureInThreadAlert(
  agentId: string,
  usage: Pick<LastContextUsageSnapshot, "fraction" | "totalTokens" | "contextWindow">,
): string {
  const percent = Math.round(usage.fraction * 100);
  const rotationPercent = 80;

  return [
    `**Context ${percent}% — ${agentId}**`,
    formatContextUsageSummary(usage),
    `You are in the last stretch before automatic rotation at ${rotationPercent}%. Run \`/tango save\` if you want a checkpoint.`,
    `You will get another in-thread notice when the session rotates at ${rotationPercent}%. Use \`/tango new\` when you are ready to rotate on your own schedule.`,
  ].join("\n");
}

export function buildContextRotationInThreadAlert(agentId: string): string {
  return [
    `**Session rotated at 80% context — ${agentId}**`,
    "The provider session was reset. Message history is preserved for warm-start on your next turn.",
    "This was rotation, not a save pass. Run `/tango save` if anything important might be missing from Atlas.",
  ].join("\n");
}

export function buildContextSlashReply(input: {
  agentId: string;
  conversationKey: string;
  usage?: LastContextUsageSnapshot;
  contextPressureAlertSent?: boolean;
  idleTimeoutHours: number;
  lifecycleIdleTimeoutHours: number;
}): string {
  const lines = [
    `**${input.agentId}** · \`${input.conversationKey}\``,
    formatContextUsageSummary(input.usage),
  ];

  if (input.usage?.recordedAt) {
    lines.push(`Last reading: ${input.usage.recordedAt.toISOString()}`);
  }

  const thresholdPercent = Math.round(DEFAULT_CONTEXT_PRESSURE_ALERT_THRESHOLD * 100);
  if (input.contextPressureAlertSent) {
    lines.push(`In-thread alert: already sent at ${thresholdPercent}%+ for this provider session.`);
  } else {
    lines.push(`In-thread alert: will post once when this conversation reaches ${thresholdPercent}%.`);
  }

  lines.push(
    "At 80% context the provider session rotates automatically; you will get an in-thread notice when that happens.",
    `Idle timeout: agent config ${input.idleTimeoutHours}h; v2 lifecycle currently closes idle runtimes after ${input.lifecycleIdleTimeoutHours}h.`,
    "If the runtime closes from idle, your next message starts fresh and context % resets.",
  );

  return lines.join("\n");
}
