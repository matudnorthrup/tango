import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '@/lib/api';
import type { Exercise } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Plus } from 'lucide-react';

export function ExercisePicker({
  open,
  onClose,
  onPick,
  excludeIds = [],
}: {
  open: boolean;
  onClose: () => void;
  onPick: (exercise: { id: number; name: string }) => void;
  excludeIds?: number[];
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const { data: exercises = [] } = useQuery({
    queryKey: ['exercises'],
    queryFn: () => apiGet<Exercise[]>('/api/exercises'),
    enabled: open,
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return exercises
      .filter((e) => !excludeIds.includes(e.id))
      .filter(
        (e) =>
          !q ||
          e.name.toLowerCase().includes(q) ||
          (e.aliases ?? []).some((a) => a.toLowerCase().includes(q)) ||
          (e.muscle_group ?? '').toLowerCase().includes(q),
      );
  }, [exercises, search, excludeIds]);

  const create = useMutation({
    mutationFn: () => apiPost<Exercise>('/api/exercises', { name: search.trim() }),
    onSuccess: (exercise) => {
      void queryClient.invalidateQueries({ queryKey: ['exercises'] });
      onPick({ id: exercise.id, name: exercise.name });
      setSearch('');
    },
  });

  const exactMatch = exercises.some((e) => e.name.toLowerCase() === search.trim().toLowerCase());

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="gap-3">
        <DialogHeader>
          <DialogTitle>Pick exercise</DialogTitle>
        </DialogHeader>
        <Input
          placeholder="Search or type a new name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
        />
        <div className="max-h-72 overflow-y-auto -mx-1 px-1">
          {filtered.map((e) => (
            <button
              key={e.id}
              className="flex w-full items-center justify-between rounded-md px-3 py-2.5 text-left text-sm hover:bg-accent"
              onClick={() => {
                onPick({ id: e.id, name: e.name });
                setSearch('');
              }}
            >
              <span className="font-medium">{e.name}</span>
              <span className="text-xs text-muted-foreground">{e.muscle_group}</span>
            </button>
          ))}
          {filtered.length === 0 && !search.trim() && (
            <p className="px-3 py-4 text-sm text-muted-foreground">No exercises.</p>
          )}
          {search.trim() && !exactMatch && (
            <Button
              variant="outline"
              className="mt-2 w-full"
              onClick={() => create.mutate()}
              disabled={create.isPending}
            >
              <Plus /> Create “{search.trim()}”
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
