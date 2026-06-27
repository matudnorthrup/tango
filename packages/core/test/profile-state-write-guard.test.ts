import { describe, expect, it } from "vitest";
import {
  applyEditPatch,
  missingFrozenHeadings,
  validateProfileStateFileMutation,
} from "../src/profile-state-write-guard.js";

const CANARY = `---
status: active
state_managed: true
---

# Cod-E canary

## Quick Read

Smoke in progress.

## Open Items

- [ ] A8 pending

## Notes

probe
`;

describe("profile-state-write-guard", () => {
  it("allows targeted patch that preserves frozen headings", () => {
    const next = applyEditPatch(CANARY, "A8 pending", "A8 pass")!;
    const result = validateProfileStateFileMutation({
      filePath: "/tmp/profile/threads/infrastructure/cod-e-canary/cod-e-canary.md",
      existingContent: CANARY,
      nextContent: next,
      operation: "patch",
      profileRoot: "/tmp/profile",
    });
    expect(result.allowed).toBe(true);
  });

  it("blocks A5-style full overwrite on existing thread file", () => {
    const result = validateProfileStateFileMutation({
      filePath: "/tmp/profile/threads/infrastructure/cod-e-canary/cod-e-canary.md",
      existingContent: CANARY,
      nextContent: "This is a full overwrite test. All original content should be gone.",
      operation: "write",
      profileRoot: "/tmp/profile",
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/full-file overwrite|frozen heading/i);
  });

  it("blocks empty write", () => {
    const result = validateProfileStateFileMutation({
      filePath: "/tmp/profile/threads/foo.md",
      existingContent: CANARY,
      nextContent: "   ",
      operation: "write",
      profileRoot: "/tmp/profile",
    });
    expect(result.allowed).toBe(false);
  });

  it("detects missing frozen headings", () => {
    expect(missingFrozenHeadings("# no headings")).toEqual(["Quick Read", "Open Items"]);
  });

  it("ignores non-thread paths", () => {
    const result = validateProfileStateFileMutation({
      filePath: "/tmp/profile/agents/assistants/cod-e/knowledge.md",
      existingContent: "long ".repeat(100),
      nextContent: "short",
      operation: "write",
      profileRoot: "/tmp/profile",
    });
    expect(result.allowed).toBe(true);
  });
});
