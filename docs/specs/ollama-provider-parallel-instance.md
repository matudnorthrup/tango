# Ollama Provider & Parallel Instance — Design Spec

This is a forward-looking design spec, not a description of the current system.
It defines (1) a first-class `ollama` model provider and (2) a parallel
"Ollama-backed" Tango instance used to evaluate it live alongside production
without disruption.

Related: [`../guides/parallel-dev.md`](../guides/parallel-dev.md) (the profile +
slot isolation this builds on), [`../guides/profile-model.md`](../guides/profile-model.md).

---

## Section 1: Motivation

Effective **2026-06-15**, Anthropic splits *programmatic* Claude usage
(`claude --print` / Agent SDK / GitHub Actions / subscription-authenticated
third-party apps) out of the flat subscription pool into a separate metered
credit pool billed at API rates (Pro ~$20 / Max5x ~$100 / Max20x ~$200 monthly
credit, no rollover), then standard API rates beyond.

Tango's runtime is exactly this: every bot turn spawns `claude --print` via
`ClaudeCodeAdapter`, authenticated by the on-machine `claudeAiOauth`
subscription credential (no `ANTHROPIC_API_KEY` set). So the bot's hot loop
moves to the metered pool.

**Measured cost** (from `~/.tango/profiles/default/data/tango.sqlite`,
`model_runs.total_cost_usd`, Apr 4 – Jun 4 2026, 4,815 runs): **~$683 / 2 months
≈ ~$340/month** at API-equivalent rates. ~90% is Sonnet; the dominant line item
is **cache-creation** (context re-send), not output.

This spec pursues the **open-weight, flat-rate** alternative: route some/all
agent traffic to **Ollama Cloud** (flat subscription, GPU-time metered, runs
DeepSeek V4 Pro / Qwen / gpt-oss), via a first-class provider, validated on a
**parallel instance** so production is never at risk.

---

## Section 2: Provider architecture

Tango already has a provider seam. Adding Ollama is a *peer implementation*, not
an adaptation of the existing Codex adapter.

- Interface (`packages/core/src/provider.ts`):
  `interface ChatProvider { generate(request: ProviderRequest): Promise<ProviderResponse> }`
- Existing implementations: `ClaudeCliProvider`, `CodexExecProvider`,
  `EchoProvider`.
- Registry: `createBuiltInProviderRegistry()` in
  `packages/core/src/provider-registry.ts` — add `providers.set("ollama", new OllamaProvider(options.ollama))`.
- Per-agent selection is config-driven (`AgentConfig.provider`):
  `default`, `model`, `reasoningEffort`, `fallback[]`. Routing an agent to
  Ollama is a YAML change, not code.

### 2.1 The one hard problem: who owns the tool loop

**Today, the Claude/Codex CLIs own the agentic tool-execution loop.** Tango
hands MCP server configs to the CLI via `--mcp-config`; the CLI shows tools to
the model, executes tool calls, feeds results back, and loops — Tango only
records the resulting `toolCalls[]`.

Ollama's OpenAI-compatible endpoint is a **raw model**: it returns "call tool X"
and *something in Tango* must execute X and continue. Nothing does that today.
A first-class Ollama provider therefore requires a **provider-agnostic
tool-execution loop** inside Tango:

1. Translate MCP tool definitions → OpenAI function-schema format.
2. Execute tool calls — reuse `packages/core/src/mcp-proxy.ts`, which already
   bridges MCP over HTTP (port 9100), instead of reinventing MCP transport.
3. Loop call → execute → feed-back with iteration caps, parallel-call handling,
   and error recovery.
4. Manage conversation history (see 2.2).

This loop is the bulk of the effort and nearly all of the risk. Once built it is
reusable for any future HTTP/OpenAI-compatible provider.

> Do **not** shim this by pointing `CLAUDE_CLI_COMMAND` at an Ollama endpoint.
> Route through the real `OllamaProvider` selected via per-profile agent config.

