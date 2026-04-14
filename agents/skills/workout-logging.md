# workout_logging

Workflow for logging workout sessions and querying exercise history.

## When to use

Any time the user wants to log a workout, record sets, check exercise history, or ask about past training.

## Starting a session

1. Check for an active (unclosed) session first:
   ```sql
   SELECT w.id, w.date, w.workout_type, w.routine_id, wr.name AS routine_name, w.started_at
   FROM workouts w
   LEFT JOIN workout_routines wr ON wr.id = w.routine_id
   WHERE w.ended_at IS NULL
   ORDER BY started_at DESC LIMIT 1;
   ```
2. If one exists, use it. Do not create a duplicate.
3. If the user names a routine like `Push Day A`, `Pull Day 2`, or `Leg Day Large`, resolve it from `workout_routines` by `name` and `aliases` before creating the session:
   ```sql
   SELECT wr.id, wr.name, wr.workout_type
   FROM workout_routines wr
   WHERE wr.name ILIKE 'Push Day A'
      OR EXISTS (
        SELECT 1
        FROM unnest(wr.aliases) alias
        WHERE alias ILIKE '%push day a%'
      );
   ```
4. If the user specifies a workout date, treat that date as authoritative. Query for a session on that date before looking at today's active session.
5. If the request is for a historical date, never append to a different day's active session.
6. If none exists, create one with the broad `workout_type` plus `routine_id` when a named routine was resolved. Only default to `CURRENT_DATE` when the user did not provide a date.
7. `workout_type` is the family only (`push`, `pull`, `legs`, `other`). Named variants live in `workout_routines` and `workouts.routine_id`.

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
  SELECT
    w.id,
    w.date,
    w.workout_type,
    wr.name AS routine_name,
    w.started_at,
    w.ended_at
  FROM workouts w
  LEFT JOIN workout_routines wr ON wr.id = w.routine_id
  ORDER BY w.date DESC
  LIMIT 5;
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
- **Named routine lookup:**
  ```sql
  SELECT
    wr.name,
    wr.workout_type,
    string_agg(e.name, ' -> ' ORDER BY wre.position) AS exercise_sequence
  FROM workout_routines wr
  JOIN workout_routine_exercises wre ON wre.routine_id = wr.id
  JOIN exercises e ON e.id = wre.exercise_id
  WHERE wr.name = 'Pull Day B'
     OR EXISTS (
       SELECT 1
       FROM unnest(wr.aliases) alias
       WHERE alias ILIKE '%pull day 2%'
     )
  GROUP BY wr.id, wr.name, wr.workout_type;
  ```
- **Recent sessions for a named routine:**
  ```sql
  SELECT
    w.id,
    w.date,
    wr.name AS routine_name,
    w.started_at,
    w.ended_at
  FROM workouts w
  JOIN workout_routines wr ON wr.id = w.routine_id
  WHERE wr.name = 'Push Day A'
  ORDER BY w.date DESC
  LIMIT 5;
  ```

## Closing a session

When the user says they're done:
```sql
UPDATE workouts SET ended_at = now() WHERE id = ? RETURNING id, started_at, ended_at;
```

If you need to resolve the active workout id first, do it with a separate `SELECT` or a CTE. Do not write `UPDATE ... ORDER BY ... LIMIT ...` directly in Postgres. Use a pattern like:

```sql
WITH target AS (
  SELECT id
  FROM workouts
  WHERE ended_at IS NULL
  ORDER BY started_at DESC
  LIMIT 1
)
UPDATE workouts w
SET ended_at = now()
FROM target
WHERE w.id = target.id
RETURNING w.id, w.started_at, w.ended_at;
```

## Rules

- **Query before asking.** If the user asks "when did I last do legs?" or "what did I bench last week?" — check the database. Do not ask the user to recall what the database already knows.
- **Never fabricate workout data.** If a query returns no results, say so.
- **Never guess weights, reps, or dates.** Use only what the user states or what the database contains.
- **Resolve exercises by name and aliases.** The same exercise may be referred to differently ("bench" vs "bench press" vs "flat barbell bench").
- **Resolve named routines from `workout_routines`.** For `Push Day A/B`, `Pull Day A/B`, `Pull Day 2`, or `Leg Day Large`, query the routine tables first. Do not infer A/B variants from exercise fingerprints when a routine row or `routine_id` already answers the question.
- **Respect explicit dates.** For backdated or historical writes, keep every read and write anchored to that date and do not touch the current active session unless the user explicitly told you to.
