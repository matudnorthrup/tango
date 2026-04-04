import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  backfillImportPaths,
  backfillMarkdownFiles,
  backfillMessages,
} from "../src/memory-backfill.js";
import { TangoStorage } from "../src/storage.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createStorage(): { storage: TangoStorage; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tango-memory-backfill-"));
  tempDirs.push(dir);
  const storage = new TangoStorage(path.join(dir, "tango.sqlite"));
  storage.bootstrapSessions([
    {
      id: "default",
      type: "persistent",
      agent: "watson",
      channels: ["discord:default"],
      memory: {
        summarizeWindow: 4,
      },
    },
  ]);
  return { storage, dir };
}

describe("memory backfill", () => {
  it("backfills message history into idempotent backfill memories", async () => {
    const { storage } = createStorage();

    for (let index = 0; index < 8; index += 1) {
      storage.insertMessage({
        sessionId: "default",
        agentId: "watson",
        direction: index % 2 === 0 ? "inbound" : "outbound",
        source: "discord",
        content:
          index % 2 === 0
            ? `User turn ${index + 1}: keep the weekly review concise and action-focused.`
            : `Assistant turn ${index + 1}: understood, I will keep the weekly review short and actionable.`,
      });
    }

    const result = await backfillMessages({
      storage,
      sessionConfigs: [
        {
          id: "default",
          type: "persistent",
          agent: "watson",
          channels: ["discord:default"],
          memory: {
            summarizeWindow: 4,
          },
        },
      ],
    });

    expect(result.insertedCount).toBe(2);
    expect(storage.listMemories({ source: "backfill", sessionId: "default", agentId: "watson" })).toHaveLength(2);

    const secondRun = await backfillMessages({
      storage,
      sessionConfigs: [
        {
          id: "default",
          type: "persistent",
          agent: "watson",
          channels: ["discord:default"],
          memory: {
            summarizeWindow: 4,
          },
        },
      ],
    });
    expect(secondRun.insertedCount).toBe(0);
    expect(secondRun.skippedCount).toBe(2);

    storage.close();
  });

  it("backfills markdown and import files with source refs", async () => {
    const { storage, dir } = createStorage();
    const markdownPath = path.join(dir, "thread.md");
    fs.writeFileSync(
      markdownPath,
      [
        "---",
        "title: Weekly Review Thread",
        "tags:",
        "  - planning",
        "  - review",
        "created: 2026-02-15",
        "---",
        "",
        "# Weekly Review Thread",
        "",
        "## Current State",
        "Weekly reviews should stay concise and action-focused.",
        "",
        "## Decisions",
        "Use Mondays for weekly reviews and keep them under ten minutes.",
      ].join("\n"),
      "utf8"
    );

    const transcriptPath = path.join(dir, "rescued.txt");
    fs.writeFileSync(
      transcriptPath,
      "Rescued voice transcript\nI need to send feedback to Nick about the trailer concept tomorrow morning.",
      "utf8"
    );

    const markdownResult = await backfillMarkdownFiles({
      storage,
      paths: [markdownPath],
      memorySource: "backfill",
    });
    expect(markdownResult.insertedCount).toBeGreaterThan(0);

    const importResult = await backfillImportPaths({
      storage,
      paths: [transcriptPath],
      memorySource: "backfill",
    });
    expect(importResult.insertedCount).toBe(1);

    const stored = storage.listMemories({ source: "backfill", limit: 10 });
    expect(stored.some((memory) => memory.sourceRef?.includes("thread.md#1"))).toBe(true);
    expect(stored.some((memory) => memory.sourceRef?.includes("rescued.txt#1"))).toBe(true);

    storage.close();
  });
});
