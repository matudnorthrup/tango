# State Management — Spec

**Status:** v5 — simplification pass: verdicts batched, receipts simplified, Obsidian editing rebuilt as an ingestion adapter, v1 scope trimmed (2026-07-17)
**Owner:** Tango PM · stakeholder: Devin
**Tracking:** Linear project *State Management* (work breakdown + status live there; this doc is the durable spec)
**Companion:** [`unified-memory-system.md`](unified-memory-system.md) — narrative/arc memory. This spec covers *typed, structured, deterministic* state. The two share substrate patterns and converge (§15).

---

## 1. Problem & evidence

Many things Devin works on with agents have **state that changes over time** —
projects in flight, body composition, health goals, vehicles, trips, budgets.
Tango has no system that tracks that state deterministically. Today, "state"
lives as atomic facts in Atlas memory, where it goes stale, accumulates
contradictions, and gets retrieved probabilistically. The result is
hallucination and confidently-wrong answers.

Evidence from the live databases (read-only audit, 2026-07-16):

1. **Contradictory snapshots coexist.** Atlas holds five active memories each
   asserting a different "current weight" (Apr–Jun 2026), at least seven
   mutually inconsistent daily-protein targets, and four different calorie
   budgets — all unarchived, all retrievable at once. Which one the model sees
   is a ranking coin-flip.
2. **Pinned facts drift.** The single Atlas `pinned_facts` row (a vehicle
   identity, updated 2026-06-05) is contradicted by two newer conversation
   memories naming a different vehicle. Both are live.
3. **Point-in-time state is stored as durable truth.** Memories self-describe
   as "current" ("Current fitness metrics baseline… Currently in deficit
   phase") and are never updated or archived. Trip-plan memories ("plans to
   visit … tomorrow") outlive the trip.
4. **The one structured state row we have is stale.** `project_state` contains
   exactly one row, untouched since 2026-06-05, still describing a trip that
   has come and gone. `topics` has 148 "active" rows and 1 archived — status
   fields exist but nothing maintains them.
5. **State-shaped questions get non-deterministic answers.** Real transcript
   samples: "what projects am I working on" has no queryable source; "how am I
   doing against budget" was asked three times and got the same non-answer;
   task progress across a timeout had to be carried by the user re-stating it;
   a location answer was computed from a 31-day-stale GPS fix without complaint
   until asked. During travel this compounded: the user had to re-state what
   day it was and where he was, and the agent still answered from stale state.
6. **Archival is the exception, not the rule.** Only ~3% of Atlas memories are
   archived. `active_tasks` is the *only* table observed that expires state
   deterministically (`expires_at` → `expired` status) — and it works.

**Goal:** a flexible, schema-governed state layer where stateful things are
*defined once, updated transactionally, queried deterministically, and injected
into every turn as canonical truth that overrides memory.*

---

## 2. Goals & non-goals

**Goals**

- Define arbitrary *state entity types* (project, body-composition,
  mental-health check-in, vehicle, trip, budget…) with typed attributes,
  allowed statuses, and lifecycle policies — without a migration per type.
- One canonical **current value** per entity, plus an **append-only event
  history** (trends, "as of" queries, audit).
- **Deterministic reads**: "what projects am I working on" is a query, not a
  semantic search.
- **State beats memory**: agents are given current state every turn with an
  explicit precedence rule; memories that assert stale current-truth get
  archived — never rewritten (two-ledgers discipline, §11).
- **Capture is a subprocess, not a hope**: a dedicated per-turn AI call (the
  State Reconciler, §9) with its own instruction set detects and applies state
  changes — the serving agent is never relied on to do this consistently.
- **Visible writes**: every state change made in a conversation is printed in
  the channel so the user can intervene (§10).
- **Nothing is destroyed**: entities finish or archive, events append, reverts
  are new events, memories archive reversibly. The history is deterministic.
- Multiple **write paths**: explicit tool calls, the per-turn reconciler, the
  dashboard, Obsidian edits to declared fields, external sync, scheduled
  check-ins.
- **Staleness is a first-class signal**: per-type freshness policy, sweep job,
  nudges, auto-expiry.
- **Human-observable**: a read-write dashboard on the tailnet (§13).

**Non-goals**

- Replacing Atlas memory. Preferences, biography, decisions, and narrative
  remain memories. State management owns *volatile facts with a current value*.
- Linear sync (**deferred by decision** — see §3). Project entities are native
  in v1; a one-way Linear adapter can be revisited after Slice 5.
- Replacing the Unified Memory System's project-arc narrative (state files /
  Obsidian bodies). Entities may *point at* a narrative body; they don't
  duplicate it.
- A general workflow engine. Status transitions are validated, not orchestrated.

---

