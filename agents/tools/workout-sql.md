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
  workout_type text,
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
```

## Safety

- `DROP`, `ALTER`, `CREATE`, and `TRUNCATE` are blocked.

## Examples

```sql
INSERT INTO workouts (date, workout_type)
VALUES (CURRENT_DATE, 'push')
RETURNING id, date, workout_type;
```

```sql
SELECT id, date, workout_type, started_at
FROM workouts
WHERE ended_at IS NULL
ORDER BY started_at DESC
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
UPDATE workouts
SET ended_at = now()
WHERE id = 11
RETURNING id, started_at, ended_at;
```

## Output

Returns the underlying command output in `result`.
