# transaction_categorization

Lunch Money transaction categorization workflow. Pull uncategorized transactions, apply rules, handle splits, and present ambiguous ones for user review.

## When to use

When the user asks to categorize transactions, review spending, or clean up their Lunch Money inbox.

## Step 1: Get uncategorized transactions

```json
{
  "method": "GET",
  "endpoint": "/transactions?status=unreviewed&start_date=2026-01-01&end_date=2026-03-10"
}
```

Adjust date range as needed. Also check for explicitly uncategorized:

```json
{
  "method": "GET",
  "endpoint": "/transactions?status=unreviewed&start_date=2026-01-01&end_date=2026-03-10"
}
```

## Step 2: Apply automatic rules

Read the active finance rules note for this installation (for example `~/.tango/profiles/default/notes/finance/Lunch Money Rules.md`).

For each uncategorized transaction, check payee against rules (first match wins). Auto-categorizable transactions can be updated directly:

```json
{
  "method": "PUT",
  "endpoint": "/transactions/{id}",
  "body": {
    "transaction": {
      "category_id": 2413616,
      "status": "cleared",
      "notes": "Auto-categorized by rule: Safeway → Groceries"
    }
  }
}
```

## Step 3: Handle excluded vendors

These vendors span multiple categories and ALWAYS need human review:
- **Amazon** — groceries, electronics, kids, home, business
- **Walmart / WMT Scan-n-go** — groceries, home, kids, auto
- **Costco** — groceries, auto, home
- **Fred Meyer** (non-fuel) — groceries, home, pharmacy
- **Subway / Chipotle / Similar restaurants** — could be personal or work reimbursement

For Amazon and Walmart: use the `amazon_orders` or `walmart_orders` skill to look up what was in the order via browser. Then use `receipt_logging` to create an Obsidian receipt. The receipt tells you whether to categorize directly or split.

Special Walmart rule:
- If a cataloged Walmart delivery receipt shows a reimbursable driver tip, split the driver tip to **Work Reimbursements** and the remaining grocery merchandise to **Groceries** (plus any other non-grocery item categories present in the receipt).
- If the driver tip posted as its own separate transaction, categorize that transaction entirely to **Work Reimbursements**.

For Costco: use the browser to look up the order on costco.com (order history). Then use `receipt_logging` to create the receipt, same flow as Amazon/Walmart.

For Venmo: use `gog_email` to search Gmail for the Venmo payment confirmation email matching the amount and approximate date. The email contains the recipient and payment note — use those to determine the category. Create a receipt via `receipt_logging` at Records/Receipts/Venmo/.

For restaurants (Subway, Chipotle, etc.): ask the user whether it was personal or a work lunch.

## Step 4: Transaction splits

When an order contains items spanning multiple categories (e.g., Walmart with groceries + a LEGO set), the transaction must be split.

Also split when a Walmart delivery order includes a reimbursable driver tip:
- reimbursement tip amount -> Work Reimbursements
- remaining merchandise -> Groceries and/or other item categories from the receipt

Lunch Money split via API (use `PUT` on the parent transaction with a `split` array — there is no separate `/split` or `/group` endpoint):

```json
{
  "method": "PUT",
  "endpoint": "/transactions/{id}",
  "body": {
    "split": [
      { "amount": 48.94, "category_id": 2413616, "notes": "Groceries" },
      { "amount": 20.28, "category_id": 2413620, "notes": "Home Improvement - hookboards" }
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
- How many remain unresolved

## Lunch Money category mapping

Category IDs are installation-specific. At the start of a categorization session:

```json
{ "method": "GET", "endpoint": "/categories" }
```

Use the active finance rules note as the authoritative source for payee matching patterns and the active category names in this installation. Common categories often include Groceries, Work Reimbursements, Discretionary Spending, Family / Allowance, Home Improvement, Travel, and Health, but do not assume names or IDs without checking the current system.

## Rate limiting

Lunch Money API: wait at least 0.3s between calls. When bulk-categorizing, don't fire all PUTs simultaneously.
