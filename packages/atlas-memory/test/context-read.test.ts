import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getAtlasConversationSummary,
  listAtlasMemoriesForContext,
  listAtlasPinnedFactsForContext,
  openAtlasMemoryDatabase,
  touchAtlasMemories,
} from "../src/index.js";
import { encodeEmbedding } from "../src/search.js";
import { v4 as uuidv4 } from "uuid";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-context-read-"));
  tempDirs.push(dir);
  return openAtlasMemoryDatabase({ dbPath: path.join(dir, "memory.db") });
}

function insertMemory(
  db: ReturnType<typeof createDb>["db"],
  input: {
    content: string;
    agentId?: string | null;
    embedding?: number[] | null;
    archived?: boolean;
    createdAt?: string;
  },
): string {
  const id = uuidv4();
  const timestamp = input.createdAt ?? new Date().toISOString();
  db.prepare(
    `INSERT INTO memories (id, content, source, agent_id, importance, tags, embedding, embedding_model, created_at, last_accessed_at, access_count, archived_at, metadata)
     VALUES (?, ?, 'conversation', ?, 0.6, '[]', ?, ?, ?, ?, 0, ?, '{}')`,
  ).run(
    id,
    input.content,
    input.agentId ?? null,
    input.embedding ? encodeEmbedding(input.embedding) : null,
    input.embedding ? "voyage-4-lite" : null,
    timestamp,
    timestamp,
    input.archived ? timestamp : null,
  );
  return id;
}

describe("atlas context read surface", () => {
  it("lists agent-scoped + global unarchived memories with decoded embeddings", () => {
    const { db } = createDb();
    insertMemory(db, { content: "global fact", agentId: null, embedding: [0.1, 0.2] });
    insertMemory(db, { content: "sierra fact", agentId: "sierra", embedding: [0.3, 0.4] });
    insertMemory(db, { content: "watson fact", agentId: "watson" });
    insertMemory(db, { content: "archived fact", agentId: "sierra", archived: true });

    const rows = listAtlasMemoriesForContext(db, { agentId: "sierra" });
    expect(rows.map((row) => row.content).sort()).toEqual(["global fact", "sierra fact"]);
    const embedded = rows.find((row) => row.content === "sierra fact");
    expect(embedded?.embedding).toEqual([0.3, 0.4]);

    db.close();
  });

  it("reads conversation summaries and pinned facts in scope priority order", () => {
    const { db } = createDb();
    db.prepare(
      `INSERT INTO conversation_summaries (id, session_id, agent_id, summary, covers_through, created_at)
       VALUES ('s1', 'thread:123', 'sierra', 'Trip planning recap.', NULL, '2026-06-09T00:00:00.000Z')`,
    ).run();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO pinned_facts (id, scope, scope_id, key, value, created_at, updated_at)
       VALUES ('p1', 'global', NULL, 'vehicle', 'F-350 diesel, 16-17 mpg', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO pinned_facts (id, scope, scope_id, key, value, created_at, updated_at)
       VALUES ('p2', 'agent', 'sierra', 'style', 'concise summaries', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO pinned_facts (id, scope, scope_id, key, value, created_at, updated_at)
       VALUES ('p3', 'agent', 'watson', 'other-agent', 'should not appear', ?, ?)`,
    ).run(now, now);

    const summary = getAtlasConversationSummary(db, { sessionId: "thread:123", agentId: "sierra" });
    expect(summary?.summary).toBe("Trip planning recap.");
    expect(getAtlasConversationSummary(db, { sessionId: "thread:999", agentId: "sierra" })).toBeNull();

    const facts = listAtlasPinnedFactsForContext(db, { sessionId: "thread:123", agentId: "sierra" });
    expect(facts.map((fact) => fact.key)).toEqual(["style", "vehicle"]);

    db.close();
  });

  it("touches memories by id, bumping access tracking", () => {
    const { db } = createDb();
    const id = insertMemory(db, { content: "touched fact", agentId: "sierra" });

    const touched = touchAtlasMemories(db, [id, id, "missing-id"]);
    expect(touched).toBe(1);
    const row = db.prepare(`SELECT access_count FROM memories WHERE id = ?`).get(id) as {
      access_count: number;
    };
    expect(row.access_count).toBe(1);

    db.close();
  });
});
