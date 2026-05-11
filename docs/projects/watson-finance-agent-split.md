# Watson Finance Agent Split

**Status:** Implemented
**Owner:** Watson PM
**Linear:** [Watson Finance Agent Split](https://linear.app/seaside-hq/project/watson-finance-agent-split-81d28292037c)
**Date:** 2026-05-11
**Agent name:** Foxtrot (changed from Ledger during stakeholder review)
**Discord channel:** `#foxtrot` (ID: `1503463044112580798`) — new channel, not the old `topics.finance`
**Smoke test channel:** `#foxtrot-test` (ID: `1503463067034587216`)

## Problem

Watson currently owns 7 domains including Finance. Finance jobs (nightly transaction categorizer, receipt cataloger, weekly/monthly sinking fund reconciliation) run under `concurrency_group: watson-tasks`, which means they compete with Watson's other work (email triage, morning planning, general Q&A). This creates two problems:

1. **Concurrency bottleneck** -- finance jobs block Watson's other tasks and vice versa
2. **Context pollution** -- finance conversations in Watson's channel mix with planning/email/general threads, making it harder to follow up on financial topics

A dedicated `topics.finance` channel already exists (`100000000000000013`) and sinking fund reports already deliver there. The split formalizes this into a standalone agent.

## Design

### 1. Agent Identity

| Field | Value |
|-------|-------|
| **id** | `ledger` |
| **display_name** | Ledger |
| **type** | `finance` |
| **Voice call sign** | "Ledger" |
| **Kokoro voice** | `am_echo` |
| **Personality** | Numbers-first, precise, dry. A fastidious accountant who takes quiet pride in clean books. Brief and factual by default, but explains methodology when asked. |

**Domain ownership:**
- Budgets and spending analysis (Lunch Money)
- Transaction categorization
- Receipt cataloging (including browser-based lookups)
- Sinking fund reconciliation
- Reimbursement tracking (Ramp)

**Relationship to Watson:** Watson loses the Finance domain entirely. Watson's daily brief aggregator continues to read the Finance domain job log (`Records/Jobs/Finance/YYYY-MM.md`) -- this is filesystem I/O, not an inter-agent call, so no cross-agent dependency is needed. Morning planning references brief data, which already includes overnight finance summaries.

### 2. Configuration

#### 2a. Agent YAML: `config/v2/agents/ledger.yaml`

```yaml
id: ledger
display_name: Ledger
type: finance

system_prompt_file: agents/assistants/ledger/soul.md

mcp_servers:
  - name: memory
    command: node
    args: ["packages/atlas-memory/dist/index.js"]
  - name: lunch-money
    command: node
    args: ["packages/core/dist/mcp-proxy.js", "lunch-money"]
    env:
      ALLOWED_TOOL_IDS: "lunch_money"
  - name: receipt-registry
    command: node
    args: ["packages/core/dist/mcp-proxy.js", "receipt-registry"]
    env:
      ALLOWED_TOOL_IDS: "receipt_registry"
  - name: ramp
    command: node
    args: ["packages/core/dist/mcp-proxy.js", "ramp"]
    env:
      ALLOWED_TOOL_IDS: "ramp_reimbursement"
  - name: browser
    command: node
    args: ["packages/core/dist/mcp-proxy.js", "browser"]
    env:
      ALLOWED_TOOL_IDS: "browser"
  - name: obsidian
    command: node
    args: ["packages/core/dist/mcp-proxy.js", "obsidian"]
    env:
      ALLOWED_TOOL_IDS: "obsidian"
  - name: onepassword
    command: node
    args: ["packages/core/dist/mcp-proxy.js", "onepassword"]
    env:
      ALLOWED_TOOL_IDS: "onepassword"
  - name: google
    command: node
    args: ["packages/core/dist/mcp-proxy.js", "google"]
    env:
      ALLOWED_TOOL_IDS: "gog_email"
  - name: agent-docs
    command: node
    args: ["packages/core/dist/mcp-proxy.js", "agent-docs"]
    env:
      ALLOWED_TOOL_IDS: "agent_docs"

runtime:
  mode: persistent
  provider: claude-code-v2
  fallback: codex
  model: claude-sonnet-4-6
  reasoning_effort: medium
  idle_timeout_hours: 24
  context_reset_threshold: 0.80

memory:
  post_turn_extraction: enabled
  extraction_model: claude-haiku-4-5
  importance_threshold: 0.4
  scheduled_reflection: enabled

voice:
  call_signs:
    - Ledger
  kokoro_voice: am_echo
  default_channel_id: "100000000000000013"

discord:
  default_channel_id: "100000000000000013"
  smoke_test_channel_id: "100000000000001013"
```

**MCP server rationale:**
- `lunch-money` -- core finance data
- `receipt-registry` -- receipt record logging/querying
- `ramp` -- reimbursement submission
- `browser` -- receipt lookups on retailer websites (Amazon, Walmart, Costco)
- `obsidian` -- receipt files, finance rules docs, domain job logs
- `onepassword` -- retailer login credentials for receipt cataloging
- `google` (email only) -- receipt email lookups (Venmo confirmations, Maid in Newport invoices, Factor receipts)
- `memory` -- Atlas Memory (own namespace)
- `agent-docs` -- self-update capability

**Not included:** `linear`, `imessage`, `slack`, `gog_calendar`, `gog_docs` -- these stay on Watson. Ledger is a pure finance agent with no planning/messaging responsibilities.

#### 2b. Soul: `agents/assistants/ledger/soul.md`

```markdown
You are Ledger.

Dedicated finance agent. You own budgets, transactions, receipts, and reimbursements.

## Style

- Numbers-first -- lead with the data, then explain
- Precise and methodical -- exact amounts, correct categories, clean books
- Dry humor in measured doses -- an accountant who enjoys a well-balanced ledger
- Brief by default -- summarize unless the user asks for detail

## Domains

- **Transactions** -- Categorization, clearing, and review of Lunch Money transactions
- **Budgets** -- Monthly budget tracking, spending pace analysis, category monitoring
- **Receipts** -- Receipt cataloging, order lookups, Obsidian receipt file management
- **Sinking Funds** -- Weekly/monthly reconciliation, contribution tracking, transfer recommendations
- **Reimbursements** -- Ramp reimbursement submission and tracking
```

#### 2c. Workers: `agents/assistants/ledger/workers.md`

```markdown
# Ledger Workers

## Dispatch rules

- Workers are **synchronous and single-turn**. Call `dispatch_worker` when it is available.
- There are **no background jobs**. Do not claim a job is "running" or "in progress" unless you are actively inside the turn that dispatched it.
- Do not tell the user you will "report back later" -- you report back in the same response that includes the worker's results.

## personal-assistant

Tools: `lunch_money`, `receipt_registry`, `ramp_reimbursement`, `browser`, `obsidian`, `onepassword`, `gog_email`, `agent_docs`, `memory_search`, `memory_add`, `memory_reflect`

Dispatch when you need to: query or categorize transactions, check budgets, look up or create receipts, submit reimbursements, browse retailer websites, read finance rules from Obsidian, retrieve retailer credentials, search receipt confirmation emails, or update agent documentation.
```

#### 2d. Knowledge: `agents/assistants/ledger/knowledge.md`

```markdown
# Ledger Domain Knowledge

Reference guidance for finance workflows.

## Lunch Money

The `lunch_money` tool wraps the Lunch Money API.

1. **Always fetch categories first.** When the user asks about spending by
   category (e.g., "How much did I spend on Groceries?"), call
   `GET /categories` to look up the `category_id` before querying transactions.
   `category_name` is NOT a valid transaction filter -- using it returns all
   transactions unfiltered.

2. **Filter by `category_id`, never `category_name`.** The transactions
   endpoint accepts `category_id` (integer) but silently ignores
   `category_name`. Always resolve the name to an ID first.

## Receipts

- Receipt files live at `Records/Finance/Receipts/{Retailer}/` in Obsidian
- Use the receipt_logging skill format for file structure
- For reimbursable receipts, add a ## Reimbursement Tracking section using receipt_registry

## Categorization Rules

- Read categorization rules from `~/Documents/main/References/Finance/Lunch Money Rules.md`
- Apply rules to transactions, handle splits, flag ambiguous vendors for review
- Rate limit: wait 0.3s between Lunch Money API calls

## Domain Job Logs

All scheduled job output is logged to `Records/Jobs/Finance/YYYY-MM.md` in Obsidian.
The daily brief aggregator reads this file -- ensure entries include a **Flagged:** section
for anything that needs user attention.

## Self-Update

When the user gives behavioral feedback, update this knowledge file using the
`mcp__agent-docs__agent_docs` tool (patch for surgical edits, write for larger rewrites).

## Available Tools

**Finance:**
- `mcp__lunch-money__lunch_money` - query and categorize Lunch Money transactions
- `mcp__receipt-registry__receipt_registry` - log and query receipt records
- `mcp__ramp__ramp_reimbursement` - submit and manage Ramp reimbursements

**Browser:**
- `mcp__browser__browser` - web browsing for receipt/order lookups

**Notes:**
- `mcp__obsidian__obsidian` - read/write Obsidian vault notes (receipts, rules, logs)

**Secrets:**
- `mcp__onepassword__onepassword` - 1Password lookups for retailer credentials

**Email:**
- `mcp__google__gog_email` - search Gmail for receipt confirmation emails

**Memory:**
- `mcp__memory__memory_search` - search stored memories
- `mcp__memory__memory_add` - store a new memory
- `mcp__memory__memory_reflect` - trigger memory reflection

**Agent Docs:**
- `mcp__agent-docs__agent_docs` - read, write, patch agent documentation

**Always use tools to look up data before responding.**
```

### 3. Schedule Migration

All 5 finance schedules move from Watson to Ledger. Changes per schedule:

| Schedule | Changes |
|----------|---------|
| `nightly-transaction-categorizer` | `concurrency_group: ledger-tasks`, tags: replace `watson` with `ledger`, `obsidian_log.domain` stays `Finance` |
| `receipt-cataloger` | `concurrency_group: ledger-tasks`, tags: replace `watson` with `ledger` |
| `weekly-finance-review` | `concurrency_group: ledger-tasks`, tags: replace `watson` with `ledger` |
| `sinking-fund-reconciliation` | `concurrency_group: ledger-tasks`, tags: replace `watson` with `ledger`, `delivery.agent_id: ledger` |
| `sinking-fund-reconciliation-month-end` | `concurrency_group: ledger-tasks`, tags: replace `watson` with `ledger`, `delivery.agent_id: ledger` |

**Common changes across all 5 schedules:**
- `policy.concurrency_group`: `watson-tasks` -> `ledger-tasks`
- `tags`: replace `watson` with `ledger`
- Schedules with `delivery.agent_id: watson` -> `delivery.agent_id: ledger`
- `execution.worker_id` stays `personal-assistant` (worker name is shared)
- `execution.intent_ids` stay the same (they already use `finance.*` namespace)
- `obsidian_log.domain` stays `Finance` (this is the domain log path, not the agent name)
- **Add `execution.deterministic_agent_id: ledger`** to all 5 schedules (none currently have this field -- without it, the scheduler can't deterministically route to Ledger)

**Manual test schedules** (`manual-test-*`) for each finance schedule also need the same tag/concurrency updates.

### 4. Pre-Check Handler Updates

Three pre-check handlers in `packages/discord/src/main.ts` currently use `watson-*` prefixed names:

| Current Name | New Name | Notes |
|-------------|----------|-------|
| `watson-unreviewed-transactions` | `ledger-unreviewed-transactions` | Update handler registration and schedule reference |
| `watson-receipt-catalog-candidates` | `ledger-receipt-catalog-candidates` | Update handler registration and schedule reference |
| `watson-sinking-fund-reconciliation-context` | `ledger-sinking-fund-reconciliation-context` | Update handler registration and schedule reference |

The handler implementations don't reference Watson-specific state -- they call Lunch Money API directly. Only the registration name changes.

Update each schedule's `execution.pre_check.handler` to match the new name.

### 5. Watson Cleanup

#### Remove from `config/v2/agents/watson.yaml`:
- `lunch-money` MCP server entry
- `receipt-registry` MCP server entry
- `ramp` MCP server entry

**Keep on Watson:** `browser`, `obsidian`, `onepassword`, `google`, `memory`, `linear`, `imessage`, `slack`, `agent-docs` -- these serve non-finance domains.

#### Update `agents/assistants/watson/soul.md`:
Remove the Finance domain line:
```diff
 ## Domains

 - **Planning** -- Daily schedules, calendar review, Linear issue tracking, task prioritization, weekly planning
 - **Email** -- Triage across Gmail accounts, drafting, archiving
-- **Finance** -- Budgets, expense tracking, spending analysis via Lunch Money
 - **Obsidian** -- Knowledge management, note creation, vault navigation
 - **Morning Briefing** -- Daily health + planning routine
 - **Messaging** -- Message monitoring, response advice, and careful handling of personal conversations.
 - **General Q&A** -- Quick answers, web lookups, information retrieval
```

#### Update `agents/assistants/watson/knowledge.md`:
Remove the entire `## Finance` section and `### Lunch Money` subsection.
Remove finance-related tool entries from `## Available Tools`:
- `mcp__lunch-money__lunch_money`
- `mcp__receipt-registry__receipt_registry`
- `mcp__ramp__ramp_reimbursement`

#### Update `agents/assistants/watson/workers.md`:
Remove `lunch_money`, `receipt_registry` from the personal-assistant tool list.

### 6. Channel & Routing Configuration

#### `config/defaults/channels.yaml` update:
```diff
 agents:
   watson: "100000000000000001"
   malibu: "100000000000000002"
   sierra: "100000000000000003"
   victor: "100000000000000004"
+  ledger: "100000000000000013"

 topics:
   email: "100000000000000012"
-  finance: "100000000000000013"
   ai-briefings: "100000000000000014"
```

The finance channel moves from `topics` to `agents` since it's now owned by a dedicated agent. This means:
- Ledger's `discord.default_channel_id` = `100000000000000013`
- Forum threads in the finance channel route to Ledger via `resolveRoutingChannelId`

#### Access Control
No per-agent access overrides are needed. All current agents use the default access policy (channel allowlist from `DISCORD_ALLOWED_CHANNELS` env var). Ledger follows the same pattern. Just ensure `100000000000000013` is in `DISCORD_ALLOWED_CHANNELS`.

#### Smoke Test Channel
Assign `100000000000001013` as Ledger's smoke test channel (following the pattern: agent channels use `100000000000001XXX` for smoke tests).

### 7. Cross-Agent Handoff for Morning Briefings

**No cross-agent call needed.** The daily brief aggregator (`daily-brief.yaml`) reads finance job logs via direct filesystem I/O:

```
~/Documents/main/Records/Jobs/Finance/YYYY-MM.md
```

This file is written by Ledger's scheduled jobs (via `obsidian_log.domain: Finance`). Watson's daily brief reads it as a plain file -- no MCP call, no inter-agent dependency.

The handoff is implicit and one-directional:
1. Ledger's overnight jobs (transaction categorizer, receipt cataloger) write results to the Finance domain log
2. Watson's daily brief aggregator reads all domain logs at 5am and compiles flagged items
3. Watson's morning planning job reads the brief and incorporates finance flags into the daily note

**No changes needed** to `daily-brief.yaml` or `morning-planning.yaml` -- they already reference the filesystem path, not the agent.

### 8. Atlas Memory Namespace

Ledger gets its own Atlas Memory namespace. The `memory` MCP server in the agent config spawns a separate `packages/atlas-memory/dist/index.js` process, which uses the agent ID to namespace memories. Since `id: ledger` is distinct from `id: watson`, memory isolation is automatic.

Existing Watson memories about finance topics will remain in Watson's namespace. This is acceptable -- Watson won't be asked finance questions anymore, so those memories become inert. No migration needed.

## Migration Plan

### Phase 1: Create Agent (No Traffic)
1. Create `config/v2/agents/ledger.yaml`
2. Create `agents/assistants/ledger/soul.md`, `workers.md`, `knowledge.md`
3. Add `ledger` to `config/defaults/channels.yaml` under `agents`
4. Verify bot starts cleanly with the new agent config
5. **Test:** Send a message in the finance channel, confirm Ledger responds

### Phase 2: Migrate Schedules
1. Update all 5 finance schedule YAMLs (concurrency group, tags, agent_id, deterministic_agent_id, pre_check handler names)
2. Update manual-test schedule variants
3. Rename pre-check handlers in `main.ts`
4. **Test:** Trigger each manual-test schedule, confirm Ledger executes them and logs to `Records/Jobs/Finance/`
5. **Test:** Confirm daily brief still reads Finance domain logs correctly

### Phase 3: Strip Watson
1. Remove finance MCP servers from `watson.yaml`
2. Remove Finance domain from Watson's soul/knowledge/workers
3. Remove `topics.finance` from channels.yaml (already moved to `agents.ledger`)
4. **Test:** Confirm Watson no longer responds to finance queries (redirects to Ledger)
5. **Test:** Confirm Watson's non-finance jobs still work (email, planning, morning brief)

### Rollback Strategy

Each phase is independently reversible:
- **Phase 1:** Delete Ledger config files, remove from channels.yaml
- **Phase 2:** Revert schedule YAMLs and pre-check handler names to `watson-*`
- **Phase 3:** Re-add finance MCP servers to Watson config, restore soul/knowledge/workers

The schedules are the critical path. If a schedule fails under Ledger, revert that schedule's `concurrency_group`/`tags`/`agent_id` back to Watson values. The pre-check handlers are functionally identical -- only the registration name changes -- so rollback is a simple rename.

## File Change Summary

| Action | File |
|--------|------|
| **Create** | `config/v2/agents/ledger.yaml` |
| **Create** | `agents/assistants/ledger/soul.md` |
| **Create** | `agents/assistants/ledger/workers.md` |
| **Create** | `agents/assistants/ledger/knowledge.md` |
| **Edit** | `config/defaults/channels.yaml` -- add `ledger` agent, remove `topics.finance` |
| **Edit** | `config/defaults/schedules/nightly-transaction-categorizer.yaml` |
| **Edit** | `config/defaults/schedules/receipt-cataloger.yaml` |
| **Edit** | `config/defaults/schedules/weekly-finance-review.yaml` |
| **Edit** | `config/defaults/schedules/sinking-fund-reconciliation.yaml` |
| **Edit** | `config/defaults/schedules/sinking-fund-reconciliation-month-end.yaml` |
| **Edit** | `config/defaults/schedules/manual-test-nightly-transaction-categorizer.yaml` |
| **Edit** | `config/defaults/schedules/manual-test-receipt-cataloger.yaml` |
| **Edit** | `config/defaults/schedules/manual-test-weekly-finance-review.yaml` |
| **Edit** | `packages/discord/src/main.ts` -- rename 3 pre-check handlers |
| **Edit** | `config/v2/agents/watson.yaml` -- remove 3 MCP server entries |
| **Edit** | `agents/assistants/watson/soul.md` -- remove Finance domain |
| **Edit** | `agents/assistants/watson/knowledge.md` -- remove Finance section and tools |
| **Edit** | `agents/assistants/watson/workers.md` -- remove finance tools from list |

## Open Questions

1. **Voice:** Does `am_echo` work well for a finance agent, or should we audition other Kokoro voices? Can be decided during implementation.
2. **Ramp server:** Ramp is only used during receipt cataloging for reimbursement tracking. If reimbursement submission moves to Ledger entirely, Watson never needs Ramp. Confirmed: remove from Watson.
3. **Google email on Ledger:** The receipt cataloger uses `gog_email` to search for Venmo/Maid in Newport/Factor receipt emails. This is a narrow use case -- only receipt confirmation lookups. Included in Ledger's config with `gog_email` only (no calendar/docs).
