# transaction_categorization

Lunch Money transaction categorization workflow. Pull uncleared transactions, verify or apply categories, handle splits, and present ambiguous ones for user review.

## When to use

When the user asks to categorize transactions, review spending, or clean up their Lunch Money inbox.

## Step 1: Get uncleared transactions

```json
{
  "method": "GET",
  "endpoint": "/transactions?status=uncleared&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD"
}
```

Adjust date range as needed. In this workflow, `uncleared` means the
transaction has not been reviewed by our process yet. It may already have a
category from a Lunch Money rule; still verify it against the finance rules.

```json
{
  "method": "GET",
  "endpoint": "/transactions?status=uncleared&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD"
}
```

## Reconcile context before categorizing or asking questions

For each item, check the supplied conversation and prior decisions, then retrieve
matching memory and live records using its transaction ID, merchant, date, and
amount. A broad nightly-review search is not enough to conclude it is unknown.
A prior explicit correction for the same purchase takes precedence over an old
merchant heuristic; verify the current category list and transaction first.

For refunds, find the original purchase and its confirmed category or split.
Use order/transaction links, amount, dates, and receipt evidence to establish the
match. A merchant name alone is insufficient, especially for partial refunds or
multiple purchases. Apply the original category only to a verified matching
refund; resolve partial-return item details before reversing a split.

For reimbursement-related charges, retrieve the prior discussion and linked
reimbursement records before flagging them again. Distinguish a planned,
submitted, and actually paid reimbursement; memory of a plan does not prove
payment, and a matching amount alone does not establish a link.

## Step 2: Apply automatic rules

For background jobs, the deterministic pre-check reads
`References/Finance/Lunch Money Rules.md` beneath the configured vault and
places the verified content directly in the task context. Use that supplied
content; do not perform a second path lookup. If the verified content is absent,
stop without updating or clearing transactions and report the run as blocked.
Never guess or silently fall back to a default category.

For an interactive categorization request without supplied rules, read the note
through the Obsidian tool with the vault-relative path exactly once:
`print 'References/Finance/Lunch Money Rules.md' --vault main`. The tool adds
`.md` only when it is absent, so do not append another extension.

### Budget-neutral transfer guard

Apply this guard before ordinary payee rules or an existing auto-applied
category. Transactions explicitly identified in task context as internal bank
transfers must use the live Lunch Money category named exactly `Transfer` and
must not retain a spend, income, or sinking-fund category. Clear successfully
classified transfers and omit them from spend/income review.

When no deterministic transfer list is supplied, treat a transaction as an
internal bank transfer only when both signals agree:

- Plaid metadata identifies an account transfer (`TRANSFER_IN` or
  `TRANSFER_OUT` with an `ACCOUNT_TRANSFER` or `SAVINGS` detail); and
- the payee explicitly describes a transfer to/from a named bank account, or
  the counterparty is a financial institution and the payee says transfer
  to/from.

This includes ALLY internal account legs and equivalent bank-account transfers.
It does not include Venmo payments, ATM cash withdrawals, or ambiguous merchant
transfers solely because Plaid uses a broad transfer label.

For each uncategorized transaction, check payee against rules (first match wins). Auto-categorizable transactions can be updated directly:

```json
{
  "method": "PUT",
  "endpoint": "/transactions/{id}",
  "body": {
    "transaction": {
      "category_id": 0,
      "status": "cleared",
      "notes": "Auto-categorized by rule: Safeway → Groceries"
    }
  }
}
```

Resolve `category_id` from a live `GET /categories` call — IDs are
installation-specific. The `0` above is a placeholder.

## Step 3: Handle excluded vendors

These vendors span multiple categories and require item-level evidence before
categorization. They do not automatically require another question to the user:
- **Amazon** — groceries, electronics, kids, home, business
- **Walmart / WMT Scan-n-go** — groceries, home, kids, auto
- **Costco** — groceries, auto, home
- **Fred Meyer** (non-fuel) — groceries, home, pharmacy
- **Subway / Chipotle / Similar restaurants** — could be personal or work reimbursement

For Amazon and Walmart, first query `receipt_registry lookup_receipts`. Use a
matched itemized receipt to categorize or split. During scheduled reviews, when
no receipt matches, check the supplied receipt-cataloger dependency status and
`state_query` for the `automation-job` before asking about the purchase. If
cataloging is pending or running, leave the transaction uncleared and report it
as waiting for receipt cataloging, with a next check after cataloging completes.
Do not ask the user what an Amazon purchase was while that workflow is pending.
If the job failed, is disabled, or its next expected run is overdue, surface that
specific blocker and next action. A successful job does not prove this particular
receipt exists; verify it in the registry. Avoid repeating the same blocker or
question from the supplied history without a material change.