## 3. Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Human/AI data boundary | **UMS-style hybrid; Obsidian edits ingest as a write path** (2026-07-16, revised 2026-07-17) | DB head is the *single* canonical source at read time. Any entity can link an Obsidian body via `body_pointer` for human-readable narrative/detail. Editing state in Obsidian is supported for a type's declared fields — via the **Obsidian adapter** (§7.1): watcher-based ingestion through the service layer, with head→frontmatter mirroring so docs never go stale. The v4 read-time overlay (dual truth) is dropped as brittle. Rule of thumb stands: *if a human needs to access it, it lives in Obsidian.* |
| Dashboard | **Read-write for entities; types read-only in v1; no auth** (2026-07-16, trimmed 2026-07-17) | Locally hosted, exposed only via Tailscale path-mount alongside `/kilo` and `/tango-workout`; tailnet membership is the trust boundary. Entity editing is full; type creation/editing ships later (a JSON-Schema-builder UI is disproportionate for v1 — types come from seeds + gated conversation). |
| Multi-user & privacy | **Profile-scoped + reserved owner column** (2026-07-16) | Entities, events, and user-defined types live in the per-profile `tango.sqlite` (already per-user by design). Repo ships only generic type schema *templates* — field definitions, never values. `owner_user_id` reserved on entities now; multi-user routing not built yet. A second user gets their own profile/instance. |
| Pilot types | **All four:** `project`, `travel`, `body-composition`, `vehicle` (2026-07-16) | Together they exercise every mechanism: statusful workflow, time-bound expiry + location freshness, observation stream + supersession, and the Obsidian-boundary registry. Vehicles are modeled per-item (§4 collections convention). |
| Type authoring | **Seeds + gated conversational; additive-only evolution in v1** (2026-07-16, tightened 2026-07-17) | Pilot types ship as curated seeds; "start tracking my reading list" drafts a type and creates it after a one-line user confirmation. Type evolution is **additive-only** in v1: new optional fields yes; renames, removals, and retyping of existing fields no — existing entities must never stop validating. |
| Capture mechanism | **Dedicated per-turn reconciler subprocess** (2026-07-17) | A separate AI call with its own very specific instruction set runs after **every** turn, on its own extraction-class model, diffs the turn against current state, and emits a validated changeset (§9). The serving agent's model is never relied on to update state consistently. No keyword gating: selective triggers are how changes get missed. |
| Capture auto-apply | **Aggressive with visibility** (2026-07-16) | All reconciler changes auto-apply (every change is an event, so everything is revertible) **and every applied change is printed in the channel** so the user sees it and can intervene (§10). |
| History discipline | **Archive-only; two ledgers** (2026-07-17) | Nothing is overwritten or deleted, anywhere. Entities finish/archive via status, events are append-only (reverts are new events), and Atlas memories are archived — reversibly — never edited or removed. Atlas is the *conversational history*; state is the *state history*; they diverge by design and are reconciled at read time (§11). |
| V1 simplification pass | **Accepted** (2026-07-17) | Supersession verdicts run batched in the sweep, not on-write (§11); receipts are a follow-up line, edit-in-place is an enhancement (§10); undo defaults to turn-level (§10); reconciler snapshot carries a full entity name-index (§9); Slice 4 ships two adapters (health-export + Obsidian), workout + OwnTracks deferred — OwnTracks has a hidden revive-the-feed dependency (§8); dashboard writes go through a bot-process HTTP API and the core DB gains `busy_timeout` (§5, §13). |
| Linear sync | **Skipped for v1** (2026-07-16) | Project entities are native; revisit a one-way Linear adapter later. |

---

## 4. Conceptual model

Three concepts, mirroring how the existing substrate already succeeds
(`active_tasks` for lifecycle, `project_state` for head+body, Atlas for recall):

```
state_entity_types     the catalog: what kinds of things we track, their
                       attribute schema, statuses, staleness policy, digest template
        │ 1:N
state_entities         the heads: one row per tracked thing; canonical current
                       value (status + attributes + one-line summary + aliases)
        │ 1:N
state_events           the ledger: append-only history of every change and
                       observation, with provenance (who/when/which turn)
```

- **Type** = "we track things like this" — e.g. `body-composition` with
  attributes `{weight_lb, body_fat_pct, protein_goal_g, calorie_target}`,
  no statuses, staleness = 7 days.
- **Entity** = "this specific thing" — e.g. `project:<slug>` with status
  `active`, attributes `{next_action, target_date, collaborating_agent}`.
- **Event** = "this changed / was observed" — e.g. an observation event with
  `{weight_lb: <value>}` from the morning weigh-in sync. Trend questions are
  `SELECT` over events; current-value questions read the head.

**Collections convention:** when items have independent lifecycle or detail,
model each item as its own entity — the `vehicle` type is one entity per
vehicle, each with its own `body_pointer` to its vault doc; the "registry" is
just `state_query {type: vehicle}`. Reserve array-valued attributes for small
atomic lists that change as a unit (patch semantics on arrays are ugly;
per-item entities keep the event ledger clean).

Flexibility requirement is met by **types-as-data**: adding a new tracked kind
is a `state_define_type` call (JSON Schema for attributes, status list +
transitions, staleness policy), not a code change or migration. Evolution is
additive-only in v1 (§3).

**Post-v1 workflow projection (2026-07-17):** recurring finance work adds two
generic seeded types without turning state into an orchestrator:
`automation-job` projects the latest scheduler run plus a deterministic
post-check, and `finance-review` records seven evidence-backed review
checkpoints. `schedule_runs` remains authoritative for whether code executed;
state answers whether the domain outcome was verified. Both types carry
provider-neutral `body_pointer` links to the applicable monthly job log or
weekly review note. A normal agent return never completes a review by itself.

---

## 5. Storage

**Location:** `tango.sqlite` (core store), new migration. Check live
`PRAGMA user_version` before numbering (the v1 substrate is 63; the scoped
workflow-projection type seeds are migration 64).
Atlas stays the *semantic* tier; state is *relational* and belongs beside
`active_tasks` / `project_state`, sharing their WAL/transaction semantics.
Because `tango.sqlite` is per-profile, all state data is profile-scoped by
construction (locked decision §3).

