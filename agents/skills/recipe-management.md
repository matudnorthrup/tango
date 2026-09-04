# recipe_management

Step-by-step workflow for creating, reading, updating, and managing recipes in wellness.db.

## When to use

Any time the user asks to create a recipe, modify an existing one, check recipe macros, substitute ingredients, or plan meals using recipes.

## Tables

- `recipes` — name, shorthand, servings, total macros (calories, protein_g, carbs_g, fat_g), instructions, `yield_g` (finished batch grams), `archived_at` (retired recipes)
- `recipe_ingredients` — `recipe_id` plus either `product_id` or `sub_recipe_id` (a component recipe), `quantity_g` (canonical grams), display `quantity`, and per-ingredient macros
- `recipe_aliases` — alternative names for recipes
- `products` — ingredient source with macros, serving sizes, brands

## Recipe Read

1. Use `wellnessdb_search_recipe` by name, shorthand, or alias; archived recipes are excluded by default.
2. Use `wellnessdb_get_recipe_detail` to read product ingredients and nested component references. Check `archived_at` on detail results.
3. Return: recipe name, serving count, per-serving macros, full ingredient list with quantities.

## Recipe Create

1. **Resolve every ingredient** — match each product with `wellnessdb_search_product` (`active_only: true`) or a component with `wellnessdb_search_recipe`. If it does not exist, report it as unresolved.
2. **Calculate macros** — sum ingredient macros for total recipe macros. Divide by servings for per-serving.
3. **Write the recipe** — use `wellnessdb_add_recipe` with name, servings, and product ingredients; the tool calculates totals.
4. **Respect the write schema** — product ingredients take `product`, display `quantity`, and a `servings` multiplier against product macros. Canonical `quantity_g`, component `sub_recipe_id`, and batch `yield_g` exist in the data model but are not supported inputs to these recipe write tools. Report that limitation for component or canonical-gram edits.
5. **Add shorthand** — pass the user-provided shorthand at creation.
6. **Add aliases** — pass common alternative names in `aliases` at creation.

## Recipe Update

1. **Identify the recipe** — find by name, shorthand, or alias.
2. **Make the change** — call `wellnessdb_update_recipe` by name/shorthand/alias with the complete product ingredient list, including for notes-only edits; it replaces all ingredient rows. Do not use it on recipes with components or canonical gram data that the schema cannot preserve.
3. **Recalculate macros** — any ingredient change requires recalculating total and per-serving macros. These must stay consistent.
4. **Preserve aliases** — existing aliases remain; this update tool does not accept new aliases.

## Ingredient Substitution

When suggesting alternatives, work within configured food preferences from the
profile overlay. Check the products table for available alternatives before
suggesting anything external.

For each substitution: show the macro impact (what changes in calories, protein, carbs, fat per serving).

## Meal Planning and Grocery Lists

1. **Build a meal plan** — select recipes and meals for the timeframe based on configured food preferences, rotation rules, and what's in season/available.
2. **Generate a grocery list** — pull ingredients from the planned recipes, aggregate quantities, and organize by store or category.
3. **Save the plan** — write to `nutrition/meal-plans/` with the date range in the filename.

The grocery list is a generated output from the meal plan, not a separate document to maintain.

## Rules

- **Every ingredient must resolve to a product or component recipe.** No unlinked ingredients.
- **Never fabricate nutrition data.** If a product isn't in wellness.db, report it unresolved.
- **Per-serving macros must match total macros / servings.** Always recalculate on changes.
- **Preserve recipe_aliases on updates.**
- **Canonical ingredient amounts are `quantity_g`.** Component portions scale against the component recipe's `yield_g`; never guess either value.
- **Read recipes only from wellness.db**, never markdown notes.

## Output

Return a concise plain-text summary:
- Recipe name and serving count
- Per-serving macros (calories, protein, carbs, fat)
- Full ingredient list (if read or create)
- What changed (if update)
- Macro impact of substitutions (if applicable)
- Any unresolved ingredients and why
