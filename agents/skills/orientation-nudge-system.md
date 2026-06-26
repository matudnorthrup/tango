# Orientation Nudge System

The orientation nudge system helps recover attention during reactive days by
checking whether the daily note has gone stale and sending a low-friction
Discord check-in.

## Trigger Rules

The deterministic schedule runs every 15 minutes and sends a nudge only when all
conditions are true:

- Local time is inside active hours, default 5:00am to 8:00pm.
- No recent daily-note activity, default 60 minutes.
- No current timed calendar event.
- Focus mode is not active.
- Vacation mode is not active.
- No unanswered active nudge is pending.
- Cooldown and minimum nudge interval have elapsed.

Calendar checks use `gog calendar events --all` by default. If
`ORIENTATION_NUDGE_CALENDAR_ACCOUNTS` is set, the runtime queries each listed
account explicitly. Timed events suppress nudges, including focus blocks,
tentative events, and travel. All-day events do not suppress nudges.
Timed events whose title starts with `Block:` are placeholders and do not
suppress nudges.

## Daily Note Contract

Daily notes include a formal `## Current Task Rotation` section. Use top-level
task checkboxes only:

```md
## Current Task Rotation
- [ ] First task
- [ ] Second task
```

The first unchecked top-level item is the current task. Nested checkboxes are
ignored. If the rotation is missing or complete, the system falls back to the
latest timestamped `## Interstitial Log` entry, then to `No current task
detected`.

Scheduled/background reads and writes use direct filesystem I/O against the
vault, not Obsidian MCP.

## State

Runtime state lives in profile `tango.sqlite`:

- `orientation_nudge_state` stores focus/vacation modes, recent note activity,
  active nudge metadata, unanswered counts, and cooldowns.
- `orientation_nudge_events` stores state-transition events for review.

The `Yes` button logs only to SQLite. The `No` modal appends an explicit new
interstitial log entry because the user typed a new task.

## Discord Flow

The nudge message uses buttons:

```md
Are you still working on **[current task]**?
```

- `Yes` confirms and snoozes.
- `No` opens a task modal and appends the new task to the interstitial log.
- `Focus Mode` opens a task modal and silences nudges for the default focus
  duration.
- `Vacation` opens an end-time modal and silences nudges until that time.

Only the latest active nudge can be answered. Stale clicks get an ephemeral
expired response.

## Cooldown

Ignored nudges are marked after the configured ignore window, default 30
minutes. The first two ignored nudges wait for the normal next eligible ping.
After that, cooldown doubles from the configured base interval up to the max.

## Watson Control

Watson can use `orientation_nudge` to read status, set/clear focus mode, and
set/clear vacation mode with an explicit end date/time. Do not rely on prompt
memory alone for these modes.
