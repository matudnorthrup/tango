# food_logging

Step-by-step workflow for resolving foods and logging meals to FatSecret.

## When to use

Any time the user asks to log a meal, snack, or individual food items.

## Lookup cascade

Every food item must be resolved through this cascade before logging. Do not skip steps.

### Step 1: Find the recipe in wellness.db

If the user names a saved dish, use `wellnessdb_search_recipe` with the name,
shorthand, or alias, then `wellnessdb_get_recipe_detail` for ingredients and
servings. Recipes live in wellness.db; never read markdown notes. If no recipe
matches, resolve the actual product with `wellnessdb_search_product`.

### Step 2: Log by name and quantity

1. Call `nutrition_log_items` with the recipe NAME and servings quantity, for example `{"name":"Yogurt bowl","quantity":"1 serving"}`. Component recipes can use their name and a gram quantity.
2. The tool expands ingredients itself, including nested components. Do not pre-expand recipes. Concrete products and amounts can go in the same batch.
3. For substitutions, name the actual product or recipe used instead. Resolve the actual amounts before logging; do not log the unchanged full recipe alongside replacement ingredients.
4. If items are unresolved, resolve only those remaining items. If the tool returns a structural runtime error or `blocked` with no logged entries, stop and report the failure; do not retry with guessed or empty parameters.

### Step 3: Product lookup for unresolved items

1. Use `wellnessdb_search_product` by name or shorthand with `active_only: true`.
2. Use stored FatSecret mappings and `grams_per_serving` for the actual product, then retry the unresolved item through `nutrition_log_items` with its resolved name and quantity.
3. If multiple products match, choose only an unambiguous name/brand match; otherwise ask. Do not guess quantities or substitute a different product silently.
4. A missing recipe yield, ambiguous component, or missing amount needs clarification, not FatSecret search.

### Step 4: FatSecret search (last-resort fallback)

Only for products with no FatSecret mapping in wellness.db (including products not found):

1. Call `fatsecret_api` with `method: "foods_search"` using a specific search expression.
2. Match the actual name and brand, then call `food_get` to verify serving details.
3. Use the verified mapping and serving metadata for the unresolved item only. Do not re-log items already confirmed by `nutrition_log_items`.

### Restaurant and branded calorie overrides

When the user gives an explicit calorie count for a restaurant or branded item:

1. Treat the user's calorie count as the target you should preserve. Do not decompose the item into ingredients just because an exact serving is missing.
2. Search FatSecret for the same restaurant and item family first.
3. If you find a strong same-brand same-item match but only in a nearby serving size, you may scale `number_of_units` to hit the user's stated calories.
4. Use the user's wording as `food_entry_name` so the diary label reflects what they actually ate, not the nearest fallback serving title. `food_entry_name` is a **first-class input** — always set it to what the user said rather than the FatSecret default.
5. After the write, call `food_entries_get` and verify the refreshed diary entry before claiming success.
6. Only stop for clarification if you cannot find a strong same-brand same-item match at all.

### Step 5: Log unresolved fallback items to FatSecret

For each remaining resolved fallback item, call `food_entry_create` with:
- `food_id` and `serving_id` from wellness.db or FatSecret
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

- **Never skip the cascade.** Use the batch logger first when you have concrete items, then wellness.db lookup and FatSecret fallback only for the unresolved remainder.
- **Never fabricate food data.** If a food can't be found in wellness.db or FatSecret, report it as unresolved. Do not invent calories, macros, food_ids, or serving_ids.
- **Never guess gram conversions.** Use `grams_per_serving` from wellness.db or `metric_serving_amount` from FatSecret to compute `number_of_units`. Do not estimate.
- **Verify serving shape before writes.** If the selected serving might be gram-denominated, inspect `food_get` first and follow the serving semantics FatSecret actually exposes. Raw gram servings take raw grams in `number_of_units`; portion-style servings take serving fractions.
- **Preserve explicit restaurant calories.** If the user says a restaurant or branded item was `730 calories`, keep that calorie target by scaling the closest strong same-item FatSecret match instead of refusing the write or decomposing the meal.
- **Do not claim an unverified write succeeded.** If FatSecret is unreachable, rejects the write, or diary refresh fails, return the attempted items as unconfirmed instead of logged.
- **Cancelled connector calls are not receipts.** A cancelled `foods_search`, `food_get`, `food_entry_create`, or `food_entries_get` call means the lookup or write is unverified until a later successful FatSecret read confirms it.
- **Batch efficiently.** Pass recipe names and quantities together to `nutrition_log_items`; it expands and resolves their ingredients in one batch. Search individually only for unresolved products.

## Output

After logging, return:
- What was logged (ingredient, amount, meal, calories, protein)
- Day totals refreshed from `food_entries_get`
- Any unresolved items that couldn't be logged
