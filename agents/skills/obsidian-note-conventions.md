# obsidian_note_conventions

Reusable conventions for reading and writing notes in the main Obsidian vault.

## Writing notes

- **Always read before writing.** Print the note first so you have the full current content. Write back the complete note — `--overwrite` replaces the entire file.
- **Always use `--overwrite` when updating an existing note.** Without it, `create` silently does nothing if the note already exists. No error, no output — the write is just dropped.
- **Always use the `content` parameter** for note body text. Never put content inline in the command string via `--content '...'` — apostrophes and special characters break the shell quoting.
- Prefer updating an existing note before creating a new one.
- Do not create new folders unless the task explicitly requires it.
- Preserve the note's existing structure, sections, and frontmatter style when editing. Don't reorganize what you weren't asked to change.

## Frontmatter

- New structured notes should include frontmatter: `date`, `areas`, and `types` at minimum.
- Common `areas` values: `Family`, `Finance`, `Health`, `Home`, `Personal`, `Projects`, `Travel`, `Work`.
- Frontmatter goes between `---` delimiters at the top of `.md` files only. Never add `---` delimiters to `.base` files.

## Tasks

- Keep task lines terse and action-oriented.
- **Daily/weekly notes:** `- [ ] Task name (Xhr) [[Area]]` — estimate in parens, area link at end. See `daily_planning` skill.
- **Area backlogs:** `- [ ] Task description (Xhr)—YYYY-MM-DD` — estimate in parens, date added after em-dash. See `backlog_management` skill.

## Base files (`.base`)

Base files live in `_Schema/Types/` and define filtered views embedded in notes via `![[Name.base]]`. They are **not markdown** — they use a YAML-like DSL with expression-based filters.

### Critical rules

- **No `---` frontmatter delimiters.** Base files start directly with content. Adding `---` causes "multiple documents" parse errors.
- **Filters use expression strings**, not `property/operator/value` objects. Write `file.tags.contains("daily")`, not `{property: tags, operator: contains, value: daily}`.
- **Every base file needs a `views` section.** Without it the base won't render.

### Filter syntax

```yaml
filters:
  and:          # combine with and/or/not
    - expression == value
    - property.contains("string")
    - property.contains(link("Note Name"))
    - property == link(this.file.name)
```

Available expressions:
- `file.name`, `file.tags`, `file.links` — file metadata
- `this.file`, `this.file.name` — the note embedding the base (for contextual filtering)
- `.contains()`, `.toString()`, `==`, `!=` — operators
- `link("Note Name")`, `link(this.file.name)` — wiki-link references
- Negate with `!` prefix: `'!file.tags.contains("daily")'` (quote the whole expression)

### Examples from working base files

**Filter by type property:**
```yaml
filters:
  and:
    - type.contains(link("Health Daily"))
views:
  - type: table
    name: Table
```

**Contextual filter (show notes related to the embedding note):**
```yaml
filters:
  or:
    - file.name.contains(this.file.name)
    - created.toString().contains(this.file.name)
    - file.links.contains(this.file)
views:
  - type: table
    name: Table
```

**Filter by frontmatter link property:**
```yaml
filters:
  and:
    - week == link(this.file.name)
views:
  - type: table
    name: Table
```

**View with ordering and grouping:**
```yaml
filters:
  and:
    - type.contains(link("Recipes"))
views:
  - type: table
    name: Table
    groupBy:
      property: meal
      direction: ASC
    order:
      - file.name
      - meal
```

**View-level filters (filter within a view, separate from top-level filters):**
```yaml
views:
  - type: table
    name: Table
    filters:
      and:
        - reviewed == false
    order:
      - file.name
      - reviewed
```
