# food_logging

Step-by-step workflow for resolving foods and logging meals to FatSecret.

## When to use

Any time the user asks to log a meal, snack, or individual food items.

## Lookup cascade

Every food item must be resolved through this cascade before logging. Do not skip steps.

### Step 1: Recipe check

If the user names a dish that could be a saved recipe (e.g., "protein yogurt bowl," "chicken stir fry," "overnight oats"):

1. Call `recipe_read` with the dish name.
2. If a match is found, use the recipe's ingredient list as the items to log. Each ingredient line has a gram amount and often an Atlas-linked food_id.
3. If no match is found, proceed to resolve the food as individual ingredients.

### Step 2: Atlas lookup

For each ingredient or food item to log:

1. Query `atlas_sql` — search by name, aliases, and brand:
   ```sql
   SELECT * FROM ingredients
   WHERE name LIKE '%search_term%' OR aliases LIKE '%search_term%';
   ```
2. If Atlas returns a match with `food_id` and `serving_id`, use those IDs as the starting point for logging.
3. If Atlas also has a trustworthy `grams_per_serving`, use it to convert the user's gram amount into `number_of_units` for portion-style servings such as `1 serving`, `1/2 cup`, or `1 large`.
4. If the Atlas row uses a gram-based serving (`serving_size: 46g`, `84g`, `100 g`, etc.) or the serving semantics are otherwise unclear, call `fatsecret_api` with `method: "food_get"` for that `food_id` before writing so you can verify whether FatSecret expects grams directly or fractional servings.
5. If Atlas has multiple matches, pick the one whose name/brand best fits the user's description. If genuinely ambiguous, report it as unresolved and ask.

### Step 3: FatSecret search (fallback only)

Only if Atlas has no match for an ingredient:

1. Call `fatsecret_api` with `method: "foods_search"` using a specific search expression.
2. Review results carefully — pick the entry whose name, brand, and serving size best match what the user described.
3. If needed, call `food_get` to inspect serving details before logging.
4. After logging, consider adding the ingredient to Atlas for next time (if it's something the user eats regularly).

### Step 4: Log to FatSecret

For each resolved ingredient, call `food_entry_create` with:
- `food_id` and `serving_id` from Atlas or FatSecret
- `number_of_units` computed from the user's stated amount and the serving's `grams_per_serving` or `metric_serving_amount`
- Correct `meal` slot and `date`

After writing, call `food_entries_get` for the target date so the receipt and totals are refreshed from the diary, not inferred locally.

Meal-slot normalization:
- If the user says `snack` or `snacks`, normalize that to FatSecret meal `other` for diary writes and receipts.
- Do not silently remap any other meal label; if it does not match `breakfast`, `lunch`, `dinner`, or `other`, ask.

### Tool failure handling

If `fatsecret_api` returns a generic cancellation or other opaque failure while the environment may be degraded:

1. Retry the critical read or write once.
2. Verify whether the underlying problem is connectivity, auth, or another FatSecret-side error.
3. If a direct fallback or local script is available, use it once to turn the opaque cancellation into a concrete failure.
4. If the concrete failure is a network restriction, DNS failure, auth error, or other environment-level block, stop retrying and return the write as unconfirmed or blocked instead of implying success.
5. If the diary cannot be refreshed after the write attempt, return the write as unconfirmed and include the concrete failure instead of implying success.
6. Treat `user cancelled MCP tool call` as an unconfirmed operation, not a successful write. Do not report calories, macros, or "logged" status unless a subsequent FatSecret read in the same run verifies the diary state.
7. For continuation or repair tasks, ignore any prior assistant claim that the item was already logged unless the current run verifies the diary state for the exact target date and meal.

## Rules

- **Never skip the cascade.** Atlas exists so the user doesn't have to describe the same food twice. Skipping it means wrong food_ids, wrong servings, wrong macros.
- **Never fabricate food data.** If a food can't be found in Atlas or FatSecret, report it as unresolved. Do not invent calories, macros, food_ids, or serving_ids.
- **Never guess gram conversions.** Use `grams_per_serving` from Atlas or `metric_serving_amount` from FatSecret to compute `number_of_units`. Do not estimate.
- **Verify serving shape before writes.** If the selected serving might be gram-denominated, inspect `food_get` first and confirm whether `number_of_units` should be grams or fractional servings.
- **Do not claim an unverified write succeeded.** If FatSecret is unreachable, rejects the write, or diary refresh fails, return the attempted items as unconfirmed instead of logged.
- **Cancelled connector calls are not receipts.** A cancelled `foods_search`, `food_get`, `food_entry_create`, or `food_entries_get` call means the lookup or write is unverified until a later successful FatSecret read confirms it.
- **Batch efficiently.** If logging a recipe with 8 ingredients, run the Atlas query for all of them in one SQL call (using OR conditions) before falling back to individual FatSecret searches for any misses.

## Output

After logging, return:
- What was logged (ingredient, amount, meal, calories, protein)
- Day totals refreshed from `food_entries_get`
- Any unresolved items that couldn't be logged
