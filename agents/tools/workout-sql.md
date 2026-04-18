# workout_sql

Direct SQL access to the workout Postgres database.

## Input

```json
{
  "sql": "SELECT * FROM workouts WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1;"
}
```

## Schema

```sql
workouts (
  id serial PRIMARY KEY,
  date date,
  workout_type text, -- broad family: push, pull, legs, other
  routine_id int REFERENCES workout_routines(id),
  started_at timestamptz DEFAULT now(),
  ended_at timestamptz,
  bodyweight_lbs numeric,
  notes text
)

sets (
  id serial PRIMARY KEY,
  workout_id int,
  exercise_id int,
  exercise_order int,
  set_number int,
  weight_lbs numeric,
  reps int,
  rpe numeric,
  volume numeric GENERATED ALWAYS AS (weight_lbs * reps),
  notes text
)

exercises (
  id serial PRIMARY KEY,
  name text UNIQUE,
  muscle_group text,
  movement_pattern text,
  equipment text,
  aliases text[]
)

workout_routines (
  id serial PRIMARY KEY,
  name text UNIQUE,
  workout_type text,
  aliases text[],
  notes text
)

workout_routine_exercises (
  routine_id int REFERENCES workout_routines(id) ON DELETE CASCADE,
  exercise_id int REFERENCES exercises(id),
  position int,
  PRIMARY KEY (routine_id, position),
  UNIQUE (routine_id, exercise_id)
)
```

## Safety

- `DROP`, `ALTER`, `CREATE`, and `TRUNCATE` are blocked.
- Do not use `ORDER BY` or `LIMIT` directly inside `UPDATE` statements in Postgres. Resolve the target row first with a `SELECT` or CTE.
- `workout_type` is the broad family only. Named templates such as `Push Day A`, `Pull Day B`, or `Leg Day Large` belong in `workout_routines`, and completed sessions should point at them through `workouts.routine_id`.
- For named routine lookups, prefer `workout_routines` and `workout_routine_exercises`. Do not re-infer A/B variants from exercise fingerprints when `routine_id` or a routine row already answers the question.
- **Timezone:** The Postgres server runs in UTC. Never use `CURRENT_DATE` — it returns the UTC date, which is wrong after 5 PM Pacific. Always use `(now() AT TIME ZONE 'America/Los_Angeles')::date` to get the user's local date.

## Examples

```sql
SELECT wr.id, wr.name, wr.workout_type, wr.aliases
FROM workout_routines wr
WHERE wr.name ILIKE 'Push Day A'
   OR EXISTS (
     SELECT 1
     FROM unnest(wr.aliases) alias
     WHERE alias ILIKE '%push day a%'
   );
```

```sql
SELECT
  wr.name,
  wr.workout_type,
  string_agg(e.name, ' -> ' ORDER BY wre.position) AS exercise_sequence
FROM workout_routines wr
JOIN workout_routine_exercises wre ON wre.routine_id = wr.id
JOIN exercises e ON e.id = wre.exercise_id
WHERE wr.name = 'Pull Day B'
GROUP BY wr.id, wr.name, wr.workout_type;
```

```sql
INSERT INTO workouts (date, workout_type, routine_id)
SELECT (now() AT TIME ZONE 'America/Los_Angeles')::date, wr.workout_type, wr.id
FROM workout_routines wr
WHERE wr.name = 'Push Day A'
RETURNING id, date, workout_type, routine_id, started_at;
```

```sql
INSERT INTO workouts (date, workout_type, routine_id, notes)
SELECT DATE '2024-01-15', wr.workout_type, wr.id, 'Historical workout entry'
FROM workout_routines wr
WHERE wr.name = 'Leg Day Large'
RETURNING id, date, workout_type, routine_id, notes;
```

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
WHERE w.ended_at IS NULL
ORDER BY w.started_at DESC
LIMIT 1;
```

```sql
SELECT id, name
FROM exercises
WHERE name ILIKE '%squat%'
   OR EXISTS (
     SELECT 1
     FROM unnest(aliases) alias
     WHERE alias ILIKE '%squat%'
   );
```

```sql
INSERT INTO sets (
  workout_id, exercise_id, exercise_order, set_number, weight_lbs, reps
) VALUES (
  11, 22, 1, 1, 135, 12
)
RETURNING id, volume;
```

```sql
SELECT
  w.id,
  w.date,
  wr.name AS routine_name,
  string_agg(e.name, ' -> ' ORDER BY s.exercise_order) AS logged_exercises
FROM workouts w
JOIN workout_routines wr ON wr.id = w.routine_id
JOIN (
  SELECT DISTINCT workout_id, exercise_id, exercise_order
  FROM sets
) s ON s.workout_id = w.id
JOIN exercises e ON e.id = s.exercise_id
WHERE wr.name = 'Pull Day B'
GROUP BY w.id, w.date, wr.name
ORDER BY w.date DESC
LIMIT 5;
```

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

## Output

Returns the underlying command output in `result`.
