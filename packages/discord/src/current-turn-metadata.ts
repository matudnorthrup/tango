import type { V2AgentConfig } from "@tango/core";

function formatPart(date: Date, locale: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(locale, options).format(date);
}

function resolveTimeZoneAbbreviation(date: Date, timezone: string): string {
  return formatPart(date, "en-US", {
    timeZone: timezone,
    timeZoneName: "short",
  })
    .split(" ")
    .filter((token) => token.trim().length > 0)
    .pop() ?? timezone;
}

export function buildCurrentTurnMetadataPrompt(
  config: Pick<V2AgentConfig, "currentTurnMetadata">,
  now: Date = new Date(),
): string | undefined {
  const metadata = config.currentTurnMetadata;
  if (!metadata) {
    return undefined;
  }

  const timezone = metadata.timezone.trim();
  if (!timezone) {
    return undefined;
  }

  const hour12 = metadata.timeFormat === "12h";
  const weekday = formatPart(now, "en-US", { timeZone: timezone, weekday: "long" });
  const monthDayYear = formatPart(now, "en-US", {
    timeZone: timezone,
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const localTime = formatPart(now, "en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
    hour12,
  });
  const zoneAbbrev = resolveTimeZoneAbbreviation(now, timezone);
  const utcTimestamp = now.toISOString().replace(".000", "");

  return `Current time: ${weekday}, ${monthDayYear} ${localTime} ${zoneAbbrev} (${utcTimestamp})`;
}
