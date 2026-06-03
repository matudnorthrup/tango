import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TangoStorage } from "@tango/core";
import {
  buildStateFilePointer,
  conversationKeyFor,
  refreshProjectHeadOnTurn,
  renderProjectStateBlock,
} from "../src/project-state.js";
import { createAtlasColdStartContextBuilder } from "../src/v2-runtime.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createStorage(): TangoStorage {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-project-state-"));
  tempDirs.push(dir);
  return new TangoStorage(path.join(dir, "tango.sqlite"));
}

describe("project-state integration", () => {
  it("derives the conversation key like TangoRouter", () => {
    expect(conversationKeyFor("chan-1")).toBe("channel:chan-1");
    expect(conversationKeyFor("chan-1", "thread-9")).toBe("thread:thread-9");
  });

  it("returns no pointer or block when the conversation is not a project arc", () => {
    const storage = createStorage();
    expect(buildStateFilePointer(storage, "thread:none")).toBeUndefined();
    expect(renderProjectStateBlock(storage, "thread:none")).toBeUndefined();
    storage.close();
  });

  it("builds a whisper pointer and a reseed block from the head + open items", () => {
    const storage = createStorage();
    const key = "thread:italy";
    storage.upsertProjectState({
      projectId: key,
      title: "Italy Motorcycle Trip",
      status: "planning",
      quickRead: "June route locked; Kalepo flight decision open.",
      obsidianPath: "Italy Motorcycle Trip June 2026.md",
    });

    const pointer = buildStateFilePointer(storage, key);
    expect(pointer).toEqual({
      path: "Italy Motorcycle Trip June 2026.md",
      project: "Italy Motorcycle Trip",
      status: "planning",
    });

    storage.upsertActiveContextItem({
      key: "kalepo-flight",
      kind: "decision",
      title: "Kalepo flight",
      summary: "Decide whether to move return +1/+2 days.",
      scope: { projectId: key },
    });

    const block = renderProjectStateBlock(storage, key)!;
    expect(block).toContain("Project: Italy Motorcycle Trip (status: planning)");
    expect(block).toContain("Quick read: June route locked");
    expect(block).toContain("State file: Italy Motorcycle Trip June 2026.md");
    expect(block).toContain("read it before responding");
    expect(block).toContain("Open items:");
    expect(block).toContain("[decision] Kalepo flight: Decide whether to move return");
    storage.close();
  });

  it("refreshes the head's session chain on a turn, and no-ops without a head", () => {
    const storage = createStorage();
    const key = "thread:italy";

    // No head yet → no-op (must not create one).
    refreshProjectHeadOnTurn(storage, key, "session-1");
    expect(storage.getProjectState(key)).toBeUndefined();

    storage.upsertProjectState({ projectId: key, title: "Italy", obsidianPath: "Italy.md" });
    refreshProjectHeadOnTurn(storage, key, "session-xyz");
    expect(storage.getProjectState(key)?.prevSessionId).toBe("session-xyz");
    storage.close();
  });

  it("emits a pointer only when an obsidian body is linked", () => {
    const storage = createStorage();
    const key = "thread:nopath";
    storage.upsertProjectState({ projectId: key, title: "No body yet", status: "active" });
    // Head exists but no obsidian_path → reseed block renders, pointer does not.
    expect(buildStateFilePointer(storage, key)).toBeUndefined();
    expect(renderProjectStateBlock(storage, key)).toContain("Project: No body yet");
    storage.close();
  });

  it("reads the live Obsidian body for reseed when a vault root is supplied", () => {
    const storage = createStorage();
    const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tango-vault-"));
    tempDirs.push(vaultRoot);
    const rel = "Trips/Italy.md";
    fs.mkdirSync(path.join(vaultRoot, "Trips"), { recursive: true });
    fs.writeFileSync(
      path.join(vaultRoot, rel),
      [
        "---", "status: planning", "---", "",
        "## Quick Read", "Route locked; +2 days added for Tre Cime.", "",
        "## Open Items", "- Book Cortina (pricey in summer)", "- Decide Kalepo return flight", "",
        "## Notes", "misc",
      ].join("\n"),
    );

    const key = "thread:italy";
    storage.upsertProjectState({
      projectId: key, title: "Italy", status: "active", quickRead: "stale head text", obsidianPath: rel,
    });

    const block = renderProjectStateBlock(storage, key, { vaultRoot })!;
    expect(block).toContain("Quick read: Route locked; +2 days added for Tre Cime.");
    expect(block).not.toContain("stale head text"); // live body overrides the head
    expect(block).toContain("- Book Cortina (pricey in summer)");
    expect(block).toContain("- Decide Kalepo return flight");

    // Missing file → graceful fallback to the head's quick read.
    storage.upsertProjectState({
      projectId: "thread:gone", title: "Gone", obsidianPath: "Trips/missing.md", quickRead: "fallback text",
    });
    expect(renderProjectStateBlock(storage, "thread:gone", { vaultRoot })).toContain(
      "Quick read: fallback text",
    );
    storage.close();
  });

  it("builds a live pointer snapshot (status + Quick Read) from the body when a vault root is given", () => {
    const storage = createStorage();
    const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tango-vault-"));
    tempDirs.push(vaultRoot);
    fs.writeFileSync(
      path.join(vaultRoot, "Trip.md"),
      "---\nstatus: active\n---\n\n## Quick Read\n+2 days confirmed; Tre Cime loop is on.\n",
    );
    const key = "thread:x";
    // Head says "planning"; the live body says "active" and should win.
    storage.upsertProjectState({ projectId: key, title: "Trip", status: "planning", obsidianPath: "Trip.md" });

    const headOnly = buildStateFilePointer(storage, key);
    expect(headOnly?.status).toBe("planning");
    expect(headOnly?.snapshot).toBeUndefined();

    const live = buildStateFilePointer(storage, key, { vaultRoot });
    expect(live?.status).toBe("active");
    expect(live?.snapshot).toContain("+2 days confirmed; Tre Cime loop is on.");
    storage.close();
  });

  it("the cold-start builder injects the project reseed block (end-to-end wiring)", async () => {
    const storage = createStorage();
    const key = "thread:italy";
    storage.upsertProjectState({
      projectId: key, title: "Italy Trip", status: "planning",
      quickRead: "June route locked.", obsidianPath: "Italy.md",
    });
    const atlasStub = { pinnedFactGet: async () => [], memorySearch: async () => [] };
    const builder = createAtlasColdStartContextBuilder(atlasStub as never, {
      projectStateProvider: (ck) => renderProjectStateBlock(storage, ck),
    });

    const ctx = await builder(key, "sierra");
    expect(ctx.recentMessages).toContain("Project state:");
    expect(ctx.recentMessages).toContain("Project: Italy Trip (status: planning)");
    expect(ctx.recentMessages).toContain("Quick read: June route locked.");
    expect(ctx.recentMessages).toContain("State file: Italy.md");

    // Unbound conversation → no project block.
    const empty = await builder("thread:unbound", "sierra");
    expect(empty.recentMessages).toBe("");
    storage.close();
  });
});
