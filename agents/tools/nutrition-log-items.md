# nutrition_log_items

High-level nutrition diary logger for common meal writes.

Use this as the default write path when the user already provided concrete foods and quantities and the items are likely to exist in Atlas. The tool resolves Atlas matches, derives FatSecret units, writes the diary entries, and refreshes the day in one transaction.

## Input

```json
{
  "items": [
    { "name": "light vanilla greek yogurt", "quantity": "100g" },
    { "name": "cocoa powder", "quantity": "4g" }
  ],
  "meal": "breakfast",
  "date": "2026-04-09",
  "strict": true
}
```

## Behavior

- Atlas-backed first: resolves against the ingredient catalog before writing.
- Transactional: writes the resolved items, then refreshes the diary once.
- Safe by default: if `strict` is true, any unresolved item prevents all writes.
- Honest fallback: unresolved items are returned explicitly instead of guessed.

## When To Use

- Logging a simple meal or snack with specific quantities.
- Logging recipe ingredients after you already expanded the recipe.
- Fast common-case meal logging where Atlas coverage is likely.

## When Not To Use

- You need raw FatSecret search results or serving metadata inspection.
- The request is a repair/debug task for an earlier failed log.
- The foods are not in Atlas and you need exploratory lookup.

Use `fatsecret_api` for those lower-level cases.

## Output

Returns structured data:
- `status`: `confirmed`, `partial_success`, `needs_clarification`, or `blocked`
- `logged`: confirmed diary writes
- `unresolved`: items that still need clarification or low-level lookup
- `totals`: summed estimated macros for the confirmed items
- `diary_entries`: refreshed day snapshot when available
- `errors`: concrete write or refresh failures
