import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { Dumbbell, ListChecks, CalendarDays, Search, BarChart3 } from 'lucide-react';
import { cn } from '@/lib/utils';

const NAV = [
  { to: '/', label: 'Workout', icon: Dumbbell, end: true },
  { to: '/routines', label: 'Routines', icon: ListChecks, end: false },
  { to: '/calendar', label: 'Calendar', icon: CalendarDays, end: false },
  { to: '/exercises', label: 'Exercises', icon: Search, end: false },
  { to: '/stats', label: 'Stats', icon: BarChart3, end: false },
];

export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh">
      {/* Desktop sidebar */}
      <aside className="hidden md:flex fixed inset-y-0 left-0 w-52 flex-col gap-1 border-r bg-card p-4 z-40">
        <div className="flex items-center gap-2 px-2 pb-4">
          <Dumbbell className="size-6 text-primary" />
          <span className="text-lg font-bold tracking-tight">Tango Lift</span>
        </div>
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                isActive ? 'bg-primary/15 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )
            }
          >
            <Icon className="size-4" />
            {label}
          </NavLink>
        ))}
      </aside>

      <main className="mx-auto max-w-3xl px-4 pt-4 pb-24 md:pb-8 md:pl-60 md:max-w-4xl lg:mx-auto">
        {children}
      </main>

      {/* Mobile bottom nav */}
      <nav
        className="md:hidden fixed bottom-0 inset-x-0 z-40 border-t bg-card/95 backdrop-blur flex justify-around"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn(
                'flex flex-col items-center gap-0.5 px-3 py-2 text-[10px] font-medium',
                isActive ? 'text-primary' : 'text-muted-foreground',
              )
            }
          >
            <Icon className="size-5" />
            {label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
