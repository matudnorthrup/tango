import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Trophy } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { apiGet } from '@/lib/api';
import type { StatsOverview } from '@/lib/types';
import { cn, fmtVolume, fmtWeight, parseDay } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

const PALETTE = ['#a3e635', '#60a5fa', '#f472b6', '#fbbf24', '#34d399', '#c084fc', '#fb923c'];

const tooltipStyle = {
  background: 'var(--card)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  color: 'var(--foreground)',
} as const;

export function StatsPage() {
  const { data, isLoading } = useQuery({
    queryKey: ['stats'],
    queryFn: () => apiGet<StatsOverview>('/api/stats/overview?weeks=12'),
  });

  const volumeChart = useMemo(() => {
    if (!data) return { rows: [] as Record<string, unknown>[], groups: [] as string[] };
    const groups = [...new Set(data.volumeByMuscle.map((r) => r.muscle_group))].sort();
    const byWeek = new Map<string, Record<string, unknown>>();
    for (const row of data.volumeByMuscle) {
      const key = row.week.slice(0, 10);
      const entry = byWeek.get(key) ?? { week: format(parseDay(key), 'M/d') };
      entry[row.muscle_group] = Math.round(row.volume);
      byWeek.set(key, entry);
    }
    return { rows: [...byWeek.values()], groups };
  }, [data]);

  const thisWeek = data?.weekly[data.weekly.length - 1];
  const lastWeek = data?.weekly[data.weekly.length - 2];

  if (isLoading || !data) return <Skeleton className="h-96" />;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Stats</h1>

      <div className="grid grid-cols-3 gap-2">
        <DeltaCard
          label="Workouts / wk"
          value={thisWeek?.workouts ?? 0}
          previous={lastWeek?.workouts ?? null}
          fmt={String}
        />
        <DeltaCard
          label="Sets / wk"
          value={thisWeek?.sets ?? 0}
          previous={lastWeek?.sets ?? null}
          fmt={String}
        />
        <DeltaCard
          label="Volume / wk"
          value={thisWeek?.volume ?? 0}
          previous={lastWeek?.volume ?? null}
          fmt={fmtVolume}
        />
      </div>

      <Card className="gap-2">
        <CardHeader>
          <CardTitle className="text-base">Weekly volume by muscle group</CardTitle>
        </CardHeader>
        <CardContent>
          {volumeChart.rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">No training data yet.</p>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={volumeChart.rows} margin={{ top: 8, right: 8, bottom: 0, left: -16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.1} />
                <XAxis dataKey="week" tick={{ fontSize: 11 }} stroke="currentColor" opacity={0.5} />
                <YAxis tick={{ fontSize: 11 }} stroke="currentColor" opacity={0.5} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: 'rgba(127,127,127,0.08)' }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {volumeChart.groups.map((group, i) => (
                  <Bar key={group} dataKey={group} stackId="volume" fill={PALETTE[i % PALETTE.length]} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {data.bodyweight.length > 1 && (
        <Card className="gap-2">
          <CardHeader>
            <CardTitle className="text-base">Bodyweight</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={180}>
              <LineChart
                data={data.bodyweight.map((b) => ({
                  date: format(parseDay(b.date), 'M/d'),
                  lbs: b.bodyweight_lbs,
                }))}
                margin={{ top: 8, right: 8, bottom: 0, left: -16 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.1} />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="currentColor" opacity={0.5} />
                <YAxis tick={{ fontSize: 11 }} stroke="currentColor" opacity={0.5} domain={['auto', 'auto']} />
                <Tooltip contentStyle={tooltipStyle} />
                <Line type="monotone" dataKey="lbs" stroke="#60a5fa" strokeWidth={2} dot={{ r: 2 }} />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      <Card className="gap-2">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Trophy className="size-4 text-primary" /> Recent PRs
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-1">
          {data.recentPrs.map((pr) => (
            <Link
              key={pr.id}
              to={`/exercises/${pr.exercise_id}`}
              className="flex items-center justify-between rounded-md px-2 py-2 text-sm hover:bg-accent"
            >
              <span className="font-medium">{pr.exercise_name}</span>
              <span className="text-xs text-muted-foreground">
                <span className="mr-2 font-semibold text-primary tabular-nums">
                  {fmtWeight(pr.weight_lbs)}×{pr.reps}
                </span>
                {format(parseDay(pr.date), 'MMM d')}
              </span>
            </Link>
          ))}
          {data.recentPrs.length === 0 && (
            <p className="text-sm text-muted-foreground">No PRs in the last 90 days — go set some.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function DeltaCard({
  label,
  value,
  previous,
  fmt,
}: {
  label: string;
  value: number;
  previous: number | null;
  fmt: (n: number) => string;
}) {
  const delta = previous != null && previous > 0 ? ((value - previous) / previous) * 100 : null;
  return (
    <Card className="gap-1 py-3 text-center">
      <p className="text-xl font-bold tabular-nums">{fmt(value)}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
      {delta != null && (
        <p className={cn('text-[10px] font-medium', delta >= 0 ? 'text-primary' : 'text-destructive')}>
          {delta >= 0 ? '+' : ''}
          {Math.round(delta)}% vs last wk
        </p>
      )}
    </Card>
  );
}
