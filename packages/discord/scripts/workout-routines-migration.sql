BEGIN;

CREATE TABLE IF NOT EXISTS workout_routines (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    workout_type TEXT NOT NULL,
    aliases TEXT[] NOT NULL DEFAULT '{}',
    notes TEXT
);

CREATE TABLE IF NOT EXISTS workout_routine_exercises (
    routine_id INT NOT NULL REFERENCES workout_routines(id) ON DELETE CASCADE,
    exercise_id INT NOT NULL REFERENCES exercises(id),
    position INT NOT NULL,
    PRIMARY KEY (routine_id, position),
    UNIQUE (routine_id, exercise_id)
);

ALTER TABLE workouts
    ADD COLUMN IF NOT EXISTS routine_id INT REFERENCES workout_routines(id);

CREATE INDEX IF NOT EXISTS idx_workouts_routine_id ON workouts(routine_id);
CREATE INDEX IF NOT EXISTS idx_workout_routines_workout_type ON workout_routines(workout_type);
CREATE INDEX IF NOT EXISTS idx_workout_routine_exercises_exercise_id ON workout_routine_exercises(exercise_id);

INSERT INTO workout_routines (name, workout_type, aliases, notes)
VALUES
    (
        'Push Day A',
        'push',
        ARRAY['push a', 'push day 1', 'template a', 'monday push', 'flat press day'],
        'Flat-press push day: Dumbbell Bench Press, Overhead Press, Cable Tricep Extension, Lateral Raise.'
    ),
    (
        'Push Day B',
        'push',
        ARRAY['push b', 'push day 2', 'template b', 'thursday push', 'incline push day', 'day 2 push upper body'],
        'Incline push day: Incline Dumbbell Press, Lateral Raise, Arnold Press, Dumbbell Overhead Tricep Extension.'
    ),
    (
        'Pull Day A',
        'pull',
        ARRAY['pull a', 'pull day 1', 'monday pull'],
        'Row-focused pull day: Incline Dumbbell Row, Wide Grip Lat Pulldown, Face Pull, Standard Curl.'
    ),
    (
        'Pull Day B',
        'pull',
        ARRAY['pull b', 'pull day 2', 'friday pull', 'friday pull day 2'],
        'Lat-focused pull day: Dumbbell Row, Close Grip Lat Pulldown, Rear Delt Fly, Hammer Curl.'
    ),
    (
        'Leg Day Standard',
        'legs',
        ARRAY['small leg day', 'smaller one', 'short leg day'],
        'Base leg day: Kettlebell Swing, Goblet Squat, Romanian Deadlift.'
    ),
    (
        'Leg Day Large',
        'legs',
        ARRAY['large leg day', 'larger one', 'full leg day', 'mar 25 template', 'beefier leg day'],
        'Expanded leg day: base leg circuit plus Bulgarian Split Squat, Calf Raise, and Barbell Hip Thrust.'
    )
ON CONFLICT (name) DO UPDATE
SET
    workout_type = EXCLUDED.workout_type,
    aliases = EXCLUDED.aliases,
    notes = EXCLUDED.notes;

DELETE FROM workout_routine_exercises
WHERE routine_id IN (
    SELECT id
    FROM workout_routines
    WHERE name IN (
        'Push Day A',
        'Push Day B',
        'Pull Day A',
        'Pull Day B',
        'Leg Day Standard',
        'Leg Day Large'
    )
);

WITH definitions AS (
    SELECT 'Push Day A'::TEXT AS routine_name, 'Dumbbell Bench Press'::TEXT AS exercise_name, 1 AS position
    UNION ALL SELECT 'Push Day A', 'Overhead Press', 2
    UNION ALL SELECT 'Push Day A', 'Cable Tricep Extension', 3
    UNION ALL SELECT 'Push Day A', 'Lateral Raise', 4
    UNION ALL SELECT 'Push Day B', 'Incline Dumbbell Press', 1
    UNION ALL SELECT 'Push Day B', 'Lateral Raise', 2
    UNION ALL SELECT 'Push Day B', 'Arnold Press', 3
    UNION ALL SELECT 'Push Day B', 'Dumbbell Overhead Tricep Extension', 4
    UNION ALL SELECT 'Pull Day A', 'Incline Dumbbell Row', 1
    UNION ALL SELECT 'Pull Day A', 'Wide Grip Lat Pulldown', 2
    UNION ALL SELECT 'Pull Day A', 'Face Pull', 3
    UNION ALL SELECT 'Pull Day A', 'Standard Curl', 4
    UNION ALL SELECT 'Pull Day B', 'Dumbbell Row', 1
    UNION ALL SELECT 'Pull Day B', 'Close Grip Lat Pulldown', 2
    UNION ALL SELECT 'Pull Day B', 'Rear Delt Fly', 3
    UNION ALL SELECT 'Pull Day B', 'Hammer Curl', 4
    UNION ALL SELECT 'Leg Day Standard', 'Kettlebell Swing', 1
    UNION ALL SELECT 'Leg Day Standard', 'Goblet Squat', 2
    UNION ALL SELECT 'Leg Day Standard', 'Romanian Deadlift', 3
    UNION ALL SELECT 'Leg Day Large', 'Kettlebell Swing', 1
    UNION ALL SELECT 'Leg Day Large', 'Goblet Squat', 2
    UNION ALL SELECT 'Leg Day Large', 'Romanian Deadlift', 3
    UNION ALL SELECT 'Leg Day Large', 'Bulgarian Split Squat', 4
    UNION ALL SELECT 'Leg Day Large', 'Calf Raise', 5
    UNION ALL SELECT 'Leg Day Large', 'Barbell Hip Thrust', 6
)
INSERT INTO workout_routine_exercises (routine_id, exercise_id, position)
SELECT wr.id, e.id, d.position
FROM definitions d
JOIN workout_routines wr ON wr.name = d.routine_name
JOIN exercises e ON e.name = d.exercise_name;

