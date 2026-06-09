import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNowStrict } from 'date-fns';
import { Plus } from 'lucide-react';
import { apiGet } from '@/lib/api';
import type { Routine } from '@/lib/types';
import { cn, parseDay, TYPE_COLORS, WEEKDAYS } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

export function RoutinesPage() {
  const { data: routines, isLoading } = useQuery({
    queryKey: ['routines'],
    queryFn: () => apiGet<Routine[]>('/api/routines'),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Routines</h1>
        <Button asChild size="sm">
          <Link to="/routines/new">
            <Plus /> New
          </Link>
        </Button>
      </div>

      {isLoading && <Skeleton className="h-48" />}

      <div className="grid gap-3">
        {routines?.map((routine) => (
          <Link
            key={routine.id}
            to={`/routines/${routine.id}`}
            className="rounded-xl border bg-card p-4 transition-colors hover:border-primary/60"
          >
            <div className="flex items-center justify-between">
              <span className="font-semibold">{routine.name}</span>
              <div className="flex items-center gap-2">
                {routine.workout_type && <Badge variant="secondary">{routine.workout_type}</Badge>}
                <span className={cn('size-2.5 rounded-full', TYPE_COLORS[routine.workout_type ?? 'other'])} />
              </div>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {routine.exercises.length} exercises · {routine.exercises.map((e) => e.name).join(' · ')}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {routine.days_of_week?.length
                ? routine.days_of_week.map((d) => WEEKDAYS[d]).join(', ')
                : 'No scheduled days'}
              {routine.last_performed &&
                ` · last ${formatDistanceToNowStrict(parseDay(routine.last_performed), { addSuffix: true })}`}
            </p>
          </Link>
        ))}
      </div>
    </div>
  );
}
