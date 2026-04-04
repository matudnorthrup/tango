# workout_logging

Workflow for logging workout sessions and querying exercise history.

## When to use

Any time the user wants to log a workout, record sets, check exercise history, or ask about past training.

## Starting a session

1. Check for an active (unclosed) session first:
   ```sql
   SELECT id, date, workout_type, started_at
   FROM workouts WHERE ended_at IS NULL
   ORDER BY started_at DESC LIMIT 1;
   ```
2. If one exists, use it. Do not create a duplicate.
3. If none, create one with the workout type and today's date.

## Logging sets

For each exercise the user mentions:

1. **Resolve the exercise** — query `exercises` by name and aliases:
   ```sql
   SELECT id, name FROM exercises
   WHERE name ILIKE '%bench press%'
      OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE a ILIKE '%bench press%');
   ```
2. If the exercise doesn't exist, insert it with best-guess metadata (muscle_group, movement_pattern, equipment).
3. **Get ordering** — query existing sets for this workout to compute the next `exercise_order` and `set_number`.
4. **Insert the set** with `workout_id`, `exercise_id`, `exercise_order`, `set_number`, `weight_lbs`, `reps`, and `rpe` if provided.

## Querying history

When the user asks about past workouts, training frequency, volume trends, or PRs — query the database. Do not ask the user for information that's already recorded.

Common queries:

- **Recent workouts:**
  ```sql
  SELECT id, date, workout_type, started_at, ended_at
  FROM workouts ORDER BY date DESC LIMIT 5;
  ```
- **Last time an exercise was done:**
  ```sql
  SELECT w.date, s.weight_lbs, s.reps, s.rpe, s.volume
  FROM sets s JOIN workouts w ON s.workout_id = w.id
  WHERE s.exercise_id = (SELECT id FROM exercises WHERE name ILIKE '%squat%' LIMIT 1)
  ORDER BY w.date DESC LIMIT 10;
  ```
- **Volume over time:**
  ```sql
  SELECT w.date, SUM(s.volume) as total_volume
  FROM sets s JOIN workouts w ON s.workout_id = w.id
  WHERE s.exercise_id = ? AND w.date >= CURRENT_DATE - INTERVAL '30 days'
  GROUP BY w.date ORDER BY w.date;
  ```

## Closing a session

When the user says they're done:
```sql
UPDATE workouts SET ended_at = now() WHERE id = ? RETURNING id, started_at, ended_at;
```

## Rules

- **Query before asking.** If the user asks "when did I last do legs?" or "what did I bench last week?" — check the database. Do not ask the user to recall what the database already knows.
- **Never fabricate workout data.** If a query returns no results, say so.
- **Never guess weights, reps, or dates.** Use only what the user states or what the database contains.
- **Resolve exercises by name and aliases.** The same exercise may be referred to differently ("bench" vs "bench press" vs "flat barbell bench").
