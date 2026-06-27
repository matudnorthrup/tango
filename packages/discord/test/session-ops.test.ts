import { describe, expect, it } from "vitest";
import {
  buildSavePassContext,
  buildSendContextWithOptionalSavePass,
  buildV2ConversationKey,
  mergeSendContext,
} from "../src/session-ops.js";

describe("buildV2ConversationKey", () => {
  it("uses channel scope for top-level channels", () => {
    expect(buildV2ConversationKey("1234567890")).toBe("channel:1234567890");
  });

  it("uses thread scope for thread conversations", () => {
    expect(buildV2ConversationKey("parent-id", "thread-id")).toBe("thread:thread-id");
  });
});

describe("buildSavePassContext", () => {
  it("includes save pass instructions and confirmation requirement", () => {
    const context = buildSavePassContext();
    expect(context).toContain("Save pass (requested via /tango save):");
    expect(context).toContain("Linked thread file");
    expect(context).toContain("Daily log");
    expect(context).toContain("Atlas (memory_add)");
    expect(context).toContain('metadata captured_by save_pass');
    expect(context).toContain("Confirm what you saved in each layer");
  });
});

describe("mergeSendContext", () => {
  it("joins non-empty sections with blank lines", () => {
    expect(mergeSendContext("warm start", "save pass")).toBe("warm start\n\nsave pass");
  });

  it("returns undefined when all sections are empty", () => {
    expect(mergeSendContext(undefined, "  ", null)).toBeUndefined();
  });
});

describe("buildSendContextWithOptionalSavePass", () => {
  it("returns warm start only when no pending save", () => {
    expect(buildSendContextWithOptionalSavePass("warm start", false)).toBe("warm start");
  });

  it("appends save pass context when pending save is set", () => {
    const context = buildSendContextWithOptionalSavePass("warm start", true);
    expect(context).toContain("warm start");
    expect(context).toContain("Save pass (requested via /tango save):");
  });

  it("returns save pass only when warm start is empty", () => {
    expect(buildSendContextWithOptionalSavePass(undefined, true)).toBe(buildSavePassContext());
  });
});
