# nutrition_logging

Step-by-step workflow for resolving foods and logging meals to wellness.db.

## When to use

Any time the user asks to log a meal, snack, supplement, or individual food item.

## Lookup cascade

Every item must be resolved through this cascade before logging. Do not skip steps.

### Step 1: Shorthand check

The user may use shorthand names. Before anything else, check the `shorthand` column:

```sql
SELECT id, name, shorthand FROM products WHERE shorthand LIKE '%keyword%';
SELECT id, name, shorthand FROM supplements WHERE shorthand LIKE '%keyword%';
SELECT id, name, shorthand FROM recipes WHERE shorthand LIKE '%keyword%';
```

Also check recipe_aliases if no shorthand match.

### Step 2: Product/recipe/supplement resolution

Match to a products, supplements, or recipes entry. Use the stored macros — never look up nutrition externally when the database has it.

For recipes: expand into ingredient list via recipe_ingredients table. Total macros come from the recipe row, adjusted by servings.

### Step 3: Log the entry

Write to meal_log with: date, meal type, product/recipe/supplement reference, servings, all four macros (calories, protein_g, carbs_g, fat_g), and meal_time.

Every item gets its own row. Never combine items into a single entry.

### Step 4: Supplement timing check

When the user reports a meal, check if supplements are due for that time of day per the supplement protocol. Compare what has been logged today against the protocol schedule.

### Step 5: FatSecret fallback (future)

If an item is not in wellness.db, search FatSecret API for nutrition data. This is a fallback — wellness.db is always checked first.

## Critical Shorthand Warnings

Profile-specific shorthand warnings belong in private prompt overlays. If a
shorthand is ambiguous or missing, ask before logging.

## How to Parse User Messages

The user may type naturally. Translate into structured entries.

**Example input:** "smoothie, fig bar, electrolyte drops magnesium"

**Parse as:**
1. "smoothie" → recipe (check recipes table)
2. "fig bar" → product (check products table)
3. "electrolyte drops magnesium" -> supplements (check supplements table, log each as its own row)

**Rules:**
- Use today's date unless the user says otherwise
- If she says a meal name (breakfast, lunch, etc.), use it. If not, infer from time of day.
- Supplements are always `meal = supplement`
- Servings: "2 fig bars" = servings 2 (one row). "half a smoothie" = servings 0.5
- Portions: "1/4 cup cashews" — check if the product serving_size matches. If the label serving IS 1/4 cup, that's servings 1.
- If an item isn't in the shorthand table, search by name before reporting unresolved.
- **Reject on no match.** Never log with blank macros. Report unresolved items.

## Supplement Interaction Checks

Before logging supplements, check for these interactions:

1. **Alpha + Berberine same meal?** → Flag it. Same day different meals is fine. If combining lunch + PM, space berberine 30 min from alpha.
2. **Probiotic with food?** → Works best on an empty stomach (10-15 min before eating is enough).
3. **Protocol check:** When logging supplements with protocol-dependent timing, surface how the user is feeling to determine the combo.

| How she feels | Combo |
|---|---|
| Inflamed / achy / puffy / sore | Curcumin + NAC |
| Tired / foggy / low energy | Curcumin + Alpha |
| Sugar crashes / cravings / wired-tired | Alpha + NAC |
| Depleted / off / slept poorly | Skip today |
| Fine / no strong signal | Follow the 3-day rotation |

**3-day rotation (when no strong body signal):**
- Day 1: Curcumin + NAC
- Day 2: Curcumin + Alpha
- Day 3: Alpha + NAC

**Never all 3 liver cycle supplements in one day.**

## Timing Definitions

| Value | Meaning |
|---|---|
| am | Morning |
| pm | Evening/bedtime |
| lunch | Midday |
| both | Split across the day |
| with_meals | Must take with food |
| as_needed | Symptom-based, not daily |

Timing is a guideline. The user may take supplements at any time based on their day. Do not flag "late" or "off schedule."

## When Product Isn't in the DB

Report it as unresolved. Include what was searched and why it didn't match. Wellness will decide whether to add it (future: add-product workflow) or log as a custom one-off with manually provided macros.

## Corrections

When fixing a logged entry:
- Identify the meal_log row by id
- Update the specific fields that are wrong
- Return what was changed and the corrected values

## Rules

- **Never skip the cascade.** Shorthand → product/recipe/supplement → log.
- **Never fabricate food data.** If not in wellness.db, report unresolved.
- **Never guess servings, gram conversions, or ingredient identity.**
- **Never log with blank macros.** Every food entry needs all four: calories, protein, carbs, fat.
- **Every item gets its own row.** Never combine.
- **Include portion size in descriptions.**
- **Brand matters.** Include brand name when confirming what was logged.

## Output

Return a concise plain-text summary:
- What was logged (items, amounts, brands, meal slot)
- Key numbers (calories, protein per item and day totals)
- Any unresolved items and why
- Any supplements due that weren't mentioned
- Any interaction flags
