import { describe, expect, it } from "vitest";
import { buildCurrentTurnMetadataPrompt } from "../src/current-turn-metadata.js";

describe("buildCurrentTurnMetadataPrompt", () => {
  const referenceDate = new Date("2026-06-01T02:27:00Z");

  it("returns undefined when metadata config is missing", () => {
    expect(buildCurrentTurnMetadataPrompt({})).toBeUndefined();
  });

  it("builds a 12h timestamp prompt using the configured timezone", () => {
    const prompt = buildCurrentTurnMetadataPrompt(
      {
        currentTurnMetadata: {
          timezone: "America/Denver",
          timeFormat: "12h",
        },
      },
      referenceDate,
    );

    expect(prompt).toBe("Current time: Sunday, May 31, 2026 8:27 PM MDT (2026-06-01T02:27:00Z)");
  });

  it("builds a 24h timestamp prompt using the configured timezone", () => {
    const prompt = buildCurrentTurnMetadataPrompt(
      {
        currentTurnMetadata: {
          timezone: "America/Denver",
          timeFormat: "24h",
        },
      },
      referenceDate,
    );

    expect(prompt).toBe("Current time: Sunday, May 31, 2026 20:27 MDT (2026-06-01T02:27:00Z)");
  });
});
