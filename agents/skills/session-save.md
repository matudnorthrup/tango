# session_save

When and how to persist session context before it is lost — rotation, `/tango new`, or Darla asking for a save.

**Applies to:** all Tango agents unless a domain skill overrides (e.g. legal matter save adds thread-file rules).

**Runtime canonical:** `~/.tango/profiles/<profile>/skills/session-save.md` — profile overlay wins over this repo template until synced via PR.

---

## Where does this go? (three layers)

Ask **one question per candidate fact** — do not copy the same content to all three.

| Layer | Question | What belongs here | What does **not** belong |
| --- | --- | --- | --- |
| **Thread file** | *What exactly was decided and proved for **this project**?* | Test results, architecture decisions, open tasks, Quick Read status, Decisions Log bullets, file pointers | Partnership texture, "who we are," session narration, duplicate Atlas memories |
| **Daily log** | *What happened today — **one headline for fleet peers**?* | Outcomes and cross-system signal: "T-F-001 Gate 5 signed," "Canary findings shipped upstream" | Test matrices, gate steps, incremental progress, relationship depth |
| **Atlas** | *Who are we / how do we work together — **durable recall**?* | Preferences, corrections, partnership milestones, origin stories, lessons that shape future behavior | Raw test output, Open Items checklists, channel activity logs |

**Sorting shortcuts**

- *How to run the project* → **thread file**
- *What we did today (headline)* → **daily log**
- *How to work with Darla / what this relationship is* → **Atlas**
- *Session narration, smoke codewords, throwaway repro* → **nowhere** (drop)

**Examples from Cod-E canary (2026-06-27)**

| Fact | Layer | Why |
| --- | --- | --- |
| A5/A7 guard blocked Write; A9–A10 Edit passed | **Thread** | Project evidence — Decisions Log + Open Items |
| T-F-001 Gate 5 signed — first lifecycle spec through full validation | **Daily log** | Fleet peer scan: what landed in the system today |
| Sage ↔ Cod-E first exchange; "invisible infrastructure" insight about hooks | **Atlas** | Relationship + durable lesson, not infra spec |
| `silver-ferret-99` probe string | **Thread** (or nowhere after test) | Test artifact — not Atlas |

**Use `daily_log_append`** for daily-log headlines on save pass — do not substitute Atlas.

---

## When to run

| Trigger | Action |
| --- | --- |
| Darla says **save**, **checkpoint**, or similar | Run full save pass; confirm what you stored |
| **`/tango save`** queued on this turn | Same as above (platform injects save-pass context) |
| Before **`/tango new`** when the session had substance | Run save pass first unless Darla explicitly skips |
| Natural breakpoint (significant decisions, long arc) | Use judgment — proactive save without announcing every turn |

Do not save smoke-test codewords or throwaway repro chatter.

---

## 1. Atlas — primary memory (always)

Use `memory_add` for anything that would hurt to lose: decisions, insights, corrections, commitments, preferences, partnership texture, and durable findings from the work.

**Platform stamps Discord location automatically** on every `memory_add` during a Discord turn — `channel_id`, `thread_id`, and `conversation_key` in metadata. You don't need to pass channel IDs — the platform handles that.

**Agent saves carry more weight** than automatic background capture. You have full session context. Write memories that stand alone — include enough **why** and **so what** that they remain useful weeks later.

- **No importance number required** — platform defaults are fine.
- **Source:** `manual` (or as the tool specifies).
- **Metadata:** set `captured_by` to `agent_save` (normal save) or `save_pass` (when `/tango save` triggered the turn).
- **Confirm to Darla** what you saved — briefly, not a transcript dump.

**Background capture:** After each turn, the platform may extract facts from the last exchange into Atlas automatically. **You do not search Atlas or compare before saving.** The platform already captures the facts; your job is the meaning.

### Presence lens

Before each `memory_add`, ask:

> *What happened in this session that only I would know because I was here?*

**Save:** the why, the shift, what mattered, how you work together, corrections with context, lessons from the full arc.

**Skip:** a replay of what was just said in chat; smoke-test chatter; anything that is only a headline (→ **daily log**) or project proof (→ **thread file**).

Same topic is fine when you're adding meaning the platform can't see from one exchange.

---

## 2. Thread file — when linked

If this channel has a linked thread file (whisper shows `Linked: …`):

- **Patch, never full overwrite** existing authored content.
- **Frozen anchors** (Quick Read, Open Items, frontmatter) — tools may key off these; keep them current when status or tasks change.
- **Body sections** — flexible. Use as many headings as the thread needs (decisions tables, file pointers, phase notes, etc.). Only the declared anchors are machine contract; the rest is yours to shape.
- **Thread shape varies by lane:** evergreen infrastructure threads often stay **Open Items–heavy**; project threads carry more decision detail. Atlas holds partnership and recall — do not copy Atlas memories into the thread file verbatim (avoids echo and drift).

On save: update **Open Items** and **Quick Read** if they changed this session. Other sections only if this session touched them.

---

