# receipt_logging

Create permanent Obsidian receipt records from retailer orders. These receipts are referenced during transaction categorization to identify items that need different categories or splits.

## When to use

After extracting order details from a retailer (Amazon, Walmart, Costco, etc.), use this skill to create the Obsidian receipt file.

## File structure

```
Records/Finance/Receipts/
├── Amazon/
│   └── 2026-02-01 Order 114-1354245-9764620.md
└── Walmart/
    └── 2026-01-29 Order 2000143-13986798.md
```

Create retailer subfolders as needed. Do NOT create other folder nesting.

## Receipt template

**Filename:** `YYYY-MM-DD Order {ORDER_ID}.md`

Use the `obsidian` tool to create the file at `Records/Finance/Receipts/{Retailer}/` with this format:

Every receipt note must include vault-standard frontmatter. Do not write
frontmatter `categories`; Lunch Money categories belong in the body text or
Lunch Money itself, not in Obsidian taxonomy.

```yaml
---
date: YYYY-MM-DD
types:
  - "[[Receipt]]"
areas:
  - "[[Finance]]"
merchant: "{Retailer or vendor}"
order_number: "{ORDER_ID}"
total: 0.00
reimbursable: false
source_kind: record
---
```

For any vendor listed in `reimbursement-config.yaml`, always include a
`## Reimbursement Tracking` section. For reimbursable receipts, set
`reimbursable: true` and include these additional frontmatter fields:

```yaml
ramp_submitted: null
ramp_report_id: null
amount: 0.00
```

Use numeric `total` and `amount` values with no dollar sign. `reimbursable`
must be the boolean `true` or `false`, not a string.

```markdown
# {Retailer} Order {ORDER_ID}

- **Date:** YYYY-MM-DD
- **Total:** ${total}
- **Card Charge:** ${card_amount} (include only if different from total, e.g. Walmart Cash applied)
- **Items:** {count}

## Non-Grocery Items

| Item | Qty | Price | Suggested Category |
|------|-----|-------|--------------------|
| Product Name | 1 | $XX.XX | Category Name |

## Grocery Items (Summary)

~${amount} in groceries including: brief item list

## Linked Transactions

- Lunch Money TXN {id}: ${amount} ({category or "uncategorized"})

## Notes

Any relevant context (partial shipment, return pending, Walmart Cash used, etc.)

## Reimbursement Tracking

- Status: not_submitted
- System: Ramp
- Ramp Report ID: null
- Reimbursable Item: Driver tip
- Amount: ${driver_tip_amount} (include only when a reimbursable tip exists)
- Note: use the installation's configured reimbursement memo or leave blank
```

## Venmo example

When the receipt source is a Venmo confirmation email, use the same structure and include reimbursement tracking when the payment is reimbursable.

```markdown
# Venmo Payment to Jane Doe

- **Date:** 2026-04-04
- **Total:** $250.00
- **Recipient:** Jane Doe

## Linked Transactions

- Lunch Money TXN 1234567890: $250.00 (One-off Expenses)

## Notes

Invoice-backed Venmo reimbursement created from the Gmail payment confirmation.

## Reimbursement Tracking

- Status: not_submitted
- System: Ramp
- Ramp Report ID: null
- Amount: $250.00
- Note: use the installation's configured reimbursement memo
```

## Category assignment rules

Reference the installation's active finance rules note for the authoritative rules file. The concrete product-to-category mappings are tuned per installation and supplied by a profile overlay; resolve category names against the live Lunch Money categories.

Common product-to-category mapping shape (categories are profile-configured — examples only):

- Tea, coffee, food, beverages, snacks → grocery category
- Cleaning supplies, toiletries, household consumables → grocery category (don't split)
- Supplements, medicine, health items → health category
- Electronics, gadgets → one-off/discretionary category
- Kitchen items, tools, home items → home category
- Toys, kids items → kids/allowance category
- Motor oil, filters, car parts → auto category
- Travel gear → travel collection

## Rules

- Always include the Lunch Money transaction ID if known.
- Use the `obsidian` tool with `create` command and the installation's default vault.
- Check `config/defaults/reimbursement-config.yaml` to determine if a vendor is reimbursable and what the default memo is.
- Do not add frontmatter `categories`, scalar `type`, scalar `types`, or scalar `areas`.
- Keep grocery summaries brief — don't list every item, just note the approximate total and key items.
- Non-grocery items need individual line items with prices for accurate splits later.
- If the order was split across multiple shipments/charges, note all transaction IDs.
- For Walmart delivery receipts, always capture the driver tip amount if present. That tip is a work reimbursement candidate and should be tracked in the receipt note.
