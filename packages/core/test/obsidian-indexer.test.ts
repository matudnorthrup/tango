import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { indexObsidianVault } from "../src/obsidian-indexer.js";
import { TangoStorage } from "../src/storage.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createFixture(): { storage: TangoStorage; dir: string; vaultDir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-obsidian-index-"));
  tempDirs.push(dir);
  const vaultDir = path.join(dir, "vault");
  fs.mkdirSync(vaultDir, { recursive: true });
  const storage = new TangoStorage(path.join(dir, "tango.sqlite"));
  return { storage, dir, vaultDir };
}

describe("obsidian indexer", () => {
  it("indexes curated notes while skipping transcript-heavy defaults", async () => {
    const { storage, vaultDir } = createFixture();
    const planningDir = path.join(vaultDir, "Planning");
    const aiConversationDir = path.join(vaultDir, "AI", "Conversations");
    const clippingsDir = path.join(vaultDir, "Clippings");

    fs.mkdirSync(planningDir, { recursive: true });
    fs.mkdirSync(aiConversationDir, { recursive: true });
    fs.mkdirSync(clippingsDir, { recursive: true });

    fs.writeFileSync(
      path.join(planningDir, "Weekly Plan.md"),
      "# Weekly Plan\n\n## Current State\nKeep the weekly review concise and action-focused.",
      "utf8"
    );
    fs.writeFileSync(
      path.join(aiConversationDir, "Transcript.md"),
      "# Transcript\n\nThis is a long AI transcript that should stay out of the curated index.",
      "utf8"
    );
    fs.writeFileSync(
      path.join(clippingsDir, "External Article.md"),
      "# External Article\n\nThis clipping should be skipped by default.",
      "utf8"
    );

    const result = await indexObsidianVault({
      storage,
      paths: [vaultDir],
    });

    expect(result.scannedFileCount).toBe(1);
    expect(result.indexedFileCount).toBe(1);
    expect(storage.listMemories({ source: "obsidian", limit: 10 })).toHaveLength(1);
    expect(storage.listMemories({ source: "obsidian", limit: 10 })[0]?.sourceRef).toContain("Weekly Plan.md#1");
    expect(storage.getObsidianIndexEntry(path.join(planningDir, "Weekly Plan.md"))).not.toBeNull();
    expect(storage.getObsidianIndexEntry(path.join(aiConversationDir, "Transcript.md"))).toBeNull();

    storage.close();
  });

  it("replaces changed files and removes deleted files from the index", async () => {
    const { storage, vaultDir } = createFixture();
    const planningDir = path.join(vaultDir, "Planning");
    fs.mkdirSync(planningDir, { recursive: true });

    const notePath = path.join(planningDir, "Project Plan.md");
    fs.writeFileSync(
      notePath,
      "# Project Plan\n\n## Current State\nShip the memory indexer next.\n\n## Next\nRun full verification.",
      "utf8"
    );

    const firstRun = await indexObsidianVault({
      storage,
      paths: [vaultDir],
    });
    expect(firstRun.indexedFileCount).toBe(1);
    expect(storage.listMemories({ source: "obsidian", limit: 10 })).toHaveLength(2);

    fs.writeFileSync(
      notePath,
      "# Project Plan\n\n## Current State\nShip the memory indexer tonight.\n\n## Decisions\nRun full verification before sleep.",
      "utf8"
    );

    const secondRun = await indexObsidianVault({
      storage,
      paths: [vaultDir],
    });
    expect(secondRun.indexedFileCount).toBe(1);
    expect(secondRun.deletedMemoryCount).toBeGreaterThan(0);
    expect(storage.listMemories({ source: "obsidian", limit: 10 })).toHaveLength(2);

    fs.rmSync(notePath);

    const thirdRun = await indexObsidianVault({
      storage,
      paths: [vaultDir],
    });
    expect(thirdRun.removedFileCount).toBe(1);
    expect(storage.listMemories({ source: "obsidian", limit: 10 })).toHaveLength(0);
    expect(storage.getObsidianIndexEntry(notePath)).toBeNull();

    storage.close();
  });
});
