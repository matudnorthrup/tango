# Tango Architecture Rebuild

**Status:** Discovery complete — awaiting stakeholder review
**Linear Project:** [Tango Architecture Rebuild](https://linear.app/seaside-hq/project/tango-architecture-rebuild-8b6d65e9227d) (`afa8073d-dc7e-43e2-90a5-fc44a0c89ba9`)
**Date:** 2026-04-21

---

## 1. Problem Statement

Tango's layered orchestration (turn executor, worker dispatch, intent classifier, narration guards, concise mode, memory compaction) has become a source of recurring failures. Over the past week, ~20 bug fixes shipped across these layers without resolving the underlying quality issue: the system is hostile to analytical/nuanced questions and increasingly unreliable for transactional ones.

The root cause is architectural: each layer was built to solve one problem (concise mode for brevity, workers for tool scoping, narration guards for dispatch leakage, compaction for context limits) but their interaction creates emergent failure modes that are expensive to debug and brittle to fix. The `deep-thinking-bypass.md` spec documented five compounding quality-killing layers — this rebuild addresses the root cause instead of working around it.

**Decision:** Replace the agent runtime/orchestration layer with a thin router over Claude Code using MCP tools. Keep the components that work well. Externalize memory as an MCP server in the Atlas family (`atlas:memory`). Codex fallback is deferred to a later phase; in the interim, MCP migration enables a manual Codex workaround during provider outages.

### Key architectural principles

1. **Sessions are ephemeral; storage is authoritative.** Tango's `messages` table remains the source of truth for conversation history. Claude Code sessions hold recent turns in their context window but are reconstructable from storage + Memory at any time.
2. **One runtime per active conversation, not per agent.** Each Discord channel/thread has its own persistent Claude Code session (with the agent's config). This naturally handles scheduled job context continuation and isolates conversations.
3. **Atlas is the structured-data family.** Memory (new) is a sibling to Nutrition (existing Atlas). Each Atlas domain is its own MCP server with its own SQLite file, branded under one umbrella.
4. **Controlled session resets over runtime auto-compaction.** We decide when sessions reset (idle timeout, context threshold, manual) and rebuild context from storage + Atlas:memory — rather than letting the runtime silently compact.
5. **Modular system prompts assembled at runtime.** Source files stay separated (soul.md, shared rules, knowledge.md); assembly into a single prompt happens at runtime spawn.

---

## 2. Component Inventory

### 2.1 Keep Untouched

| Component | Location | Why Keep |
|-----------|----------|----------|
| **Discord bot ingestion** | `packages/discord/src/main.ts` (message handling, channel routing) | Stable, well-tested, handles all Discord API complexity |
| **Voice pipeline** | `packages/voice/` — Whisper ASR, VAD, Kokoro TTS, wake word detection | Working well, no complaints, hardware-coupled |
| **Voice-level route classifier** | `packages/voice/` — determines which agent handles a voice turn based on callsigns, channel defaults | Lightweight, accurate, stays in the voice layer |
| **Health database** | PostgreSQL — `workouts`, `workout_sets`, `exercises`, `workout_routines`, `workout_routine_exercises` | External DB, well-structured, accessed via MCP tools already |
| **Atlas system** | Atlas SQL MCP tool — ingredient catalog, nutrition reference data | Standalone data service, already MCP-accessible |
| **Existing MCP servers** | See inventory below | Already the target architecture pattern |
| **Scheduler engine** | `packages/core/src/scheduler/` — cron runner, store, executor | Solid engine; only the execution bridge changes |
| **Governance system** | `packages/core/src/governance.ts`, `governance-schema.ts` | Permission checks, audit logging — keep for tool governance |
| **Access control** | `packages/discord/src/access-control.ts` — per-agent channel restrictions | Simple, correct, no reason to change |
| **Provider failover** | `packages/discord/src/provider-failover.ts` | Useful for multi-provider resilience |

### 2.2 Replace

| Component | Location | Why Replace |
|-----------|----------|-------------|
| **Turn executor** | `packages/discord/src/turn-executor.ts` (~1400 lines) | Central orchestration monolith; tightly couples dispatch, guards, synthesis, retries. Every fix here causes regressions. |
| **Worker dispatch** | Worker dispatch tags (`<worker-dispatch>`), `worker-report.ts`, `dispatch-extractor.ts`, `mcp-dispatch-server.ts` | Strips context via task summarization; workers can't see the user's actual words. Replaced by giving the runtime direct tool access. |
| **Worker agents** | `packages/core/src/worker-agent.ts`, all worker configs in `config/defaults/workers/*.yaml` | Intermediary layer between user intent and tool execution. The new runtime (Claude Code/Codex) has native tool use. |
| **Intent classifier** (agent-level) | `packages/discord/src/intent-classifier.ts`, `deterministic-router.ts` | Complex classification pipeline with continuation patterns, nutrition-specific heuristics, etc. The new runtime handles intent natively — no separate classification step. |
| **Narration guards** | `looksLikeNarratedDispatch()`, `looksLikeIncompleteWorkerSynthesis()`, `looksLikeContextConfusion()` in turn-executor | Exist only because the dispatch-synthesis loop leaks internal narration. No dispatch loop = no narration to guard. |
| **Memory compaction** | `packages/core/src/memory-compaction.ts` | Aggressive truncation (180 chars/turn, 1800 char summary) destroys analytical context. Replaced by Atlas:memory with proper search/retrieval. |
| **Concise response mode** | `composeSystemPrompt()` response mode injection | Blanket brevity instruction. New runtime uses per-agent system prompts without artificial length constraints. |
| **Deterministic routing fast path** | `deterministic-runtime.ts`, `deterministic-router.ts`, `deterministic-worker-fast-path.ts`, `wellness-direct-step-executor.ts` | Complex optimization layer for transactional turns. Claude Code/Codex handle tool calls natively; no need for a separate fast path. |
| **Prompt assembly** | `packages/core/src/prompt-assembly.ts` | Convention-based prompt assembly (soul.md + shared + knowledge + workers.md + tools + skills). Replaced by per-agent system prompts + MCP server allowlists. |
| **Warm-start context** | `buildWarmStartContextPrompt()` in turn executor dependencies | Context reconstruction from stored messages. Replaced by Claude Code session persistence + Atlas:memory. |

### 2.3 Build New

| Component | Description |
|-----------|-------------|
| **Atlas:memory MCP server** | Externalized memory with semantic search, pinned facts, tag taxonomy, retention policy |
| **Runtime abstraction** (`AgentRuntime`) | Interface for spawning/communicating with Claude Code or Codex processes |
| **Claude Code adapter** | Spawns Claude Code with agent-specific config, routes messages, streams responses |
| **Codex adapter** | Fallback runtime using Codex CLI |
| **Tango Router** | Thin layer: Discord message → agent selection → runtime dispatch → Discord response |
| **Scheduled job bridge** | Connects existing scheduler engine to new runtime for job execution |
| **Agent config v2** | Simplified agent profiles: system prompt + MCP allowlist + runtime preferences |

### 2.4 Defer

| Component | Reason |
|-----------|--------|
| Agent-as-a-service external endpoints | Solo user for now; noted as future work |
| Cross-user auth | Single user system |
| Advanced governance beyond per-agent MCP allowlists | Current governance works; extend later if needed |
| Mobile app integration | Existing Discord mobile is sufficient |

---

## 3. Current MCP Server Inventory

These already exist and demonstrate the target pattern:

| MCP Server | Location | Tools Exposed |
|------------|----------|---------------|
| **mcp-wellness-server** | `packages/discord/src/mcp-wellness-server.ts` | `health_query`, `workout_sql`, `nutrition_log_items`, `health_morning` |
| **mcp-dispatch-server** | `packages/discord/src/mcp-dispatch-server.ts` | `dispatch_worker` (will be retired) |
| **mcp-sub-agent-server** | `packages/discord/src/mcp-sub-agent-server.ts` | Sub-agent spawn/management |
| **mcp-proxy** | `packages/core/src/mcp-proxy.ts` | Proxies external MCP servers (Obsidian, etc.) |

**External MCP servers** referenced in tool contracts (accessed via mcp-proxy or directly):
- Lunch Money (finance API)
- FatSecret (nutrition API)
- Google (Gmail, Calendar, Docs)
- Atlas (ingredient catalog, SQL)
- Obsidian (vault read/write)
- 1Password (secrets)
- Linear (project management)
- Slack (messaging)
- iMessage (messaging)
- Browser (Playwright)
- YouTube (transcripts)
- Walmart (orders)
- Exa (web search)
- Receipt Registry (receipt tracking)
- Ramp Reimbursement (expense management)
- Latitude (remote execution)

### Tools NOT Yet MCP — Need Migration

| Tool | Current Implementation | Migration Path |
|------|----------------------|----------------|
| `memory_search`, `memory_add`, `memory_reflect` | `packages/discord/src/memory-agent-tools.ts` | → Atlas:memory MCP server (new) |
| `WebSearch`, `WebFetch` | Provider-level tools | → MCP server or keep as provider tools |
| `discord-manage` | `packages/discord/src/discord-manage-tools.ts` | → Discord management MCP server |
| `tango-dev` | `packages/discord/src/tango-dev-tools.ts` | → Dev tools MCP server (Victor only) |
| `agent_docs` | Tool contract doc | → Agent docs MCP server or filesystem |
| `printing` | Tool contract doc | → Printer MCP server |

---

## 4. Atlas Family & Atlas:memory Design

### 4.0 The Atlas Family

Atlas is the umbrella name for Tango's structured/tabular data services. Each Atlas domain is its own MCP server with its own SQLite file under `~/.tango/atlas/`. This is a naming and organizational decision, not a shared-database decision — each domain has isolated storage for backup/corruption resilience.

| Service | Status | Scope | Storage |
|---------|--------|-------|---------|
| **atlas:memory** | New (this project) | Memories, pinned facts, conversation summaries | `~/.tango/atlas/memory.db` |
| **atlas:nutrition** | Exists (currently referred to as "Atlas") | Ingredients, FatSecret cache, nutrition reference | Existing location, migrate to `~/.tango/atlas/nutrition.db` |
| **atlas:health** | Existing tables under Tango's main DB | Workouts, workout_sets, exercises, routines | Future: extract to `~/.tango/atlas/health.db` |
| **atlas:finance** | Future | Lunch Money aggregate queries, budget state, sinking funds | TBD |

For this rebuild, the only new Atlas service is **atlas:memory**. Others remain in their current form — rebranding to Atlas naming happens at the MCP server registration level.

### 4.1 Current Memory State

**Tables being replaced:**
- `memories` — 10 columns, text content + embeddings, importance scoring, access tracking
- `pinned_facts` — scoped key-value pairs (global/agent/session)
- `session_summaries` — per-session compacted summaries
- `session_compactions` — compaction state tracking
- `obsidian_index` — Obsidian vault index for search

**Current operations:**
- `memory_search(query, agent_id?)` — text/embedding search across memories
- `memory_add(content, source, importance)` — store a new memory
- `memory_reflect(session_id)` — generate reflection memories from recent conversation
- Pinned facts: CRUD on scoped key-value pairs

### 4.2 Schema (v1)

```sql
-- Core memory entries
CREATE TABLE memories (
  id TEXT PRIMARY KEY,          -- UUID
  content TEXT NOT NULL,
  source TEXT NOT NULL,         -- 'conversation' | 'reflection' | 'manual' | 'observation' | 'import'
  agent_id TEXT,                -- which agent created this (null = system)
  importance REAL DEFAULT 0.5,  -- 0.0-1.0, affects retrieval ranking
  tags TEXT,                    -- JSON array of tag strings
  embedding BLOB,              -- binary embedding vector
  embedding_model TEXT,
  created_at TEXT NOT NULL,
  last_accessed_at TEXT NOT NULL,
  access_count INTEGER DEFAULT 0,
  archived_at TEXT,             -- soft delete
  metadata TEXT                 -- JSON, extensible
);

-- Pinned facts (high-priority, always-available context)
CREATE TABLE pinned_facts (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,           -- 'global' | 'agent' | 'session'
  scope_id TEXT,                 -- agent_id or session_id
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(scope, scope_id, key)
);

-- Conversation summaries (replaces session_compactions)
CREATE TABLE conversation_summaries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  covers_through TEXT,           -- ISO timestamp of last message covered
  created_at TEXT NOT NULL,
  UNIQUE(session_id, agent_id)
);

-- Schema version tracking
CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
```

### 4.3 MCP Tool Surface

```yaml
tools:
  memory_search:
    description: "Search memories by semantic similarity and/or tags"
    params:
      query: string          # natural language search query
      agent_id?: string      # filter to specific agent's memories
      tags?: string[]        # filter by tags
      limit?: number         # max results (default 10)
      include_archived?: bool # include soft-deleted (default false)
    returns: Memory[]

  memory_add:
    description: "Store a new memory"
    params:
      content: string
      source: string         # conversation | reflection | manual | observation
      agent_id?: string
      importance?: number    # 0.0-1.0
      tags?: string[]
    returns: { id: string }

  memory_reflect:
    description: "Generate reflection memories from recent conversation context"
    params:
      session_id: string
      agent_id: string
    returns: { memories_created: number, reflections: string[] }

  pinned_fact_get:
    description: "Get pinned facts by scope"
    params:
      scope: string          # global | agent | session
      scope_id?: string
    returns: PinnedFact[]

  pinned_fact_set:
    description: "Set or update a pinned fact"
    params:
      scope: string
      scope_id?: string
      key: string
      value: string
    returns: { id: string }

  pinned_fact_delete:
    description: "Remove a pinned fact"
    params:
      scope: string
      scope_id?: string
      key: string
    returns: { deleted: boolean }

  memory_admin:
    description: "Admin operations: archive, bulk tag, export"
    params:
      operation: string      # archive | unarchive | tag | export | stats
      filter?: object
    returns: object
```

### 4.4 Semantic Search Approach

**Keep current approach** (embedding-based) with improvements:
- Use embeddings model (same as current `embedding_model` in memories table)
- Store embeddings as binary blobs in SQLite
- Compute cosine similarity in application code (SQLite doesn't have vector extensions, but the current approach works at Tango's scale of ~thousands of memories)
- Add tag-based filtering as a pre-filter before semantic ranking

**Future option:** Switch to a vector-enabled SQLite extension (sqlite-vec) or Postgres pgvector when scale requires it. The MCP interface stays the same.

### 4.5 Migration Plan

1. Build Atlas:memory MCP server with both old and new schemas
2. Migration script reads from old `memories`, `pinned_facts`, `session_summaries` tables
3. Writes to new schema with consistent UUIDs
4. Validates row counts and spot-checks content
5. Old tables remain read-only as backup until Phase 4 retirement

### 4.6 Admin Surface

- **CLI tool:** `atlas memory ...` command for inspecting/editing memories outside chat
- **Discord command:** `/memory search <query>`, `/memory stats`, `/memory export`
- **SQLite file** is user-accessible at `~/.tango/atlas/memory.db` — user can query directly with any SQLite client
- **Obsidian vault integration** continues: obsidian indexer writes to Atlas:memory, memories can reference Obsidian notes

### 4.7 Memory Capture Sources

Memory writes come from four orthogonal sources, each with its own trigger and purpose:

| Source | When | Who triggers | Example |
|--------|------|--------------|---------|
| **Agent-triggered** | Mid-conversation, agent decides something is worth remembering | Agent calls `memory_add` as an MCP tool | "You're working on building a mental health agent named Juliet" |
| **Post-turn extraction** | After each turn, small background pass extracts salient facts | Background job (optional, per-agent config) | Extract decisions, commitments, new facts from the exchange |
| **Scheduled reflection** | Cron-driven, synthesizes themes across recent conversations | Existing `memory-reflections` schedule | Weekly pattern synthesis |
| **User-triggered** | Explicit user request to remember or pin | Slash command `/pin`, `/remember`, or natural language "remember this" | User declares something important |

**Configuration per agent** (v2 agent config):
```yaml
memory:
  post_turn_extraction: enabled  # enabled | disabled
  extraction_model: claude-haiku-4-5  # lightweight model for extraction
  importance_threshold: 0.4      # memories below this aren't stored
  scheduled_reflection: enabled
```

**Why all four:** Different memories have different shapes. Agent-triggered captures analytical insights. Post-turn catches facts the agent forgot to store. Scheduled reflection surfaces patterns. User-triggered enforces user intent. Together they approximate "the agent remembers what a human collaborator would remember."

---

## 5. Runtime Abstraction

### 5.1 `AgentRuntime` Interface

```typescript
interface AgentRuntime {
  /** Unique runtime instance ID */
  readonly id: string;

  /** Runtime type identifier */
  readonly type: 'claude-code' | 'codex';

  /** Whether this runtime is currently active */
  readonly active: boolean;

  /**
   * Send a user message and get a response.
   * Handles streaming internally; returns the complete response.
   */
  send(message: string, options?: SendOptions): Promise<RuntimeResponse>;

  /**
   * Initialize the runtime with agent configuration.
   * Called once when the runtime is spawned.
   */
  initialize(config: AgentRuntimeConfig): Promise<void>;

  /**
   * Gracefully shut down the runtime process.
   */
  teardown(): Promise<void>;

  /**
   * Check if the runtime process is still alive.
   */
  healthCheck(): Promise<boolean>;
}

interface AgentRuntimeConfig {
  agentId: string;
  systemPrompt: string;
  mcpServers: McpServerConfig[];
  runtimePreferences: {
    model?: string;
    reasoningEffort?: 'low' | 'medium' | 'high' | 'max';
    maxTokens?: number;
    timeout?: number;
  };
  coldStartContext?: string;  // injected on first message
}

interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface SendOptions {
  /** Additional context to prepend (e.g., recent conversation) */
  context?: string;
  /** Timeout override for this specific message */
  timeout?: number;
  /** Stream callback for real-time output */
  onChunk?: (chunk: string) => void;
}

interface RuntimeResponse {
  text: string;
  durationMs: number;
  model?: string;
  toolsUsed?: string[];
  metadata?: Record<string, unknown>;
}
```

### 5.2 Claude Code Adapter

**Implementation approach:** Spawn Claude Code as a subprocess with `--print` mode or use the SDK.

```
Claude Code process lifecycle:
1. spawn: claude --model <model> --system-prompt <file> --mcp-server <config>...
2. send: pipe user message to stdin, read response from stdout
3. session: maintained via Claude Code's built-in session management
4. teardown: send SIGTERM, wait for graceful shutdown
```

**Key design decisions:**
- **Persistent mode for interactive/voice:** One Claude Code process per agent, kept alive across turns. Cold-start is expensive (~2-5s); keeping the process warm eliminates this for conversational flow.
- **Fresh mode for scheduled jobs:** New process per job execution. Jobs are isolated by nature; stale context from prior jobs would be harmful.
- **MCP server configuration:** Pass MCP servers via `--mcp-config <file>` — a JSON file listing the servers this agent can access.

**Session persistence:**
- Claude Code manages its own conversation context
- We inject cold-start context (pinned facts, recent conversation summary from Atlas:memory) on the first message of a new session
- No more warm-start prompt reconstruction — the runtime remembers

### 5.3 Codex Adapter

**Fallback path** — used when Claude Code is unavailable or rate-limited.

```
Codex process lifecycle:
1. spawn: codex --model <model> --instructions <file>
2. send: pipe message, read response
3. teardown: terminate process
```

**Differences from Claude Code:**
- Codex doesn't have native MCP support — tools would need to be exposed as function definitions or shell commands
- No built-in session persistence — context must be reconstructed each turn
- Different prompt format/conventions

**Recommendation:** Use Codex as degraded-mode fallback only. Primary development targets Claude Code. The `AgentRuntime` interface ensures we can swap without changing the router.

### 5.4 Provider Failover

```
User message arrives
       │
  ┌────▼────┐
  │  Router  │
  └────┬─────┘
       │
  Try Claude Code adapter
       │
  ┌────▼──────────┐
  │ Success?       │──yes──→ Return response
  │                │
  └────┬──────────┘
       │ no (timeout, error, rate limit)
       │
  Try Codex adapter
       │
  ��────▼──────────┐
  │ Success?       │──yes──→ Return response (degraded mode)
  │                │
  └────┬──────────┘
       │ no
       │
  Return error to user
```

**When to fail over:**
- Connection timeout (>30s for first response token)
- Process crash/exit
- Rate limit error from provider
- NOT on: slow responses, unexpected output format

### 5.5 Runtime Scope: Per-Conversation, Not Per-Agent

**Core model change from the original spec:** runtimes are scoped to **active conversations** (channels/threads), not to agents.

- Lunch Money thread → its own runtime, loaded with Watson's agent config
- Malibu's main channel → its own runtime, loaded with Malibu's config
- A new DM thread with Sierra → its own runtime, loaded with Sierra's config
- Two different threads both "owned" by Watson → two independent runtimes

**Why per-conversation:**

1. **Natural context isolation.** Conversations don't bleed into each other. A discussion in the finance thread doesn't contaminate the morning briefing thread.
2. **Scheduled job bridging becomes trivial.** A Watson scheduled job posts to the Lunch Money thread — that thread already has its own runtime, so follow-up messages continue naturally.
3. **Independent lifecycles.** Each conversation can be active, idle, closed, or reset independently.
4. **Better resource management** (see 5.7 below).

The agent configuration (system prompt, MCP allowlist, runtime preferences) is the same for all conversations owned by an agent. Each conversation just gets its own process instance of it.

### 5.6 Session Mode Design

| Mode | When | Behavior |
|------|------|----------|
| **Persistent** | Interactive Discord conversations, voice turns | One runtime per conversation, kept alive with idle-based lifecycle. |
| **Fresh** | Scheduled jobs delivering to new threads | New runtime per execution. Full context reconstruction from Atlas:memory. |
| **Pooled** (future) | High-throughput scenarios | Pool of pre-warmed runtimes. Not needed for solo user. |

**Recommended default:** Persistent for interactive conversations, Fresh for scheduled jobs that create new threads (the job runs, writes output to the new thread, exits — that thread then spawns its own persistent runtime on the next user message).

**Config per agent:**
```yaml
# config/v2/agents/malibu.yaml
runtime:
  mode: persistent   # default for conversations
  provider: claude-code
  model: claude-sonnet-4-6
  reasoning_effort: medium
  # Lifecycle defaults (can override per-conversation)
  idle_timeout_hours: 24
  context_reset_threshold: 0.80  # fraction of context window used
```

### 5.7 Session Lifecycle: Idle Closure, Resume, and Reset

Each conversation's runtime goes through these states:

```
   SPAWNING ──► ACTIVE ──► IDLE ──► CLOSED
                  ▲           │         │
                  │           │         │
                  └───────────┴─────────┘
                      (resume on next message)

  CONTEXT_FULL ──► RESET (hard reset: cold-start reconstruction)
```

**Transitions:**

| Event | From → To | Action |
|-------|-----------|--------|
| First message in conversation | — → SPAWNING | Spawn Claude Code with agent config + cold-start context |
| Conversation has been running | SPAWNING → ACTIVE | Ready to receive messages |
| No messages for N minutes | ACTIVE → IDLE | Mark idle; runtime still alive |
| Idle > `idle_timeout_hours` (default 24h) | IDLE → CLOSED | Send SIGTERM, store session ID for resume |
| New message arrives while CLOSED | CLOSED → SPAWNING | `claude --resume <session-id>` to restore |
| Context usage > `context_reset_threshold` (default 80%) | ACTIVE → RESET | Hard reset: close session, spawn fresh with cold-start from storage + Atlas:memory |
| User `/reset` command | any → RESET | Same as context threshold |

**Why this model:**

- **Resource efficiency.** Only actively-used conversations hold hot processes. Idle ones close. On a machine where you might have 10-20 threads but 2-3 active at a time, this is the difference between ~8GB and ~1GB RAM.
- **Controlled compaction.** WE decide when a reset happens — not Claude Code's auto-compaction. On reset, we inject cold-start context from authoritative storage + Atlas:memory. Nothing important gets silently summarized away.
- **Resume preserves conversational flow.** For normal idle closures, `--resume` brings the session back with its context intact. User feels continuity.
- **Hard reset is a deliberate circuit breaker.** When the model's own context would start degrading (80% threshold), we reset rather than accept degraded quality.

**Caveats to validate in Phase 0:**
- How long does Claude Code retain `--resume`-able session state? May be bounded; if so, IDLE → CLOSED may need to be shorter.
- Behavior when resumed session's context was auto-compacted by Claude Code between close and resume. Acceptable? Or should we hard-reset on resume if detectable?
- Codex has similar resume functionality (noted for Codex phase).

### 5.8 Cold-Start Context Reconstruction

When a runtime is spawned fresh (new conversation OR post-reset), it needs context:

1. **System prompt** — assembled from soul.md + shared rules + knowledge.md (see Section 6)
2. **Pinned facts** — from Atlas:memory (`pinned_fact_get(scope: 'global')` + `pinned_fact_get(scope: 'agent', scope_id: agentId)`)
3. **Recent conversation summary** — last N messages from this channel/thread (from Tango's `messages` table, the authoritative store)
4. **Relevant memories** — semantic search of Atlas:memory for memories relevant to the recent conversation topics
5. **Active task state** — any pending tasks, follow-up threads, scheduled job output awaiting response

This replaces the current `buildWarmStartContextPrompt()`. Key difference: the new approach leans on Atlas:memory for long-term recall rather than embedding everything in a warm-start string.

### 5.9 Storage is Authoritative, Sessions are Ephemeral

Explicit principle: **Tango's `messages` table remains the source of truth for all conversation history.** Runtime sessions are ephemeral views on top.

Implications:
- Every user message and agent response is stored in the messages table before/after the runtime sees it
- Runtime crashes, resets, or closes do NOT lose conversation history
- Conversation can be reconstructed, audited, exported regardless of runtime state
- If we switch runtime providers (Claude Code → Codex → something else), history is preserved

Messages table stays. Session IDs are tracked alongside messages for debugging, but are not the record of what was said.

---

## 6. Per-Agent Configuration

### 6.1 Agent Profile Structure (v2)

```yaml
# config/v2/agents/{agent-id}.yaml
id: malibu
display_name: Malibu
type: wellness

# System prompt = personality + domain + rules
system_prompt_file: agents/assistants/malibu/soul.md

# MCP servers this agent can access
mcp_servers:
  - memory           # Atlas:memory (all agents)
  - wellness         # health_query, workout_sql, nutrition_log_items
  - fatsecret        # nutrition API
  - atlas            # ingredient catalog
  - obsidian         # vault read/write (read-only for Malibu)

# Runtime configuration
runtime:
  mode: persistent
  provider: claude-code
  fallback: codex
  model: claude-sonnet-4-6
  reasoning_effort: medium

# Voice configuration (unchanged)
voice:
  call_signs: [Malibu, Malibooth, "Coach Malibu"]
  kokoro_voice: am_puck
  default_channel_id: "100000000000000002"

# Discord routing
discord:
  default_channel_id: "100000000000000002"
  smoke_test_channel_id: "100000000000001002"
```

### 6.2 Agent Migration Map

| Agent | Current Workers | New MCP Servers | Notes |
|-------|----------------|-----------------|-------|
| **Malibu** | health-analyst, nutrition-logger, recipe-librarian, workout-recorder | memory, wellness, fatsecret, atlas, obsidian(ro) | All 4 workers collapse into direct MCP tool access |
| **Watson** | personal-assistant | memory, google (email/calendar/docs), obsidian, lunch-money, receipt-registry, ramp, linear, imessage, slack, browser, 1password, latitude | Largest tool surface; personal-assistant was the catch-all worker |
| **Sierra** | research-coordinator, research-assistant | memory, browser, exa, obsidian(ro) | Research workers become direct web/search tool access |
| **Victor** | dev-assistant | memory, tango-dev, browser, obsidian | Dev tools + full system access |
| **Juliet** | (none) | memory | Already has no workers; simplest migration |

### 6.3 Channel/Thread → Agent Mapping

**Keep existing approach.** The current system works:
1. Each agent has a `default_channel_id`
2. Voice channels use callsign matching (voice-level route classifier)
3. Threads inherit the agent from the parent channel
4. `access-control.ts` enforces per-agent channel restrictions

**Change:** Remove the `dispatch` system agent (`config/defaults/agents/dispatch.yaml`). In the new architecture, there is no dispatch orchestrator — the router sends messages directly to the target agent's runtime.

---

## 7. Tango Router Design

The router replaces the turn executor as the central orchestration point, but is dramatically simpler.

```
Discord message
       │
  ┌────▼──────────────┐
  │ Channel → Agent    │  (existing mapping, unchanged)
  │ resolver           │
  └────┬──────────────┘
       │
  ┌────▼──────────────┐
  │ Runtime pool       │  Get or create runtime for this agent
  │ manager            │
  └────┬───────────���──┘
       │
  ��────▼──────────────┐
  │ Context builder    │  Fetch recent messages, pinned facts
  │                    │  (only on cold start or session gap)
  └───��┬────��─────────┘
       │
  ┌─���──▼���─────────────┐
  │ runtime.send()     │  User message → Claude Code/Codex
  │                    │  Runtime has MCP tools, handles everything
  └���───┬───────────��──┘
       │
  ���────▼──────────────┐
  │ Response handler   │  Stream to Discord, store message,
  │                    │  handle voice TTS
  ���────┬──────────────┘
       │
  ┌─��──▼──────────────┐
  │ Post-turn hooks    │  Memory reflection, audit log,
  │                    │  telemetry
  └──────────────────┘
```

**What's NOT in the router:**
- No intent classification
- No worker dispatch
- No narration guards
- No response mode injection
- No deterministic fast path
- No synthesis retries

The LLM (Claude Code/Codex) handles all of this natively through its system prompt and tool access.

---

## 8. Scheduled Job Context Bridging

### The Problem

Watson runs a lunch money review as a scheduled job. Later, Devin wants to reply in Discord to correct a decision or ask follow-up. If jobs run in isolated runtimes, the context is gone.

### Resolution via Per-Conversation Runtimes

The per-conversation runtime model (Section 5.5) makes this problem largely solve itself. Each Discord channel/thread has its own runtime with its own independent lifecycle. Scheduled jobs simply deliver their output to the appropriate conversation; follow-up messages in that conversation are handled by that conversation's runtime, which sees the job output in its history.

**Two delivery patterns remain useful:**

| Delivery | When | Flow |
|----------|------|------|
| **Channel** | Job is an ongoing informational stream for an existing conversation | Job posts to the agent's channel. That channel's runtime has it in history. User replies land in the same runtime. |
| **Thread** | Job is a bounded, high-stakes decision point that deserves its own thread | Job creates a new thread, posts output with a "reply here to correct" prompt. The thread spawns its own runtime on first user reply, with the job output as cold-start context. |

**Schedule config:**
```yaml
delivery:
  mode: channel          # default: deliver to agent's channel
  # OR
  mode: thread           # create a new thread for this run
  thread_title: "Lunch Money Review — {date}"
  follow_up_prompt: "Reply to correct any decisions or ask questions."
```

**Recommendation:** Default to **channel** delivery. Use **thread** for jobs that produce bounded decisions needing explicit correction loops (transaction categorization, receipt processing, reimbursement automation).

**Context propagation mechanism:**
1. Job completes, output stored in Tango's `messages` table (authoritative, unchanged)
2. For channel delivery: the conversation's persistent runtime sees the scheduled output as a message in its history
3. For thread delivery: the new thread's runtime gets the job output injected as part of cold-start context on first user reply
4. Atlas:memory stores key decisions as memories with `source: 'scheduled_job'` tag — available to all future sessions regardless of runtime/conversation

---

## 9. Voice Pipeline Integration

### Current Flow
```
Voice audio → VAD → Whisper ASR → transcript
  → Route classifier (callsign/channel) → agent selection
  → Turn executor (in-process) → response text
  → Kokoro TTS → audio playback
```

### Target Flow
```
Voice audio → VAD → Whisper ASR → transcript
  → Route classifier (callsign/channel) → agent selection
  → Tango Router → runtime.send(transcript)
  → Response text
  → Kokoro TTS → audio playback
```

### Key Changes

**Minimal.** The voice pipeline stays untouched through VAD/Whisper/route-classifier. The only change is replacing the turn executor call with a router call. Since the router is async and returns text, the voice pipeline doesn't care what's behind it.

### Latency Analysis

| Stage | Current | Target | Delta |
|-------|---------|--------|-------|
| VAD + Whisper | ~500ms | ~500ms | 0 |
| Route classifier | ~100ms | ~100ms | 0 |
| **Turn executor / Router** | ~2-8s | ~3-10s | **+1-2s worst case** |
| Kokoro TTS (streaming) | ~200ms to first audio | ~200ms to first audio | 0 |

**The +1-2s delta** comes from Claude Code process overhead vs in-process provider call. Mitigations:
- **Persistent runtime** eliminates cold-start (~2-5s saved on subsequent turns)
- **Streaming response** — start TTS on first sentence while the rest generates
- **Earcon UX** — play "thinking" earcon immediately on voice turn receipt (already exists for some flows)

### Runtime Failover During Voice

**No mid-turn failover.** If the primary runtime fails during a voice turn:
1. Return an error earcon + brief spoken message ("Sorry, I'm having trouble. Try again.")
2. Next voice turn retries on the primary, or fails over to secondary if primary is down
3. Failover decision happens at the router level, not mid-sentence

**Rationale:** Mid-turn failover would require reconstructing the partial response in a new runtime, which is more complex than just retrying. Voice turns are short enough that retry latency is acceptable.

### Fresh vs Persistent for Voice

**Always persistent.** Voice is the most latency-sensitive path. Cold-start would add 2-5s to every voice turn, which is unacceptable. The persistent runtime keeps the conversation context warm and eliminates process spawn overhead.

---

## 10. Migration Plan

### Phase 0: Atlas:memory + Malibu Migration (Feature-Flagged)

**Goal:** Validate the architecture with one agent before committing to full migration.

**Approach:** Migrate Malibu **in place** on the existing Discord channel, behind a feature flag (`runtime: legacy | v2`). Malibu is already semi-broken and the user has been routing analytical work to a separate Claude Code session anyway, so the risk of an in-place migration is low. Rollback is a config flip.

**Scope:**
1. Build Atlas:memory MCP server (`packages/atlas-memory/`, SQLite, schema v1, all operations from Section 4)
2. Build `AgentRuntime` interface + Claude Code adapter
3. Build session lifecycle manager (idle closure, resume, context-threshold reset)
4. Build minimal Tango Router (conversation → runtime → response)
5. Materialize Malibu's merged system prompt from existing soul.md + shared files (refactor `prompt-assembly.ts` to drop worker/tool composition)
6. Configure Malibu with new runtime + Atlas:memory + wellness MCP (existing mcp-wellness-server)
7. Wire feature flag: `config/v2/agents/malibu.yaml` with `runtime.provider: claude-code-v2`
8. Migrate existing Malibu memory data into Atlas:memory
9. Switch Malibu's conversations to the new runtime
10. Run and observe for ~1 week; compare against expected behavior (analytical questions work, transactional still work, no generic "something went wrong")

**Acceptance criteria:**
- Atlas:memory passes unit tests for all operations (search, add, reflect, pinned facts, memory_admin)
- Claude Code adapter maintains a persistent session across multiple turns in a conversation
- Session lifecycle works: idle closure, resume, context threshold reset all observable in logs
- Malibu answers analytical questions with full nuance (the body-fat-trend style question that currently fails)
- Malibu handles transactional requests (log food, check workout) via MCP tools in similar or better latency
- Voice pipeline works with new runtime
- Memory continuity across runtime reset (a memory created before reset is retrievable after)
- Feature flag flip back to legacy restores existing behavior cleanly

**Rollback:** Flip `runtime.provider` back to `legacy` in Malibu's config. Legacy turn executor remains alive during Phase 0 and Phase 1.

**Ancillary outputs:**
- Validated answers to the open caveats in Section 5.7 (Claude Code resume TTL, context-compaction behavior on resume)
- Measured latency numbers (for informational use only — no optimization work planned)
- Documented any issues discovered during real use, for Phase 1 fixes

### Phase 1: Migrate Remaining Agents

**Goal:** Move Watson, Sierra, Victor, Juliet to new runtime.

**Scope:**
1. Configure Watson with new runtime + all MCP servers (largest tool surface)
2. Configure Sierra with new runtime + research MCP servers
3. Configure Victor with new runtime + dev MCP servers
4. Configure Juliet with new runtime + memory MCP
5. Migrate any remaining tool contracts to MCP servers
6. Update voice pipeline to route through Tango Router

**Acceptance criteria:**
- All 5 agents responding correctly on new runtime
- Watson scheduled jobs executing successfully
- Sierra research workflows working end-to-end
- Victor dev workflows working
- Juliet therapeutic conversations working
- Voice turns for all agents working

**Rollback:** Per-agent rollback by switching `runtime.provider` back to the legacy turn executor (kept alive during migration).

### Phase 2: Retire Legacy Orchestration

**Goal:** Remove the old orchestration code.

**Scope:**
1. Remove turn executor (`turn-executor.ts`)
2. Remove worker dispatch infrastructure (`dispatch-extractor.ts`, `mcp-dispatch-server.ts`, `worker-report.ts`)
3. Remove worker agent runtime (`worker-agent.ts`)
4. Remove intent classifier (`intent-classifier.ts`, `deterministic-router.ts`)
5. Remove deterministic runtime (`deterministic-runtime.ts`, `deterministic-worker-fast-path.ts`)
6. Remove narration guards
7. Remove concise response mode injection
8. Remove all worker configs (`config/defaults/workers/*.yaml`)
9. Remove prompt assembly system (`prompt-assembly.ts`)

**Acceptance criteria:**
- All agents functional without legacy code
- No references to removed modules in active code
- Clean build with no dead code warnings
- All tests pass

**Rollback:** Git revert. Legacy code is in version control.

### Phase 3: Scheduler Integration

**Goal:** Connect the existing scheduler engine to the new runtime.

**Scope:**
1. Build scheduled job bridge: `ScheduledTurnExecuteFn` implementation that uses `AgentRuntime`
2. Update schedule configs to reference agents instead of workers
3. Implement context bridging (Option B channel delivery + Option A thread delivery)
4. Migrate all 27 schedule configs
5. Test each scheduled job end-to-end

**Acceptance criteria:**
- All enabled scheduled jobs running successfully
- Morning planning, email review, finance review producing correct output
- Follow-up replies in threads have job context
- Job failures alert correctly

**Rollback:** Point scheduler back at legacy worker bridge (if still exists) or pause jobs.

### Phase 4: Deprecate Legacy Memory

**Goal:** Clean up old memory tables after data migration.

**Scope:**
1. Verify all data migrated to Atlas:memory
2. Remove old memory tables from storage.ts schema
3. Remove `memory-compaction.ts`
4. Remove `session_summaries`, `session_compactions` tables
5. Remove old `memory-agent-tools.ts` (replaced by Atlas:memory)
6. Update any remaining references to old memory system

**Acceptance criteria:**
- Atlas:memory is sole source of truth
- Old tables dropped from schema
- No data loss verified by audit
- Memory search quality matches or exceeds old system

**Rollback:** Atlas:memory keeps serving; old tables are just unused schema.

---

## 11. Risk Assessment

### R1: Claude Code/Codex Process Reliability

**Risk:** External CLI processes crash, hang, or become unresponsive.
**Likelihood:** Medium. **Impact:** High — agent becomes unresponsive.
**Mitigation:**
- Health check every 30s on persistent runtimes
- Auto-restart on crash with cold-start context reconstruction
- Failover to Codex adapter
- Watchdog timer on every `send()` call (30s default, configurable)
**Foreclosure:** None. The `AgentRuntime` interface means we can swap implementations.

### R2: Latency Regression

**Risk:** Claude Code subprocess adds latency vs in-process provider calls.
**Likelihood:** Medium. **Impact:** Medium — voice users notice.
**Mitigation:**
- Persistent mode eliminates cold-start for interactive/voice
- Streaming responses start TTS immediately
- Earcon UX covers thinking time
- Benchmark before/after in Phase 0
**Foreclosure:** If latency is unacceptable, we could implement an in-process Claude SDK path as another `AgentRuntime` adapter.

### R3: Context Loss During Migration

**Risk:** Memories, pinned facts, or conversation context lost or corrupted during migration.
**Likelihood:** Low. **Impact:** High — user loses trusted data.
**Mitigation:**
- Migration script with row count validation and content spot-checks
- Old tables kept read-only as backup through Phase 4
- Atlas:memory schema is versioned
- Full SQLite backup before migration
**Foreclosure:** None. Reversible.

### R4: MCP Server Proliferation

**Risk:** Too many MCP servers become hard to manage, debug, and secure.
**Likelihood:** Medium. **Impact:** Low — manageable with good tooling.
**Mitigation:**
- Keep MCP servers coarse-grained (one per domain, not one per tool)
- Document server inventory and ownership
- Standard health check / logging across all servers
**Foreclosure:** Could consolidate servers later if needed.

### R5: Scheduled Job Context Isolation

**Risk:** Scheduled jobs on fresh runtimes lack context needed for good decisions.
**Likelihood:** Medium. **Impact:** Medium — job output quality degrades.
**Mitigation:**
- Jobs get cold-start context from Atlas:memory (pinned facts + relevant memories)
- Job task prompts include explicit context (already true in current schedule configs)
- Follow-up thread mechanism for corrections
**Foreclosure:** Could switch to persistent mode for frequently-running jobs if context matters.

### R6: Worker-Level Governance Loss

**Risk:** Workers had scoped tool access; agents with direct MCP access have broader tool surface.
**Likelihood:** Low. **Impact:** Medium — agent could misuse tools.
**Mitigation:**
- MCP server allowlists per agent (replace worker-level tool scoping)
- Governance system (`governance.ts`) still checks permissions on tool calls
- Audit logging unchanged
- Per-MCP-server access control (read-only obsidian for Malibu, etc.)
**Foreclosure:** Could add per-tool permission overrides within MCP servers if needed.

### R7: Parallel Operation During Migration

**Risk:** Running old and new systems simultaneously causes confusion or conflicts.
**Likelihood:** Low. **Impact:** Low — short duration.
**Mitigation:**
- Phase 0 uses separate Discord channel (no conflict with existing Malibu)
- Phase 1 migrates one agent at a time
- Feature flag per agent: `runtime: legacy | v2`
- Quick rollback per agent

---

## 12. Resolved Design Decisions

### D1: Session Persistence Model — DECIDED
**Decision:** Persistent per-conversation runtimes with controlled session lifecycle (idle closure, resume, reset). See Section 5.5-5.7.

### D2: Agent System Prompts — DECIDED (modular preserved)
**Decision:** Keep modular source files (soul.md, shared/RULES.md, shared/USER.md, knowledge.md) for maintainability — a change to a shared rule propagates to all agents. Workers.md and tool contract docs are retired. Prompt assembly happens at runtime spawn time: the various source files are concatenated into a single system prompt string passed to the runtime via `--append-system-prompt` (or equivalent). This preserves the current `prompt-assembly.ts` pattern minus worker/tool composition.

### D3: Voice Latency Tolerance — DECIDED (no optimization work)
**Decision:** Accept whatever latency the new runtime produces. Measure in Phase 0 for information only. Not worth optimizing preemptively — with persistent runtimes, latency may even improve. Revisit only if it becomes a user-visible problem.

### D4: Codex Fallback — DEFERRED
**Decision:** Skip formal Codex adapter in this project. Deferred to a later phase.

**Rationale and interim workaround:** Once MCP migration is done (Phase 0-1), the user can manually spin up a Codex session pointed at the same MCP servers during Anthropic outages. This is already how the user handled recent downtime. The "Codex adapter" is really a formalization of something that will already work manually.

Scope of a future Codex adapter phase (not this project):
- Wrap each MCP tool as a Codex function definition (one-time work)
- Build context injection machinery (Codex has no native session persistence)
- Implement Memory MCP access via the wrapped tools
- Integrate with the router's provider failover

Estimated 1-2 weeks when we decide to do it. Will be its own Linear project.

### D5: Atlas:memory Ownership — DECIDED (in-repo, under Atlas family)
**Decision:** Atlas:memory lives in `packages/atlas-memory/` within the Tango repo. Part of the Atlas family of structured-data MCP servers. Standalone extraction is a 1-day move later if needed; MCP interface guarantees portability regardless.

### D6: Session Reset Defaults — DECIDED
**Decision:**
- Idle > 24 hours → close runtime (resumable via `--resume`)
- Context usage > 80% → hard reset with cold-start reconstruction
- Manual `/reset` slash command available
- All thresholds configurable per-agent and overridable per-conversation

### D7: Runtime Scope — DECIDED (per-conversation, not per-agent)
**Decision:** Each active Discord channel/thread gets its own runtime instance. Agent config defines the shape (system prompt, MCP allowlist, defaults); each conversation gets its own process with that config. Natural resolution of the scheduled job bridging problem. See Section 5.5.

---

## 13. Key Files Reference

### Being Replaced
| File | Lines | Purpose |
|------|-------|---------|
| `packages/discord/src/turn-executor.ts` | ~1400 | Central orchestration |
| `packages/discord/src/intent-classifier.ts` | ~500 | Intent classification |
| `packages/discord/src/deterministic-runtime.ts` | ~600 | Deterministic fast path |
| `packages/discord/src/deterministic-router.ts` | ~400 | Deterministic routing |
| `packages/discord/src/deterministic-worker-fast-path.ts` | ~200 | Worker fast path |
| `packages/discord/src/dispatch-extractor.ts` | ~200 | Dispatch tag parsing |
| `packages/discord/src/mcp-dispatch-server.ts` | ~300 | Dispatch MCP server |
| `packages/discord/src/worker-report.ts` | ~200 | Worker report merging |
| `packages/core/src/worker-agent.ts` | ~400 | Worker agent runtime |
| `packages/core/src/memory-compaction.ts` | ~110 | Memory compaction |
| `packages/core/src/prompt-assembly.ts` | ~300 | Prompt composition |
| `config/defaults/workers/*.yaml` | 8 files | Worker configurations |

### Being Created
| File | Purpose |
|------|---------|
| `packages/atlas-memory/` | Atlas:memory MCP server (new package, Atlas family) |
| `packages/core/src/agent-runtime.ts` | AgentRuntime interface |
| `packages/core/src/claude-code-adapter.ts` | Claude Code runtime implementation |
| `packages/core/src/session-lifecycle.ts` | Idle closure, resume, context-threshold reset logic |
| `packages/discord/src/tango-router.ts` | Thin router (replaces turn-executor) |
| `config/v2/agents/*.yaml` | New agent configurations |
| `~/.tango/atlas/memory.db` | Atlas:memory SQLite database (user-owned data) |

### Deferred (future phases)
| File | Purpose |
|------|---------|
| `packages/core/src/codex-adapter.ts` | Codex runtime implementation — deferred per D4 |

### Being Kept
| File | Purpose |
|------|---------|
| `packages/discord/src/main.ts` | Discord bot (message handling, channel routing) |
| `packages/voice/` | Voice pipeline (Whisper, VAD, Kokoro, route classifier) |
| `packages/core/src/scheduler/` | Scheduler engine |
| `packages/core/src/governance.ts` | Permission system |
| `packages/core/src/storage.ts` | Storage layer (trimmed of retired tables) |
| `packages/discord/src/access-control.ts` | Channel access control |
| `packages/discord/src/provider-failover.ts` | Provider failover |
| `packages/discord/src/mcp-wellness-server.ts` | Wellness MCP server |
| `config/defaults/schedules/*.yaml` | Schedule configurations |
