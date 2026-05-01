# Deep-Thinking Escape Hatch

**Status:** Discovery — awaiting stakeholder approval
**Linear Project:** Deep-Thinking Escape Hatch (`7744370a-0a34-4553-83ac-df5c3ca04f38`)
**Date:** 2026-04-21

## Problem Statement

Tango's transactional pipeline (route → classify → dispatch worker → concise synthesis) is optimized for action-oriented interactions ("log my yogurt", "check my calendar"). When users ask **analytical questions** — "how have my body fat trends changed at the same weight across months?" — the pipeline actively degrades quality through five compounding layers:

1. **Concise response mode** forces 1-3 sentence answers. Analysis requires 200-500 words with tables, comparisons, and nuanced conclusions.
2. **Worker dispatch context stripping** summarizes the user's rich question into a task string. The health-analyst worker gets "analyze body fat trends" instead of the user's full reasoning context.
3. **Tool boundedness** confines the worker to its declared tool contracts (e.g., `health_query` SQL). It can't reach outside to cross-reference Apple Health exports, Obsidian notes, or other data sources the user might expect.
4. **Memory compaction** truncates 551/559 turns to 180 chars each. Specific data points, prior analytical discussions, and trend context are lost.
5. **Narration guards** calibrated for transactional responses sometimes suppress legitimate analytical output as "narrated dispatch" false positives.

**Result:** A vanilla Claude Code session with file access produces 10× better analytical answers than Tango. This undermines Tango's value proposition as a thinking partner while its strengths (memory, voice, governance, multi-agent personality) go underutilized.

## Quality-Killing Layers — Detailed Analysis

### Layer 1: Concise Response Mode

**Where:** `packages/discord/src/main.ts` lines 2734-2743 (`composeSystemPrompt`)

```typescript
const policy = responseMode === "explain"
  ? "Response mode: explain. Give a concise step-by-step explanation and final answer."
  : "Response mode: concise. Give the direct answer only. Do not include internal reasoning or process narration unless explicitly asked.";
```

All agents except Juliet use `concise` mode. This instruction is injected into every system prompt, telling the LLM to suppress reasoning, comparisons, tables, and nuanced conclusions — exactly the output an analytical question needs.

**Precedent:** Juliet already uses `explain` mode for therapeutic education. This proves the system supports per-agent mode overrides.

**User override exists:** `/explain` prefix switches mode for one turn. But users don't know about it, and it shouldn't require manual invocation for obviously analytical questions.

### Layer 2: Worker Dispatch Context Stripping

**Where:** `packages/discord/src/turn-executor.ts` (worker-dispatch tag parsing), `packages/core/src/worker-agent.ts`

When the orchestrator dispatches to `health-analyst`, it writes a `<worker-dispatch>` tag with a task summary:
```xml
<worker-dispatch worker="health-analyst">Analyze the user's body fat trends at the same weight across recent months.</worker-dispatch>
```

The worker receives this task string + its tool contracts + a compacted warm-start context. The user's exact words, their reasoning, their framing ("help me understand", "what do you make of") — all lost. The worker answers a sanitized version of the question.

### Layer 3: Tool Boundedness

**Where:** `config/defaults/workers/health-analyst.yaml`

The health-analyst worker has exactly 4 tool contracts: `health_query`, `memory_search`, `memory_add`, `memory_reflect`. It cannot:
- Read Apple Health `.hae` exports directly
- Cross-reference Obsidian wellness notes
- Access FatSecret nutrition data (that's nutrition-logger's domain)
- Combine health + nutrition + workout data in one analysis

For analytical questions, the user often wants cross-domain synthesis. The worker architecture silos each domain.

### Layer 4: Memory Compaction

**Where:** `packages/core/src/memory-compaction.ts`

Compaction triggers at 24 turns. Older turns are truncated to 180 chars each, with a 1800-char total summary cap. In a long Malibu session (551/559 turns), this means:
- Specific measurements, dates, and data points from prior discussions are gone
- Context like "last time we discussed this, you said X" has no backing data
- The agent can't recall the trajectory of a multi-session analytical conversation

