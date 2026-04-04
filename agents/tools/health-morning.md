# health_morning

Personal health briefing tool for Watson-style daily check-ins.

## Input

```json
{
  "mode": "morning",
  "date": "2026-03-07"
}
```

Supported modes:
- `morning`
- `recovery`
- `checkin`
- `trend`

Optional fields:
- `date`
- `days` for `trend`

## Notes

- Interpretation guidance and baselines live in `agents/skills/health-baselines.md`.

## Output

Returns parsed JSON when available, otherwise `result` with raw script output.
