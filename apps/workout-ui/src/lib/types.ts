export interface WorkoutSummary {
  id: number;
  date: string;
  workout_type: string | null;
  started_at: string;
  ended_at: string | null;
  bodyweight_lbs: number | null;
  notes: string | null;
  routine_id: number | null;
  routine_name: string | null;
  set_count: number;
  exercise_count: number;
  total_volume: number;
}

export interface SetRow {
  id: number;
  exercise_id: number;
  exercise_name: string;
  muscle_group: string | null;
  exercise_order: number;
  set_number: number;
  weight_lbs: number | null;
  reps: number;
  rpe: number | null;
  volume: number | null;
  notes: string | null;
}

export interface RoutineExercise {
  routine_id: number;
  exercise_id: number;
  name: string;
  muscle_group: string | null;
  equipment: string | null;
  position: number;
  superset_group: number | null;
  target_sets: number | null;
  target_reps: string | null;
}

export interface Routine {
  id: number;
  name: string;
  workout_type: string | null;
  aliases: string[] | null;
  notes: string | null;
  days_of_week: number[] | null;
  last_performed: string | null;
  exercises: RoutineExercise[];
}

export interface TargetSet {
  set_number: number;
  weight_lbs: number | null;
  reps: number;
  rpe: number | null;
}

export interface Target {
  last: { date: string; sets: TargetSet[] } | null;
  pr: { date: string; weight_lbs: number; reps: number } | null;
  e1rm: { date: string; weight_lbs: number; reps: number; e1rm: number } | null;
}

export interface ActiveWorkout {
  workout:
    | (Omit<WorkoutSummary, 'set_count' | 'exercise_count' | 'total_volume'> & { routine_name: string | null })
    | null;
  sets: SetRow[];
  routine_exercises: RoutineExercise[];
  targets: Record<number, Target>;
}

export interface Exercise {
  id: number;
  name: string;
  muscle_group: string | null;
  movement_pattern: string | null;
  equipment: string | null;
  aliases: string[] | null;
  total_sets: number;
  last_used: string | null;
  max_weight: number | null;
}

export interface ExerciseSession {
  workout_id: number;
  date: string;
  top_weight: number | null;
  best_e1rm: number | null;
  volume: number | null;
  sets: number;
  reps: number;
  avg_rpe: number | null;
}

export interface ExerciseHistoryRow {
  id: number;
  workout_id: number;
  date: string;
  set_number: number;
  weight_lbs: number | null;
  reps: number;
  rpe: number | null;
  volume: number | null;
  notes: string | null;
}

export interface ExerciseDetail {
  exercise: Omit<Exercise, 'total_sets' | 'last_used' | 'max_weight'>;
  sessions: ExerciseSession[];
  history: ExerciseHistoryRow[];
  pr: Target['pr'];
  e1rm: Target['e1rm'];
}

export interface CalendarData {
  logged: WorkoutSummary[];
  expected: { id: number; name: string; workout_type: string | null; days_of_week: number[] }[];
}

export interface StatsOverview {
  volumeByMuscle: { week: string; muscle_group: string; volume: number }[];
  weekly: { week: string; workouts: number; volume: number; reps: number; sets: number; avg_rpe: number | null }[];
  bodyweight: { date: string; bodyweight_lbs: number }[];
  recentPrs: { id: number; exercise_id: number; exercise_name: string; date: string; weight_lbs: number; reps: number }[];
}