```sql
CREATE TABLE state_entity_types (
  id TEXT PRIMARY KEY,              -- 'project', 'body-composition', ...
  display_name TEXT NOT NULL,
  description TEXT,
  attributes_schema TEXT NOT NULL,  -- JSON Schema for entity attributes (additive-only evolution in v1)
  statuses TEXT,                    -- JSON: allowed statuses + transitions; NULL = statusless
  staleness_policy TEXT,            -- JSON: {expected_update_days, on_stale: nudge|expire|archive}
  digest_template TEXT,             -- render template: {placeholders} over attributes +
                                    -- built-in helpers age()/days_until()/day_of(); no code
  body_fields TEXT,                 -- JSON array: attribute fields synced with a linked body's
                                    -- frontmatter via the Obsidian adapter (§7.1)
  visibility TEXT NOT NULL DEFAULT 'shared',  -- shared | private:<scope>
  origin TEXT NOT NULL DEFAULT 'seed',        -- seed | conversation | dashboard
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE state_entities (
  id TEXT PRIMARY KEY,              -- '<type>:<slug>'
  type_id TEXT NOT NULL REFERENCES state_entity_types(id),
  slug TEXT NOT NULL,               -- service-assigned, kebab-case, immutable
  title TEXT NOT NULL,
  aliases TEXT,                     -- JSON array: alternate names for resolution (§9)
  status TEXT,                      -- validated against type.statuses
  attributes TEXT NOT NULL,         -- JSON, validated against type.attributes_schema
  summary TEXT,                     -- one-line quick read for digests
  body_pointer TEXT,                -- optional narrative body (provider-neutral pointer, same
                                    -- contract as project_state.obsidian_path)
  body_fields_hash TEXT,            -- hash of body-synced fields as last mirrored/ingested (§7.1)
  owner_user_id TEXT,               -- reserved for multi-user; unused in v1
  owner_agent_id TEXT,
  source TEXT NOT NULL,             -- conversation | tool | reconciler | dashboard | sync:<adapter> | seed
  last_event_at TEXT,
  stale_after TEXT,                 -- computed from type staleness policy on each write
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,                 -- archive-only lifecycle; rows are never deleted
  UNIQUE (type_id, slug)
);
CREATE INDEX idx_state_entities_type_status ON state_entities(type_id, status, archived_at);
CREATE INDEX idx_state_entities_stale ON state_entities(stale_after) WHERE archived_at IS NULL;

CREATE TABLE state_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id TEXT NOT NULL REFERENCES state_entities(id),
  kind TEXT NOT NULL,               -- status_change | update | observation | note | sync |
                                    -- archive | revert (reverts reference the original; nothing deleted)
  patch TEXT,                       -- JSON: {field: {from, to}} or observation values
  note TEXT,
  actor TEXT NOT NULL,              -- agent id | 'user' | 'reconciler' | 'dashboard' | 'sync:<adapter>' | 'sweep'
  session_id TEXT,                  -- provenance: which conversation produced this
  message_id TEXT,
  occurred_at TEXT NOT NULL,        -- when the fact was true (backdatable)
  recorded_at TEXT NOT NULL         -- when we wrote it
);
CREATE INDEX idx_state_events_entity ON state_events(entity_id, occurred_at);

CREATE TABLE state_focus (
  conversation_key TEXT NOT NULL,   -- 'channel:{id}' / 'thread:{id}'
  entity_id TEXT NOT NULL REFERENCES state_entities(id),
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,         -- TTL'd; refreshed when a turn engages the entity
  PRIMARY KEY (conversation_key, entity_id)
);
```

Design notes:

- **Head + ledger, not ledger-only.** Reads are hot (every turn); the head keeps
  them O(1). Every head write appends an event in the same transaction.
- **One write path, one writer process.** Tools, the reconciler, dashboard,
  adapters, and the sweep all call the same service module (validate →
  transact → event → receipt) **inside the bot process**; the dashboard
  frontend talks to a thin HTTP API the bot serves (§13) rather than opening
  the SQLite file from a second process. The service layer also exposes
  `revert(event_id)` (§10).
- **`busy_timeout`:** the core DB currently sets none (audit finding; Atlas and
  the wellness MCP server set 5000ms). This migration's rollout adds it —
  cheap insurance even with the single-writer design.
- **JSON attributes validated at write time** against the type's JSON Schema.
- **`occurred_at` vs `recorded_at`** enables backdated observations ("I weighed
  in this morning") and correct trend queries.
- **`stale_after`** is denormalized so the sweep and the digest can flag
  staleness without evaluating policy JSON per row.
- **Derived values are never stored** (day-of-trip, fix age, days-behind);
  they render at read time via the digest-template helpers.
- Volume is trivial next to existing tables; no perf concern.

---

## 6. Tool surface

One small MCP tool family (working name: `state`). **Governance gotcha applies
(TGO-737):** new MCP tools are invisible to all agents until seeded in
`governance_tools` *and* granted — the migration must do both, for the
`-ollama` clones too, and agent YAML `ALLOWED_TOOL_IDS` must be updated.

| Tool | Access | Purpose |
|---|---|---|
| `state_query` | read | List/filter entities (`type`, `status`, `stale=true`, text match); get one entity with recent events; trend query over events (field, window, aggregation). |
| `state_update` | write | Upsert an entity; patch attributes; transition status (validated against type transitions); append an observation/note event; revert by event or turn (§10). One tool, mode parameter — keeps grant surface small. |
| `state_define_type` | admin | Create or evolve (additive-only) a type definition. Seeds ship the pilots; conversational creation is gated behind a one-line user confirmation (locked decision §3). |

Deliberately *not* separate tools per operation: small surface = simpler
grants, simpler clone adherence, simpler prompts. The dashboard (§13), the
reconciler (§9), and the Obsidian adapter (§7.1) are additional clients of the
same service layer, not second implementations.

Answering the motivating questions becomes deterministic:

- *"What projects am I working on?"* → `state_query {type: project, status: active}`
- *"Which projects are behind?"* → `state_query {type: project, stale: true}` or
  filter on `attributes.target_date < today`
- *"What's my current weight / trend?"* → head read + event trend query
- *"Which projects do we need to work on today?"* → active projects sorted by
  `attributes.next_action` / target date / staleness
- *"What vehicles do I have?"* → `state_query {type: vehicle}`; per-vehicle
  detail lives in each entity's linked vault doc

---

## 7. Read path: per-turn digest + precedence rule

The tool is the deep-read path, but the **default read path must not depend on
the model choosing to call a tool** — the Ollama clones (primary voice targets)
demonstrably ignore optional tooling, and Claude runtimes drop warm-start
context on session resume.

Inject a compact **state digest** into the turn briefing
(`packages/core/src/turn-briefing.ts`) — the one channel that survives resume
and reaches stateless Ollama runtimes every turn. **The digest reads the head
only** — no file I/O in the read path; the Obsidian adapter (§7.1) keeps the
head current with human edits.

```
state (canonical — overrides anything remembered):
- [project] E-350 purchase — active; next: inspect listing (updated 2d ago)
- [travel] <trip> — day 3 of 5, in <city>; location updated 2h ago
- [body-composition] weight <val> lb, protein goal <val> g (updated today)
(3 more: state_query)
```

**Selection: a deterministic priority ladder** (fill tiers in order until the
~400-token budget is spent; within a tier, most recently updated first):

1. **Conversation-focused entities** — from `state_focus`, written by the
   reconciler whenever a turn clearly engages an entity (TTL'd, refreshed on
   touch). This replaces reliance on the near-empty `project_focus` /
   `topic_focus` tables (0 and 6 rows in the audit), which remain as inputs
   when present.
2. **The agent's always-on types** — per-agent config (e.g. health types for
   the wellness agent, projects for the PM agent).
