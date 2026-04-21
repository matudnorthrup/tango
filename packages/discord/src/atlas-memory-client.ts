import {
  createAtlasMemoryTools,
  openAtlasMemoryDatabase,
  type AtlasMemoryToolDefinition,
  type MemoryRecord,
  type PinnedFactRecord,
  type PinnedFactScope,
  type MemorySource,
  type SqliteDatabase,
} from "@tango/atlas-memory";

type AtlasMemoryToolHandler = AtlasMemoryToolDefinition["handler"];

export class AtlasMemoryClient {
  private readonly db: SqliteDatabase;
  private readonly tools: Map<string, AtlasMemoryToolHandler>;

  constructor(dbPath?: string) {
    const { db } = openAtlasMemoryDatabase({
      ...(dbPath ? { dbPath } : {}),
    });

    this.db = db;
    this.tools = new Map(
      createAtlasMemoryTools({ db }).map((tool) => [tool.name, tool.handler]),
    );
  }

  async memoryAdd(params: {
    content: string;
    source: MemorySource;
    agent_id?: string;
    session_id?: string;
    importance?: number;
    tags?: string[];
    metadata?: Record<string, unknown>;
  }): Promise<{ id: string }> {
    return await this.callTool<{ id: string }>("memory_add", params);
  }

  async memorySearch(params: {
    query: string;
    agent_id?: string;
    tags?: string[];
    limit?: number;
  }): Promise<MemoryRecord[]> {
    return await this.callTool<MemoryRecord[]>("memory_search", params);
  }

  async pinnedFactGet(params: {
    scope: PinnedFactScope;
    scope_id?: string;
  }): Promise<PinnedFactRecord[]> {
    return await this.callTool<PinnedFactRecord[]>("pinned_fact_get", params);
  }

  async memoryReflect(params: {
    session_id: string;
    agent_id: string;
  }): Promise<{ memories_created: number; reflections: string[] }> {
    return await this.callTool<{
      memories_created: number;
      reflections: string[];
    }>("memory_reflect", params);
  }

  close(): void {
    this.db.close();
  }

  private async callTool<TResult>(
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<TResult> {
    const handler = this.tools.get(toolName);
    if (!handler) {
      throw new Error(`Atlas memory tool '${toolName}' is not registered`);
    }

    return await handler(params) as TResult;
  }
}
