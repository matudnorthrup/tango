import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { ChevronLeft } from 'lucide-react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { apiGet } from '@/lib/api';
import type { ExerciseDetail, ExerciseHistoryRow } from '@/lib/types';
import { cn, fmtVolume, fmtWeight, parseDay } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

const METRICS = [
  { key: 'top_weight', label: 'Top set' },
  { key: 'best_e1rm', label: 'Est. 1RM' },
  { key: 'volume', label: 'Volume' },
] as const;

export function ExerciseDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [metric, setMetric] = useState<(typeof METRICS)[number]['key']>('top_weight');

  const { data, isLoading } = useQuery({
    queryKey: ['exercise', id],
    queryFn: () => apiGet<ExerciseDetail>(`/api/exercises/${id}`),
  });

  const chartData = useMemo(
    () =>
      (data?.sessions ?? []).map((s) => ({
        date: format(parseDay(s.date), 'M/d'),
        value: s[metric] != null ? Math.round(s[metric]!) : null,
      })),
    [data, metric],
  );

  const historyBySession = useMemo(() => {
    const map = new Map<number, { date: string; sets: ExerciseHistoryRow[] }>();
    for (const row of data?.history ?? []) {
      const entry = map.get(row.workout_id) ?? { date: row.date, sets: [] };
      entry.sets.push(row);
      map.set(row.workout_id, entry);
    }
    return [...map.entries()];
  }, [data]);

  if (isLoading || !data) return <Skeleton className="h-64" />;

  const { exercise, sessions, pr, e1rm } = data;
  const totalVolume = sessions.reduce((sum, s) => sum + (s.volume ?? 0), 0);

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" onClick={() => navigate(-1)}>
        <ChevronLeft /> Back
      </Button>

      <div>
        <h1 className="text-2xl font-bold">{exercise.name}</h1>
        <p className="text-sm text-muted-foreground">
          {[exercise.muscle_group, exercise.equipment].filter(Boolean).join(' · ')}
          {exercise.aliases?.length ? ` · aka ${exercise.aliases.join(', ')}` : ''}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatCard label="All-time PR" value={pr ? `${fmtWeight(pr.weight_lbs)}×${pr.reps}` : '–'} highlight />
        <StatCard label="Best e1RM" value={e1rm ? String(Math.round(e1rm.e1rm)) : '–'} />
        <StatCard label="Sessions" value={String(sessions.length)} />
        <StatCard label="Total volume" value={fmtVolume(totalVolume)} />
      </div>

      <Card className="gap-2">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Progress</CardTitle>
            <div className="flex gap-1">
              {METRICS.map((m) => (
                <button
                  key={m.key}
                  className={cn(
                    'rounded-full px-2.5 py-1 text-xs font-medium',
                    metric === m.key ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground',
                  )}
                  onClick={() => setMetric(m.key)}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {chartData.length < 2 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">Not enough sessions to chart yet.</p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.1} />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="currentColor" opacity={0.5} />
                <YAxis tick={{ fontSize: 11 }} stroke="currentColor" opacity={0.5} domain={['auto', 'auto']} />
                <Tooltip
                  contentStyle={{
                    background: 'var(--card)',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    color: 'var(--foreground)',
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke="var(--primary)"
                  strokeWidth={2}
                  dot={{ r: 3, fill: 'var(--primary)' }}
                  connectNulls
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      <Card className="gap-2">
        <CardHeader>
          <CardTitle className="text-base">History</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          {historyBySession.map(([workoutId, session]) => (
            <div key={workoutId} className="border-b border-border/50 pb-2 last:border-0">
              <p className="text-xs font-medium text-muted-foreground">
                {format(parseDay(session.date), 'EEE, MMM d, yyyy')}
              </p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {session.sets.map((set) => (
                  <Badge key={set.id} variant="secondary" className="tabular-nums">
                    {fmtWeight(set.weight_lbs)}×{set.reps}
                    {set.rpe != null && <span className="text-muted-foreground">@{set.rpe}</span>}
                  </Badge>
                ))}
              </div>
            </div>
          ))}
          {historyBySession.length === 0 && <p className="text-sm text-muted-foreground">No sets logged yet.</p>}
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }) {
  return (
    <Card className={cn('gap-1 py-3 text-center', highlight && 'border-primary/40')}>
      <p className={cn('text-xl font-bold tabular-nums', highlight && 'text-primary')}>{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </Card>
  );
}
