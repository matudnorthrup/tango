import type { Target } from '@/lib/types';
import { fmtWeight, parseDay } from '@/lib/utils';
import { format } from 'date-fns';

/** Compact "Last / PR / e1RM" line shown under an exercise name. */
export function TargetChips({ target }: { target: Target | undefined }) {
  if (!target || (!target.last && !target.pr)) {
    return <p className="text-xs text-muted-foreground">First time — no history yet</p>;
  }
  const last = target.last;
  const topLast = last
    ? last.sets.reduce((best, s) => ((s.weight_lbs ?? 0) > (best.weight_lbs ?? 0) ? s : best), last.sets[0]!)
    : null;
  return (
    <p className="text-xs text-muted-foreground flex flex-wrap gap-x-3 gap-y-0.5">
      {last && topLast && (
        <span>
          Last <span className="text-foreground font-medium">{fmtWeight(topLast.weight_lbs)}×{topLast.reps}</span>
          {last.sets.length > 1 && <> ({last.sets.length} sets)</>} · {format(parseDay(last.date), 'MMM d')}
        </span>
      )}
      {target.pr && (
        <span>
          PR <span className="text-primary font-medium">{fmtWeight(target.pr.weight_lbs)}×{target.pr.reps}</span>
        </span>
      )}
      {target.e1rm && (
        <span>
          e1RM <span className="text-foreground font-medium">{Math.round(target.e1rm.e1rm)}</span>
        </span>
      )}
    </p>
  );
}