3. **Recently updated** — entities with events in the last 24h, within the
   agent's visibility.
4. **Stale-flagged** — entities the sweep marked ⚠ in the agent's scope.

Overflow collapses to a count + tool hint. Until the reconciler ships
(Slice 3), tier 1 is empty and tiers 2–4 carry the digest.

**Precedence rule (the hallucination fix):** the digest header instructs that
these values are canonical and override memory. Symmetrically, the memory
system's prompt framing changes: retrieved memories that carry a state-entity
tag are presented as *historical* ("as of <date>"), never as current truth.

**Rendering:** `digest_template` is a deterministic mini-template —
`{placeholder}` substitution over attributes plus a fixed helper set
(`age(field)`, `days_until(field)`, `day_of(start_date, end_date)`, staleness
marker). No arbitrary code; derived values (day 3 of 5, fix 2h old) are
computed at render time, never stored.

Cold-start reseed (`v2-runtime.ts`) additionally includes the digest so a
rotated session re-orients on current state, composing with the UMS rich
reseed.

### 7.1 The Obsidian adapter (editing state in the vault)

Obsidian editing is supported — but as an **ingestion write path**, not a
read-time overlay (revised locked decision, §3). The head stays the single
source of truth; the vault doc is a human surface kept in lockstep.

- **Declared fields only.** A type's `body_fields` lists the attribute fields
  (plus `status`) that sync with a linked body's frontmatter. Everything else
  in the doc is free narrative, untouched by the system.
- **Ingest (human → head).** A file watcher on linked bodies (direct fs I/O,
  per the Obsidian background-job convention; the watch set is small — only
  entities with a `body_pointer` and a type declaring `body_fields`) parses
  frontmatter on change, validates, diffs against the head, and submits real
  changes through the service layer (`actor: 'user'`, `source: obsidian`) —
  an ordinary event in the ledger, visible on the dashboard, reflected in the
  next turn's digest. Latency: seconds.
- **Mirror (head → doc).** When the head changes and a linked body declares
  `body_fields`, the service layer writes those frontmatter keys back into the
  doc. This is not cosmetic — it is **load-bearing for correctness**: because
  the doc always equals the head between human edits, any watcher-detected
  diff is unambiguously human intent. (Without the mirror, a stale doc plus an
  unrelated narrative edit would falsely re-ingest old values.)
- **Loop safety.** `body_fields_hash` on the entity records the synced-field
  hash as last mirrored/ingested. The watcher skips when the doc's field hash
  equals the stored hash (our own mirror write, or no field change); ingestion
  and mirroring both converge doc == head, so echoes are structural no-ops.
- **Failure modes, handled boringly.** Validation-failing human edits are not
  applied — flagged on the dashboard and ⚠ in the digest; the doc is never
  "corrected" out from under the human. Mirror-write failures (vault
  unavailable) are retried by the sweep, which also does a startup/periodic
  scan as the watcher's backstop. Off-vault operation degrades cleanly: no
  watcher, head remains canonical, docs lag until the vault returns.
- UMS write-guard and `source_kind` protections apply to any body writes; the
  mirror only ever touches declared frontmatter keys.

---

## 8. Write paths

Six, all through the single service-layer write path (§5):

1. **Explicit tool calls (Slice 1).** Agent calls `state_update` during a turn
   ("mark the E-350 project blocked"). Kept because it lets an agent act on
   state *within* a turn — but it is **best-effort, not the guarantee**. The
   guarantee is path 2.
2. **The State Reconciler (Slice 3) — the primary capture path.** A dedicated
   per-turn AI subprocess with its own instruction set; see §9. Whatever the
   serving agent did or didn't do, the reconciler diffs every turn against
   current state and applies the delta.
3. **Dashboard writes (Slice 2).** Create/edit/archive entities from the
   tailnet dashboard (§13); `actor: 'dashboard'` on the events.
4. **Obsidian adapter (Slice 4).** Human edits to declared fields in linked
   vault docs ingest as events (§7.1).
5. **External sync adapters (Slice 4, scoped).** v1 ships **one**:
   health-auto-export MongoDB → `body-composition` observations, on the
   existing in-process scheduler. Workout-DB and OwnTracks adapters are
   deferred — OwnTracks first needs its feed revived (the audit's 31-day-stale
   GPS fix exists *because* OwnTracks isn't live). *(Linear adapter deferred —
   §3.)*
