-- Workout UI migration: routine scheduling, supersets, targets, change notifications.
-- Idempotent; safe to re-run.

BEGIN;

-- Expected training days (0=Sunday .. 6=Saturday) for calendar + suggestions.
ALTER TABLE workout_routines
  ADD COLUMN IF NOT EXISTS days_of_week INT[];

-- Superset grouping + optional prescription on routine exercises.
ALTER TABLE workout_routine_exercises
  ADD COLUMN IF NOT EXISTS superset_group INT,
  ADD COLUMN IF NOT EXISTS target_sets INT,
  ADD COLUMN IF NOT EXISTS target_reps TEXT;

-- Change notifications for live-refreshing clients (LISTEN workout_changes).
CREATE OR REPLACE FUNCTION notify_workout_change() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify(
    'workout_changes',
    json_build_object('table', TG_TABLE_NAME, 'op', TG_OP)::text
  );
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS workouts_notify ON workouts;
CREATE TRIGGER workouts_notify
  AFTER INSERT OR UPDATE OR DELETE ON workouts
  FOR EACH ROW EXECUTE FUNCTION notify_workout_change();

DROP TRIGGER IF EXISTS sets_notify ON sets;
CREATE TRIGGER sets_notify
  AFTER INSERT OR UPDATE OR DELETE ON sets
  FOR EACH ROW EXECUTE FUNCTION notify_workout_change();

DROP TRIGGER IF EXISTS exercises_notify ON exercises;
CREATE TRIGGER exercises_notify
  AFTER INSERT OR UPDATE OR DELETE ON exercises
  FOR EACH ROW EXECUTE FUNCTION notify_workout_change();

DROP TRIGGER IF EXISTS workout_routines_notify ON workout_routines;
CREATE TRIGGER workout_routines_notify
  AFTER INSERT OR UPDATE OR DELETE ON workout_routines
  FOR EACH ROW EXECUTE FUNCTION notify_workout_change();

DROP TRIGGER IF EXISTS workout_routine_exercises_notify ON workout_routine_exercises;
CREATE TRIGGER workout_routine_exercises_notify
  AFTER INSERT OR UPDATE OR DELETE ON workout_routine_exercises
  FOR EACH ROW EXECUTE FUNCTION notify_workout_change();

COMMIT;
