# walmart

Walmart queue and purchase-history tool.

## Input

```json
{
  "action": "queue_add",
  "items": ["zero sugar Greek yogurt", "paper towels"],
  "note": "weekly restock"
}
```

## Queue actions

- `queue_add` with `items` or `query`, optional `note`
- `queue_list`
- `queue_clear`
- `queue_remove` with `index`

## History actions

- `history_analyze` with optional `days_back`, `top_n`
- `history_restock` with optional `days_back`
- `history_preferences`

## Data sources

- Queue file: profile data `walmart-queue.json` or `TANGO_WALMART_DATA_DIR`
- Preferences file: profile data `walmart-preferences.json` or `TANGO_WALMART_DATA_DIR`
- Receipt history: profile data receipts or `TANGO_WALMART_RECEIPTS_DIR`

## Output

Returns structured JSON for queue state, purchase statistics, restock recommendations, or saved preferences.

This tool does not drive Walmart.com directly. Use `browser` for cart interaction.
