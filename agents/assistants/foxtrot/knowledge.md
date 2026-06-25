# Foxtrot Domain Knowledge

Reference guidance for finance and shopping-execution workflows.

## Budgeting Service

The `lunch_money` tool wraps the configured budgeting service's API.

1. **Always fetch categories first.** When the user asks about spending by
   category (e.g., "How much did I spend on Groceries?"), call
   `GET /categories` to look up the `category_id` before querying transactions.
   `category_name` is NOT a valid transaction filter — using it returns all
   transactions unfiltered.

2. **Filter by `category_id`, never `category_name`.** The transactions
   endpoint accepts `category_id` (integer) but silently ignores
   `category_name`. Always resolve the name to an ID first.

3. **Charged means budgetable — do not wait for transactions to clear the
   card.** Once a transaction is charged (even `is_pending: true`), categorize,
   note, and mark it `cleared` in the review workflow. There is nothing special
   about the credit-card clearing step; waiting on it only causes confusion and
   leaves work undone. The only exception is when the final posted amount is
   expected to differ from the pending hold (e.g., a tip/hold discrepancy) — in
   that case note the expected final amount and reconcile after it posts, but
   still categorize it now.

## Shopping

- Foxtrot owns purchase execution and purchase lifecycle work: retailer queue
  review, cart changes, retailer order flows, order-status lookups, purchase
  records, receipts, reimbursements, and budget impact.
- Sierra may research and recommend products, but once the user asks to add,
  buy, order, remove from cart, check an order, or connect the purchase to
  finance records, Foxtrot owns the task.
- Queue management, purchase history, and browser-driven shopping are separate
  concerns. Use the right tool for each.
- **Never use the retailer tool's `queue_add` (e.g.
  `mcp__walmart__walmart queue_add`) as a completion step when the user has asked
  you to add something to their actual retailer cart.** `queue_add` writes to a
  local Tango list, not the retailer's website. It is only useful for drafting or
  staging a list before the user reviews it.
- To add items to the user's actual retailer cart, use `mcp__browser__browser`
  to navigate the retailer's site and add items directly.
- Only report "done" on a cart add after verifying the item appears in the live
  cart via browser. If the browser add fails, report the failure honestly rather
  than falling back to the queue silently.
- Authenticated shopping flows depend on the user's configured browser profile
  and secret management setup.
- Avoid running multiple browser-heavy shopping flows at the same time unless
  the tasks are clearly independent and safe to run side by side.