6. **Scheduled check-ins (Slice 4).** Types can declare a check-in cadence
   (e.g. mental-health weekly); the scheduler runs a v2 agent turn that asks,
   then records an observation event. Missed check-ins are just staleness.

Duplicate-write safety: multiple paths can touch the same fact. The service
layer's idempotence check against the **live head at apply time** makes the
second write a no-op, and the reconciler receives the turn's tool calls as
input so it does not re-apply what the agent already wrote.

---

## 9. The State Reconciler (per-turn subprocess)

**Locked decision (2026-07-17):** capture is not the serving agent's job. A
separate AI call with its own very specific instructions runs after **every**
turn, on its own model, and is the system's guarantee that state gets updated.

**Why a subprocess.** Serving models cannot be trusted to consistently
self-report state changes: the Ollama clones demonstrably ignore optional
tooling, models vary in tool adherence, and even strong models prioritize the
user-facing task over bookkeeping. Running capture out-of-band on a dedicated
extraction-class model makes capture quality uniform across every agent and
backend — the same property that made post-turn memory extraction and
active-task continuation work.

**Pipeline position.** Runs in the existing post-turn hook
(`packages/discord/src/v2-runtime.ts`), ordered **first** among the post-turn
passes:

```
turn completes → reply posted immediately (reconciler adds zero reply latency)
  1. State Reconciler   → propose changeset → service layer validates+applies
                        → receipt posted to the channel (§10)
                        → state_focus refreshed for engaged entities
                        → claimed-facts list handed to pass 2
  2. Memory extraction  → suppresses facts claimed by the reconciler
                          (enforces the routing rule: state-shaped facts go to
                          the state store, not Atlas — closes the tap that
                          created the five-weights problem)
  3. Active-task continuation (unchanged)
```

**Inputs** (assembled deterministically, ~2–4K tokens):

- the completed turn: user message + agent reply in full; the turn's tool
  calls with results **truncated** to a per-result cap and a total budget
  (prior receipt lines stripped so the reconciler never re-ingests its own
  output);
- the **entity name index**: slug, title, and aliases of **all active
  entities** (one line each — a few hundred tokens at realistic scale), so
  resolution never misses an entity merely because it fell outside digest
  scope;
- the **scoped current-state snapshot**: digest-scoped entities with full
  attribute values and their few most recent events (so undo/correction has a
  target and unchanged values are recognizable);
- the **type catalog** (schemas, statuses, staleness) so it knows what is
  trackable and what a legal change looks like;
- turn metadata: timestamps (for `occurred_at`), session/message ids
  (provenance), agent id.

**Contract (its own instruction set):**

- detect explicit or clearly-implied state assertions in the turn; classify
  each as `observation | attribute update | status transition | new entity |
  revert | no-op`;
- every proposal must **quote its evidence** from the turn;
- never invent values not stated or directly computed in the turn;
- never propose a value equal to current state (idempotence — enforced again
  by the service layer against the live head);
- **entity resolution:** map mentions ("the van", "that Eugene listing")
  against the full name index; prefer matching an existing entity; propose
  `new entity` only when nothing plausibly matches; when the user refers to a
  known entity by a new name, propose an alias addition (an ordinary `update`)
  so future resolution is exact;
- **undo & correction:** "undo that / no, that's wrong" → propose a `revert`
  of the referenced turn's changeset (§10); "it was 174, not 175" → propose an
  `update` citing the event being corrected;
- backdate `occurred_at` when the turn says so ("weighed in this morning");
- output is a **structured changeset** (JSON-schema-constrained), never prose.

**The model proposes; deterministic code disposes.** The changeset goes
through the same service-layer write path as every other client: JSON-schema
validation, transition-legality check, transaction + event append
(`actor: 'reconciler'`). Slugs for new entities are assigned by the service
layer (kebab-case from title, uniquified), immutable thereafter. Invalid or
non-grounded proposals are dropped and logged — never partially applied.

**Dedup backstop.** Resolution will occasionally miss: the sweep (§12) flags
near-duplicate titles/aliases within a type, and the dashboard offers a merge
— which archives the duplicate with a `merged_into` note; its events are
retained under the archived entity (archive-only, §3).

**Model assignment.** Per the golden-path-first practice: establish the
process on a capable model, then bake off cheap candidates
(`scripts/model-bakeoff.mjs`) and assign per-task in config. Known constraints:
gpt-oss:20b is a broken extractor (empty content on Ollama Cloud);
deepseek-v4-pro:cloud and Haiku are the proven extraction paths. The
reconciler's model is configured independently of every serving agent's model
— that independence is the point.

**Labeled fixture set (explicit Slice 3 deliverable).** Curated from real
transcripts: each fixture = turn + snapshot → *expected changeset*, including
deliberate no-op turns (false-positive rate), undo/correction turns, and
entity-resolution traps (same entity by different names). This dataset drives
the model bake-off and remains as the regression suite; a parallel labeled set
drives the supersession-verdict eval (§11). No bake-off result means anything
without it.

**Cost & latency.** Runs every turn by design — no keyword or heuristic gating
(locked). At ~2–4K input tokens on an extraction-class model this is
sub-second and pennies per day at current volume (~40–70 turns/day).
User-facing latency is unaffected: the reply posts first, the receipt follows.

**Failure handling.** A reconciler failure never blocks or delays the reply.
Transient errors retry with backoff (same pattern as the Ollama rate-limit
retry); persistent failures land in `dead_letters` and surface on the
dashboard. **Fail-open is explicit:** if the reconciler fails, memory
extraction proceeds *unsuppressed* (occasional state-facts leak to Atlas
rather than post-turn processing halting). Because a silent capture outage
looks identical to "nothing changed," the sweep (§12) checks *reconciler
last-ran recency* and flags a stall — absent receipts are the human-visible
symptom.

