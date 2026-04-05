# receipt_logging

Create permanent Obsidian receipt records from retailer orders. These receipts are referenced during transaction categorization to identify items that need different categories or splits.

## When to use

After extracting order details from a retailer (Amazon, Walmart, Costco, etc.), use this skill to create the Obsidian receipt file.

## File structure

```
{notes-root}/Receipts/
├── Amazon/
│   └── 2026-02-01 Order 114-1354245-9764620.md
└── Walmart/
    └── 2026-01-29 Order 2000143-13986798.md
```

Create retailer subfolders as needed. Do NOT create other folder nesting.

## Receipt template

**Filename:** `YYYY-MM-DD Order {ORDER_ID}.md`

Use the `obsidian` tool to create the file at `Records/Receipts/{Retailer}/` with this format:

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
- Reimbursable Item: Driver tip
- Amount: ${driver_tip_amount} (include only when a reimbursable tip exists)
- Note: use the installation's configured reimbursement memo or leave blank
```

## Category assignment rules

Reference the installation's active finance rules note for the authoritative rules file.

Common product-to-category mappings for receipt items:

- Tea, coffee, food, beverages, snacks → Groceries
- Cleaning supplies, toiletries, household consumables → Groceries (don't split)
- Supplements, medicine, health items → Health
- Electronics, gadgets → One-off Expenses
- Kitchen items, tools, home items → Home Improvement
- LEGO, toys, kids items → Kids / Allowance
- Motor oil, filters, car parts → Auto Repair
- Boat oil, marine parts → Fishing & Outdoors
- Travel gear → Travel

## Rules

- Always include the Lunch Money transaction ID if known.
- Use the `obsidian` tool with `create` command and the installation's default vault.
- Keep grocery summaries brief — don't list every item, just note the approximate total and key items.
- Non-grocery items need individual line items with prices for accurate splits later.
- If the order was split across multiple shipments/charges, note all transaction IDs.
- For Walmart delivery receipts, always capture the driver tip amount if present. That tip is a work reimbursement candidate and should be tracked in the receipt note.
