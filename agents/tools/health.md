# health_query

Universal Apple Health data tool. Queries sleep, recovery, activity, and trends from MongoDB.

## Input

```json
{
  "command": "recovery | date | morning | checkin | trend | sleep",
  "date": "YYYY-MM-DD | today | yesterday",
  "days": 7
}
```

## Commands

- **recovery** — Sleep + HRV + RHR + weight + 7-day trend comparison. Default for "how did I sleep?" questions.
- **date** — Full day activity: steps, exercise, workouts, active/basal cal, TDEE, RHR, weight, BP.
- **morning** — Combined briefing: last night's sleep + yesterday's activity + today's vitals.
- **checkin** — Today's activity snapshot (steps, exercise, calories, TDEE so far).
- **trend** — Multi-day trends with averages. Use `days` param (default 7). Any range is valid — use whatever the question requires.
- **sleep** — Detailed sleep stages + HRV + RHR for a specific night.

## Parameters

- `command` (required): Which query to run.
- `date` (optional): Used by recovery, date, sleep. Defaults vary by command.
- `days` (optional): Number of days for trend. Default 7.

## Output

Returns parsed JSON from the health query script. Shape varies by command.
