# gog_docs

Google Docs operations through the `gog` CLI. Follows the same pattern as `gog_email` and `gog_calendar` — pass the full command string after `gog`.

## Input

```json
{
  "command": "docs list --account personal@example.com"
}
```

## Extracting doc IDs from URLs

When given a Google Docs URL like `https://docs.google.com/document/d/<docId>/edit`, extract the `<docId>` segment and use it with `gog_docs` commands. **Always use this tool for Google Docs operations — never use the browser tool to visit docs.google.com URLs.**

If the URL contains a tab parameter (e.g., `?tab=t.abc123`), note the tab but use just the doc ID for commands.

## Common commands

- `docs list [--account <email>]` — List Google Docs in the account (via Drive export).

- `docs cat <docId> [--account <email>]` / `docs read <docId>` — Print doc as plain text.

- `docs info <docId> [--account <email>]` — Get document metadata (title, id, etc).

- `docs create '<title>' [--account <email>]` — Create a new empty Google Doc.

- `docs copy <docId> '<new title>' [--account <email>]` — Duplicate a document.

- `docs write <docId> --text '<text>' [--account <email>]` — Write content to a document. Use `--text '<text>'` flag (not `--content`). Also accepts `--file <path>` or `--file -` for stdin. Add `--append` to append instead of replacing.

- `docs insert <docId> [<content>] [--account <email>]` — Insert text at a specific position.

- `docs delete --start=<N> --end=<N> <docId> [--account <email>]` — Delete a text range.

- `docs find-replace <docId> <find> [<replace>] [--account <email>]` — Find and replace text. Supports `--first` flag for single occurrence.

- `docs edit <docId> <find> <replace> [--account <email>]` — Find and replace text.

- `docs sed <docId> [<expression>] [--account <email>]` — Regex find/replace (sed-style: `s/pattern/replacement/g`).

- `docs update <docId> [--account <email>]` — Insert text at a specific index.

- `docs clear <docId> [--account <email>]` — Clear all content from a document.

- `docs structure <docId> [--account <email>]` — Show document structure with numbered paragraphs.

- `docs list-tabs <docId> [--account <email>]` — List all tabs in a Google Doc.

- `docs export <docId> [--account <email>]` — Export as pdf|docx|txt|md.

- `docs comments <subcommand> [--account <email>]` — Manage comments on files.

## Editing best practices

**Prefer targeted edits over full rewrites.** When modifying an existing document, use `find-replace`, `edit`, `sed`, `insert`, or `delete` to make surgical changes. Do not `clear` + `write` the entire document unless the user explicitly asks for a full rewrite. A clear-and-rewrite destroys formatting, version history, comments, and cursor positions. Even when making many changes, a batch of targeted operations is better than a nuclear replace.

- Small text changes: `find-replace` or `edit`
- Pattern-based changes (e.g. replacing punctuation): `sed`
- Removing a section: use `structure` to find paragraph indices, then `delete --start=<N> --end=<N>`
- Adding new content: `insert` at a specific index
- Re-read the doc after a batch of targeted edits. If paragraph order or headings drift unexpectedly, stop and verify before continuing.
- If a plain-text doc body has already drifted and targeted fixes would be riskier than restoring known-good text, use `docs write <docId> --file <path>` as a repair path, then verify with `docs cat`.
- Full rewrite: only with explicit user request

## Common flags

- `--account <email>` — Account to use (required for most commands).
- `--json` / `-j` — JSON output (best for scripting).
- `--plain` / `-p` — Stable TSV output (no colors).
- `--dry-run` / `-n` — Print intended actions without executing.

## Account notes

- Accounts are installation-specific. Common patterns are `personal@example.com` and `work@example.com`.
- Use any configured alias exposed by the installed gog version if available.

## Output

Returns CLI output in `result`. Use `--json` where supported for structured output.

## Background / Scheduled Runs

Same keychain restriction as `gog_email`. If running in a background process and you see `errSecInteractionNotAllowed`, switch to the file-based keyring:

```bash
gog auth keyring file
gog auth add personal@example.com --services docs
gog auth add work@example.com --services docs
```
