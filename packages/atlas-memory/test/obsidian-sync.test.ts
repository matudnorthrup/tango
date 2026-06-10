import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addObsidianMemories,
  createAtlasMemoryTools,
  deleteObsidianMemoriesBySourceRefPrefix,
  openAtlasMemoryDatabase,
} from "../src/index.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-obsidian-sync-"));
  tempDirs.push(dir);
  return openAtlasMemoryDatabase({ dbPath: path.join(dir, "memory.db") });
}

describe("obsidian sync", () => {
  it("adds obsidian chunks with upstream embeddings and prunes by source_ref prefix", () => {
    const { db } = createDb();

    const ids = addObsidianMemories(db, [
      {
        content: "Puerto Escondido fishing: inshore panga, roosterfish, ~$450 half day.",
        sourceRef: "obsidian:Trips/Puerto Escondido.md#1",
        importance: 0.6,
        metadata: { title: "Puerto Escondido" },
        embedding: [0.1, 0.2, 0.3],
        embeddingModel: "voyage-4-lite",
      },
      {
        content: "Offshore sportfisher, dorado and sailfish, ~$950 full day.",
        sourceRef: "obsidian:Trips/Puerto Escondido.md#2",
        importance: 0.6,
        embedding: null,
      },
      {
        content: "Unrelated note chunk.",
        sourceRef: "obsidian:Other.md#1",
        importance: 0.4,
      },
    ]);
    expect(ids).toHaveLength(3);

    const rows = db
      .prepare(
        `SELECT source, embedding, embedding_model, json_extract(metadata, '$.source_ref') AS source_ref FROM memories ORDER BY source_ref`,
      )
      .all() as Array<{
      source: string;
      embedding: Buffer | null;
      embedding_model: string | null;
      source_ref: string;
    }>;

    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.source === "obsidian")).toBe(true);
    const embedded = rows.find((row) => row.source_ref.endsWith("Puerto Escondido.md#1"));
    expect(embedded?.embedding).not.toBeNull();
    expect(embedded?.embedding_model).toBe("voyage-4-lite");
    const unembedded = rows.find((row) => row.source_ref.endsWith("Puerto Escondido.md#2"));
    expect(unembedded?.embedding).toBeNull();

    const deleted = deleteObsidianMemoriesBySourceRefPrefix(db, "obsidian:Trips/Puerto Escondido.md#");
    expect(deleted).toBe(2);
    const remaining = db.prepare(`SELECT COUNT(*) AS total FROM memories`).get() as { total: number };
    expect(remaining.total).toBe(1);

    db.close();
  });

  it("makes synced obsidian chunks searchable via memory_search (text ranking)", async () => {
    const { db } = createDb();
    addObsidianMemories(db, [
      {
        content: "Puerto Escondido fishing charters: inshore roosterfish and offshore dorado.",
        sourceRef: "obsidian:Trips/PE.md#1",
        importance: 0.7,
      },
    ]);

    const tools = createAtlasMemoryTools({ db, embeddingProvider: null });
    const search = tools.find((tool) => tool.name === "memory_search");
    const results = (await search?.handler({ query: "fishing charters" })) as Array<{
      source: string;
      content: string;
    }>;

    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.source).toBe("obsidian");
    expect(results[0]?.content).toContain("fishing charters");

    db.close();
  });
});