### Layer 5: Narration Guards

**Where:** `packages/discord/src/turn-executor.ts` lines 799-842

Guards check for patterns like "let me grab", "dispatching", "waiting on the worker" and suppress text matching those patterns. This is correct for transactional turns where the orchestrator narrates internal dispatch mechanics. But for analytical turns:
- Phrases like "let me walk through this" or "let me dig into the data" can trigger false positives
- The guard logic checks receipt status — if a worker completed but returned no confirmed write, the guard may still suppress legitimate analytical output
- Recent fix (TGO-232-234) added a bypass for completed receipts, but edge cases remain

## Proposed Design: Thinking Mode

### Core Concept

Add a **thinking mode** that activates per-turn when the system detects an analytical question. Thinking mode is an additive layer — it does not replace the transactional pipeline, it branches around the quality-killing layers for that turn only.

```
User message arrives
       │
  ┌────▼────────────────┐
  │ Thinking Detector    │  ← NEW: runs before or alongside intent classifier
  │ (heuristic + LLM)   │
  └────┬───────────┬─────┘
       │           │
  thinking=false   thinking=true
       │           │
       ▼           ▼
  TRANSACTIONAL    THINKING MODE
  (existing flow)  (bypass flow)
       │           │
       │     ┌─────▼──────────────┐
       │     │ Override concise   │  → response_mode = "thinking"
       │     │ Skip dispatch      │  → agent reasons directly
       │     │ Widen tool access  │  → governed file-read tools
       │     │ Extend context     │  → retain more recent turns
       │     │ Relax narr. guards │  → allow analytical phrasing
       │     └─────┬──────────────┘
       │           │
       └─────┬─────┘
             ▼
      Standard output path
      (memory, voice, audit)
```

### Trigger Detection

Three-tier detection with increasing confidence:

#### Tier 1: Keyword Heuristics (fast, zero-cost)

Match against the user's input text before any LLM call:

**Strong signals** (any one → thinking=likely):
- "analyze", "evaluate", "compare", "contrast", "correlate"
- "help me understand", "what do you make of", "walk me through"
- "why do you think", "what's your take on", "how would you explain"
- "trend", "pattern", "over time", "across months/weeks"
- "pros and cons", "trade-offs", "implications"

**Supporting signals** (2+ → thinking=likely):
- Question mark + multi-clause sentence (>20 words)
- "think about", "consider", "reflect on"
- Temporal comparison language: "last month vs this month", "since January"
- Quantitative language: "percentage", "average", "deviation", "range"

**Anti-signals** (override thinking → transactional):
- "log", "record", "save", "add", "delete", "set", "remind"
- Imperative verbs without reasoning markers
- Short commands (<8 words) without question marks

#### Tier 2: Intent Classifier Flag (low cost, already in pipeline)

Extend `IntentEnvelope` with:
```typescript
thinkingRequired?: boolean;  // classifier detected analytical intent
thinkingConfidence?: number; // 0-1 confidence that thinking mode is warranted
```

The intent classifier already runs on every turn. Adding a thinking detection instruction to its prompt costs ~50 tokens of input and ~2 tokens of output. The classifier sees the full user message and existing context, making it better at detecting nuanced analytical intent than keyword matching alone.

**Classifier prompt addition:**
```
Also assess whether this message requires analytical thinking (comparison, trend analysis, evaluation, explanation). Set thinkingRequired=true if the user is asking for analysis, reasoning, or explanation rather than a discrete action.
```

#### Tier 3: Explicit User Declaration (zero ambiguity)

- `/think` prefix: forces thinking mode for this turn
- `/concise` prefix: forces transactional mode (already exists)
- Agent personality hooks: "Malibu, break this down for me" → thinking

#### Resolution

