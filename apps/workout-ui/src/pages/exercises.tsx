import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNowStrict } from 'date-fns';
import { Search } from 'lucide-react';
import { apiGet } from '@/lib/api';
import type { Exercise } from '@/lib/types';
import { cn, fmtWeight, parseDay } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

export function ExercisesPage() {
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState<string | null>(null);

  const { data: exercises, isLoading } = useQuery({
    queryKey: ['exercises'],
    queryFn: () => apiGet<Exercise[]>('/api/exercises'),
  });

  const groups = useMemo(
    () => [...new Set((exercises ?? []).map((e) => e.muscle_group).filter((g): g is string => !!g))].sort(),
    [exercises],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (exercises ?? [])
      .filter((e) => !group || e.muscle_group === group)
      .filter(
        (e) =>
          !q ||
          e.name.toLowerCase().includes(q) ||
          (e.aliases ?? []).some((a) => a.toLowerCase().includes(q)),
      )
      .sort((a, b) => b.total_sets - a.total_sets);
  }, [exercises, search, group]);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Exercises</h1>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-9"
          placeholder="Search exercises…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="flex flex-wrap gap-1.5">
        <button
          className={cn(
            'rounded-full px-3 py-1 text-xs font-medium',
            group === null ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground',
          )}
          onClick={() => setGroup(null)}
        >
          All
        </button>
        {groups.map((g) => (
          <button
            key={g}
            className={cn(
              'rounded-full px-3 py-1 text-xs font-medium',
              group === g ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground',
            )}
            onClick={() => setGroup(group === g ? null : g)}
          >
            {g}
          </button>
        ))}
      </div>

      {isLoading && <Skeleton className="h-64" />}

      <div className="grid gap-2">
        {filtered.map((exercise) => (
          <Link
            key={exercise.id}
            to={`/exercises/${exercise.id}`}
            className="flex items-center justify-between rounded-xl border bg-card px-4 py-3 transition-colors hover:border-primary/60"
          >
            <div className="min-w-0">
              <p className="truncate font-medium">{exercise.name}</p>
              <p className="text-xs text-muted-foreground">
                {[exercise.muscle_group, exercise.equipment].filter(Boolean).join(' · ')}
              </p>
            </div>
            <div className="text-right">
              {exercise.max_weight != null && (
                <p className="font-semibold tabular-nums text-primary">{fmtWeight(exercise.max_weight)} lb</p>
              )}
              <p className="text-xs text-muted-foreground">
                {exercise.last_used
                  ? formatDistanceToNowStrict(parseDay(exercise.last_used), { addSuffix: true })
                  : 'never used'}
              </p>
            </div>
          </Link>
        ))}
        {!isLoading && filtered.length === 0 && <p className="text-sm text-muted-foreground">No exercises match.</p>}
      </div>
    </div>
  );
}