WITH routine_flags AS (
    SELECT
        w.id AS workout_id,
        bool_or(e.name = 'Incline Dumbbell Row') AS has_incline_dumbbell_row,
        bool_or(e.name IN ('Wide Grip Lat Pulldown', 'Lat Pulldown')) AS has_wide_lat_pulldown,
        bool_or(e.name = 'Face Pull') AS has_face_pull,
        bool_or(e.name IN ('Standard Curl', 'Curl', 'Dumbbell Curl')) AS has_standard_curl,
        bool_or(e.name = 'Dumbbell Row') AS has_dumbbell_row,
        bool_or(e.name = 'Close Grip Lat Pulldown') AS has_close_grip_lat_pulldown,
        bool_or(e.name IN ('Rear Delt Fly', 'Prone Single Arm Rear Delt Fly')) AS has_rear_delt_fly,
        bool_or(e.name = 'Hammer Curl') AS has_hammer_curl,
        bool_or(e.name = 'Dumbbell Bench Press') AS has_dumbbell_bench_press,
        bool_or(e.name = 'Overhead Press') AS has_overhead_press,
        bool_or(e.name IN ('Cable Tricep Extension', 'Cable Overhead Tricep Extension')) AS has_cable_tricep_extension,
        bool_or(e.name = 'Incline Dumbbell Press') AS has_incline_dumbbell_press,
        bool_or(e.name = 'Arnold Press') AS has_arnold_press,
        bool_or(e.name = 'Dumbbell Overhead Tricep Extension') AS has_dumbbell_overhead_tricep_extension,
        bool_or(e.name = 'Kettlebell Swing') AS has_kettlebell_swing,
        bool_or(e.name = 'Goblet Squat') AS has_goblet_squat,
        bool_or(e.name IN ('Romanian Deadlift', 'Dumbbell Romanian Deadlift')) AS has_romanian_deadlift,
        bool_or(e.name = 'Bulgarian Split Squat') AS has_bulgarian_split_squat,
        bool_or(e.name = 'Calf Raise') AS has_calf_raise,
        bool_or(e.name = 'Barbell Hip Thrust') AS has_barbell_hip_thrust
    FROM workouts w
    LEFT JOIN sets s ON s.workout_id = w.id
    LEFT JOIN exercises e ON e.id = s.exercise_id
    GROUP BY w.id
),
matched_routines AS (
    SELECT
        workout_id,
        CASE
            WHEN has_dumbbell_row
                AND has_close_grip_lat_pulldown
                AND has_rear_delt_fly
                AND has_hammer_curl
                THEN 'Pull Day B'
            WHEN has_incline_dumbbell_row
                AND has_wide_lat_pulldown
                AND has_face_pull
                AND has_standard_curl
                THEN 'Pull Day A'
            WHEN has_incline_dumbbell_press
                AND has_arnold_press
                AND has_dumbbell_overhead_tricep_extension
                THEN 'Push Day B'
            WHEN has_dumbbell_bench_press
                AND has_overhead_press
                AND NOT has_incline_dumbbell_press
                THEN 'Push Day A'
            WHEN has_kettlebell_swing
                AND has_goblet_squat
                AND has_romanian_deadlift
                AND (has_bulgarian_split_squat OR has_calf_raise OR has_barbell_hip_thrust)
                THEN 'Leg Day Large'
            WHEN has_kettlebell_swing
                AND has_goblet_squat
                AND has_romanian_deadlift
                THEN 'Leg Day Standard'
            ELSE NULL
        END AS routine_name
    FROM routine_flags
)
UPDATE workouts w
SET
    routine_id = wr.id,
    workout_type = wr.workout_type
FROM matched_routines mr
JOIN workout_routines wr ON wr.name = mr.routine_name
WHERE w.id = mr.workout_id
  AND mr.routine_name IS NOT NULL
  AND (
      w.routine_id IS DISTINCT FROM wr.id
      OR w.workout_type IS DISTINCT FROM wr.workout_type
  );

COMMIT;
