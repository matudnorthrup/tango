import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { query, withTransaction } from './db.js';
import { addSubscriber } from './sse.js';

const LA_DATE = `(now() AT TIME ZONE 'America/Los_Angeles')::date`;

export const api = new Hono();

api.onError((err, c) => {
  console.error('[workout-ui] api error:', err);
  return c.json({ error: err instanceof Error ? err.message : 'internal error' }, 500);
});

api.get('/health', (c) => c.json({ ok: true }));

// ---------------------------------------------------------------------------
// Live events (SSE)
// ---------------------------------------------------------------------------

api.get('/events', (c) =>
  streamSSE(c, async (stream) => {
    let open = true;
    const unsubscribe = addSubscriber({
      send: (event, data) => {
        void stream.writeSSE({ event, data });
      },
    });
    stream.onAbort(() => {
      open = false;
      unsubscribe();
    });
    await stream.writeSSE({ event: 'hello', data: '{}' });
    while (open) {
      await stream.sleep(25_000);
      await stream.writeSSE({ event: 'ping', data: 'keepalive' });
    }
  }),
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function num(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`invalid number: ${String(value)}`);
  return n;
}

function intId(value: string | undefined): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid id: ${String(value)}`);
  return n;
}

const SET_ROWS_SQL = `
  SELECT s.id, s.exercise_id, e.name AS exercise_name, e.muscle_group,
         s.exercise_order, s.set_number,
         s.weight_lbs::float AS weight_lbs, s.reps, s.rpe::float AS rpe,
         s.volume::float AS volume, s.notes
  FROM sets s JOIN exercises e ON e.id = s.exercise_id
  WHERE s.workout_id = $1
  ORDER BY s.exercise_order, s.set_number, s.id`;

const ROUTINE_EXERCISES_SQL = `
  SELECT wre.routine_id, wre.exercise_id, e.name, e.muscle_group, e.equipment,
         wre.position, wre.superset_group, wre.target_sets, wre.target_reps
  FROM workout_routine_exercises wre
  JOIN exercises e ON e.id = wre.exercise_id`;

/** Last-session sets + all-time PRs for a list of exercise ids, excluding one workout. */
async function fetchTargets(exerciseIds: number[], excludeWorkoutId: number) {
  if (exerciseIds.length === 0) return {};

  const lastSets = await query(
    `SELECT s.exercise_id, w.date, s.set_number,
            s.weight_lbs::float AS weight_lbs, s.reps, s.rpe::float AS rpe
     FROM sets s JOIN workouts w ON w.id = s.workout_id
     WHERE s.exercise_id = ANY($1) AND s.workout_id <> $2
       AND s.workout_id = (
         SELECT s2.workout_id FROM sets s2 JOIN workouts w2 ON w2.id = s2.workout_id
         WHERE s2.exercise_id = s.exercise_id AND s2.workout_id <> $2
         ORDER BY w2.date DESC, w2.id DESC LIMIT 1
       )
     ORDER BY s.exercise_id, s.set_number`,
    [exerciseIds, excludeWorkoutId],
  );

  const topSets = await query(
    `SELECT DISTINCT ON (s.exercise_id) s.exercise_id, w.date,
            s.weight_lbs::float AS weight_lbs, s.reps
     FROM sets s JOIN workouts w ON w.id = s.workout_id
     WHERE s.exercise_id = ANY($1) AND s.workout_id <> $2 AND s.weight_lbs IS NOT NULL
     ORDER BY s.exercise_id, s.weight_lbs DESC, s.reps DESC, w.date ASC`,
    [exerciseIds, excludeWorkoutId],
  );

  const bestE1rm = await query(
    `SELECT DISTINCT ON (s.exercise_id) s.exercise_id, w.date,
            s.weight_lbs::float AS weight_lbs, s.reps,
            (s.weight_lbs * (1 + s.reps / 30.0))::float AS e1rm
     FROM sets s JOIN workouts w ON w.id = s.workout_id
     WHERE s.exercise_id = ANY($1) AND s.workout_id <> $2 AND s.weight_lbs IS NOT NULL
     ORDER BY s.exercise_id, (s.weight_lbs * (1 + s.reps / 30.0)) DESC, w.date ASC`,
    [exerciseIds, excludeWorkoutId],
  );

  const targets: Record<
    number,
    { last: { date: string; sets: unknown[] } | null; pr: unknown | null; e1rm: unknown | null }
  > = {};
  for (const id of exerciseIds) targets[id] = { last: null, pr: null, e1rm: null };

  for (const row of lastSets) {
    const t = targets[row.exercise_id as number];
    if (!t) continue;
    if (!t.last) t.last = { date: row.date as string, sets: [] };
    t.last.sets.push({ set_number: row.set_number, weight_lbs: row.weight_lbs, reps: row.reps, rpe: row.rpe });
  }
  for (const row of topSets) {
    const t = targets[row.exercise_id as number];
    if (t) t.pr = { date: row.date, weight_lbs: row.weight_lbs, reps: row.reps };
  }
  for (const row of bestE1rm) {
    const t = targets[row.exercise_id as number];
    if (t) t.e1rm = { date: row.date, weight_lbs: row.weight_lbs, reps: row.reps, e1rm: row.e1rm };
  }
  return targets;
}

// ---------------------------------------------------------------------------
// Workouts
// ---------------------------------------------------------------------------

api.get('/workouts', async (c) => {
  const from = c.req.query('from') ?? null;
  const to = c.req.query('to') ?? null;
  const limit = Math.min(num(c.req.query('limit')) ?? 50, 500);
  const rows = await query(
    `SELECT w.id, w.date, w.workout_type, w.started_at, w.ended_at,
            w.bodyweight_lbs::float AS bodyweight_lbs, w.notes, w.routine_id,
            r.name AS routine_name,
            COUNT(s.id)::int AS set_count,
            COUNT(DISTINCT s.exercise_id)::int AS exercise_count,
            COALESCE(SUM(s.volume), 0)::float AS total_volume
     FROM workouts w
     LEFT JOIN workout_routines r ON r.id = w.routine_id
     LEFT JOIN sets s ON s.workout_id = w.id
     WHERE ($1::date IS NULL OR w.date >= $1) AND ($2::date IS NULL OR w.date <= $2)
     GROUP BY w.id, r.name
     ORDER BY w.date DESC, w.id DESC
     LIMIT $3`,
    [from, to, limit],
  );
  return c.json(rows);
});

api.get('/workouts/active', async (c) => {
  const workouts = await query(
    `SELECT w.*, w.bodyweight_lbs::float AS bodyweight_lbs, r.name AS routine_name
     FROM workouts w LEFT JOIN workout_routines r ON r.id = w.routine_id
     WHERE w.ended_at IS NULL
     ORDER BY w.started_at DESC LIMIT 1`,
  );
  const workout = workouts[0];
  if (!workout) return c.json({ workout: null });

  const sets = await query(SET_ROWS_SQL, [workout.id]);
  const routineExercises = workout.routine_id
    ? await query(`${ROUTINE_EXERCISES_SQL} WHERE wre.routine_id = $1 ORDER BY wre.position`, [workout.routine_id])
    : [];

  const exerciseIds = [
    ...new Set([
      ...routineExercises.map((r) => r.exercise_id as number),
      ...sets.map((s) => s.exercise_id as number),
    ]),
  ];
  const targets = await fetchTargets(exerciseIds, workout.id as number);

  return c.json({ workout, sets, routine_exercises: routineExercises, targets });
});

api.get('/workouts/:id', async (c) => {
  const id = intId(c.req.param('id'));
  const workouts = await query(
    `SELECT w.*, w.bodyweight_lbs::float AS bodyweight_lbs, r.name AS routine_name
     FROM workouts w LEFT JOIN workout_routines r ON r.id = w.routine_id
     WHERE w.id = $1`,
    [id],
  );
  const workout = workouts[0];
  if (!workout) return c.json({ error: 'not found' }, 404);
  const sets = await query(SET_ROWS_SQL, [id]);
  return c.json({ workout, sets });
});

api.post('/workouts', async (c) => {
  const body = await c.req.json();
  const routineId = num(body.routine_id);
  let workoutType: string | null = body.workout_type ?? null;
  if (routineId && !workoutType) {
    const routine = await query(`SELECT workout_type FROM workout_routines WHERE id = $1`, [routineId]);
    workoutType = (routine[0]?.workout_type as string | undefined) ?? null;
  }
  const rows = await query(
    `INSERT INTO workouts (date, workout_type, routine_id, bodyweight_lbs)
     VALUES (${LA_DATE}, $1, $2, $3)
     RETURNING *, bodyweight_lbs::float AS bodyweight_lbs`,
    [workoutType ?? 'other', routineId, num(body.bodyweight_lbs)],
  );
  return c.json(rows[0], 201);
});

api.patch('/workouts/:id', async (c) => {
  const id = intId(c.req.param('id'));
  const body = await c.req.json();
  const updates: string[] = [];
  const params: unknown[] = [id];

  const push = (expr: string, value: unknown) => {
    params.push(value);
    updates.push(`${expr} = $${params.length}`);
  };

  if (body.end === true) updates.push('ended_at = now()');
  if (body.reopen === true) updates.push('ended_at = NULL');
  if ('notes' in body) push('notes', body.notes || null);
  if ('bodyweight_lbs' in body) push('bodyweight_lbs', num(body.bodyweight_lbs));
  if ('workout_type' in body) push('workout_type', body.workout_type);
  if ('routine_id' in body) push('routine_id', num(body.routine_id));
  if ('date' in body) push('date', body.date);

  if (updates.length === 0) return c.json({ error: 'no updates' }, 400);
  const rows = await query(
    `UPDATE workouts SET ${updates.join(', ')} WHERE id = $1
     RETURNING *, bodyweight_lbs::float AS bodyweight_lbs`,
    params,
  );
  if (!rows[0]) return c.json({ error: 'not found' }, 404);
  return c.json(rows[0]);
});

api.delete('/workouts/:id', async (c) => {
  const id = intId(c.req.param('id'));
  const rows = await query(`DELETE FROM workouts WHERE id = $1 RETURNING id`, [id]);
  if (!rows[0]) return c.json({ error: 'not found' }, 404);
  return c.json({ deleted: id });
});

// ---------------------------------------------------------------------------
// Sets
// ---------------------------------------------------------------------------

api.post('/workouts/:id/sets', async (c) => {
  const workoutId = intId(c.req.param('id'));
  const body = await c.req.json();
  const exerciseId = num(body.exercise_id);
  const reps = num(body.reps);
  if (!exerciseId || !reps) return c.json({ error: 'exercise_id and reps are required' }, 400);

  const rows = await query(
    `WITH eo AS (
       SELECT COALESCE(
         (SELECT MIN(exercise_order) FROM sets WHERE workout_id = $1 AND exercise_id = $2),
         (SELECT COALESCE(MAX(exercise_order), 0) + 1 FROM sets WHERE workout_id = $1)
       ) AS exercise_order
     ), sn AS (
       SELECT COALESCE(MAX(set_number), 0) + 1 AS set_number
       FROM sets WHERE workout_id = $1 AND exercise_id = $2
     )
     INSERT INTO sets (workout_id, exercise_id, exercise_order, set_number, weight_lbs, reps, rpe, notes)
     SELECT $1, $2, eo.exercise_order, sn.set_number, $3, $4, $5, $6 FROM eo, sn
     RETURNING *, weight_lbs::float AS weight_lbs, rpe::float AS rpe, volume::float AS volume`,
    [workoutId, exerciseId, num(body.weight_lbs), reps, num(body.rpe), body.notes || null],
  );
  return c.json(rows[0], 201);
});

api.patch('/sets/:id', async (c) => {
  const id = intId(c.req.param('id'));
  const body = await c.req.json();
  const updates: string[] = [];
  const params: unknown[] = [id];
  const push = (expr: string, value: unknown) => {
    params.push(value);
    updates.push(`${expr} = $${params.length}`);
  };
  if ('weight_lbs' in body) push('weight_lbs', num(body.weight_lbs));
  if ('reps' in body) push('reps', num(body.reps));
  if ('rpe' in body) push('rpe', num(body.rpe));
  if ('notes' in body) push('notes', body.notes || null);
  if ('exercise_id' in body) push('exercise_id', num(body.exercise_id));
  if (updates.length === 0) return c.json({ error: 'no updates' }, 400);
  const rows = await query(
    `UPDATE sets SET ${updates.join(', ')} WHERE id = $1
     RETURNING *, weight_lbs::float AS weight_lbs, rpe::float AS rpe, volume::float AS volume`,
    params,
  );
  if (!rows[0]) return c.json({ error: 'not found' }, 404);
  return c.json(rows[0]);
});

api.delete('/sets/:id', async (c) => {
  const id = intId(c.req.param('id'));
  const rows = await query(`DELETE FROM sets WHERE id = $1 RETURNING id`, [id]);
  if (!rows[0]) return c.json({ error: 'not found' }, 404);
  return c.json({ deleted: id });
});

// ---------------------------------------------------------------------------
// Routines
// ---------------------------------------------------------------------------

async function routineWithExercises(routineId?: number) {
  const routines = await query(
    `SELECT r.id, r.name, r.workout_type, r.aliases, r.notes, r.days_of_week,
            (SELECT MAX(w.date) FROM workouts w WHERE w.routine_id = r.id) AS last_performed
     FROM workout_routines r
     ${routineId ? 'WHERE r.id = $1' : ''}
     ORDER BY r.name`,
    routineId ? [routineId] : [],
  );
  const exercises = await query(
    `${ROUTINE_EXERCISES_SQL} ${routineId ? 'WHERE wre.routine_id = $1' : ''} ORDER BY wre.position`,
    routineId ? [routineId] : [],
  );
  return routines.map((r) => ({
    ...r,
    exercises: exercises.filter((e) => e.routine_id === r.id),
  }));
}

api.get('/routines', async (c) => c.json(await routineWithExercises()));

api.get('/routines/:id', async (c) => {
  const id = intId(c.req.param('id'));
  const result = await routineWithExercises(id);
  if (!result[0]) return c.json({ error: 'not found' }, 404);
  return c.json(result[0]);
});

type RoutineExerciseInput = {
  exercise_id: number;
  superset_group?: number | null;
  target_sets?: number | null;
  target_reps?: string | null;
};

async function replaceRoutineExercises(routineId: number, exercises: RoutineExerciseInput[]) {
  await withTransaction(async (client) => {
    await client.query(`DELETE FROM workout_routine_exercises WHERE routine_id = $1`, [routineId]);
    for (let i = 0; i < exercises.length; i++) {
      const ex = exercises[i]!;
      await client.query(
        `INSERT INTO workout_routine_exercises
           (routine_id, exercise_id, position, superset_group, target_sets, target_reps)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [routineId, ex.exercise_id, i + 1, ex.superset_group ?? null, ex.target_sets ?? null, ex.target_reps ?? null],
      );
    }
  });
}

