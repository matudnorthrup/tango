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

### 2.2 Context ownership (statelessness as an advantage)

Claude/Codex persist sessions server-side; Tango stores only the opaque
`providerSessionId` in the `provider_sessions` table and resumes via `--resume`.
Tango never sees or controls the resulting context window — compaction,
truncation, and continuity all happen inside the harness, and Tango can only
*influence* them indirectly (warm-start injection, `--append-system-prompt`).
Much of today's context handling is working *around* that opacity.

Ollama is stateless: `OllamaProvider` assembles and sends the full message array
on every turn. The obvious framing is "extra work," but the real consequence is
**control** — Tango owns exactly what enters the context window each turn. This
is strictly more capable than the CLI path, and it converges with the in-flight
Unified Memory System work (per-thread state files, the context meter, governed
retrieval): context assembly becomes the *native* path instead of a layer
fighting the harness. Two long-standing constraints relax:

- **Thread-scoped context** becomes natural — the provider builds a
  per-channel/thread array instead of inheriting one opaque server-side session.
- **Compaction is ours to design** — summarize-and-replace, sliding window, or
  retrieval-augmented context on *our* policy and at *our* threshold, rather than
  the harness's heuristic.

The cost of this control is that we must build it well: naive full-history
replay is *worse* than Claude's compaction — it will overflow the model's
context window on long Discord threads. A deliberate context-assembly +
compaction strategy is therefore part of Phase 1, not an afterthought. Storage:
in-memory is fine for a single-process pilot; **DB-backed history is required
before multi-process / wider rollout.**

### 2.3 Tool parity: MCP carries over, Claude built-ins do not

The Phase 2 tool loop translates **MCP** tool definitions → OpenAI function
schemas. That covers the overwhelming majority of Tango's tool surface: ~24 MCP
servers (memory/Atlas, obsidian, slack, linear, google, **browser** (Playwright),
exa, receipts, ramp, etc.), almost all bridged through `mcp-proxy.ts` on port
9100. All of it is provider-agnostic and carries over unchanged.

The gap is the handful of tools that are **Claude CLI built-ins**, passed via
`--allowedTools` (`packages/core/src/provider.ts`) rather than `--mcp-config`.
These are NOT MCP and would be lost on a raw endpoint:

| Built-in | Who uses it | Replacement on Ollama |
|---|---|---|
| `WebSearch` | Watson, Sierra, Charlie, Porter (allowlist) | **`exa` MCP** — already wired, already used by Sierra/Charlie for search. Swap `WebSearch`→exa in the allowlists. |
| `WebFetch` | same agents | `exa` content retrieval. **Confirm** it covers arbitrary fetch-by-URL as well as `WebFetch` did. |
| `Bash` / file built-ins | appears only in a **test** config (`provider.test.ts`), not live personas | Confirm no live persona/worker depends on it; if so, no work. |

Net: browser automation (the obvious worry) is **already an MCP server** and
needs no work. The only genuine loss is `WebSearch`/`WebFetch`, and Tango already
ships `exa` as the replacement. Juliet's `memory_*` tools and every other persona
capability are MCP-backed and portable. "Tool parity" is therefore a small,
well-bounded task inside Phase 2 — not a from-scratch rebuild.

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
| **0 — Provider plumbing** | `OllamaProvider implements ChatProvider`; register in `provider-registry.ts`; env + YAML config (`OLLAMA_BASE_URL`=`https://ollama.com/v1`, `OLLAMA_MODEL`=`deepseek-v4-pro:cloud`, key via `getSecret`); map response → `ProviderResponse` (usage + `reasoning`/`thinking` handling per §7.1; `totalCostUsd` null — flat sub); record to `model_runs`. **Text-only, `tools.mode: off`.** | S (~½ day) | Route text-only workers to DeepSeek on Ollama Cloud; validate connectivity, model selection, accounting. |
| **1 — Context ownership** | Assemble + persist the per-`providerSessionId` message array (in-memory pilot → DB-backed for prod), **including a context-assembly + compaction policy** (see 2.2). Converges with the Unified Memory System. | M | Multi-turn continuity; thread-scoped context; deterministic, Tango-owned compaction. |
| **1b — Parallel instance** | Stand up `TANGO_PROFILE=ollama` profile, second bot token, `DISCORD_ALLOWED_CHANNELS`, dedicated channels, watchdog; apply the Section 4 data policy. | S–M | Live A/B surface; dogfood without touching prod. |
| **2 — Agentic tool loop** | Provider-agnostic executor: MCP→OpenAI schema translation, tool exec via mcp-proxy, loop control. **Plus built-in-tool parity** (swap `WebSearch`/`WebFetch`→`exa`; see 2.3). **The real cost and risk.** | L | Tool-using agents on any non-CLI provider. |
| **3 — Usage/cost + parity** | Map Ollama usage into `model_runs`; map/handle `reasoningEffort`. | M | Accurate accounting; routing parity. |
| **4 — Live validation** | Side-by-side on real traffic, workers/classifiers first, then user-facing. (`done-means-live-tested`.) | M | Trust before promoting. |

