# recipe_format

Reusable guidance for reading and writing recipe markdown files.

## Canonical shape

- Start with YAML frontmatter, then the markdown body.
- Keep the title and sections stable when updating an existing recipe.
- Common sections are `## Macros`, `## Pillars`, `## Ingredients`, `## Instructions`, and `## Notes`.

## Frontmatter

- Common keys include `source`, `created`, `meal`, `calories`, `protein`, `carbs`, `fat`, `fiber`, `prep_minutes`, `tags`, `type`, and `areas`.
- Preserve unknown keys instead of dropping them.

## Writing rules

- `recipe_write` expects the full markdown file, not a partial patch.
- Keep frontmatter, title, ingredient lines, and macro summaries consistent with each other.
- Ingredient lines should keep concrete quantities and any known macro note, for example `- 230g Canned Chicken Breast - 185 cal, 53g P`.
- Do not invent missing steps, ingredients, or nutrition values.
