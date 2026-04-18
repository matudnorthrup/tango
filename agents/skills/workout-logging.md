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
2. If one exists **and it's from today**, use it. Do not create a duplicate.
3. If one exists but it's from a **previous day**, it's an orphan — close it with `ended_at` set to that day (not now), then create a fresh session for today. Mention the closure briefly in the receipt.
4. If the user names a routine like `Push Day A`, `Pull Day 2`, or `Leg Day Large`, resolve it from `workout_routines` by `name` and `aliases` before creating the session:
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
5. If the user specifies a workout date, treat that date as authoritative. Query for a session on that date before looking at today's active session.
6. If the request is for a historical date, never append to a different day's active session.
7. If none exists, create one with the broad `workout_type` plus `routine_id` when a named routine was resolved. Only default to `(now() AT TIME ZONE 'America/Los_Angeles')::date` when the user did not provide a date. **Never use `CURRENT_DATE`** — the Postgres server runs in UTC and `CURRENT_DATE` returns the wrong day after 5 PM Pacific.
8. `workout_type` is the family only (`push`, `pull`, `legs`, `other`). Named variants live in `workout_routines` and `workouts.routine_id`.

## Mid-session routine swap

If the user switches routines mid-workout (e.g., "actually doing Pull Day B"):
1. Update the existing session's `routine_id` to the new routine. Do not create a second session.
2. Sets already logged stay — real workouts deviate from templates.

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
  WHERE s.exercise_id = ? AND w.date >= (now() AT TIME ZONE 'America/Los_Angeles')::date - INTERVAL '30 days'
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

## Managing routines

When the user wants to create, edit, rename, or delete a workout routine template.

### Creating a routine

1. Insert the routine:
   ```sql
   INSERT INTO workout_routines (name, workout_type, aliases, notes)
   VALUES ('Push Day C', 'push', ARRAY['Push 3'], 'Added per user request')
   RETURNING id, name, workout_type;
   ```
2. Resolve each exercise from the `exercises` table (by name/aliases), inserting any that don't exist.
3. Add exercises to the routine with position ordering:
   ```sql
   INSERT INTO workout_routine_exercises (routine_id, exercise_id, position)
   VALUES
     (?, (SELECT id FROM exercises WHERE name ILIKE '%bench press%'), 1),
     (?, (SELECT id FROM exercises WHERE name ILIKE '%overhead press%'), 2),
     (?, (SELECT id FROM exercises WHERE name ILIKE '%incline dumbbell press%'), 3);
   ```

### Adding an exercise to a routine

1. Resolve the exercise from `exercises`.
2. Find the current max position:
   ```sql
   SELECT COALESCE(MAX(position), 0) + 1 AS next_pos
   FROM workout_routine_exercises
   WHERE routine_id = ?;
   ```
3. Insert at the next position (or a specific position if the user requested one):
   ```sql
   INSERT INTO workout_routine_exercises (routine_id, exercise_id, position)
   VALUES (?, ?, ?);
   ```
4. If inserting at a specific position, shift existing exercises down first:
   ```sql
   UPDATE workout_routine_exercises
   SET position = position + 1
   WHERE routine_id = ? AND position >= ?;
   ```

### Removing an exercise from a routine

1. Delete the exercise link:
   ```sql
   DELETE FROM workout_routine_exercises
   WHERE routine_id = ? AND exercise_id = ?;
   ```
2. Reorder remaining positions to stay sequential:
   ```sql
   WITH reordered AS (
     SELECT routine_id, exercise_id, ROW_NUMBER() OVER (ORDER BY position) AS new_pos
     FROM workout_routine_exercises
     WHERE routine_id = ?
   )
   UPDATE workout_routine_exercises wre
   SET position = r.new_pos
   FROM reordered r
   WHERE wre.routine_id = r.routine_id AND wre.exercise_id = r.exercise_id;
   ```

### Reordering exercises

Update positions directly:
```sql
UPDATE workout_routine_exercises
SET position = ?
WHERE routine_id = ? AND exercise_id = ?;
```
Reorder all positions afterward to keep them sequential (same CTE as removal).

### Renaming a routine or updating aliases

```sql
UPDATE workout_routines
SET name = 'New Name', aliases = ARRAY['Alias 1', 'Alias 2']
WHERE id = ?
RETURNING id, name, aliases;
```

### Deleting a routine

1. **Check for sessions first** — warn the user if workouts reference this routine:
   ```sql
   SELECT COUNT(*) AS session_count
   FROM workouts
   WHERE routine_id = ?;
   ```
2. If sessions exist, tell the user how many sessions reference it and ask for confirmation. Deleting the routine will set those sessions' `routine_id` to NULL (or the user can reassign them first).
3. If confirmed (or no sessions reference it):
   ```sql
   DELETE FROM workout_routines WHERE id = ?;
   ```
   `workout_routine_exercises` rows cascade-delete automatically.

## Rules

- **Query before asking.** If the user asks "when did I last do legs?" or "what did I bench last week?" — check the database. Do not ask the user to recall what the database already knows.
- **Never fabricate workout data.** If a query returns no results, say so.
- **Never guess weights, reps, or dates.** Use only what the user states or what the database contains.
- **Resolve exercises by name and aliases.** The same exercise may be referred to differently ("bench" vs "bench press" vs "flat barbell bench").
- **Resolve named routines from `workout_routines`.** For `Push Day A/B`, `Pull Day A/B`, `Pull Day 2`, or `Leg Day Large`, query the routine tables first. Do not infer A/B variants from exercise fingerprints when a routine row or `routine_id` already answers the question.
- **Respect explicit dates.** For backdated or historical writes, keep every read and write anchored to that date and do not touch the current active session unless the user explicitly told you to.
