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

  it("exposes sheet-only calling pipeline and task operations on ward_program_update", () => {
    const tool = createWardProgramTools().find((candidate) => candidate.name === "ward_program_update");
    const schema = tool?.inputSchema as { properties?: Record<string, unknown> };
    expect(schema.properties?.tasks).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        updateCalling: {
          type: "array",
          items: {
            type: "object",
            properties: {
              calling: { type: "string" },
              status: { type: "string", enum: ["Identify", "Extend", "Sustain", "Set Apart", "Done"] },
              person: { type: "string" },
              assigned: {
                type: "array",
                items: { type: "string" },
                description:
                  'Bishopric member(s) who own the next step (first names as used on the board, e.g. ["Devin","Shawn"]). Replaces the current assignment.',
              },
              notes: { type: "string" },
            },
            required: ["calling"],
            additionalProperties: false,
          },
        },
        addTask: {
          type: "array",
          items: {
            type: "object",
            properties: {
              task: { type: "string" },
              owner: { type: "array", items: { type: "string" }, description: "Bishopric member(s) responsible." },
              notes: { type: "string" },
            },
            required: ["task"],
            additionalProperties: false,
          },
        },
        updateTask: {
          type: "array",
          description: "Update only the supplied cells on a matching general Tasks-tab row (reassign, add a note).",
          items: {
            type: "object",
            properties: {
              task: { type: "string" },
              owner: { type: "array", items: { type: "string" } },
              notes: { type: "string" },
            },
            required: ["task"],
            additionalProperties: false,
          },
        },
        completeTask: {
          type: "array",
          items: {
            type: "object",
            properties: { task: { type: "string" } },
            required: ["task"],
            additionalProperties: false,
          },
        },
      },
    });
  });
});
