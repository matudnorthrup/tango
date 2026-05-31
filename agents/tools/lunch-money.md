# lunch_money

Lunch Money REST API wrapper for transactions, categories, and budgets.

## Input

```json
{
  "method": "GET",
  "endpoint": "/transactions?start_date=2026-03-01&end_date=2026-03-09"
}
```

For writes:

```json
{
  "method": "PUT",
  "endpoint": "/transactions/123",
  "body": {
    "transaction": {
      "category_id": 45,
      "notes": "matched to Amazon order"
    }
  }
}
```

## Common endpoints

- `GET /transactions?...`
- `GET /transactions?status=uncleared&start_date=YYYY-MM-DD&end_date=YYYY-MM-DD`
- `PUT /transactions/:id`
- `GET /categories`
- `GET /budgets?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD`

## Notes

- Lunch Money uses `status=uncleared` for transactions not yet reviewed by this
  workflow. Do not use `status=unreviewed`; it is not a Lunch Money status.
- For receipt-backed spending, run `receipt_registry lookup_receipts` and copy
  the returned `lunchMoneyNote` into the Lunch Money transaction or split note
  when it matches the transaction.
- Receipt-backed notes must put the purchased items or summary first and the
  Obsidian receipt link last. Do not write notes that are only `Receipt`, only
  a URL, or an unexplained category label.
- Do not leave generic `Devin Spending` notes on receipt-backed transactions
  when item details are available. If the category is truly Devin Spending, the
  note still needs to say what was purchased and why that category is supported.
- Split amounts are dollar strings, not cents.
- Transaction updates require a top-level `transaction` wrapper. Splits use
  `PUT /transactions/:id` with a top-level `split` array.
- The API uses `https://dev.lunchmoney.app/v1`.
- This environment does not expose a working recurring-items endpoint. Verify recurring transfers or subscriptions from transaction history instead.

## Output

Returns parsed JSON when possible, otherwise `result` with raw text. Errors come back as `error`.