```
if explicit /think prefix       → thinking = true
if explicit /concise prefix     → thinking = false
if classifier.thinkingRequired && classifier.thinkingConfidence > 0.7 → thinking = true
if keyword strong signal        → thinking = true (unless anti-signal)
if keyword 2+ supporting        → thinking = true (unless anti-signal)
else                            → thinking = false (transactional)
```

### What Thinking Mode Does

#### 1. Response Mode Override

New mode: `"thinking"` (sits alongside `"concise"` and `"explain"`).

System prompt injection:
```
Response mode: thinking. The user has asked an analytical question. Provide a thorough,
well-structured response. Use paragraphs, bullet points, tables, or comparison matrices
as appropriate. Include your reasoning, not just conclusions. It's OK to be 200-500 words.
Be honest about data quality, confidence levels, and what the data does/doesn't show.
```

This is distinct from `explain` (which is "concise step-by-step + final answer") — thinking mode explicitly permits long-form, structured, nuanced output.

#### 2. Skip Worker Dispatch

When thinking mode is active, the orchestrator does NOT dispatch to a worker. Instead, the agent (Malibu, Watson, etc.) reasons directly with:
- Its full personality prompt (soul.md)
- The user's exact words (no task summarization)
- Full recent conversation context
- Expanded tool access (see below)

**Why this is critical:** Worker dispatch exists to scope tool access and enforce governance. But for analytical questions, the bottleneck isn't tool access — it's the LLM having enough context and freedom to reason. The agent can still call tools, just through the governed agent-level tool surface instead of the worker's narrower one.

#### 3. Expanded Tool Access (Governed)

For thinking turns, temporarily widen the agent's tool surface:

| Agent | Current Tools | Thinking Mode Additions |
|-------|--------------|------------------------|
| Malibu | OFF (workers only) | `health_query` (read), `memory_search`, `memory_reflect` |
| Watson | WebSearch, WebFetch | + `obsidian_read` (read-only), `memory_search` |
| Sierra | WebSearch, WebFetch | + `obsidian_read` (read-only) |
| Victor | Full access | No change needed |

**Governance preserved:** These are the same tools the workers already use, with the same permission checks. The difference is the agent calls them directly instead of through a worker intermediary. The 4-step governance resolution (principal → group → parent → deny) still applies. Audit logging still fires.

**File access (future phase):** For questions like "analyze my Apple Health export", a governed `file_read` tool could expose specific directories:
- `~/Health/` — Apple Health exports (.hae, .csv)
- `~/Documents/Obsidian/Vault/` — Obsidian notes (read-only)
- Governed by the same permission system: agent must have explicit read access to the path

This is Phase 2 — Phase 1 uses existing tool contracts only.

#### 4. Context Preservation

For thinking turns, adjust compaction parameters:
- `retainRecentTurns`: 8 → 16 (keep more recent context)
- `maxTurnChars`: 180 → 400 (less aggressive truncation)
- `maxSummaryChars`: 1800 → 3600 (richer compaction summaries)

**Alternative (simpler):** Instead of adjusting compaction globally, inject a "thinking context block" that includes the last 5 analytical exchanges at full fidelity. This avoids changing the compaction algorithm and only costs tokens on thinking turns.

#### 5. Narration Guard Relaxation

For thinking turns, skip `looksLikeNarratedDispatch()` and `looksLikeIncompleteWorkerSynthesis()` checks. These guards exist to suppress orchestrator narration of internal dispatch mechanics — but in thinking mode, there IS no dispatch. The agent is reasoning directly, so phrases like "let me walk through" and "digging into the data" are legitimate analytical framing, not dispatch narration.

**Keep active:** `looksLikeContextConfusion()` (still valid — detects when the agent lost context) and write-confirmation guards (still valid — governance).

### What Thinking Mode Preserves

