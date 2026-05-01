# Daily Brief Architecture

**Status:** Ready for Implementation
**Owner:** Victor
**Requested:** 2026-04-27

## Problem

Automated jobs (nightly transaction categorizer, daily email review, morning planning, etc.) post results to separate Discord channels throughout the day and night. This creates noise and requires Devin to check multiple channels. Most automated output is low-signal and doesn't need immediate attention — only flagged items matter.

## Solution

Two-part architecture:

1. **Domain job logs** — each automated job appends a structured entry to a domain-specific Obsidian log file instead of (or in addition to) posting to Discord.
2. **Morning brief aggregator** — a single job at 5:15am reads all domain logs from the past 24h, collects flagged items, and delivers one consolidated Discord ping to the personal channel.

Finance and email channels are silenced. One ping, one place.

---

## Domain Job Logs

### Location

```
Records/Jobs/Finance/YYYY-MM.md
Records/Jobs/Planning/YYYY-MM.md
Records/Jobs/Email/YYYY-MM.md
```

Append-only. New entry per job run. Monthly files rotate automatically.

### Entry Format

```markdown
## 2026-04-27 23:00 — Nightly Transaction Categorizer

**Status:** Done — 4 transactions categorized
**Summary:** Amazon $34.12 → Home Improvement; Walmart $67.88 → Groceries; ...

No flagged items.
```

Or with flags:

```markdown
## 2026-04-27 23:00 — Nightly Transaction Categorizer

**Status:** Done — 3 categorized, 1 flagged
**Summary:** Amazon $34.12 → Home Improvement; Walmart $67.88 → Groceries; ...

**Flagged:**
- Apple $149.00 — ambiguous (hardware vs. software?). Reply to clarify.
```

### Obsidian Excluded Files

Add `Records/Jobs/` to Obsidian Settings → Files & Links → Excluded Files. These logs are operational output, not reference material — they should stay out of search and Quick Switcher.

---

## Morning Brief Job

### Schedule

- **Time:** 5:15am Pacific
- **Cron:** `15 5 * * *`

### What It Does

1. Reads all domain log files, collecting entries from the past 24h
2. Extracts any **Flagged** blocks
3. Fetches today's calendar events (first 3–5)
4. Optionally fetches current weather
5. Writes a `## Morning Brief` section to the top of today's daily note in Obsidian
6. Posts a single Discord ping to the personal channel

### Daily Note Format

```markdown
## Morning Brief — Mon Apr 27

**Today:** 3 meetings | 68°F, partly cloudy

### Flagged (1)
- **Transaction Categorizer:** Apple $149.00 — ambiguous (hardware vs. software?). Reply in #finance to clarify.

### Overnight Jobs
- Nightly Transaction Categorizer — 4 categorized, 1 flagged
- Daily Email Review — 2 actionable threads, 14 informational
- Morning Planning — plan ready

### Calendar
- 9:00am — Team Messaging Session
- 11:00am — VSC Contract Review
- 2:00pm — Latitude Website Copy
```

### Discord Ping (personal channel)

```
Morning brief ready. 1 flagged item needs attention.
Records/Jobs/ → today's note for full summary.
```

If nothing flagged:

```
Morning brief ready. No flags — clean night.
```

---

## Channel Changes

| Channel | Current | New |
|---|---|---|
| Personal channel | various pings | 5:15am brief only |
| Finance / Lunch Money channel | nightly transaction categorizer output | silenced |
| Email channel | daily email review output | silenced |

"Silenced" means the job no longer delivers to that channel. The job still runs and logs to Obsidian.

---

## Jobs to Update

Each existing schedule that currently delivers to a channel needs two changes:

1. **Add Obsidian log step** — append structured entry to the relevant domain log
2. **Remove or suppress channel delivery** — stop posting to the finance/email channels (or conditionally skip if nothing flagged)

Jobs in scope:

- `nightly-transaction-categorizer` → logs to `Records/Jobs/Finance/`
- `daily-email-review` → logs to `Records/Jobs/Email/`
- `morning-planning` → logs to `Records/Jobs/Planning/`
- `weekly-email-subscriptions` → logs to `Records/Jobs/Email/`
- `weekly-finance-review` → logs to `Records/Jobs/Finance/`

### New Jobs to Create

- `daily-brief` — the 5:15am aggregator (new schedule YAML)

---

## Implementation Notes

### Obsidian Write Pattern

Use direct filesystem I/O (not obsidian-cli — it steals app focus). Append to the monthly log file with a formatted entry block.

Reference: `feedback_obsidian_direct_io.md` in Claude memory.

### Schedule YAML Pattern

Reference existing schedules in `config/defaults/schedules/` for the v2 runtime format. The brief aggregator is a `conditional-agent` or standard `agent` execution mode depending on whether flagged-only filtering is needed.

### Watson vs. Victor

The morning brief aggregator should run under Watson (personal assistant context). The domain log appending runs under whatever agent owns that job (Watson for finance/planning).

### Sierra Integration

Deferred. Sierra's proactive briefings stay as-is for now. This architecture does not replace Sierra.

---

## Open Decisions (Resolved)

| Decision | Resolution |
|---|---|
| Brief timing | 5:15am Pacific |
| Finance channel | Silenced |
| Email channel | Silenced |
| Sierra integration | Deferred |
| Log location | Obsidian `Records/Jobs/` (excluded from search) |
| Brief destination | Personal Discord channel + top of daily note |

---

## Success Criteria

- No automated job output posted to finance or email channels
- One Discord ping per day at 5:15am
- All flagged items from overnight jobs visible in the brief
- Daily note in Obsidian has brief section populated before Devin wakes
