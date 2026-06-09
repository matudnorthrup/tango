# Workout UI (Tango Lift)

Mobile-first web interface for the Tango workout tracker. Companion surface to
voice logging (Malibu → `workout_sql`): browse, edit, and analyze the same
Postgres data, with live refresh when agents write in the background.

## Pages

- **Workout (`/`)** — live in-gym view. Start a session from a routine
  (suggested by scheduled day), log/edit/delete sets, see "up next" with
  superset grouping, and per-exercise targets: last session, all-time PR, and
  estimated 1RM (Epley).
- **Routines (`/routines`)** — create/edit routines: reorder exercises, chain
  supersets (same letter = one superset), set target sets×reps, and schedule
  days of the week.
- **Calendar (`/calendar`)** — month view of logged (filled dots, colored by
  type) and planned (hollow dots, from routine schedules) workouts.
- **Exercises (`/exercises`)** — searchable library; per-exercise progress
  charts (top set / est. 1RM / volume), PRs, and full set history.
- **Stats (`/stats`)** — weekly volume by muscle group, week-over-week deltas,
  bodyweight trend, recent PRs.

## Architecture

- **Frontend**: Vite + React + Tailwind v4 + shadcn-style components
  (`src/`). Built to `dist/client/`.
- **Server**: Hono on Node (`server/`, built to `dist/server/`). Serves the
  SPA, a JSON API under `/api`, and an SSE stream at `/api/events`.
- **Database**: the existing `workout-db` Postgres container (host port
  5433). Connection string via `WORKOUT_DB_URL` (defaults to the local
  container).
- **Live refresh**: triggers on `workouts`/`sets`/`exercises`/
  `workout_routines`/`workout_routine_exercises` call
  `pg_notify('workout_changes', ...)`; the server LISTENs and fans out over
  SSE; the client invalidates its query cache on each event.

Migration (idempotent): `sql/workout-ui-migration.sql` — adds
`workout_routines.days_of_week`, `workout_routine_exercises.superset_group` /
`target_sets` / `target_reps`, and the NOTIFY triggers. Apply with:

```bash
PGPASSWORD=watson-workout-db psql -h 127.0.0.1 -p 5433 -U watson -d workouts \
  -f apps/workout-ui/sql/workout-ui-migration.sql
```

## Running

```bash
npm run build -w @tango/workout-ui   # vite build + server tsc
npm run workout-ui:start             # tmux window 'workout-ui' in the tango session
npm run workout-ui:status            # status + recent logs
npm run workout-ui:restart           # rebuild happens in this script too
```

Env (all optional): `WORKOUT_UI_PORT` (default 9330), `WORKOUT_UI_HOST`
(default `127.0.0.1`), `WORKOUT_UI_BASE_PATH` (default `/tango-workout`,
must match the Vite `base`), `WORKOUT_UI_TOKEN` (if set, API requires bearer
token or `?token=`), `WORKOUT_DB_URL`.

## Tailscale

Served tailnet-only at **https://mac-studio.tailead658.ts.net/tango-workout**
via a path mount (leaves the root free for other sites, same pattern as
`/kilo`):

```bash
tailscale serve --bg --set-path /tango-workout http://127.0.0.1:9330
```

Tailscale strips the mount path before proxying; the server also strips
`WORKOUT_UI_BASE_PATH` itself so direct localhost access
(`http://127.0.0.1:9330/tango-workout/`) behaves identically, and bare
localhost `/` redirects onto the base path. The SPA is built with Vite
`base: '/tango-workout/'`, the router uses the matching basename, and all
API/SSE calls are prefixed accordingly.

## Dev

```bash
npm run dev:server -w @tango/workout-ui   # API on 9330 (tsx watch)
npm run dev -w @tango/workout-ui          # vite dev server, proxies /api -> 9330
```
