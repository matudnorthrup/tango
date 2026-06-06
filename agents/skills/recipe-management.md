# recipe_management

Step-by-step workflow for creating, reading, updating, and managing recipes in wellness.db.

## When to use

Any time Darla asks to create a recipe, modify an existing one, check recipe macros, substitute ingredients, or plan meals using recipes.

## Tables

- `recipes` — name, shorthand, servings, total macros (calories, protein_g, carbs_g, fat_g), instructions
- `recipe_ingredients` — recipe_id → product_id mapping with per-ingredient quantity and macros
- `recipe_aliases` — alternative names for recipes
- `products` — ingredient source with macros, serving sizes, brands

## Recipe Read

1. Search recipes by name, shorthand, or alias (check recipe_aliases table).
2. Pull ingredient list from recipe_ingredients joined to products.
3. Return: recipe name, serving count, per-serving macros, full ingredient list with quantities.

## Recipe Create

1. **Resolve every ingredient** — match each ingredient name to a products table entry. If a product doesn't exist, report it as unresolved.
2. **Calculate macros** — sum ingredient macros for total recipe macros. Divide by servings for per-serving.
3. **Write the recipe** — insert into recipes table with name, servings, total macros.
4. **Write ingredients** — insert each ingredient into recipe_ingredients with recipe_id, product_id, quantity, and per-ingredient macros.
5. **Add shorthand** — if Darla provides a shorthand name, set it on the recipe.
6. **Add aliases** — if the recipe has common alternative names, add to recipe_aliases.

## Recipe Update

1. **Identify the recipe** — find by name, shorthand, or alias.
2. **Make the change** — update ingredients, quantities, servings, or instructions.
3. **Recalculate macros** — any ingredient change requires recalculating total and per-serving macros. These must stay consistent.
4. **Preserve aliases** — never drop existing recipe_aliases when updating.

## Ingredient Substitution

When suggesting alternatives, work within Darla's food preferences:
- No added sugar
- Organic and non-GMO when possible
- Whole, minimally processed foods
- Check the products table for available alternatives before suggesting anything external

For each substitution: show the macro impact (what changes in calories, protein, carbs, fat per serving).

## Meal Planning and Grocery Lists

1. **Build a meal plan** — select recipes and meals for the timeframe based on Darla's food preferences, rotation rules, and what's in season/available.
2. **Generate a grocery list** — pull ingredients from the planned recipes, aggregate quantities, and organize by store or category.
3. **Save the plan** — write to `nutrition/meal-plans/` with the date range in the filename.

The grocery list is a generated output from the meal plan, not a separate document to maintain.

## Rules

- **Every ingredient must resolve to a products entry.** No unlinked ingredients.
- **Never fabricate nutrition data.** If a product isn't in wellness.db, report it unresolved.
- **Per-serving macros must match total macros / servings.** Always recalculate on changes.
- **Preserve recipe_aliases on updates.**
- **Include concrete quantities** on ingredient lines (grams, cups, count).

## Output

Return a concise plain-text summary:
- Recipe name and serving count
- Per-serving macros (calories, protein, carbs, fat)
- Full ingredient list (if read or create)
- What changed (if update)
- Macro impact of substitutions (if applicable)
- Any unresolved ingredients and why