- **Chipotle orders: before starting, read `agents/skills/chipotle-ordering.md`
  via `agent_docs`** — it carries verified turn-saving eval recipes (bag count,
  drawer open/remove, empty-confirm) and site hazards (the header bag icon can
  navigate to checkout, where a live Submit Order button sits next to the saved
  card; element refs go stale after drawer changes — re-snapshot, don't retry).
  A clean add-to-bag roundtrip is ~25-45 tool calls; bake-off verified
  (2026-06-10) that minimax-m2.5 and deepseek-v4-pro both complete it reliably
  with these recipes.

## Receipts

- Receipt files live at `Records/Finance/Receipts/{Retailer}/` in Obsidian
- Use the receipt_logging skill format for file structure
- For reimbursable receipts, add a ## Reimbursement Tracking section using receipt_registry
- Before saying no receipt exists or asking the user for itemized split amounts,
  run `receipt_registry lookup_receipts` with the budgeting-service transaction
  ID when available, otherwise amount/date/merchant/store/item clues. If the
  receipt has item rows, use those rows for the split.
- When `lookup_receipts` matches a budgeting-service transaction, use its
  `lunchMoneyNote` value for the transaction or split note. The note must show
  purchased items or summary first and keep the Obsidian receipt link as the
  final line.
- Do not leave receipt-backed budgeting-service notes as only `Receipt`, only a
  URL, or an unexplained personal-spending category label. If the category is
  truly the user's personal-spending category, include the item details and
  evidence basis; if it is ambiguous, leave it for review instead of guessing.
- When an itemized receipt has subtotal and tax fields, sum the relevant item
  rows by the user's category decision and allocate tax proportionally so the
  split totals match the budgeting-service transaction. Only ask for amounts if
  the receipt lacks item rows or the category ownership is still ambiguous.

## Categorization Rules

- Read categorization rules from the configured Obsidian finance rules note
  (path defined in Foxtrot's profile overlay)
- Apply rules to transactions, handle splits, flag ambiguous vendors for review
- Rate limit: wait 0.3s between budgeting-service API calls

## Domain Job Logs

All scheduled job output is logged to `Records/Jobs/Finance/YYYY-MM.md` in Obsidian.
The daily brief aggregator reads this file — ensure entries include a **Flagged:** section
for anything that needs user attention.

## Finance Current Status

When the user asks what is left from a finance review, treat review notes and job
logs as historical candidate lists. Before answering, verify current state with
the budgeting service plus `receipt_registry`/the reimbursement service as
applicable. If a note is stale, update the current review record with a
timestamped correction before reporting the current open items. For
budgeting-service review-inbox queries, use `status=uncleared`; do not use
`status=unreviewed`.

## Self-Update

When the user gives behavioral feedback, update this knowledge file using the
`mcp__agent-docs__agent_docs` tool (patch for surgical edits, write for larger rewrites).

## Available Tools

**Finance:**
- `mcp__lunch-money__lunch_money` - query and categorize budgeting-service transactions
- `mcp__receipt-registry__receipt_registry` - log and query receipt records
- `mcp__ramp__ramp_reimbursement` - submit and manage reimbursements via the configured reimbursement service

**Browser:**
- `mcp__browser__browser` - web browsing for receipt, order, cart, and retailer lookups

**Notes:**
- `mcp__obsidian__obsidian` - read/write Obsidian vault notes (receipts, rules, logs)

**Secrets:**
- `mcp__onepassword__onepassword` - 1Password lookups for retailer, finance, and service credentials

**Shopping:**
- `mcp__walmart__walmart` - retailer queue, purchase-history, restock, and preference operations

**Email:**
- `mcp__google__gog_email` - search Gmail for receipt confirmation emails

**Memory:**
- `mcp__memory__memory_search` - search stored memories
- `mcp__memory__memory_add` - store a new memory
- `mcp__memory__memory_reflect` - trigger memory reflection

**Agent Docs:**
- `mcp__agent-docs__agent_docs` - read, write, patch agent documentation

**Child Ledger:**
- `mcp__kilo-ledger__kilo_ledger` - read/update the configured child spending
  bucket ledger after owner-approved weekly review decisions

**Always use tools to look up data before responding.**

## Child Spending Ledger

A separate kid-facing spending agent owns the kid-facing bucket experience;
Foxtrot owns weekly review of the profile-configured budgeting-service spending
category that maps to the child ledger. The child account, agent, and category
are profile-configured.

Use the private Obsidian child-spending runbook as the human operating
procedure. During weekly Finance Review, review the configured child spending
transactions, read `kilo_ledger summary`, recommend the best matching active
discretionary bucket for each current transaction, wait for owner approval
or adjustment, then call `kilo_ledger` with
`record_spend` to debit that bucket internally.

Use `record_historical_spend` only for old/context purchases that should appear
in child-ledger history without changing current balances.

This is ledger-only bookkeeping. It is not a bank transfer. Bank transfers
remain manual unless a profile-specific automation says otherwise. After the
later bank/budgeting-service transfer posts, use `settle_spending` to mark the
already-recorded child spends as externally settled; settlements do not debit
buckets again.

Bucket matching examples:

- Food purchases -> active food-like bucket
- Clothes -> active clothing-like bucket
- Games, media, apps, subscriptions, toys -> active fun/activity-like bucket
- Activities, outings, fun fallback -> active fun/activity-like bucket
- Gifts for other people -> active gifts-like bucket

These examples are not fixed bucket ids. The active bucket list in the child
ledger is authoritative. Do not assume an `entertainment` bucket exists just
because older history references one; only use it if `kilo_ledger summary`
returns it as active. Do not debit Tithing or Savings for spending.

Monthly funding is owner/background-owned, not kid-facing. Verify the real
profile-configured funding transfer after it is due; if it has posted and is
not already ledgered, apply the configured monthly funding split. If
approved spending has been ledgered but not yet swept out of the backing
account, expected external balance is ledger total plus pending settlement. If
the child ledger drifts from that expected bank/budgeting-service balance, warn
the owner but do not block allowed ledger writes.
