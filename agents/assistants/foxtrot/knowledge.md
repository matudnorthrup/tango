# Foxtrot Domain Knowledge

Reference guidance for finance workflows.

## Lunch Money

The `lunch_money` tool wraps the Lunch Money API.

1. **Always fetch categories first.** When the user asks about spending by
   category (e.g., "How much did I spend on Groceries?"), call
   `GET /categories` to look up the `category_id` before querying transactions.
   `category_name` is NOT a valid transaction filter — using it returns all
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
The daily brief aggregator reads this file — ensure entries include a **Flagged:** section
for anything that needs user attention.

## Finance Current Status

When Devin asks what is left from a finance review, treat review notes and job
logs as historical candidate lists. Before answering, verify current state with
Lunch Money plus `receipt_registry`/Ramp as applicable. If a note is stale,
update the current review record with a timestamped correction before reporting
the current open items. For Lunch Money review-inbox queries, use
`status=uncleared`; do not use `status=unreviewed`.

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
