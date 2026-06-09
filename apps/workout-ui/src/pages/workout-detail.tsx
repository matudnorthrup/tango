import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ChevronLeft, Plus, Trash2 } from 'lucide-react';
import { apiDelete, apiGet, apiPatch } from '@/lib/api';
import type { SetRow, WorkoutSummary } from '@/lib/types';
import { fmtVolume, fmtWeight, parseDay } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { SetDialog, type SetDialogState } from '@/components/set-dialog';
import { ExercisePicker } from '@/components/exercise-picker';

interface WorkoutDetail {
  workout: WorkoutSummary;
  sets: SetRow[];
}

export function WorkoutDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [setDialog, setSetDialog] = useState<SetDialogState | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [notesDraft, setNotesDraft] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['workout', id],
    queryFn: () => apiGet<WorkoutDetail>(`/api/workouts/${id}`),
  });

  const groups = useMemo(() => {
    if (!data) return [];
    const byExercise = new Map<number, SetRow[]>();
    for (const set of data.sets) {
      const list = byExercise.get(set.exercise_id) ?? [];
      list.push(set);
      byExercise.set(set.exercise_id, list);
    }
    return [...byExercise.entries()]
      .map(([exerciseId, sets]) => ({ exerciseId, sets, name: sets[0]!.exercise_name }))
      .sort((a, b) => a.sets[0]!.exercise_order - b.sets[0]!.exercise_order);
  }, [data]);

  const saveNotes = useMutation({
    mutationFn: (notes: string) => apiPatch(`/api/workouts/${id}`, { notes }),
    onSuccess: () => {
      setNotesDraft(null);
      void queryClient.invalidateQueries();
    },
  });

  const removeWorkout = useMutation({
    mutationFn: () => apiDelete(`/api/workouts/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      navigate('/calendar');
    },
  });

  if (isLoading || !data) {
    return <Skeleton className="h-64" />;
  }

  const { workout } = data;
  const totalVolume = data.sets.reduce((sum, s) => sum + (s.volume ?? 0), 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
          <ChevronLeft /> Back
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive"
          onClick={() => {
            if (confirm('Delete this workout and all of its sets?')) removeWorkout.mutate();
          }}
        >
          <Trash2 /> Delete
        </Button>
      </div>

      <div>
        <h1 className="text-2xl font-bold">{workout.routine_name ?? workout.workout_type ?? 'Workout'}</h1>
        <p className="text-sm text-muted-foreground">
          {format(parseDay(workout.date), 'EEEE, MMMM d, yyyy')}
          {workout.ended_at === null && (
            <Badge className="ml-2" variant="secondary">
              In progress
            </Badge>
          )}
        </p>
      </div>

      <div className="grid grid-cols-3 gap-2 text-center">
        <Card className="gap-1 py-3">
          <p className="text-xl font-bold tabular-nums">{data.sets.length}</p>
          <p className="text-xs text-muted-foreground">sets</p>
        </Card>
        <Card className="gap-1 py-3">
          <p className="text-xl font-bold tabular-nums">{groups.length}</p>
          <p className="text-xs text-muted-foreground">exercises</p>
        </Card>
        <Card className="gap-1 py-3">
          <p className="text-xl font-bold tabular-nums">{fmtVolume(totalVolume)}</p>
          <p className="text-xs text-muted-foreground">volume (lb)</p>
        </Card>
      </div>

      {groups.map((group) => (
        <Card key={group.exerciseId} className="gap-2">
          <CardHeader>
            <CardTitle className="text-base">
              <Link to={`/exercises/${group.exerciseId}`} className="hover:text-primary">
                {group.name}
              </Link>
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-1">
            {group.sets.map((set) => (
              <button
                key={set.id}
                className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-accent"
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
            <Button
              variant="ghost"
              size="sm"
              className="justify-start text-primary"
              onClick={() => {
                const last = group.sets[group.sets.length - 1];
                setSetDialog({
                  mode: 'add',
                  workoutId: workout.id,
                  exerciseId: group.exerciseId,
                  exerciseName: group.name,
                  prefill: last ? { weight_lbs: last.weight_lbs, reps: last.reps, rpe: last.rpe } : undefined,
                });
              }}
            >
              <Plus /> Add set
            </Button>
          </CardContent>
        </Card>
      ))}

      <Button variant="outline" className="w-full" onClick={() => setPickerOpen(true)}>
        <Plus /> Add exercise
      </Button>

      <Card className="gap-2">
        <CardHeader>
          <CardTitle className="text-base">Notes</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2">
          <Textarea
            value={notesDraft ?? workout.notes ?? ''}
            placeholder="No notes"
            onChange={(e) => setNotesDraft(e.target.value)}
          />
          {notesDraft !== null && notesDraft !== (workout.notes ?? '') && (
            <Button size="sm" onClick={() => saveNotes.mutate(notesDraft)} disabled={saveNotes.isPending}>
              Save notes
            </Button>
          )}
        </CardContent>
      </Card>

      <SetDialog state={setDialog} onClose={() => setSetDialog(null)} />
      <ExercisePicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={(exercise) => {
          setPickerOpen(false);
          setSetDialog({
            mode: 'add',
            workoutId: workout.id,
            exerciseId: exercise.id,
            exerciseName: exercise.name,
          });
        }}
      />
    </div>
  );
}
