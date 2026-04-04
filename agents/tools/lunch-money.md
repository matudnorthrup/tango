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
- `GET /transactions?status=unreviewed`
- `PUT /transactions/:id`
- `POST /transactions/:id/group`
- `GET /categories`
- `GET /budgets?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD`

## Notes

- Split amounts are dollar strings, not cents.
- Transaction updates require a top-level `transaction` wrapper.
- The API uses `https://dev.lunchmoney.app/v1`.
- This environment does not expose a working recurring-items endpoint. Verify recurring transfers or subscriptions from transaction history instead.

## Output

Returns parsed JSON when possible, otherwise `result` with raw text. Errors come back as `error`.