For interactive receipt lookup, or when the scheduled task explicitly assigns
cataloging to this run, use the `amazon_orders` or `walmart_orders` skill to look
up the order via browser, then `receipt_logging` to create the receipt.
If a receipt note already exists, use `receipt_registry lookup_receipts` before
opening the retailer site. Matched receipts return `lunchMoneyNote`; copy that
value into the Lunch Money note so item details are visible in Lunch Money and
the Obsidian receipt link remains the final line.

Special Walmart rule:
- If a cataloged Walmart delivery receipt shows a reimbursable driver tip, split the driver tip to the configured **work reimbursements** category and the remaining grocery merchandise to **Groceries** (plus any other non-grocery item categories present in the receipt).
- If the driver tip posted as its own separate transaction, categorize that transaction entirely to the configured **work reimbursements** category.

For Costco: use the browser to look up the order on costco.com (order history). Then use `receipt_logging` to create the receipt, same flow as Amazon/Walmart.

For Venmo: use `gog_email` to search Gmail for the Venmo payment confirmation email matching the amount and approximate date. The email contains the recipient and payment note — use those to determine the category. Create a receipt via `receipt_logging` at `Records/Finance/Receipts/Venmo/`.

For restaurants (Subway, Chipotle, etc.), check prior decisions and reimbursement
evidence first. Ask whether it was personal or a work lunch only if still unresolved
and the same question is not already awaiting an answer.

## Lunch Money note policy

For receipt-backed transactions and splits:

- Put the itemized purchase summary first.
- Put category notes or split rationale after the items when useful.
- Put the Obsidian receipt link as the final line.
- Do not use notes that only say `Receipt`, only include a URL, or only repeat
  a category label such as the configured personal-spending category.
- If the category is the configured personal-spending category, include the
  purchased item details and the evidence basis. If the evidence is ambiguous,
  leave it uncleared or ask the user instead of silently assigning the
  personal-spending category.

Preferred receipt-backed note format:

```text
Items:
- George Men's Solid Black Slim Necktie - $10.00
- Mens Primry Color Synthetic Player Jersey - $33.00
Total: $53.70
Categories: Necktie, Jersey -> Clothing & Accessories; Frozen strawberries -> Groceries
Receipt: obsidian://open?vault=main&file=Records%2FFinance%2FReceipts%2FWalmart%2F...
```

## Step 4: Transaction splits

When an order contains items spanning multiple categories (e.g., Walmart with groceries + a LEGO set), the transaction must be split.

Also split when a Walmart delivery order includes a reimbursable driver tip:
- reimbursement tip amount -> configured work reimbursements category
- remaining merchandise -> Groceries and/or other item categories from the receipt

Lunch Money split via API (use `PUT` on the parent transaction with a `split` array — there is no separate `/split` or `/group` endpoint):

```json
{
  "method": "PUT",
  "endpoint": "/transactions/{id}",
  "body": {
    "split": [
      { "amount": 48.94, "category_id": 0, "notes": "Items:\n- Great Value Whole Strawberries 16 oz (Frozen) - $2.86\n- Other grocery items - $46.08\nTotal: $48.94\nReceipt: obsidian://open?vault=main&file=Records%2FFinance%2FReceipts%2FWalmart%2F..." },
      { "amount": 20.28, "category_id": 0, "notes": "Items:\n- Hookboards - $20.28\nTotal: $20.28\nReceipt: obsidian://open?vault=main&file=Records%2FFinance%2FReceipts%2FWalmart%2F..." }
    ]
  }
}
```

**Note:** Split amounts are dollar strings, not cents. They must sum to the original transaction amount.

## Step 5: Present results

Report to the orchestrator:
- How many transactions were auto-categorized (with rule matches)
- How many were split (with details)
- How many need user input (with the question for each)
- How many await another automation, its blocker if any, and when to revisit
- How many remain unresolved

## Lunch Money category mapping

Category IDs are installation-specific. At the start of a categorization session:

```json
{ "method": "GET", "endpoint": "/categories" }
```

Use the categorization rules file (see Step 2) as the authoritative source for payee matching patterns and category names. Do not assume category names or IDs without checking the current system via `GET /categories`.

## Rate limiting

Lunch Money API: wait at least 0.3s between calls. When bulk-categorizing, don't fire all PUTs simultaneously.