**Observability & eval.** Every run is recorded (model, latency, proposal
count, applied/rejected with reasons) via `model_runs` metadata +
`state_events`.

**Future optimization (explicitly deferred):** merging the reconciler, memory
extraction, and active-task continuation into one combined post-turn call
would save a model invocation, but the reconciler ships as a **separate call**
first — isolation, its own instructions, its own model assignment, its own
eval — and merging is only considered once both passes are stable and
measured.

---

## 10. State-change receipts + undo

Locked decision: writes are aggressive, so they must be **visible** — and
because history is append-only, everything is **revertible**.

- Any state mutation applied for a conversational turn — whether by the
  agent's own tool call or by the reconciler — renders a compact receipt in
  the channel. New-entity creations are the loudest case:

  ```
  ⟢ state: body-composition weight → <val> lb · NEW project/e350-purchase (active)
  ```

- **Mechanics (simplified, v5):** the baseline is a **small follow-up
  message** posted right after the reply — one uniform mechanism across plain
  messages, chunked long replies, webhook personas, threads, and voice (voice
  additionally records via the `voice_turn_receipts` precedent). Editing the
  receipt *into* the reply message is an enhancement applied only in the
  simple case (single plain bot message), not a correctness dependency. A
  follow-up line is also harder to miss on mobile than a silent edit — which
  serves the intervene-if-wrong goal.
- **Undo, concretely:** `revert` operates at **turn granularity** by default —
  "undo that" reverts the referenced turn's whole changeset (the receipt
  presents it as one unit); per-event revert remains available on the
  dashboard. A revert applies inverse patches, appends `revert` events
  referencing the originals (nothing deleted), and **un-archives** any
  memories whose archival links to the reverted events (§11).
- Out-of-band mutations (dashboard, adapters, sweep) don't emit Discord
  receipts; they're visible on the dashboard's event timeline. A staleness
  *nudge* (§12) may reference them.
- This composes with the UMS L4 per-turn receipt design; when both ship, state
  changes are one line item of the general turn receipt rather than a separate
  block.

---

## 11. Two ledgers: memory vs state (archive-only supersession)

**Locked decision (2026-07-17): nothing is overwritten or deleted — anywhere.**

The framing: **Atlas is the conversational history; state is the state
history.** Atlas records what was said, felt, and decided — point-in-time
records that are *correct as records* even when the world moves on. State
records what was true, when, and what is true now. The two will often diverge,
by design. Divergence is resolved at **read time** — the digest precedence
rule and date-framing (§7) — never by rewriting either history.

Concretely:

- Memories are never edited or deleted. When state ownership of a fact makes a
  memory misleading *as current truth*, the memory is **archived**: excluded
  from default retrieval, fully retained, reversible.
- Entities are never deleted: a finished thing is status `finished`/`done`
  (still queryable), an obsolete one is archived.
- Events are append-only; even reverts are new events pointing at the
  original.

**Three mechanisms, in load-bearing order:**

1. **The routing rule (§9)** stops *new* contradictions: state-shaped facts
   captured by the reconciler never become Atlas memories.
2. **Read-time precedence + date-framing (§7)** neutralizes *old* ones: the
   canonical value is in context every turn, and entity-tagged memories render
   as historical.
3. **The supersession verdict — batched in the sweep, not on-write (v5).**
   Because mechanisms 1–2 carry the anti-hallucination load, archiving
   conflicting legacy memories is cleanup, not a hot-path requirement. The
   sweep batches candidates (entity-tagged memories first; semantic search for
   legacy) to a dedicated verdict call — same extraction-class tier as the
   reconciler, its own instruction set and labeled eval set:

   | Verdict | Meaning | Action |
   |---|---|---|
   | current-truth assertion | asserts a current value for a fact state now owns | archive, `superseded_by: <event_id>` metadata |
   | state-adjacent narrative | mentions the fact but records conversation | keep; tag with entity id (date-framed at retrieval) |
   | unsure | can't tell | **keep and tag** — never archive on uncertainty |

   Verdicts are logged; the dashboard shows recent archives; reverting a state
   event un-archives what it superseded (§10).

**One-time backfill = a supervised job, not a side effect.** Per pilot type: a
script sweeps Atlas for state-shaped memories, seeds/updates the entity with
the latest value (as a backdated event trail where history is worth keeping),
and produces a **dry-run report** of proposed archives for human review before
applying. The weight/protein/calorie contradiction set is the acceptance
fixture.

Memories *about* state (context, feelings, decisions) stay memories forever;
tagging just lets retrieval frame them in time.

---

## 12. Staleness, lifecycle, workflows

- **Per-type staleness policy:** `{expected_update_days, on_stale}`.
  `on_stale: nudge` → sweep flags it (digest ⚠, optional Discord nudge);
  `expire` → status auto-set (the `active_tasks` pattern — the one mechanism
  proven to work here); `archive` → for time-bound types like trips, entities
  with an `end_date` attribute auto-archive after it passes.
