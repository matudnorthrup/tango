import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiPatch, apiPost } from '@/lib/api';
import type { SetRow } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export interface SetDialogState {
  mode: 'edit' | 'add';
  workoutId: number;
  exerciseId: number;
  exerciseName: string;
  set?: SetRow;
  prefill?: { weight_lbs: number | null; reps: number; rpe: number | null };
}

export function SetDialog({ state, onClose }: { state: SetDialogState | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [weight, setWeight] = useState('');
  const [reps, setReps] = useState('');
  const [rpe, setRpe] = useState('');

  useEffect(() => {
    if (!state) return;
    const source = state.mode === 'edit' ? state.set : state.prefill;
    setWeight(source?.weight_lbs != null ? String(source.weight_lbs) : '');
    setReps(source?.reps != null ? String(source.reps) : '');
    setRpe(source?.rpe != null ? String(source.rpe) : '');
  }, [state]);

  const invalidate = () => queryClient.invalidateQueries();

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        weight_lbs: weight === '' ? null : Number(weight),
        reps: Number(reps),
        rpe: rpe === '' ? null : Number(rpe),
      };
      if (state!.mode === 'edit') {
        return apiPatch(`/api/sets/${state!.set!.id}`, body);
      }
      return apiPost(`/api/workouts/${state!.workoutId}/sets`, { ...body, exercise_id: state!.exerciseId });
    },
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });

  const remove = useMutation({
    mutationFn: () => apiDelete(`/api/sets/${state!.set!.id}`),
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });

  if (!state) return null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {state.mode === 'edit' ? `Edit set ${state.set?.set_number}` : 'Add set'} — {state.exerciseName}
          </DialogTitle>
        </DialogHeader>
        <form
          className="grid grid-cols-3 gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (reps !== '') save.mutate();
          }}
        >
          <div className="grid gap-1.5">
            <Label htmlFor="set-weight">Weight (lb)</Label>
            <Input
              id="set-weight"
              type="number"
              inputMode="decimal"
              step="0.5"
              min="0"
              placeholder="BW"
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
              autoFocus
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="set-reps">Reps</Label>
            <Input
              id="set-reps"
              type="number"
              inputMode="numeric"
              min="1"
              required
              value={reps}
              onChange={(e) => setReps(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="set-rpe">RPE</Label>
            <Input
              id="set-rpe"
              type="number"
              inputMode="decimal"
              step="0.5"
              min="1"
              max="10"
              placeholder="–"
              value={rpe}
              onChange={(e) => setRpe(e.target.value)}
            />
          </div>
          <DialogFooter className="col-span-3 mt-2 justify-between">
            {state.mode === 'edit' ? (
              <Button type="button" variant="destructive" onClick={() => remove.mutate()} disabled={remove.isPending}>
                Delete
              </Button>
            ) : (
              <span />
            )}
            <Button type="submit" disabled={save.isPending || reps === ''}>
              {state.mode === 'edit' ? 'Save' : 'Log set'}
            </Button>
          </DialogFooter>
        </form>
        {(save.error || remove.error) && (
          <p className="text-sm text-destructive">{String((save.error ?? remove.error) as Error)}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
