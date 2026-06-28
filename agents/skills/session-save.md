# session_save

When and how to persist session context before it is lost — rotation, `/tango new`, or the operator asking for a save.

**Applies to:** all Tango agents unless a domain skill overrides (e.g. legal matter save adds thread-file rules).

Installations extend this doc via profile overlay (`~/.tango/profiles/<profile>/prompts/skills/session-save.md`).

---

## Where does this go? (three layers)

Ask **one question per candidate fact** — do not copy the same content to all three.

| Layer | Question | What belongs here | What does **not** belong |
| --- | --- | --- | --- |
| **Thread file** | *What exactly was decided and proved for **this project**?* | Test results, architecture decisions, open tasks, Quick Read status, Decisions Log bullets, file pointers | Partnership texture, "who we are," session narration, duplicate Atlas memories |
| **Daily log** | *What happened today — **one headline** for the fleet calendar?* | Dated one-liners: "Phase 1b smoke complete," "First multi-agent exchange" | Test matrices, decision detail, relationship depth |
| **Atlas** | *Who are we / how do we work together — **durable recall**?* | Preferences, corrections, partnership milestones, origin stories, lessons that shape future behavior | Raw test output, Open Items checklists, channel activity logs, **thin facts from the last exchange** (Haiku's lane) |

**Sorting shortcuts**

- *How to run the project* → **thread file**
- *What we did today (headline)* → **daily log**
- *How to work with the operator / what this relationship is* → **Atlas** — use the **presence lens** below, not a replay of what just happened in chat
- *Session narration, smoke codewords, throwaway repro* → **nowhere** (drop)

**Example routing**

| Fact | Layer | Why |
| --- | --- | --- |
| Write guard blocked full overwrite; Edit patch passed | **Thread** | Project evidence — Decisions Log + Open Items |
| Infrastructure smoke complete (headline) | **Daily log** | Fleet-visible "what happened today" |
| Insight about invisible hook infrastructure | **Atlas** | Durable lesson, not infra spec |
| Throwaway probe string from a test | **Thread** (or nowhere after test) | Test artifact — not Atlas |

Use **`daily_log_append`** for daily-log headlines on save pass — do not substitute Atlas.

---

## When to run

| Trigger | Action |
| --- | --- |
| Operator says **save**, **checkpoint**, or similar | Run full save pass; confirm what you stored |
| **`/tango save`** queued on this turn | Same as above (platform injects save-pass context and turn whisper) |
| Before **`/tango new`** when the session had substance | Run save pass first unless the operator explicitly skips |
| Natural breakpoint (significant decisions, long arc) | Use judgment — proactive save without announcing every turn |

Do not save smoke-test codewords or throwaway repro chatter. Otherwise, save when it matters — do not pause to check whether post-turn extraction already captured the same topic.

---

## 1. Atlas — primary memory (always)

Use `memory_add` anytime something would hurt to lose — mid-conversation or on save pass.

**The table question sets the lane** (partnership, preferences, durable lessons). **The sorting lens sets what to notice:**

> *What happened between us that only I would know because I was here?*

That draws the line against Haiku naturally — not by comparing databases, but by asking what **presence and full-session judgment** add: why it mattered, how we work together, what to do differently, partnership texture Haiku cannot see from one exchange.

**Do not `memory_add` a replay of facts already stated plainly in the last turn** — atomic who/what/when from one exchange is Haiku post-turn's job. You add **why**, **so what**, and **relationship** from the whole arc.

Decisions, insights, corrections, commitments, preferences, and durable findings from the work still belong here when they meet the lens.

**Platform stamps Discord location automatically** on every `memory_add` during a Discord turn — `channel_id`, `thread_id`, and `conversation_key` in metadata (same provenance Haiku post-turn uses). Agents do not need to pass channel IDs manually.

**Agent-initiated saves carry more weight** than automatic post-turn extraction. You have full session context Haiku does not. Write memories that stand alone — include enough **why** and **so what** that they remain useful weeks later.

- **No importance number required** — platform defaults are fine.
- **Source:** `manual` (or as the tool specifies).
- **Metadata:** set `captured_by` to `agent_save` (normal save) or `save_pass` (when `/tango save` triggered the turn).
- **Confirm to the operator** what you saved — briefly, not a transcript dump.

### Haiku post-turn runs in parallel (not a dedup check)

After each turn, a lightweight model may extract atomic facts into Atlas automatically. **You do not need to compare against it before saving.** Use the **presence lens** above instead: if the memory is only "what we said in the last message," skip it — Haiku has that lane.

Same topic with richer framing is still fine when **you** add judgment Haiku could not: partnership meaning, lessons through presence, corrections with context.

| | Agent save (`memory_add`) | Haiku post-turn |
| --- | --- | --- |
| **Atlas `source`** | `manual` | `conversation` |
| **Typical metadata** | `captured_by: agent_save` or `save_pass` | `captured_by: post_turn_extraction` |
| **Context** | Full session judgment | Last user + agent message only |
| **Weight** | **Higher** — intentional, richer | Background capture |

**Save when the presence lens says it matters.** Overlap in subject with Haiku is acceptable when your write adds framing; duplicate thin facts are not.

---

## 2. Thread file — when linked

If this channel has a linked thread file (whisper shows `Linked: …`):

- **Patch, never full overwrite** existing authored content.
- **Frozen anchors** (Quick Read, Open Items, frontmatter) — tools may key off these; keep them current when status or tasks change.
- **Body sections** — flexible. Use as many headings as the thread needs (decisions tables, file pointers, phase notes, etc.). Only the declared anchors are machine contract; the rest is yours to shape.

On save: update **Open Items** and **Quick Read** if they changed this session. Other sections only if this session touched them.

---

## 3. Daily log — fleet chronological record (when enabled)

**Path:** `~/.tango/profiles/<profile>/memory/YYYY-MM-DD.md`  
**One file per calendar day, all agents append.**

**Use `daily_log_append`** — pass bullets only; the platform stamps agent id, timestamp, channel/thread, conversation_key, and `captured_by`. Do not use raw Write on existing daily log files (write guard blocks it).

```markdown
## {agent_id} · {YYYY-MM-DD HH:MM TZ} · channel:{channel_id} · thread:{thread_id}
- One to three bullets: what happened this session worth a dated record.
```

| Field | Required | Notes |
| --- | --- | --- |
| `agent_id` | Yes | Who saved |
| Timestamp | Yes | When |
| `channel_id` | Yes | Discord channel (forum parent for thread conversations) |
| `thread_id` | When in a thread | Omit the `· thread:…` segment for top-level channels only |

Use the **same channel/thread ids** the platform injects for Atlas. Do not paraphrase channel names — ids are what make grep and later tooling reliable.

Purpose: **chronological search** ("what did we do today?", "what happened in this channel?") — not a replacement for Atlas semantic recall. Keep bullets factual; put durable meaning in Atlas.

**Concurrency:** platform serializes appends to the same file. Bootstrap cron creates today's file if missing (`daily-log-bootstrap`).

---

## Save pass checklist

1. Review the session — what would be lost on rotation?
2. **Atlas** — before each `memory_add`, apply the **presence lens** (more than the last exchange restated? partnership/judgment only you would weigh?). If it's project evidence → thread file; today's headline → daily log.
3. If linked — patch thread file anchors/sections that changed.
4. **Daily log** — call `daily_log_append` with 1–3 headline bullets (platform stamps metadata).
5. Reply with a short confirmation by layer — not a full session recap.

---

## Related

- Thread contract: frozen anchors vs free body — see profile thread-file playbooks
- Cod-E tools: `agents/assistants/cod-e/knowledge.md` → Memory section
- Platform: `/tango save` injection — `packages/discord/src/session-ops.ts`