- **Sweep job:** a deterministic scheduler job (15s-tick engine, new schedule
  config). Duties: recompute `stale_after` flags and apply `on_stale` actions;
  run batched supersession verdicts (§11 — the sweep's one LLM-calling duty);
  retry Obsidian mirror failures + periodic body scan (§7.1); flag
  near-duplicate titles/aliases for the dashboard merge queue (§9); check
  reconciler last-ran recency (§9); emit `sweep` events.
- **Workflows = validated transitions.** A type's `statuses` JSON lists states
  and legal transitions (e.g. project: `idea → active ↔ blocked ↔ waiting →
  done | dropped`). Writes rejecting illegal transitions return an actionable
  error the model can self-correct on. Nothing more elaborate until a real use
  case demands it.

---

## 13. State dashboard (observability)

Locked decision: **read-write for entities, part of the initial offering, no
auth; types read-only in v1** (§3).

- **Hosting:** frontend served locally, exposed only via Tailscale Serve
  path-mount at `/tango-state`, following the established tailnet-site
  convention (root directory page + `/kilo` + `/tango-workout`; take the next
  port in that series and register on the root directory page). Tailnet
  membership is the trust boundary — no app-level auth.
- **Write path:** the dashboard talks to a thin HTTP API **served by the bot
  process** (the wellness-server pattern), which calls the same service module
  as the tools — validation, transactions, events (`actor: 'dashboard'`)
  included. One writer process; no second SQLite client (§5).
- **Scope (v1):**
  - entity list with type / status / staleness filters and search;
  - entity detail: current head, event timeline (with per-event and per-turn
    revert), linked body pointer (deep-link into Obsidian where applicable);
  - edit: patch attributes, transition status (same validation as tools),
    archive/restore; create entities;
  - types: **view-only catalog** (creation/editing via seeds + gated
    conversation; a schema-builder UI is deferred);
  - staleness board: everything flagged ⚠ by the sweep, body-validation
    warnings, the duplicate-merge queue, reconciler health (last run, recent
    failure count), and recent supersession archives.
- **Profile-scoped:** the dashboard serves the profile it runs under; it never
  aggregates across profiles.

---

## 14. Governance & privacy

- Seed `state_query` / `state_update` / `state_define_type` in
  `governance_tools` + grants in the same migration; include all `-ollama`
  clones (TGO-737 lesson).
- **Type-level visibility:** `visibility: private:<scope>` types (health,
  mental-health) are only visible to designated agents' queries and digests;
  enforced in the service layer via the existing 4-step governance resolution,
  logged to `governance_log`. The reconciler honors the same scoping: it only
  receives (and can only write) types visible to the serving agent's context.
- **System/profile boundary (locked decision §3):**
  - The **repo** ships code + generic type schema *templates* only — field
    definitions and example digest templates, never values, never
    user-specific type instances.
  - **All data** (entities, events, user-created types) lives in the
    per-profile `tango.sqlite` and per-profile Obsidian/profile bodies —
    outside the repo by construction.
  - Sensitive type *definitions* a user doesn't want in the repo can be
    created per-profile (conversationally) instead of seeded.
  - The existing CI privacy gate + pre-push hook remain the backstop; this
    spec and Linear artifacts use placeholders, never real values.
  - Multi-user: each user runs their own profile/instance; `owner_user_id` is
    reserved so a future shared instance can scope without a schema change.
- Private values in the DB are already covered by the nightly restic-encrypted
  B2 backup.

---

## 15. Relationship to existing systems

| Existing | Relationship |
|---|---|
| **UMS `project_state` (head+body)** | Same pattern, narrower scope. Converge in Slice 5: `project_state` becomes a `project`-type entity; `body_pointer` carries the Obsidian/profile body; UMS whisper pointer and the state digest merge into one turn-briefing block. Until then they coexist without overlap (UMS = narrative arc, this = structured status). |
| **`active_tasks` / active-task continuation** | Complementary, not merged. Tasks are short-lived conversational continuations; entities are durable. The reconciler runs *before* task continuation in the post-turn order (§9). Add optional `entity_id` on tasks so "continue lesson three" links task progress to a durable entity. |
| **Post-turn memory extraction** | Runs after the reconciler with a claimed-facts suppression filter (§9), failing open on reconciler outage: state-shaped facts become state events, not Atlas memories. Atlas remains the conversational ledger (§11). |
| **Atlas `pinned_facts`** | Fold in (Slice 5) as a statusless `fact` type — pinned facts are exactly "current values that drift" (see the vehicle contradiction). The per-item `vehicle` pilot covers the concrete case sooner. |
| **`active_context_items`** | Superseded. Same idea, built in v1, never wired (0 rows). Retire rather than resurrect: its schema lacks types/events/staleness, and dormant code is a false floor. |
| **`topics` / `project_focus` / `topic_focus`** | Near-empty in practice (0 / 6 rows); used as digest-scoping inputs when present, but the maintained focus signal is the new reconciler-written `state_focus` (§7). Topic status maintenance can later ride the sweep. |
| **Linear** | Stays the source of truth for Tango dev projects, unsynced (locked decision). A one-way adapter into `project` entities is a candidate follow-on after Slice 5. |
| **Obsidian** | Human-readable tier per the locked boundary rule: entities point at vault docs (`body_pointer`); declared fields sync two-way via the Obsidian adapter (§7.1) with the head canonical; write-guard + `source_kind` protections from UMS apply to body writes; the mirror touches only declared frontmatter keys. |

---

## 16. Use cases → acceptance

Each maps to live evidence and becomes a validation fixture ("done = live
tested"):

1. **Project portfolio:** "What projects am I working on?" → complete, correct
   list from `state_query` across native project entities.
2. **Behind/at-risk:** "Which projects are behind?" → stale/overdue filter, no
   hallucinated status.
3. **Canonical current value:** "What's my current weight and protein goal?"
   → single canonical answer matching the latest observation; the
   contradictory memories are archived by backfill/sweep (retained +
   reversible, never surfaced as current truth).
4. **Trend:** "Weight trend over the last 30 days" → event-ledger query (the
   thing `atlas_sql` couldn't answer on 2026-04-22).
5. **Cross-session task state:** "How much progress on lesson three?" →
   entity-linked progress survives timeouts without the user re-stating it.
6. **Travel grounding:** during a trip, "what day is it / where am I / are we
   on plan" answers from the `travel` entity with update-freshness flagged
   (conversational location in v1; live GPS awaits the OwnTracks revival);
   after the trip, the entity auto-archives — no post-trip "plans to visit
   tomorrow" answers.
7. **Staleness honesty:** a query touching a stale entity gets the ⚠ staleness
   signal in-context instead of silent stale-data use.
8. **Check-in loop:** a mental-health type with weekly cadence produces a
   scheduled check-in, records an observation, and shows up in trend queries.
9. **Vehicle registry:** "what vehicles do I have / which bike do I ride" →
   per-vehicle entities, current and singular; per-vehicle depth via linked
   vault docs; the stale pinned-fact contradiction is retired.
10. **Visible capture, any model:** a conversational state mention — on a
    Claude agent *and* on an `-ollama` clone that made no tool call — produces
    the reconciler capture and the receipt in the channel.
11. **Undo & correction:** "undo that" after a receipt reverts the turn's
    changeset (and un-archives any memories it superseded); "it was 174, not
    175" produces a correcting update citing the original event. Nothing is
    deleted either way.
12. **Entity resolution:** referring to one project three different ways
    yields one entity (aliases accumulate); a genuinely new project yields a
    loud `NEW` receipt; no duplicate entities after a week of live use.
13. **Obsidian round-trip:** editing a declared field in a linked vault doc
    produces a ledger event within seconds and shows in the next turn's
    digest; a chat-driven change appears in the doc's frontmatter; an
    unrelated narrative edit produces **no** state event (mirror + hash gate
    proven).

---

## 17. Vertical slices

Same discipline as UMS: thin end-to-end increments, live-tested, then widen.

- **Slice 0 — Discovery lock-in.** Decisions locked (§3). Remaining: author the
  four pilot type definitions as seed data (per-item `vehicle` convention,
  `body_fields` declarations, digest templates); fix digest token budget;
  pick the dashboard stack + port per tailnet convention.
- **Slice 1 — Substrate + tools.** Migration (tables incl. `state_focus` +
  governance seed + grants + core-DB `busy_timeout`, live `PRAGMA
  user_version` check), service-layer write path (incl. turn/event `revert`),
  `state_query`/`state_update` handlers with schema validation, agent YAML
  allowlists, pilot type seeds. *Acceptance:* use case 1 live on a `-test`
  channel; illegal transition rejected with actionable error; revert
  round-trips.
- **Slice 2 — Digest, receipts, dashboard.** Turn-briefing digest with the
  priority ladder (tiers 2–4 until the reconciler ships) + precedence;
  receipt follow-up-message mechanics for tool-path writes; dashboard v1
  (entities read-write via bot-process HTTP API; types view-only); gated
  conversational `state_define_type` (additive-only evolution). *Acceptance:*
  use case 3 answered from state on a resumed session AND on an `-ollama`
  clone with tool-calling disabled; a dashboard edit shows up in the next
  turn's digest.
- **Slice 3 — The State Reconciler + two-ledger hygiene.** The per-turn
  reconciler subprocess (§9): golden-path prompt on a capable model first;
  entity resolution (full name index) + aliases + `state_focus` writes;
  undo/correction; receipt posting; claimed-facts handoff to memory extraction
  (fail-open); the **labeled fixture set**, then the model bake-off and
  per-task assignment; pilot-type backfill via dry-run-reviewed job; batched
  supersession verdicts land with the sweep in Slice 4 (backfill covers the
  interim). *Acceptance:* a conversational weight mention — serving agent
  making no tool call — updates the entity and posts the receipt; "undo that"
  reverts and un-archives; idempotence proven (repeating the same value
  produces no event); use cases 3–5, 10–12.
- **Slice 4 — Lifecycle + adapters.** Staleness sweep (staleness actions,
  batched supersession verdicts, Obsidian mirror retries + scan, duplicate
  flagging, reconciler-stall check), auto-expiry, the **Obsidian adapter**
  (§7.1), the **health-export adapter**, scheduled check-ins. Workout +
  OwnTracks adapters deferred (OwnTracks feed must be revived first).
  *Acceptance:* use cases 2, 6–8, 13.
- **Slice 5 — Convergence.** Fold `project_state` and `pinned_facts`; retire
  `active_context_items`; merge whisper/digest blocks; evaluate merging
  post-turn passes (§9 deferred optimization). Revisit Linear + workout +
  OwnTracks adapters as follow-on candidates.

---

## 18. Open questions (remaining)

1. **`state_events` retention:** keep forever (cheap at this volume) or
   compact observations older than N months into daily aggregates? Lean:
   forever until it hurts — consistent with archive-only.
2. **Always-on type config per agent:** which types are tier-2 for which
   agents (health → wellness agent; projects → Watson/PM)? Settle during
   Slice 2 with real usage.
3. **Whisper/digest merge timing:** run the UMS whisper pointer and the state
   digest side-by-side until Slice 5 (lean), or merge earlier if token budget
   forces it.
4. **Receipt format:** exact rendering of the follow-up line (plain text vs
   small embed) — pick during Slice 2 live testing.
5. **Reconciler + verdict model:** which extraction-class model wins the
   bake-off on the labeled fixture set (candidates: Haiku,
   deepseek-v4-pro:cloud; gpt-oss:20b excluded as known-broken). Settle in
   Slice 3.
6. **`state_focus` TTL:** how long a conversation stays "about" an entity
   without re-engagement. Pick a default (lean: 7 days) and tune live.

---

## 19. Linear mapping (seed for the project)

- **Project:** State Management (Seaside HQ → Tango team, General Project
  template).
- **Milestones:** Discovery (Slice 0), Implementation (Slices 1–2), Capture &
  Hygiene (Slice 3 — the State Reconciler + two-ledger hygiene), Lifecycle &
  Adapters (Slice 4), Validation, Ship. (Slice 5 convergence is its own
  follow-on once UMS lands.)
- Per-slice issues carry the §16/§17 acceptance criteria as validation gates;
  live-test evidence attached before Done.