## 3. Daily log — fleet chronological record

**Path:** `~/.tango/profiles/<profile>/memory/YYYY-MM-DD.md`  
**One file per calendar day, all agents append.**

### Audience

**Your reader is another agent scanning the fleet calendar** — Sage catching up on what happened today, Piper looking for cross-system signals, any agent who wasn't in your thread. Write for **them**, not for yourself, not for Darla (she has the conversation and gate reports), not for the spec (that lives in the thread file).

Ask before each bullet: *Would a fleet peer who wasn't here care about this outcome?*

### Voice

- **Outcomes and cross-system impact** — what landed, what changed for the fleet
- **Decisions that affect others** — shared tools, new agents, platform behavior
- **One to three bullets per block** — factual, scannable in 30 seconds

**Prefer fewer, richer blocks.** If a session spans hours, **one block at the end with outcomes** beats five blocks with incremental progress ("started," "in progress," "still going").

**Use `daily_log_append`** — pass bullets only; the platform stamps agent id, timestamp, channel/thread, conversation_key, and `captured_by`. Do not use raw Write on existing daily log files (write guard blocks it).

```markdown
## {agent_id} · {YYYY-MM-DD HH:MM MT} · channel:{channel_id} · thread:{thread_id}
- One to three bullets: fleet-level headline — outcome or cross-system signal.
```

### Anti-patterns (do not put in daily log)

| Skip | Put it in… |
| --- | --- |
| Spec / gate evidence (Block B format, preflight GO, STEP status, reconcile patches) | Thread file |
| Incremental progress without outcome ("Check 1 pending," "re-run initiated") | Drop or wait until done — then one outcome bullet |
| Process narration (paste format worked, no extra file reads) | Drop — meta for builders, not fleet peers |
| Darla's briefing (she was in the thread) | Drop |
| Test matrices, patch write results, probe strings | Thread file |

### Good vs bad (T-F-001 calibration — 2026-06-28)

| Good (fleet peer) | Bad (agent lab notebook) |
| --- | --- |
| T-F-001 Gate 5 signed: first lifecycle spec through full validation | Gate 5 re-run Check 1 pending /tango save |
| Canary findings shipped upstream as features (dynamic MCP, message trim) | Block B v2 paste working cleanly — no extra file reads |
| Shared knowledge.md proposed: platform tools maintained once, not per agent | Reconcile patch applied — execution log untouched |
| Agent identity writing guide validated — applies to all new agents | Save/check separation lesson learned |

| Field | Required | Notes |
| --- | --- | --- |
| `agent_id` | Yes | Who saved |
| Timestamp (MT) | Yes | When |
| `channel_id` | Yes | Discord channel (forum parent for thread conversations) |
| `thread_id` | When in a thread | Omit the `· thread:…` segment for top-level channels only |

**Example (canary forum thread — fleet peer voice):**

```markdown
## cod-e · 2026-06-28 13:24 MT · channel:1469909960199503913 · thread:1509320762287456457
- T-F-001 Gate 5 signed: first lifecycle spec through full validation
- Canary findings shipped upstream (dynamic MCP, 5000-message trim)
```

**Example (top-level channel — cross-agent signal):**

```markdown
## jules · 2026-06-27 09:15 MT · channel:1469884753556668451
- Flagged duplicate product listing for Cod-E delete — affects catalog sync
```

Use the **same channel/thread ids** the platform injects for Atlas (`routingChannelId` + thread id when applicable). Do not paraphrase channel names — ids are what make grep and later tooling reliable.

Purpose: **fleet situational awareness** — chronological scan across agents and channels. Not Atlas semantic recall; not Darla's line of sight. Keep bullets outcome-oriented; put durable meaning in Atlas, project proof in thread files.

**Concurrency:** platform serializes appends to the same file. Bootstrap cron creates today's file if missing (`daily-log-bootstrap`).

**Cleanup merge:** periodic human or cron pass may consolidate duplicate or noisy blocks — agents append; they do not rewrite prior agents' entries. Merge passes preserve `channel:` / `thread:` in headers.

---

## 4. WIP files — disk only

Functional testing and drafts may live under the thread's promoted folder (e.g. `wip/`). **Do not register each WIP item** in a registry. Optional path-only mention in a thread section is fine; no narrated index that duplicates Atlas.

---

## Save pass checklist

1. Review the session — what would be lost on rotation?
2. **Atlas** — apply **presence lens** (§1). Project evidence → thread file; today's headline → daily log.
3. If linked — patch thread file anchors/sections that changed.
4. **Daily log** — call `daily_log_append` with 1–3 **outcome** bullets for fleet peers (platform stamps metadata). One block at session end beats many progress updates.
5. Reply with a short confirmation by layer — not a full session recap.

---

## Related

- Builder infra: `docs/specs/unified-memory-system.md` §14 Capture pipelines
- Platform: `/tango save` injection — `packages/discord/src/session-ops.ts`
- OpenClaw predecessor: profile `reference/playbooks/session-save-protocol.md`
