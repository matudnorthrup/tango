import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getAtlasMemorySchemaVersion,
  openAtlasMemoryDatabase,
  resolveAtlasMemoryDatabasePath,
} from "../src/schema.js";
import { createVoyageEmbeddingProviderFromEnv } from "../src/search.js";
import { createAtlasMemoryTools } from "../src/tools.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDb(): {
  dir: string;
  dbPath: string;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-memory-"));
  tempDirs.push(dir);
  return {
    dir,
    dbPath: path.join(dir, "memory.sqlite"),
  };
}

function createTestTools(options?: {
  dbPath?: string;
  now?: Date;
  useEnvProvider?: boolean;
}) {
  const dbInfo = openAtlasMemoryDatabase({
    dbPath: options?.dbPath,
  });
  const tools = createAtlasMemoryTools({
    db: dbInfo.db,
    ...(options?.useEnvProvider ? {} : { embeddingProvider: null }),
    ...(options?.now ? { now: () => options.now as Date } : {}),
  });

  return {
    ...dbInfo,
    tools,
  };
}

function getTool<TName extends string>(
  tools: ReturnType<typeof createAtlasMemoryTools>,
  name: TName,
) {
  const tool = tools.find((candidate) => candidate.name === name);
  expect(tool).toBeDefined();
  return tool!;
}

