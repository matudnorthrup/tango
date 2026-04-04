# gog_calendar

Google Calendar operations through the `gog` CLI.

## Input

```json
{
  "command": "calendar events --today --all --json --account personal@example.com"
}
```

## Common commands

- `calendar events [--today] [--all] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--days N] [--max N] [--account <email>] [--json]`
- `calendar create primary --summary '<title>' --from '<ISO datetime>' --to '<ISO datetime>' [--description '<desc>'] [--account <email>]`
  - Positional arg is calendarId — use `primary` for the main calendar
  - Flags are `--summary` (not `--title`), `--from` (not `--start`), `--to` (not `--end`)

## Notes

- `--to` is exclusive.
- Use `--today` or make `--to` the following day when querying a single day.
- `--all` includes non-primary calendars.
- Accounts are installation-specific. Common patterns are `personal@example.com` and `work@example.com`.

## Output

Returns CLI output in `result`. With `--json`, event details are structured.
