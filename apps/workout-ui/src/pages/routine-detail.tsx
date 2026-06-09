import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, ChevronLeft, Link2, Plus, Trash2, X } from 'lucide-react';
import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api';
import type { Routine } from '@/lib/types';
import { cn, SUPERSET_LABELS, WEEKDAYS } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { ExercisePicker } from '@/components/exercise-picker';

interface DraftExercise {
  exercise_id: number;
  name: string;
  superset_group: number | null;
  target_sets: number | null;
  target_reps: string | null;
}

interface Draft {
  name: string;
  workout_type: string;
  days_of_week: number[];
  notes: string;
  exercises: DraftExercise[];
}

const EMPTY: Draft = { name: '', workout_type: 'other', days_of_week: [], notes: '', exercises: [] };

export function RoutineDetailPage({ isNew = false }: { isNew?: boolean }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(isNew ? EMPTY : null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const { data: routine, isLoading } = useQuery({
    queryKey: ['routine', id],
    queryFn: () => apiGet<Routine>(`/api/routines/${id}`),
    enabled: !isNew,
  });

  useEffect(() => {
    if (routine && draft === null) {
      setDraft({
        name: routine.name,
        workout_type: routine.workout_type ?? 'other',
        days_of_week: routine.days_of_week ?? [],
        notes: routine.notes ?? '',
        exercises: routine.exercises.map((e) => ({
          exercise_id: e.exercise_id,
          name: e.name,
          superset_group: e.superset_group,
          target_sets: e.target_sets,
          target_reps: e.target_reps,
        })),
      });
    }
  }, [routine, draft]);

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: draft!.name,
        workout_type: draft!.workout_type,
        days_of_week: draft!.days_of_week.length ? draft!.days_of_week : null,
        notes: draft!.notes || null,
        exercises: draft!.exercises.map((e) => ({
          exercise_id: e.exercise_id,
          superset_group: e.superset_group,
          target_sets: e.target_sets,
          target_reps: e.target_reps,
        })),
      };
      if (isNew) return apiPost<Routine>('/api/routines', body);
      return apiPatch<Routine>(`/api/routines/${id}`, body);
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries();
      if (isNew) navigate(`/routines/${saved.id}`, { replace: true });
    },
  });

  const remove = useMutation({
    mutationFn: (force: boolean) => apiDelete(`/api/routines/${id}${force ? '?force=true' : ''}`),
    onSuccess: () => {
      void queryClient.invalidateQueries();
      navigate('/routines');
    },
    onError: (error: Error & { status?: number }) => {
      if (error.status === 409 && confirm(`${error.message}\n\nDetach those workouts and delete anyway?`)) {
        remove.mutate(true);
      }
    },
  });

  if (!draft) {
    return isLoading ? <Skeleton className="h-64" /> : <p className="text-muted-foreground">Routine not found.</p>;
  }

  const update = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });

  const move = (index: number, delta: number) => {
    const next = [...draft.exercises];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item!);
    update({ exercises: next });
  };

  const updateExercise = (index: number, patch: Partial<DraftExercise>) => {
    const next = [...draft.exercises];
    next[index] = { ...next[index]!, ...patch };
    update({ exercises: next });
  };

  const cycleSuperset = (index: number) => {
    const current = draft.exercises[index]!.superset_group;
    const next = current === null ? 1 : current >= 4 ? null : current + 1;
    updateExercise(index, { superset_group: next });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => navigate('/routines')}>
          <ChevronLeft /> Routines
        </Button>
        {!isNew && (
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive"
            onClick={() => {
              if (confirm('Delete this routine?')) remove.mutate(false);
            }}
          >
            <Trash2 /> Delete
          </Button>
        )}
      </div>

      <div className="grid gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="routine-name">Name</Label>
          <Input
            id="routine-name"
            value={draft.name}
            placeholder="e.g. Push Day A"
            onChange={(e) => update({ name: e.target.value })}
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label>Type</Label>
            <Select value={draft.workout_type} onValueChange={(v) => update({ workout_type: v })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {['push', 'pull', 'legs', 'other'].map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>Scheduled days</Label>
            <div className="flex flex-wrap gap-1">
              {WEEKDAYS.map((day, i) => (
                <button
                  key={day}
                  type="button"
                  className={cn(
                    'size-8 rounded-full text-xs font-medium transition-colors',
                    draft.days_of_week.includes(i)
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-secondary text-muted-foreground hover:text-foreground',
                  )}
                  onClick={() =>
                    update({
                      days_of_week: draft.days_of_week.includes(i)
                        ? draft.days_of_week.filter((d) => d !== i)
                        : [...draft.days_of_week, i].sort(),
                    })
                  }
                >
                  {day[0]}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <Card className="gap-2">
        <CardHeader>
          <CardTitle className="text-base">Exercises</CardTitle>
          <p className="text-xs text-muted-foreground">
            Use <Link2 className="inline size-3" /> to chain exercises into supersets (same letter = one superset).
          </p>
        </CardHeader>
        <CardContent className="grid gap-1.5">
          {draft.exercises.map((exercise, index) => (
            <div key={exercise.exercise_id} className="flex items-center gap-1.5 rounded-lg border p-2">
              <div className="flex flex-col">
                <Button variant="ghost" size="icon-sm" onClick={() => move(index, -1)} disabled={index === 0}>
                  <ArrowUp />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => move(index, 1)}
                  disabled={index === draft.exercises.length - 1}
                >
                  <ArrowDown />
                </Button>
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{exercise.name}</p>
                <div className="mt-1 flex items-center gap-1.5">
                  <Input
                    className="h-7 w-14 text-xs"
                    type="number"
                    inputMode="numeric"
                    placeholder="sets"
                    value={exercise.target_sets ?? ''}
                    onChange={(e) =>
                      updateExercise(index, { target_sets: e.target.value === '' ? null : Number(e.target.value) })
                    }
                  />
                  <span className="text-xs text-muted-foreground">×</span>
                  <Input
                    className="h-7 w-16 text-xs"
                    placeholder="reps"
                    value={exercise.target_reps ?? ''}
                    onChange={(e) => updateExercise(index, { target_reps: e.target.value || null })}
                  />
                </div>
              </div>
              <Button
                variant={exercise.superset_group !== null ? 'default' : 'outline'}
                size="icon-sm"
                title="Superset group"
                onClick={() => cycleSuperset(index)}
              >
                {exercise.superset_group !== null ? SUPERSET_LABELS[exercise.superset_group] : <Link2 />}
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-muted-foreground"
                onClick={() => update({ exercises: draft.exercises.filter((_, i) => i !== index) })}
              >
                <X />
              </Button>
            </div>
          ))}
          <Button variant="outline" size="sm" onClick={() => setPickerOpen(true)}>
            <Plus /> Add exercise
          </Button>
        </CardContent>
      </Card>

      <div className="grid gap-1.5">
        <Label htmlFor="routine-notes">Notes</Label>
        <Textarea id="routine-notes" value={draft.notes} onChange={(e) => update({ notes: e.target.value })} />
      </div>

      <Button className="w-full" size="lg" onClick={() => save.mutate()} disabled={save.isPending || !draft.name}>
        {isNew ? 'Create routine' : 'Save changes'}
      </Button>
      {save.error && <p className="text-sm text-destructive">{String(save.error)}</p>}

      <ExercisePicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        excludeIds={draft.exercises.map((e) => e.exercise_id)}
        onPick={(exercise) => {
          setPickerOpen(false);
          update({
            exercises: [
              ...draft.exercises,
              { exercise_id: exercise.id, name: exercise.name, superset_group: null, target_sets: null, target_reps: null },
            ],
          });
        }}
      />
    </div>
  );
}
