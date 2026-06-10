import { decodeEmbedding } from "./search.js";
import type { PinnedFactScope, SqliteDatabase } from "./types.js";

/**
 * Read surface for warm-start context assembly (store consolidation: Atlas is
 * the single substrate for distilled memory; core keeps operational state).
 * These are plain row readers — ranking/zoning stays in @tango/core.
 */
export interface AtlasContextMemoryRow {
  id: string;
  content: string;
  source: string;
  agentId: string | null;
  importance: number;
  /** Decoded embedding vector (Float64 BLOB → number[]). */
  embedding: number[] | null;
  embeddingModel: string | null;
  createdAt: string;
  lastAccessedAt: string;
  accessCount: number;
  metadata: Record<string, unknown> | null;
}

export interface AtlasContextSummaryRow {
  id: string;
  sessionId: string;
  agentId: string;
  summary: string;
  coversThrough: string | null;
  createdAt: string;
}

export interface AtlasContextPinnedFactRow {
  id: string;
  scope: PinnedFactScope;
  scopeId: string | null;
  key: string;
  value: string;
  createdAt: string;
  updatedAt: string;
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Unarchived memories visible to an agent (its own + global), newest first. */
export function listAtlasMemoriesForContext(
  db: SqliteDatabase,
  input: { agentId?: string | null; limit?: number },
): AtlasContextMemoryRow[] {
  const limit = Math.max(1, Math.trunc(input.limit ?? 5000));
  const agentId = input.agentId?.trim() || null;
  const rows = (
    agentId
      ? db
          .prepare(
            `
              SELECT id, content, source, agent_id, importance, embedding,
                     embedding_model, created_at, last_accessed_at, access_count, metadata
              FROM memories
              WHERE archived_at IS NULL AND (agent_id IS NULL OR agent_id = ?)
              ORDER BY created_at DESC
              LIMIT ?
            `,
          )
          .all(agentId, limit)
      : db
          .prepare(
            `
              SELECT id, content, source, agent_id, importance, embedding,
                     embedding_model, created_at, last_accessed_at, access_count, metadata
              FROM memories
              WHERE archived_at IS NULL
              ORDER BY created_at DESC
              LIMIT ?
            `,
          )
          .all(limit)
  ) as Array<{
    id: string;
    content: string;
    source: string;
    agent_id: string | null;
    importance: number;
    embedding: Buffer | null;
    embedding_model: string | null;
    created_at: string;
    last_accessed_at: string;
    access_count: number;
    metadata: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    content: row.content,
    source: row.source,
    agentId: row.agent_id,
    importance: Number.isFinite(row.importance) ? Math.min(Math.max(row.importance, 0), 1) : 0.5,
    embedding: decodeEmbedding(row.embedding),
    embeddingModel: row.embedding_model,
    createdAt: row.created_at,
    lastAccessedAt: row.last_accessed_at,
    accessCount: Number(row.access_count) || 0,
    metadata: parseJsonObject(row.metadata),
  }));
}

/** The conversation summary for a (conversationKey, agent) pair, if any. */
export function getAtlasConversationSummary(
  db: SqliteDatabase,
  input: { sessionId: string; agentId: string },
): AtlasContextSummaryRow | null {
  const row = db
    .prepare(
      `
        SELECT id, session_id, agent_id, summary, covers_through, created_at
        FROM conversation_summaries
        WHERE session_id = ? AND agent_id = ?
      `,
    )
    .get(input.sessionId, input.agentId) as
    | {
        id: string;
        session_id: string;
        agent_id: string;
        summary: string;
        covers_through: string | null;
        created_at: string;
      }
    | undefined;

  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    agentId: row.agent_id,
    summary: row.summary,
    coversThrough: row.covers_through,
    createdAt: row.created_at,
  };
}

/** Pinned facts in context priority order: session → agent → global. */
export function listAtlasPinnedFactsForContext(
  db: SqliteDatabase,
  input: { sessionId?: string | null; agentId?: string | null },
): AtlasContextPinnedFactRow[] {
  const sessionId = input.sessionId?.trim() || null;
  const agentId = input.agentId?.trim() || null;
  const rows = db
    .prepare(
      `
        SELECT id, scope, scope_id, key, value, created_at, updated_at
        FROM pinned_facts
        WHERE (scope = 'global' AND scope_id IS NULL)
           OR (scope = 'agent' AND scope_id = ?)
           OR (scope = 'session' AND scope_id = ?)
        ORDER BY CASE scope WHEN 'session' THEN 0 WHEN 'agent' THEN 1 ELSE 2 END, key ASC
      `,
    )
    .all(agentId, sessionId) as Array<{
    id: string;
    scope: PinnedFactScope;
    scope_id: string | null;
    key: string;
    value: string;
    created_at: string;
    updated_at: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    scope: row.scope,
    scopeId: row.scope_id,
    key: row.key,
    value: row.value,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

/** Bump access tracking for memories that reached the prompt. */
export function touchAtlasMemories(
  db: SqliteDatabase,
  ids: string[],
  touchedAt: Date = new Date(),
): number {
  const uniqueIds = [...new Set(ids.filter((id) => id.trim().length > 0))];
  if (uniqueIds.length === 0) return 0;

  const statement = db.prepare(`
    UPDATE memories
    SET last_accessed_at = ?, access_count = access_count + 1
    WHERE id = ?
  `);
  const timestamp = touchedAt.toISOString();
  const transaction = db.transaction((memoryIds: string[]) => {
    let touched = 0;
    for (const id of memoryIds) {
      touched += Number(statement.run(timestamp, id).changes ?? 0);
    }
    return touched;
  });
  return transaction(uniqueIds);
}
