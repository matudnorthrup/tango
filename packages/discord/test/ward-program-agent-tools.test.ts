import { describe, expect, it } from "vitest";
import { createWardProgramTools } from "../src/ward-program-agent-tools.js";

describe("ward program agent tools", () => {
  it("exposes sheet-only callings on ward_program_update", () => {
    const tool = createWardProgramTools().find((candidate) => candidate.name === "ward_program_update");
    const schema = tool?.inputSchema as { properties?: Record<string, unknown> };
    expect(schema.properties?.sheetCallings).toMatchObject({
      type: "object",
      description: "Updates the tracking spreadsheet's Callings tab ONLY — no program change, nothing announced over the pulpit.",
    });
  });
});
