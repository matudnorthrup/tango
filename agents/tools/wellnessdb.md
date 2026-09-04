# wellnessdb

Malibu's nine tools use the active profile's `wellness/wellness.db` through the
`wellness-db` MCP server. Jules also has other wellness.db tools in her allowlist.

| Tool | Access | Purpose and inputs |
| --- | --- | --- |
| `wellnessdb_search_product` | Read | Find products, macros, and FatSecret mappings by `query`; set `active_only: true` to exclude discontinued products. |
| `wellnessdb_search_recipe` | Read | Find recipes by `query` (name, shorthand, alias); `include_archived` defaults to false. |
| `wellnessdb_get_recipe_detail` | Read | Read recipe, ingredient/component rows, macros, and aliases by `query` (name, shorthand, alias, numeric ID). |
| `wellnessdb_day_summary` | Read | Read meals, totals, aggregates, and note for `date` (defaults to today). |
| `wellnessdb_day_range` | Read | Read daily aggregates from `start_date` through `end_date`. |
| `wellnessdb_recent_meals` | Read | Read latest meal entries with `limit` (default 10, max 50). |
| `wellnessdb_active_products` | Read | List products with no `discontinued_date`. |
| `wellnessdb_add_recipe` | Write | Create with `name`, `ingredients` (each a `product` or component `sub_recipe`, with `quantity_g`); optional `servings`, `yield_g` (component batch weight), `shorthand`, `instructions`, `notes`, `aliases`. |
| `wellnessdb_update_recipe` | Write | Update by name/shorthand/alias `query`. Omit `ingredients` to change only `servings`, `yield_g`, `instructions`, `notes`, or add `aliases` (rows untouched). Pass `ingredients` only as the FULL list from `get_recipe_detail`, products and `sub_recipe` rows alike, with `quantity_g`. |

Searches return matches and counts; detail returns `recipe`, `ingredients`, and
`aliases`; writes return the recipe ID. Product search includes discontinued
products unless `active_only` is true. Recipe detail can return archived recipes;
check `archived_at` even when the query is a numeric ID.

Recipes store servings, total macros, `yield_g` (finished batch grams), and
`archived_at`. Each `recipe_ingredients` row links a product via `product_id` or a
component via `sub_recipe_id`; `quantity_g` is canonical grams and `quantity` is
display text. Component grams scale against that component's `yield_g`.

Recipe writes currently accept product ingredients shaped as
`{"product":"plain yogurt","quantity":"100g","servings":1}`; `servings` multiplies
the product's stored macros. They do not accept `quantity_g`, `sub_recipe_id`,
`yield_g`, or `archived_at`. Update requires the full ingredient list even for a
notes change, so do not use it where those unsupported fields would be lost.

To log to FatSecret, pass the recipe NAME and servings (or component name and
grams) to `nutrition_log_items`; it expands nested ingredients itself. These
wellness.db summary tools read the local meal log, not the FatSecret diary.