- **Memory reads/writes** — agent still queries and stores memories. Analytical conclusions can be remembered.
- **Voice integration** — thinking mode works in voice channels. Response may be longer, but Kokoro handles multi-paragraph TTS. Consider a "thinking..." earcon while the LLM generates.
- **Agent personality** — Malibu still sounds like Malibu. The soul.md prompt is still active. The response mode only controls structure and length, not voice.
- **Tool contracts and permissions** — broader access, still governed. No tool runs without permission check.
- **Audit logging** — all tool calls and LLM interactions logged as usual.
- **Agent ownership** — Malibu answers wellness questions in thinking mode, not Watson. The route classifier still determines which agent handles the message.

### What It Does NOT Do

- **Replace the transactional path** — "log my yogurt" still uses fast dispatch. Thinking mode only activates when detected or explicitly requested.
- **Disable safety guards** — write confirmation, dedup checks, access control all remain active.
- **Remove governance** — tool access is widened but still permission-checked. The escape hatch bypasses *dispatch*, not *governance*.
- **Break agent specialization** — each agent still owns its domain. Thinking mode gives the agent more power to reason within its domain.

### Edge Cases

#### Mixed requests: "Log my dinner and tell me if I'm on track"

**Proposed handling:** Split into two intents via the intent classifier (it already supports multi-intent). The "log" intent routes through the transactional pipeline. The "tell me if I'm on track" intent triggers thinking mode. Both run, and responses are composed:
1. Transactional: "Logged dinner: grilled chicken, rice, broccoli (485 cal)"
2. Thinking: "Looking at your day so far... [analytical response]"

**Alternative (simpler Phase 1):** If thinking is detected alongside a write intent, run the write through dispatch first, then run thinking mode for the analytical portion using the write receipt as additional context.

#### Voice latency

Thinking mode produces longer responses (200-500 words vs 1-3 sentences). Voice implications:
- **TTS latency:** Kokoro streams, so first audio starts quickly regardless of total length
- **User experience:** Play a "thinking..." earcon (like the existing confirmation earcon) to signal longer processing
- **Timeout risk:** Worker watchdog (90s activity timeout) doesn't apply since we skip dispatch. The main provider call has its own timeout (configurable).
- **Opt-out for voice:** Consider a config flag `thinking_mode_in_voice: true|false` per agent. Default: true (users want good answers regardless of modality).

#### Follow-up turns after thinking

**Proposed:** Thinking mode does NOT persist across turns. Each turn is independently classified. But the intent classifier gets context from the previous turn, so a follow-up like "what about sleep quality?" after a health analysis will likely be classified as thinking again due to contextual continuity.

**Explicit persistence:** User can prefix a conversation with `/think` to force thinking mode for that turn. No "sticky" mode — it's per-turn only to avoid accidentally producing 500-word responses to "thanks".

#### Agent specialization preservation

Thinking mode activates within the agent that owns the domain. The route classifier still determines agent assignment. If a user asks Watson "analyze my body composition", the route classifier routes to Malibu (wellness domain), and Malibu enters thinking mode. This is the correct behavior — the bypass doesn't break routing.

**Risk:** If the route classifier misroutes an analytical question (e.g., routes a health question to Watson because the user said "Watson, analyze my health"), the user gets Watson's thinking mode without wellness tools. Mitigation: the route classifier already handles this via callsign priority gates (TGO-225). No change needed.

## Phased Rollout

### Phase 1: Minimum Viable Thinking Mode (1-2 weeks implementation)

**Scope:**
1. Add `"thinking"` response mode to `composeSystemPrompt`
2. Add keyword heuristic trigger in `parseLeadingCommands` (detect `/think` prefix)
3. Add `thinkingRequired` flag to intent classifier output
4. When thinking detected: override response mode, skip worker dispatch, relax narration guards
5. No tool widening yet — agent uses its existing tool surface (even if `tools.mode: off`, it gets memory tools)

**Acceptance criteria:**
- User asks Malibu "analyze my body fat trends at the same weight" → gets 200-400 word structured analysis
- User says "log my yogurt" → still uses fast transactional dispatch
- `/think how's my nutrition tracking going?` → forces thinking mode
- Voice channel works with thinking mode (longer response, streamed TTS)

