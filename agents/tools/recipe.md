# Recipe File Tools

Shared doc for `recipe_list`, `recipe_read`, and `recipe_write`.

Recipes live as markdown files in the recipe vault.

## `recipe_list`

Lists saved recipe file names without the `.md` extension.

Input:

```json
{}
```

## `recipe_read`

Reads recipe files by partial, case-insensitive title match.
Normalizes punctuation and treats `&` and `and` as equivalent during matching, so queries like `egg and fries hash` and `egg&fries hash` both match `Egg & Fries Hash`.

Input:

```json
{
  "name": "protein yogurt bowl"
}
```

Output includes:
- `found`
- `matches` with `title` and full markdown `content`

## `recipe_write`

Creates or overwrites a recipe file using full markdown content.

`content` must be the complete markdown file, not a partial update. Canonical file-shape conventions live in `agents/skills/recipe-format.md`.

Input:

```json
{
  "name": "Protein Yogurt Bowl",
  "content": "---\nsource: [ai/watson]\ncreated: 2026-01-28\n...\n"
}
```

Output includes:
- `success`
- `action` as `created` or `updated`
- `file`
