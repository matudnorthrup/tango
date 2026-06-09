import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { apiGet } from '@/lib/api';
import type { CalendarData } from '@/lib/types';
import { cn, fmtVolume, TYPE_COLORS, WEEKDAYS } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export function CalendarPage() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1); // 1-12
  const [selected, setSelected] = useState<string | null>(format(now, 'yyyy-MM-dd'));

  const { data, isLoading } = useQuery({
    queryKey: ['calendar', year, month],
    queryFn: () => apiGet<CalendarData>(`/api/calendar?year=${year}&month=${month}`),
  });

  const shift = (delta: number) => {
    const next = new Date(year, month - 1 + delta, 1);
    setYear(next.getFullYear());
    setMonth(next.getMonth() + 1);
    setSelected(null);
  };

  const loggedByDay = useMemo(() => {
    const map = new Map<string, CalendarData['logged']>();
    for (const workout of data?.logged ?? []) {
      const key = workout.date.slice(0, 10);
      map.set(key, [...(map.get(key) ?? []), workout]);
    }
    return map;
  }, [data]);

  const expectedByWeekday = useMemo(() => {
    const map = new Map<number, CalendarData['expected']>();
    for (const routine of data?.expected ?? []) {
      for (const day of routine.days_of_week) {
        map.set(day, [...(map.get(day) ?? []), routine]);
      }
    }
    return map;
  }, [data]);

  const firstWeekday = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();
  const todayKey = format(now, 'yyyy-MM-dd');

  const cells: (string | null)[] = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => {
      const day = i + 1;
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }),
  ];

  const selectedLogged = selected ? (loggedByDay.get(selected) ?? []) : [];
  const selectedExpected = selected ? (expectedByWeekday.get(new Date(`${selected}T12:00:00`).getDay()) ?? []) : [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">
          {format(new Date(year, month - 1, 1), 'MMMM yyyy')}
        </h1>
        <div className="flex gap-1">
          <Button variant="outline" size="icon-sm" onClick={() => shift(-1)}>
            <ChevronLeft />
          </Button>
          <Button variant="outline" size="icon-sm" onClick={() => shift(1)}>
            <ChevronRight />
          </Button>
        </div>
      </div>

      {isLoading ? (
        <Skeleton className="h-72" />
      ) : (
        <div className="grid grid-cols-7 gap-1">
          {WEEKDAYS.map((day) => (
            <div key={day} className="py-1 text-center text-[10px] font-medium uppercase text-muted-foreground">
              {day}
            </div>
          ))}
          {cells.map((dateKey, i) => {
            if (!dateKey) return <div key={`pad-${i}`} />;
            const logged = loggedByDay.get(dateKey) ?? [];
            const weekday = new Date(`${dateKey}T12:00:00`).getDay();
            const expected = expectedByWeekday.get(weekday) ?? [];
            const isFutureOrToday = dateKey >= todayKey;
            const showExpected = logged.length === 0 && expected.length > 0;
            return (
              <button
                key={dateKey}
                className={cn(
                  'flex aspect-square flex-col items-center justify-center gap-1 rounded-lg border text-sm transition-colors',
                  selected === dateKey ? 'border-primary bg-primary/10' : 'border-transparent hover:bg-accent',
                  dateKey === todayKey && 'font-bold text-primary',
                )}
                onClick={() => setSelected(dateKey)}
              >
                {Number(dateKey.slice(8, 10))}
                <span className="flex h-2 items-center gap-0.5">
                  {logged.slice(0, 3).map((w) => (
                    <span key={w.id} className={cn('size-2 rounded-full', TYPE_COLORS[w.workout_type ?? 'other'])} />
                  ))}
                  {showExpected &&
                    expected
                      .slice(0, 3)
                      .map((r) => (
                        <span
                          key={r.id}
                          className={cn(
                            'size-2 rounded-full border',
                            isFutureOrToday ? 'border-muted-foreground/60' : 'border-muted-foreground/25',
                          )}
                        />
                      ))}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div className="flex gap-4 text-xs text-muted-foreground">
        {Object.entries(TYPE_COLORS).map(([type, color]) => (
          <span key={type} className="flex items-center gap-1.5">
            <span className={cn('size-2 rounded-full', color)} /> {type}
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-full border border-muted-foreground/60" /> planned
        </span>
      </div>

      {selected && (
        <Card className="gap-2">
          <CardHeader>
            <CardTitle className="text-base">{format(new Date(`${selected}T12:00:00`), 'EEEE, MMMM d')}</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2">
            {selectedLogged.map((workout) => (
              <Link
                key={workout.id}
                to={`/workouts/${workout.id}`}
                className="flex items-center justify-between rounded-md border px-3 py-2.5 text-sm hover:border-primary/60"
              >
                <span className="flex items-center gap-2 font-medium">
                  <span className={cn('size-2.5 rounded-full', TYPE_COLORS[workout.workout_type ?? 'other'])} />
                  {workout.routine_name ?? workout.workout_type ?? 'Workout'}
                  {workout.ended_at === null && <Badge variant="secondary">in progress</Badge>}
                </span>
                <span className="text-xs text-muted-foreground">
                  {workout.set_count} sets · {fmtVolume(workout.total_volume)} lb
                </span>
              </Link>
            ))}
            {selectedLogged.length === 0 && selectedExpected.length > 0 && (
              <>
                {selectedExpected.map((routine) => (
                  <div key={routine.id} className="flex items-center justify-between rounded-md border border-dashed px-3 py-2.5 text-sm">
                    <span className="text-muted-foreground">Planned: {routine.name}</span>
                    <span className={cn('size-2.5 rounded-full', TYPE_COLORS[routine.workout_type ?? 'other'])} />
                  </div>
                ))}
              </>
            )}
            {selectedLogged.length === 0 && selectedExpected.length === 0 && (
              <p className="text-sm text-muted-foreground">Rest day.</p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