### Phase 2: Tool Widening + Context Preservation (1-2 weeks after Phase 1)

**Scope:**
1. Expand agent tool access in thinking mode (health_query, obsidian_read, etc.)
2. Implement thinking context block (retain recent analytical exchanges at full fidelity)
3. Add thinking earcon for voice channels
4. Add agent-level config: `thinking_mode: { enabled: true, tool_widening: [...] }`

### Phase 3: File Access + Cross-Domain (future)

**Scope:**
1. Governed file-read tool for Apple Health exports, Obsidian vault
2. Cross-agent data synthesis (Malibu can reference nutrition + health + workout)
3. Analytics-specific memory: store analytical conclusions as structured memories for cross-session continuity

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Thinking mode triggers too aggressively, makes transactional responses slow | Medium | Medium | Anti-signals for imperative commands; `/concise` override; monitor trigger rate |
| Skipping worker dispatch removes tool governance | Low | High | Agent-level tools still go through governance checker; audit logging unchanged |
| Longer responses annoy users who wanted a quick answer | Medium | Low | "thinking" earcon signals intent; response still starts streaming fast; user can `/concise` |
| Memory compaction changes affect other turns | Low | Medium | Phase 1 doesn't change compaction; Phase 2 uses per-turn context injection |
| False positives in trigger detection | Medium | Low | Worst case: user gets a longer answer than needed. Not harmful, just verbose. `/concise` override available. |
| Thinking mode becomes a crutch, masking dispatch pipeline bugs | Low | Medium | Monitor: if >30% of turns use thinking mode, the transactional pipeline may need its own improvements |

## Architecture Diagram

### Current Pipeline (All Turns)
```
User → Route Classifier → Intent Classifier → Deterministic Router
  → Worker Dispatch → Worker Agent (scoped tools, task summary)
  → Narration Guards → Concise Synthesis → Output
```

### Proposed Pipeline (With Thinking Branch)
```
User → Route Classifier → Intent Classifier + Thinking Detector
  │
  ├─ thinking=false → Deterministic Router → Worker Dispatch → ... (unchanged)
  │
  └─ thinking=true → Agent Direct Reasoning
                        ├─ Full user message (no task summarization)
                        ├─ response_mode="thinking" (long-form permitted)
                        ├─ Extended context window (more recent turns)
                        ├─ Widened tool access (governed, Phase 2)
                        ├─ Narration guards relaxed (no dispatch to narrate)
                        └─ Output → Memory, Voice, Audit (unchanged)
```

## Key Files

| File | Relevance |
|------|-----------|
| `packages/discord/src/main.ts` | `composeSystemPrompt`, `resolveResponseMode`, `parseLeadingCommands` |
| `packages/discord/src/turn-executor.ts` | Worker dispatch, narration guards, response synthesis |
| `packages/discord/src/intent-classifier.ts` | Intent classification (add `thinkingRequired` flag) |
| `packages/discord/src/deterministic-runtime.ts` | Deterministic execution plan (thinking mode skips this) |
| `packages/core/src/memory-compaction.ts` | Compaction parameters (Phase 2 adjustments) |
| `packages/core/src/config.ts` | AgentConfig types (add thinking mode config) |
| `config/defaults/agents/*.yaml` | Per-agent thinking mode configuration |

## Open Questions for Stakeholder

1. **Trigger aggressiveness:** Should thinking mode be opt-in only (`/think`) for Phase 1, or should automatic detection be included from the start?
2. **Voice latency tolerance:** Is a 10-15 second thinking response acceptable in voice channels, or should voice default to concise with a "say /think for deeper analysis" hint?
3. **Cross-domain synthesis:** Should Malibu be able to reference nutrition data (FatSecret) in a health analysis, or keep domains siloed even in thinking mode?
4. **Agent tool widening scope:** For Phase 2, which tools should each agent gain in thinking mode? Should this be configured per-agent or use a global "read-only access to own worker tools" rule?
