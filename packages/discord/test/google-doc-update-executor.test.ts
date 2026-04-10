import { describe, expect, it, vi } from "vitest";
import { executeGoogleDocTabUpdate } from "../src/google-doc-update-executor.js";

describe("executeGoogleDocTabUpdate", () => {
  it("applies verified find-replace updates against a specific tab", async () => {
    let tabText = "Old headline\n\nBody copy";
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] !== "docs") {
        throw new Error(`Unexpected gog namespace: ${args.join(" ")}`);
      }
      if (args[1] === "cat") {
        return tabText;
      }
      if (args[1] === "write") {
        tabText = "New headline\n\nBody copy";
        return "ok";
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    const result = await executeGoogleDocTabUpdate(
      {
        doc: "https://docs.google.com/document/d/1abcDocId/edit?tab=t.original",
        tab: "https://docs.google.com/document/d/1abcDocId/edit?tab=t.target",
        account: "devin@latitude.io",
        replacements: [{ find: "Old headline", replace: "New headline", first: true }],
        verify_contains: ["New headline", "Body copy"],
      },
      {
        gogCommand: "gog",
        runCommand,
      },
    );

    expect(result).toMatchObject({
      status: "confirmed",
      docId: "1abcDocId",
      tabId: "t.target",
      account: "devin@latitude.io",
      appliedReplacementCount: 1,
      verificationCount: 2,
      missingVerifications: [],
    });
    expect(runCommand.mock.calls.map(([, args]) => args.slice(0, 2))).toEqual([
      ["docs", "cat"],
      ["docs", "write"],
      ["docs", "cat"],
    ]);
    expect(runCommand.mock.calls[0]?.[1]).toContain("--tab");
    expect(runCommand.mock.calls[1]?.[1]).toContain("--tab-id");
  });

  it("returns precondition_failed instead of guessing when the source text is missing", async () => {
    const runCommand = vi.fn(async () => "Current tab content");

    const result = await executeGoogleDocTabUpdate(
      {
        doc: "1abcDocId",
        tab: "t.target",
        account: "devin@latitude.io",
        replacements: [{ find: "Missing headline", replace: "New headline" }],
      },
      {
        gogCommand: "gog",
        runCommand,
      },
    );

    expect(result).toEqual({
      status: "precondition_failed",
      docId: "1abcDocId",
      tabId: "t.target",
      account: "devin@latitude.io",
      missing: ["Missing headline"],
    });
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("writes full content without a pre-read when no replacements are requested", async () => {
    const runCommand = vi.fn(async (_command: string, args: string[]) => {
      if (args[0] !== "docs") {
        throw new Error(`Unexpected gog namespace: ${args.join(" ")}`);
      }
      if (args[1] === "write") {
        return "ok";
      }
      if (args[1] === "cat") {
        return "Fresh content";
      }
      throw new Error(`Unexpected command: ${args.join(" ")}`);
    });

    const result = await executeGoogleDocTabUpdate(
      {
        doc: "1abcDocId",
        tab: "t.target",
        account: "devin@latitude.io",
        content: "Fresh content",
        verify_contains: ["Fresh content"],
      },
      {
        gogCommand: "gog",
        runCommand,
      },
    );

    expect(result).toMatchObject({
      status: "confirmed",
      docId: "1abcDocId",
      tabId: "t.target",
      verificationCount: 1,
    });
    expect(runCommand.mock.calls.map(([, args]) => args.slice(0, 2))).toEqual([
      ["docs", "write"],
      ["docs", "cat"],
    ]);
  });
});
