import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
              happened: {
                type: "array",
                items: { enum: ["extended", "accepted", "sustained", "setApart", "recordedInLcr"] },
                description: "Calling lifecycle step(s) that happened. Stamps each step's date column and advances Status to the next action unless status is also supplied.",
              },
              on: {
                type: "string",
                description: "Date for the happened step(s), when the request provides one; otherwise the engine uses today.",
              },
              status: { type: "string", enum: ["Identify", "Extend", "Sustain", "Set apart", "Record in LCR", "Done"] },
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

  it("exposes the explicit weekly email send tool", async () => {
    const tool = createWardProgramTools().find((candidate) => candidate.name === "ward_program_send_email");

    expect(tool).toMatchObject({
      name: "ward_program_send_email",
      inputSchema: {
        type: "object",
        properties: {
          by: { type: "string" },
          force: { type: "boolean" },
        },
        required: ["by"],
        additionalProperties: false,
      },
    });
    expect(tool?.description).toContain("ONLY call when the user or portal explicitly asks");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-ward-email-tool-"));
    fs.mkdirSync(path.join(dir, "scripts"));
    fs.writeFileSync(
      path.join(dir, "scripts", "send-email.mjs"),
      "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }));\n",
    );
    const previousDir = process.env.WARD_PROGRAM_DIR;
    process.env.WARD_PROGRAM_DIR = dir;
    try {
      await expect(tool?.handler({ by: "Portal Requester", force: true })).resolves.toEqual({
        argv: ["--by=Portal Requester", "--force"],
      });
    } finally {
      if (previousDir === undefined) delete process.env.WARD_PROGRAM_DIR;
      else process.env.WARD_PROGRAM_DIR = previousDir;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