### 2.2 Statelessness / session continuity

Claude/Codex persist sessions server-side; Tango stores only the opaque
`providerSessionId` in the `provider_sessions` table and resumes via `--resume`.
Ollama is stateless, so `OllamaProvider` must store and replay conversation
history per `providerSessionId`. In-memory is acceptable for a single-process
pilot; **DB-backed history is required before multi-process / wider rollout.**

---

## Section 3: Parallel instance topology

The evaluation runs as a **second, fully isolated Tango instance** — same
codebase, different config — using the existing `TANGO_PROFILE` mechanism
(`packages/core/src/runtime-paths.ts`). Setting `TANGO_PROFILE=ollama` routes
*all* runtime state under `~/.tango/profiles/ollama/`.

- **Process:** a second always-on Tango process with `TANGO_PROFILE=ollama`,
  plus its own watchdog (sibling to the existing remote-control/session
  watchdogs).
- **Discord identity:** a **dedicated second bot token** (`DISCORD_TOKEN`), not
  the shared claim/release queue from worktree-dev (that was for *ephemeral* dev
  slots). This gives a persistent, visibly distinct identity (e.g.
  "Tango [Ollama]") and true process isolation.
- **Channels:** `DISCORD_ALLOWED_CHANNELS` (see
  `packages/discord/src/allowed-channels.ts`) pins the Ollama instance to
  dedicated channels (e.g. `#watson-ollama`, `#sierra-ollama`). Each instance
  answers only in its own channels — same agents/personas, different brain.
- **Provider config:** the `ollama` profile's agent YAMLs set
  `provider.default: ollama`; production's stay `claude-oauth`.

### 3.1 The split is temporary

During development the Ollama provider + tool loop live on a feature branch in a
worktree (the Ollama instance runs that build; prod runs `main`). **Once merged,
both instances run identical code** — the only difference is per-profile config
+ env. This converges to *one codebase, two configs*, not a maintained fork.

---

## Section 4: Data sharing policy (layered)

`TANGO_PROFILE` already isolates the runtime and shares the knowledge layer —
the boundary this evaluation wants is largely the default. Policy by layer:

| Data | Store | Default scope | Policy for Ollama instance |
|---|---|---|---|
| Sessions, messages, `model_runs`, `obsidian_index` | per-profile `tango.sqlite` | isolated | **Isolated** (default). Clean A/B; own usage accounting. |
| Atlas semantic memory (memories, pinned_facts, embeddings, conversation_summaries) | global `~/.tango/atlas/memory.db` | **shared** | **Read-shared, write-isolated.** Both read the same knowledge (fair test); the experimental instance must NOT write into prod's brain. Disable Atlas writes on the Ollama instance, or seed it a private copy. |
| Obsidian vault (markdown files) | global, `TANGO_OBSIDIAN_VAULT` → `~/Documents/main` (`packages/core/src/obsidian-indexer.ts`) | **shared** (not profile-scoped) | **Shared read + write.** Either brain may legitimately write notes. Vault is file-backed with version history, so rollback is the safety net; simultaneous writes are unlikely. |

Rationale for the Atlas/Obsidian asymmetry: Atlas is a *semantic* store
production reasons over directly — experimental writes could silently poison
retrieval, and there's no easy per-entry rollback. Obsidian is *file-backed and
versioned*, so shared writes are recoverable and the user has accepted that
trade.

### 4.1 Concurrency notes

Both `tango.sqlite` and Atlas use WAL (`journal_mode=WAL`, Atlas
`busy_timeout=5000`). WAL allows many readers + one writer; shared-Atlas
*reads* are safe. The Atlas write-isolation above is a **quality/contamination**
guard, not merely a locking concern. For shared Obsidian, prefer the project's
direct-filesystem I/O convention (not `obsidian-cli`, which steals app focus in
background jobs) and consider tagging Ollama-instance writes for attribution +
easier rollback during the A/B.

