import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format, formatDistanceToNowStrict } from 'date-fns';
import { Flame, Plus, Square, Timer } from 'lucide-react';
import { apiGet, apiPatch, apiPost } from '@/lib/api';
import type { ActiveWorkout, Routine, RoutineExercise, SetRow, WorkoutSummary } from '@/lib/types';
import { cn, fmtVolume, fmtWeight, parseDay, TYPE_COLORS, WEEKDAYS } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { SetDialog, type SetDialogState } from '@/components/set-dialog';
import { ExercisePicker } from '@/components/exercise-picker';
import { TargetChips } from '@/components/target-chips';

export function LivePage() {
  const { data, isLoading } = useQuery({
    queryKey: ['active'],
    queryFn: () => apiGet<ActiveWorkout>('/api/workouts/active'),
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-28" />
        <Skeleton className="h-40" />
      </div>
    );
  }
  if (!data?.workout) return <StartView />;
  return <ActiveView data={data} />;
}

// ---------------------------------------------------------------------------
// No active session: start screen
// ---------------------------------------------------------------------------

function StartView() {
  const queryClient = useQueryClient();
  const { data: routines = [] } = useQuery({
    queryKey: ['routines'],
    queryFn: () => apiGet<Routine[]>('/api/routines'),
  });
  const { data: recent = [] } = useQuery({
    queryKey: ['workouts', 'recent'],
    queryFn: () => apiGet<WorkoutSummary[]>('/api/workouts?limit=5'),
  });

  const today = new Date().getDay();
  const sorted = useMemo(() => {
    return [...routines].sort((a, b) => {
      const aToday = a.days_of_week?.includes(today) ? 0 : 1;
      const bToday = b.days_of_week?.includes(today) ? 0 : 1;
      if (aToday !== bToday) return aToday - bToday;
      return (a.last_performed ?? '0000') < (b.last_performed ?? '0000') ? -1 : 1;
    });
  }, [routines, today]);

  const start = useMutation({
    mutationFn: (routineId: number | null) =>
      apiPost('/api/workouts', routineId ? { routine_id: routineId } : { workout_type: 'other' }),
    onSuccess: () => queryClient.invalidateQueries(),
  });

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold">Start a workout</h1>
        <p className="text-sm text-muted-foreground">{format(new Date(), 'EEEE, MMMM d')}</p>
      </div>

      <div className="grid gap-3">
        {sorted.map((routine) => {
          const isToday = routine.days_of_week?.includes(today);
          return (
            <button
              key={routine.id}
              className={cn(
                'rounded-xl border bg-card p-4 text-left transition-colors hover:border-primary/60',
                isToday && 'border-primary/60 ring-1 ring-primary/30',
              )}
              onClick={() => start.mutate(routine.id)}
              disabled={start.isPending}
            >
              <div className="flex items-center justify-between">
                <span className="font-semibold">{routine.name}</span>
                <div className="flex items-center gap-2">
                  {isToday && <Badge>Today</Badge>}
                  <span className={cn('size-2.5 rounded-full', TYPE_COLORS[routine.workout_type ?? 'other'])} />
                </div>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {routine.exercises.map((e) => e.name).join(' · ')}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {routine.last_performed
                  ? `Last: ${formatDistanceToNowStrict(parseDay(routine.last_performed), { addSuffix: true })}`
                  : 'Never performed'}
                {routine.days_of_week?.length
                  ? ` · ${routine.days_of_week.map((d) => WEEKDAYS[d]).join(', ')}`
                  : ''}
              </p>
            </button>
          );
        })}
      </div>

      <Button variant="outline" className="w-full" onClick={() => start.mutate(null)} disabled={start.isPending}>
        <Plus /> Quick start without a routine
      </Button>

      {recent.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent workouts</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2">
            {recent.map((w) => (
              <Link
                key={w.id}
                to={`/workouts/${w.id}`}
                className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-accent"
              >
                <span>{w.routine_name ?? w.workout_type ?? 'Workout'}</span>
                <span className="text-xs text-muted-foreground">
                  {format(parseDay(w.date), 'MMM d')} · {w.set_count} sets · {fmtVolume(w.total_volume)} lb
                </span>
              </Link>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Active session
// ---------------------------------------------------------------------------

function ActiveView({ data }: { data: ActiveWorkout }) {
  const workout = data.workout!;
  const queryClient = useQueryClient();
  const [setDialog, setSetDialog] = useState<SetDialogState | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [endOpen, setEndOpen] = useState(false);

  // Group logged sets by exercise, in exercise_order
  const groups = useMemo(() => {
    const byExercise = new Map<number, SetRow[]>();
    for (const set of data.sets) {
      const list = byExercise.get(set.exercise_id) ?? [];
      list.push(set);
      byExercise.set(set.exercise_id, list);
    }
    return [...byExercise.entries()]
      .map(([exerciseId, sets]) => ({ exerciseId, sets, name: sets[0]!.exercise_name }))
      .sort((a, b) => a.sets[0]!.exercise_order - b.sets[0]!.exercise_order);
  }, [data.sets]);

  const loggedIds = new Set(groups.map((g) => g.exerciseId));
  const upNext = data.routine_exercises.filter((e) => !loggedIds.has(e.exercise_id));

  const addSet = (exerciseId: number, exerciseName: string) => {
    const logged = groups.find((g) => g.exerciseId === exerciseId);
    const lastLogged = logged?.sets[logged.sets.length - 1];
    const lastSession = data.targets[exerciseId]?.last?.sets;
    const nextIndex = logged?.sets.length ?? 0;
    const fromHistory = lastSession?.[nextIndex] ?? lastSession?.[lastSession.length - 1];
    const prefill = lastLogged
      ? { weight_lbs: lastLogged.weight_lbs, reps: lastLogged.reps, rpe: lastLogged.rpe }
      : fromHistory
        ? { weight_lbs: fromHistory.weight_lbs, reps: fromHistory.reps, rpe: fromHistory.rpe }
        : undefined;
    setSetDialog({ mode: 'add', workoutId: workout.id, exerciseId, exerciseName, prefill });
  };

  return (
    <div className="space-y-4">
      <SessionHeader workout={workout} onEnd={() => setEndOpen(true)} />

      {groups.map((group) => (
        <Card key={group.exerciseId} className="gap-2">
          <CardHeader>
            <CardTitle className="flex items-center justify-between text-base">
              <Link to={`/exercises/${group.exerciseId}`} className="hover:text-primary">
                {group.name}
              </Link>
              <span className="text-xs font-normal text-muted-foreground">
                {fmtVolume(group.sets.reduce((sum, s) => sum + (s.volume ?? 0), 0))} lb
              </span>
            </CardTitle>
            <TargetChips target={data.targets[group.exerciseId]} />
          </CardHeader>
          <CardContent className="grid gap-1">
            {group.sets.map((set) => (
              <button
                key={set.id}
                className="flex items-center justify-between rounded-md px-2 py-2 text-sm hover:bg-accent"
                onClick={() =>
                  setSetDialog({
                    mode: 'edit',
                    workoutId: workout.id,
                    exerciseId: set.exercise_id,
                    exerciseName: set.exercise_name,
                    set,
                  })
                }
              >
                <span className="flex items-center gap-3">
                  <span className="w-5 text-xs text-muted-foreground">{set.set_number}</span>
                  <span className="font-semibold tabular-nums">
                    {fmtWeight(set.weight_lbs)} <span className="text-muted-foreground font-normal">×</span> {set.reps}
                  </span>
                </span>
                {set.rpe != null && (
                  <Badge variant="secondary" className="tabular-nums">
                    RPE {set.rpe}
                  </Badge>
                )}
              </button>
            ))}
            <Button variant="ghost" size="sm" className="justify-start text-primary" onClick={() => addSet(group.exerciseId, group.name)}>
              <Plus /> Add set
            </Button>
          </CardContent>
        </Card>
      ))}

      {upNext.length > 0 && <UpNext exercises={upNext} targets={data.targets} onLog={addSet} />}

      <Button variant="outline" className="w-full" onClick={() => setPickerOpen(true)}>
        <Plus /> Add exercise
      </Button>

      <SetDialog state={setDialog} onClose={() => setSetDialog(null)} />
      <ExercisePicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={(exercise) => {
          setPickerOpen(false);
          addSet(exercise.id, exercise.name);
        }}
      />
      <EndDialog
        open={endOpen}
        onClose={() => setEndOpen(false)}
        workoutId={workout.id}
        bodyweight={workout.bodyweight_lbs}
        onEnded={() => queryClient.invalidateQueries()}
      />
    </div>
  );
}

function SessionHeader({
  workout,
  onEnd,
}: {
  workout: NonNullable<ActiveWorkout['workout']>;
  onEnd: () => void;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(interval);
  }, []);

  return (
    <Card className="gap-2 border-primary/40">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Flame className="size-5 text-primary" />
            {workout.routine_name ?? workout.workout_type ?? 'Workout'}
          </CardTitle>
          <Button variant="destructive" size="sm" onClick={onEnd}>
            <Square className="size-3.5" /> Finish
          </Button>
        </div>
        <CardDescription className="flex items-center gap-2">
          <Timer className="size-3.5" />
          Started {format(new Date(workout.started_at), 'h:mm a')} ·{' '}
          {formatDistanceToNowStrict(new Date(workout.started_at))} elapsed
        </CardDescription>
      </CardHeader>
    </Card>
  );
}

function UpNext({
  exercises,
  targets,
  onLog,
}: {
  exercises: RoutineExercise[];
  targets: ActiveWorkout['targets'];
  onLog: (exerciseId: number, name: string) => void;
}) {
  // Group consecutive exercises that share a superset_group
  const blocks: { superset: number | null; items: RoutineExercise[] }[] = [];
  for (const exercise of exercises) {
    const last = blocks[blocks.length - 1];
    if (last && last.superset !== null && last.superset === exercise.superset_group) {
      last.items.push(exercise);
    } else {
      blocks.push({ superset: exercise.superset_group, items: [exercise] });
    }
  }

  return (
    <Card className="gap-2">
      <CardHeader>
        <CardTitle className="text-base text-muted-foreground">Up next</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2">
        {blocks.map((block, i) => (
          <div
            key={i}
            className={cn(block.superset !== null && block.items.length > 1 && 'rounded-lg border border-dashed border-primary/40 p-2')}
          >
            {block.superset !== null && block.items.length > 1 && (
              <p className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-primary">Superset</p>
            )}
            {block.items.map((exercise) => (
              <div key={exercise.exercise_id} className="flex items-center justify-between gap-2 px-1 py-1.5">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {exercise.name}
                    {exercise.target_sets && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {exercise.target_sets}×{exercise.target_reps ?? '?'}
                      </span>
                    )}
                  </p>
                  <TargetChips target={targets[exercise.exercise_id]} />
                </div>
                <Button size="sm" variant="secondary" onClick={() => onLog(exercise.exercise_id, exercise.name)}>
                  Log
                </Button>
              </div>
            ))}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function EndDialog({
  open,
  onClose,
  workoutId,
  bodyweight,
  onEnded,
}: {
  open: boolean;
  onClose: () => void;
  workoutId: number;
  bodyweight: number | null;
  onEnded: () => void;
}) {
  const [notes, setNotes] = useState('');
  const [weight, setWeight] = useState(bodyweight != null ? String(bodyweight) : '');

  const end = useMutation({
    mutationFn: () =>
      apiPatch(`/api/workouts/${workoutId}`, {
        end: true,
        notes: notes || null,
        bodyweight_lbs: weight === '' ? null : Number(weight),
      }),
    onSuccess: () => {
      onEnded();
      onClose();
    },
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Finish workout</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="end-bw">Bodyweight (lb)</Label>
            <Input
              id="end-bw"
              type="number"
              inputMode="decimal"
              step="0.1"
              placeholder="optional"
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="end-notes">Notes</Label>
            <Textarea
              id="end-notes"
              placeholder="How did it go?"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Keep going
          </Button>
          <Button onClick={() => end.mutate()} disabled={end.isPending}>
            Finish
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