Early win: Phases 0 + 1 + 1b alone move the existing Haiku-class worker/
classifier traffic onto Ollama Cloud and measure real cost + quality **before**
committing to Phase 2.

**Implementation status (2026-06-06):** **Phase 0 built + live-verified.**
`OllamaProvider` (fetch-based, OpenAI-compat) + pure `buildOllamaChatBody` /
`parseOllamaChatResponse` in `packages/core/src/provider.ts`; registered as
`ollama` in `provider-registry.ts`; `OLLAMA_BASE_URL` / `OLLAMA_MODEL` /
`OLLAMA_API_KEY` env + call-site block in `packages/discord/src/main.ts` with a
lazy `getSecret("Watson","Ollama API Credential Tango")` key resolver. 7 unit
tests pass (core builds clean; 326 core + 337 discord tests green). Live smoke
test: a real `generate()` to `deepseek-v4-pro:cloud` returned correct text,
`usage {inputTokens,outputTokens}`, `stopReason`, reasoning kept in `raw` (not
`text`), and no `providerSessionId`. Provider returns no session id by design, so
the discord failover layer re-injects warm-start history — **no Phase 1 history
replay is needed for basic continuity**. Not yet committed. The full
Discord-turn validation is gated on either a deploy (merge → rebuild → restart →
test channel) or the Phase 1b parallel instance (the zero-prod-risk path).

---

## Section 6: Locked decisions

- **Pilot scope:** Phases 0–1 first (text-only worker routing), then evaluate.
- **Hosting:** Ollama Cloud (flat-rate, no local hardware).
- **Pilot model:** DeepSeek V4 Pro (`deepseek-v4-pro:cloud`; paid Ollama Cloud
  tier — active 2026-06-06).
- **Atlas memory:** read-shared, write-isolated.
- **Obsidian vault:** shared read + write (rollback via file history).
- **Discord:** dedicated second bot token + parallel instance (not the shared
  claim/release queue).
- **Context ownership:** Tango owns the message array — provider-side context
  assembly + compaction (see 2.2), converging with the Unified Memory System; no
  attempt to mirror Claude's opaque server-side sessions.
- **Tool parity:** `WebSearch`/`WebFetch` → `exa` MCP; everything else is already
  MCP-backed and portable (see 2.3).
- **End state:** one codebase, per-profile config selects the provider.

---

## Section 7: Open questions

### 7.1 Confirmed during setup (2026-06-06, live-tested)

- **Endpoints:** native `https://ollama.com/api` (e.g. `/api/generate`);
  OpenAI-compatible `https://ollama.com/v1` (e.g. `/v1/chat/completions`) — note
  `/v1`, **not** `/api/v1`. Auth header: `Authorization: Bearer <OLLAMA_API_KEY>`.
  Both paths verified HTTP 200 with the live key.
- **Pilot model tag:** `deepseek-v4-pro:cloud` — 1.6T/49B MoE, **1M-token
  context**, tool use + three reasoning modes. **Requires a paid Ollama Cloud
  subscription** (free tier 403s "requires a subscription"); subscription active
  as of 2026-06-06.
- **Usage IS returned** (so `model_runs` accounting works): native →
  `prompt_eval_count` / `eval_count`; OpenAI-compat →
  `usage.{prompt_tokens,completion_tokens,total_tokens}`. `totalCostUsd` is null
  (flat subscription).
- **Reasoning is exposed separately** from the answer: native → `thinking`;
  OpenAI-compat → `choices[].message.reasoning`. The provider must read/strip/
  store this, not treat it as answer content.
- **API key source:** 1Password **Watson** vault, item **`Ollama API Credential
  Tango`**, field `credential` — fetch via
  `getSecret("Watson", "Ollama API Credential Tango")`
  (`packages/discord/src/op-secret.ts`; requires `OP_SERVICE_ACCOUNT_TOKEN`). No
  device/SSH key needed (HTTP API, not the `ollama` CLI).

### 7.2 Still open / to confirm during build

- `reasoningEffort` → reasoning-mode mapping (no-thinking / thinking / max-
  thinking). Likely wire in Phase 3; pilot default TBD.
- Whether the Ollama instance's worker/classifier targets are genuinely
  LLM-backed vs deterministic (route only the LLM-backed ones).
- Tier volume cap under sustained bot traffic — does it throttle? (Validate
  during pilot.)
- Does `exa` cover arbitrary fetch-by-URL to full `WebFetch` parity, or only
  search + content for search results?
- Confirm no live persona/worker depends on the Claude `Bash`/file built-ins
  (only seen in a test config so far).

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
- **Context-assembly is now ours to get right** — owning the message array is a
  capability win (2.2), but naive full replay overflows the model's context
  window; the compaction policy is load-bearing, not optional.
