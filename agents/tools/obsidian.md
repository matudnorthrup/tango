# obsidian

Obsidian vault access through `obsidian-cli`.

## Input

```json
{
  "command": "print '2026 Week 10 Plan' --vault main"
}
```

For writes, use the separate `content` parameter for note body text:

```json
{
  "command": "create 'Planning/Daily/2026-03-13' --vault main --overwrite",
  "content": "---\ntags:\n  - daily\n---\n\n## Primary Tasks\n\n- [ ] Review budget (1hr) [[Personal]]"
}
```

## Common commands

- `print '<note name>' --vault main`
- `search-content '<term>' --vault main`
- `create '<note name>' --vault main --overwrite` (with `content` parameter)
- `create '<note name>' --vault main --append` (with `content` parameter)
- `move '<source>' '<dest>' --vault main`

## Notes

- Use the `main` vault unless the task explicitly says otherwise.
- **Always use `--overwrite` when updating an existing note.** Without it, `create` silently does nothing if the note exists.
- **Always pass note body via the `content` parameter**, not `--content` in the command string. This avoids quoting issues with apostrophes and special characters.
- If a note write includes raw `&` characters, verify the saved file immediately after writing. In this environment some Obsidian writes can truncate at `&`; prefer `and` when wording allows.
- Note-writing conventions live in `agents/skills/obsidian-note-conventions.md`.

## Output

Returns CLI output in `result`.