---

## Section 5: Phased plan

**Pilot first (Phases 0–1), then the hard loop (Phase 2).** The parallel
instance is the live, zero-prod-risk test bed for each phase.

| Phase | Work | Size | Unlocks |
|---|---|---|---|
| **0 — Provider plumbing** | `OllamaProvider implements ChatProvider`; register in `provider-registry.ts`; env + YAML config (`OLLAMA_BASE_URL`, `OLLAMA_API_KEY`, `OLLAMA_MODEL`); map response → `ProviderResponse` (tokens from `prompt_eval_count`/`eval_count`; `totalCostUsd` null — flat sub); record to `model_runs`. **Text-only, `tools.mode: off`.** | S (~½ day) | Route text-only workers to DeepSeek on Ollama Cloud; validate connectivity, model selection, accounting. |
| **1 — Stateless history** | Persist conversation history per `providerSessionId` (in-memory for single-process pilot → DB-backed for prod). | S–M | Multi-turn continuity; survives restart / multi-process. |
| **1b — Parallel instance** | Stand up `TANGO_PROFILE=ollama` profile, second bot token, `DISCORD_ALLOWED_CHANNELS`, dedicated channels, watchdog; apply the Section 4 data policy. | S–M | Live A/B surface; dogfood without touching prod. |
| **2 — Agentic tool loop** | Provider-agnostic executor: MCP→OpenAI schema translation, tool exec via mcp-proxy, loop control. **The real cost and risk.** | L | Tool-using agents on any non-CLI provider. |
| **3 — Usage/cost + parity** | Map Ollama usage into `model_runs`; map/handle `reasoningEffort`. | M | Accurate accounting; routing parity. |
| **4 — Live validation** | Side-by-side on real traffic, workers/classifiers first, then user-facing. (`done-means-live-tested`.) | M | Trust before promoting. |

Early win: Phases 0 + 1 + 1b alone move the existing Haiku-class worker/
classifier traffic onto Ollama Cloud and measure real cost + quality **before**
committing to Phase 2.

---

## Section 6: Locked decisions

- **Pilot scope:** Phases 0–1 first (text-only worker routing), then evaluate.
- **Hosting:** Ollama Cloud (flat-rate, no local hardware).
- **Pilot model:** DeepSeek V4 Pro.
- **Atlas memory:** read-shared, write-isolated.
- **Obsidian vault:** shared read + write (rollback via file history).
- **Discord:** dedicated second bot token + parallel instance (not the shared
  claim/release queue).
- **End state:** one codebase, per-profile config selects the provider.

---

## Section 7: Open questions / to confirm during build

- Exact Ollama Cloud model tag for DeepSeek V4 Pro + endpoint URL and auth
  header format.
- Whether Ollama Cloud's OpenAI-compatible endpoint returns usage counts (some
  hosted endpoints omit them).
- `reasoningEffort` handling for open models (likely ignore for the pilot).
- Whether the Ollama instance's worker/classifier targets are genuinely
  LLM-backed routes vs deterministic ones (route only the LLM-backed ones).
- Does Ollama Cloud's tier volume cap accommodate sustained bot traffic, or does
  it throttle under load? (Validate during pilot.)

---

## Section 8: Risk register

- **Tool-calling reliability** of open models against Tango's MCP toolset — the
  primary quality risk; Phase 2 gates user-facing promotion.
- **New shared infrastructure** (the tool loop) — bugs affect any non-CLI
  provider; build behind the parallel instance.
- **mcp-proxy reuse** assumption needs validation for non-Claude callers.
- **Flat-rate durability** — open-weight hosting incentives differ from
  Anthropic's eroding subsidy, but a flat consumer plan driven by an automated
  agent could still be re-metered; treat the flat rate as advantageous, not
  permanent.
- **Single-process in-memory history** must not be used across the parallel
  worktree profiles; DB-backed history before any multi-process use.