describe("atlas-memory schema", () => {
  it("creates the SQLite schema and tracks schema version once", () => {
    const { dbPath } = createTempDb();
    const first = openAtlasMemoryDatabase({ dbPath });
    const second = openAtlasMemoryDatabase({ dbPath });

    const tables = first.db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
      ORDER BY name ASC
    `).all() as Array<{ name: string }>;
    const versions = first.db.prepare(`
      SELECT version, applied_at
      FROM schema_version
      ORDER BY version ASC
    `).all() as Array<{ version: number; applied_at: string }>;

    expect(tables.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "conversation_summaries",
        "memories",
        "pinned_facts",
        "schema_version",
      ]),
    );
    expect(getAtlasMemorySchemaVersion(first.db)).toBe(1);
    expect(versions).toHaveLength(1);
    expect(versions[0]?.version).toBe(1);

    first.db.close();
    second.db.close();
  });

  it("resolves the default path inside ~/.tango/atlas", () => {
    const resolved = resolveAtlasMemoryDatabasePath(
      { ...process.env, ATLAS_MEMORY_DB: undefined },
      undefined,
    );
    expect(resolved).toContain(path.join(".tango", "atlas", "memory.db"));
  });
});

describe("atlas-memory tools", () => {
  it("registers all seven tools", () => {
    const { dbPath } = createTempDb();
    const { db, tools } = createTestTools({ dbPath });

    expect(tools.map((tool) => tool.name)).toEqual([
      "memory_search",
      "memory_add",
      "memory_reflect",
      "pinned_fact_get",
      "pinned_fact_set",
      "pinned_fact_delete",
      "memory_admin",
    ]);

    db.close();
  });

  it("stores memories and falls back to LIKE search when embeddings are unavailable", async () => {
    const { dbPath } = createTempDb();
    const { db, tools } = createTestTools({ dbPath });
    const memoryAdd = getTool(tools, "memory_add");
    const memorySearch = getTool(tools, "memory_search");

    const created = await memoryAdd.handler({
      content: "Weekly review should stay concise and action-focused.",
      source: "manual",
      agent_id: "atlas",
      importance: 0.8,
      tags: ["weekly-review", "preferences"],
    }) as { id: string };

    contextInsertConversationMemory(db, {
      id: "conv-1",
      content: "Conversation note about the printer enclosure.",
      agent_id: "atlas",
      metadata: { session_id: "session-123" },
    });

    const results = await memorySearch.handler({
      query: "weekly review cadence",
      agent_id: "atlas",
      tags: ["preferences"],
    }) as Array<{ id: string; content: string; accessCount: number }>;

    expect(results).toHaveLength(1);
    expect(results[0]?.id).toBe(created.id);
    expect(results[0]?.content).toContain("Weekly review");

    const touched = db.prepare(`
      SELECT access_count
      FROM memories
      WHERE id = ?
    `).get(created.id) as { access_count: number } | undefined;
    expect(touched?.access_count).toBe(1);

    db.close();
  });

  it("uses Voyage embeddings for semantic search when configured", async () => {
    const { dbPath } = createTempDb();
    vi.stubEnv("VOYAGE_API_KEY", "test-key");
    vi.stubEnv("VOYAGE_EMBED_MODEL", "voyage-4-lite");
    vi.stubEnv("VOYAGE_API_URL", "https://api.voyageai.test/v1/embeddings");
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        input?: string | string[];
      };
      const inputs = Array.isArray(body.input) ? body.input : [body.input ?? ""];
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({
          data: inputs.map((text) => ({
            embedding: embedForTest(text),
          })),
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = createVoyageEmbeddingProviderFromEnv();
    expect(provider).not.toBeNull();

    const { db } = openAtlasMemoryDatabase({ dbPath });
    const tools = createAtlasMemoryTools({
      db,
      embeddingProvider: provider,
    });
    const memoryAdd = getTool(tools, "memory_add");
    const memorySearch = getTool(tools, "memory_search");

    await memoryAdd.handler({
      content: "Weekly reviews belong on Monday and should stay concise.",
      source: "manual",
      agent_id: "atlas",
      tags: ["weekly-review"],
    });
    await memoryAdd.handler({
      content: "Printer enclosure needs a fresh heat soak test.",
      source: "manual",
      agent_id: "atlas",
      tags: ["printer"],
    });

    const results = await memorySearch.handler({
      query: "what did we decide about weekly reviews",
      agent_id: "atlas",
      limit: 2,
    }) as Array<{ content: string }>;

    expect(fetchMock).toHaveBeenCalled();
    expect(results[0]?.content).toContain("Weekly reviews");
    expect(results[1]?.content).toContain("Printer enclosure");

    db.close();
  });

  it("creates a reflection memory and conversation summary for a session", async () => {
    const { dbPath } = createTempDb();
    const { db, tools } = createTestTools({ dbPath });
    const memoryReflect = getTool(tools, "memory_reflect");

    contextInsertConversationMemory(db, {
      id: "m-1",
      content: "The user wants Atlas responses to stay concise.",
      agent_id: "atlas",
      metadata: { session_id: "session-42" },
    });
    contextInsertConversationMemory(db, {
      id: "m-2",
      content: "We agreed to keep the weekly review on Monday.",
      agent_id: "atlas",
      metadata: { session_id: "session-42" },
    });

    const result = await memoryReflect.handler({
      session_id: "session-42",
      agent_id: "atlas",
    }) as { memories_created: number; reflections: string[] };

    expect(result).toEqual({
      memories_created: 1,
      reflections: [expect.stringContaining("Session session-42 reflection")],
    });

    const summaryRow = db.prepare(`
      SELECT session_id, agent_id, summary
      FROM conversation_summaries
      WHERE session_id = ? AND agent_id = ?
    `).get("session-42", "atlas") as {
      session_id: string;
      agent_id: string;
      summary: string;
    } | undefined;
    expect(summaryRow?.summary).toContain("weekly review");

    db.close();
  });

  it("supports pinned fact CRUD across global, agent, and session scopes", async () => {
    const { dbPath } = createTempDb();
    const { db, tools } = createTestTools({ dbPath });
    const pinnedFactSet = getTool(tools, "pinned_fact_set");
    const pinnedFactGet = getTool(tools, "pinned_fact_get");
    const pinnedFactDelete = getTool(tools, "pinned_fact_delete");

    const globalFact = await pinnedFactSet.handler({
      scope: "global",
      key: "product_name",
      value: "Atlas",
    }) as { id: string };
    const agentFact = await pinnedFactSet.handler({
      scope: "agent",
      scope_id: "atlas",
      key: "tone",
      value: "concise",
    }) as { id: string };
    const sessionFact = await pinnedFactSet.handler({
      scope: "session",
      scope_id: "session-99",
      key: "current_goal",
      value: "finish MCP server",
    }) as { id: string };

    expect(globalFact.id).toBeTruthy();
    expect(agentFact.id).toBeTruthy();
    expect(sessionFact.id).toBeTruthy();

    const globalFacts = await pinnedFactGet.handler({
      scope: "global",
    }) as Array<{ key: string; value: string }>;
    const agentFacts = await pinnedFactGet.handler({
      scope: "agent",
      scope_id: "atlas",
    }) as Array<{ key: string; value: string }>;
    const sessionFacts = await pinnedFactGet.handler({
      scope: "session",
      scope_id: "session-99",
    }) as Array<{ key: string; value: string }>;

    expect(globalFacts).toEqual([{ key: "product_name", value: "Atlas", id: expect.any(String), scope: "global", scopeId: null, createdAt: expect.any(String), updatedAt: expect.any(String) }]);
    expect(agentFacts[0]).toMatchObject({ key: "tone", value: "concise" });
    expect(sessionFacts[0]).toMatchObject({ key: "current_goal", value: "finish MCP server" });

    const deleted = await pinnedFactDelete.handler({
      scope: "agent",
      scope_id: "atlas",
      key: "tone",
    }) as { deleted: boolean };

    expect(deleted.deleted).toBe(true);
    const remaining = await pinnedFactGet.handler({
      scope: "agent",
      scope_id: "atlas",
    }) as Array<unknown>;
    expect(remaining).toHaveLength(0);

    db.close();
  });

  it("performs memory_admin archive, unarchive, tag, export, and stats operations", async () => {
    const { dbPath } = createTempDb();
    const { db, tools } = createTestTools({ dbPath });
    const memoryAdd = getTool(tools, "memory_add");
    const memoryAdmin = getTool(tools, "memory_admin");

    const first = await memoryAdd.handler({
      content: "Atlas should keep release notes short.",
      source: "manual",
      agent_id: "atlas",
      tags: ["release-notes"],
    }) as { id: string };
    await memoryAdd.handler({
      content: "Observed a printer calibration drift this morning.",
      source: "observation",
      agent_id: "atlas",
      tags: ["printer"],
    });

    const tagged = await memoryAdmin.handler({
      operation: "tag",
      filter: {
        ids: [first.id],
        add_tags: ["shipping"],
      },
    }) as { updated: number };
    expect(tagged.updated).toBe(1);

    const archived = await memoryAdmin.handler({
      operation: "archive",
      filter: {
        source: "manual",
      },
    }) as { updated: number };
    expect(archived.updated).toBe(1);

    const stats = await memoryAdmin.handler({
      operation: "stats",
      filter: {
        include_archived: true,
      },
    }) as {
      total: number;
      by_source: Record<string, number>;
      by_archived_status: Record<string, number>;
    };
    expect(stats.total).toBe(2);
    expect(stats.by_source.manual).toBe(1);
    expect(stats.by_archived_status.archived).toBe(1);

    const exported = await memoryAdmin.handler({
      operation: "export",
      filter: {
        include_archived: true,
        tags: ["shipping"],
      },
    }) as { memories: Array<{ tags: string[]; archivedAt: string | null }> };
    expect(exported.memories).toHaveLength(1);
    expect(exported.memories[0]?.tags).toEqual(expect.arrayContaining(["release-notes", "shipping"]));
    expect(exported.memories[0]?.archivedAt).toEqual(expect.any(String));

    const unarchived = await memoryAdmin.handler({
      operation: "unarchive",
      filter: {
        source: "manual",
        include_archived: true,
      },
    }) as { updated: number };
    expect(unarchived.updated).toBe(1);

    const after = db.prepare(`
      SELECT archived_at, tags
      FROM memories
      WHERE id = ?
    `).get(first.id) as { archived_at: string | null; tags: string } | undefined;
    expect(after?.archived_at).toBeNull();
    expect(JSON.parse(after?.tags ?? "[]")).toEqual(
      expect.arrayContaining(["release-notes", "shipping"]),
    );

    db.close();
  });
});

function contextInsertConversationMemory(
  db: ReturnType<typeof openAtlasMemoryDatabase>["db"],
  input: {
    id: string;
    content: string;
    agent_id?: string;
    metadata?: Record<string, unknown>;
  },
) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO memories (
      id,
      content,
      source,
      agent_id,
      importance,
      tags,
      embedding,
      embedding_model,
      created_at,
      last_accessed_at,
      access_count,
      archived_at,
      metadata
    ) VALUES (?, ?, 'conversation', ?, 0.5, '[]', NULL, NULL, ?, ?, 0, NULL, ?)
  `).run(
    input.id,
    input.content,
    input.agent_id ?? null,
    now,
    now,
    JSON.stringify(input.metadata ?? {}),
  );
}

function embedForTest(text: string): number[] {
  const normalized = text.toLowerCase();
  if (normalized.includes("weekly")) {
    return [1, 0, 0];
  }
  if (normalized.includes("printer")) {
    return [0, 1, 0];
  }
  return [0, 0, 1];
}