api.post('/routines', async (c) => {
  const body = await c.req.json();
  if (!body.name) return c.json({ error: 'name is required' }, 400);
  const rows = await query(
    `INSERT INTO workout_routines (name, workout_type, days_of_week, notes)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [body.name, body.workout_type ?? 'other', body.days_of_week ?? null, body.notes || null],
  );
  const id = rows[0]!.id as number;
  if (Array.isArray(body.exercises)) await replaceRoutineExercises(id, body.exercises);
  return c.json((await routineWithExercises(id))[0], 201);
});

api.patch('/routines/:id', async (c) => {
  const id = intId(c.req.param('id'));
  const body = await c.req.json();
  const updates: string[] = [];
  const params: unknown[] = [id];
  const push = (expr: string, value: unknown) => {
    params.push(value);
    updates.push(`${expr} = $${params.length}`);
  };
  if ('name' in body) push('name', body.name);
  if ('workout_type' in body) push('workout_type', body.workout_type);
  if ('days_of_week' in body) push('days_of_week', body.days_of_week);
  if ('notes' in body) push('notes', body.notes || null);
  if (updates.length > 0) {
    const rows = await query(`UPDATE workout_routines SET ${updates.join(', ')} WHERE id = $1 RETURNING id`, params);
    if (!rows[0]) return c.json({ error: 'not found' }, 404);
  }
  if (Array.isArray(body.exercises)) await replaceRoutineExercises(id, body.exercises);
  const result = await routineWithExercises(id);
  if (!result[0]) return c.json({ error: 'not found' }, 404);
  return c.json(result[0]);
});

api.delete('/routines/:id', async (c) => {
  const id = intId(c.req.param('id'));
  const force = c.req.query('force') === 'true';
  const used = await query(`SELECT COUNT(*)::int AS count FROM workouts WHERE routine_id = $1`, [id]);
  const count = (used[0]?.count as number) ?? 0;
  if (count > 0 && !force) {
    return c.json({ error: `routine is referenced by ${count} logged workout(s); pass ?force=true to detach and delete` }, 409);
  }
  if (count > 0) await query(`UPDATE workouts SET routine_id = NULL WHERE routine_id = $1`, [id]);
  const rows = await query(`DELETE FROM workout_routines WHERE id = $1 RETURNING id`, [id]);
  if (!rows[0]) return c.json({ error: 'not found' }, 404);
  return c.json({ deleted: id });
});

// ---------------------------------------------------------------------------
// Exercises
// ---------------------------------------------------------------------------

api.get('/exercises', async (c) => {
  const rows = await query(
    `SELECT e.id, e.name, e.muscle_group, e.movement_pattern, e.equipment, e.aliases,
            COUNT(s.id)::int AS total_sets,
            MAX(w.date) AS last_used,
            MAX(s.weight_lbs)::float AS max_weight
     FROM exercises e
     LEFT JOIN sets s ON s.exercise_id = e.id
     LEFT JOIN workouts w ON w.id = s.workout_id
     GROUP BY e.id
     ORDER BY e.name`,
  );
  return c.json(rows);
});

api.post('/exercises', async (c) => {
  const body = await c.req.json();
  if (!body.name) return c.json({ error: 'name is required' }, 400);
  const rows = await query(
    `INSERT INTO exercises (name, muscle_group, movement_pattern, equipment, aliases)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
     RETURNING *`,
    [body.name, body.muscle_group ?? null, body.movement_pattern ?? null, body.equipment ?? null, body.aliases ?? null],
  );
  return c.json(rows[0], 201);
});

api.patch('/exercises/:id', async (c) => {
  const id = intId(c.req.param('id'));
  const body = await c.req.json();
  const updates: string[] = [];
  const params: unknown[] = [id];
  const push = (expr: string, value: unknown) => {
    params.push(value);
    updates.push(`${expr} = $${params.length}`);
  };
  for (const field of ['name', 'muscle_group', 'movement_pattern', 'equipment', 'aliases'] as const) {
    if (field in body) push(field, body[field]);
  }
  if (updates.length === 0) return c.json({ error: 'no updates' }, 400);
  const rows = await query(`UPDATE exercises SET ${updates.join(', ')} WHERE id = $1 RETURNING *`, params);
  if (!rows[0]) return c.json({ error: 'not found' }, 404);
  return c.json(rows[0]);
});

api.get('/exercises/:id', async (c) => {
  const id = intId(c.req.param('id'));
  const exercises = await query(`SELECT * FROM exercises WHERE id = $1`, [id]);
  const exercise = exercises[0];
  if (!exercise) return c.json({ error: 'not found' }, 404);

  const sessions = await query(
    `SELECT w.id AS workout_id, w.date,
            MAX(s.weight_lbs)::float AS top_weight,
            MAX(s.weight_lbs * (1 + s.reps / 30.0))::float AS best_e1rm,
            SUM(s.volume)::float AS volume,
            COUNT(*)::int AS sets,
            SUM(s.reps)::int AS reps,
            ROUND(AVG(s.rpe), 1)::float AS avg_rpe
     FROM sets s JOIN workouts w ON w.id = s.workout_id
     WHERE s.exercise_id = $1
     GROUP BY w.id, w.date
     ORDER BY w.date ASC, w.id ASC`,
    [id],
  );

  const history = await query(
    `SELECT s.id, w.id AS workout_id, w.date, s.set_number,
            s.weight_lbs::float AS weight_lbs, s.reps, s.rpe::float AS rpe,
            s.volume::float AS volume, s.notes
     FROM sets s JOIN workouts w ON w.id = s.workout_id
     WHERE s.exercise_id = $1
     ORDER BY w.date DESC, w.id DESC, s.set_number ASC
     LIMIT 300`,
    [id],
  );

  const targets = await fetchTargets([id], -1);
  return c.json({ exercise, sessions, history, pr: targets[id]?.pr ?? null, e1rm: targets[id]?.e1rm ?? null });
});

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

api.get('/calendar', async (c) => {
  const year = num(c.req.query('year'));
  const month = num(c.req.query('month'));
  if (!year || !month) return c.json({ error: 'year and month are required' }, 400);

  const logged = await query(
    `SELECT w.id, w.date, w.workout_type, w.ended_at, w.routine_id, r.name AS routine_name,
            COUNT(s.id)::int AS set_count,
            COUNT(DISTINCT s.exercise_id)::int AS exercise_count,
            COALESCE(SUM(s.volume), 0)::float AS total_volume
     FROM workouts w
     LEFT JOIN workout_routines r ON r.id = w.routine_id
     LEFT JOIN sets s ON s.workout_id = w.id
     WHERE w.date >= make_date($1, $2, 1)
       AND w.date < make_date($1, $2, 1) + interval '1 month'
     GROUP BY w.id, r.name
     ORDER BY w.date`,
    [year, month],
  );

  const expected = await query(
    `SELECT id, name, workout_type, days_of_week
     FROM workout_routines
     WHERE days_of_week IS NOT NULL AND array_length(days_of_week, 1) > 0
     ORDER BY name`,
  );

  return c.json({ logged, expected });
});

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

api.get('/stats/overview', async (c) => {
  const weeks = Math.min(num(c.req.query('weeks')) ?? 12, 52);
  const since = `${LA_DATE} - ${weeks * 7}`;

  const volumeByMuscle = await query(
    `SELECT date_trunc('week', w.date)::date AS week,
            COALESCE(e.muscle_group, 'other') AS muscle_group,
            SUM(s.volume)::float AS volume
     FROM sets s
     JOIN workouts w ON w.id = s.workout_id
     JOIN exercises e ON e.id = s.exercise_id
     WHERE w.date >= ${since}
     GROUP BY 1, 2
     ORDER BY 1`,
  );

  const weekly = await query(
    `SELECT date_trunc('week', w.date)::date AS week,
            COUNT(DISTINCT w.id)::int AS workouts,
            COALESCE(SUM(s.volume), 0)::float AS volume,
            COALESCE(SUM(s.reps), 0)::int AS reps,
            COUNT(s.id)::int AS sets,
            ROUND(AVG(s.rpe), 1)::float AS avg_rpe
     FROM workouts w
     LEFT JOIN sets s ON s.workout_id = w.id
     WHERE w.date >= ${since}
     GROUP BY 1
     ORDER BY 1`,
  );

  const bodyweight = await query(
    `SELECT date, bodyweight_lbs::float AS bodyweight_lbs
     FROM workouts
     WHERE bodyweight_lbs IS NOT NULL AND date >= ${LA_DATE} - 365
     ORDER BY date`,
  );

  const recentPrs = await query(
    `SELECT s.id, s.exercise_id, e.name AS exercise_name, w.date,
            s.weight_lbs::float AS weight_lbs, s.reps
     FROM sets s
     JOIN workouts w ON w.id = s.workout_id
     JOIN exercises e ON e.id = s.exercise_id
     WHERE s.weight_lbs IS NOT NULL
       AND w.date >= ${LA_DATE} - 90
       AND NOT EXISTS (
         SELECT 1 FROM sets s2 JOIN workouts w2 ON w2.id = s2.workout_id
         WHERE s2.exercise_id = s.exercise_id
           AND s2.weight_lbs >= s.weight_lbs
           AND (w2.date < w.date OR (w2.date = w.date AND s2.id < s.id))
       )
     ORDER BY w.date DESC
     LIMIT 20`,
  );

  return c.json({ volumeByMuscle, weekly, bodyweight, recentPrs });
});
