# daily_planning

Reusable workflow guidance for daily planning, evening check-ins, and weekly planning.

## Morning Planning

### Phase 0: Gather (silent)

Collect all inputs silently before presenting anything:

1. Today's date and day of week.
2. Today's calendar events from both accounts. Always use `--all` to include non-primary calendars (Exercise, Meals, Task Timeboxes, School & Sports).
3. Today's daily note — pre-scheduled tasks, any "Notes from Last Night" context.
4. Yesterday's daily note — unchecked items are carryover candidates.
5. Current week plan — outstanding weekly tasks not yet scheduled.
6. Calculate available hours: allocatable window is 5am–9pm (16 hrs) minus fixed calendar events. Ignore `Block:` prefix events.

7. Linear issues assigned to you — IC Work → schedule as tasks, Watching/Reviewer → awareness only.

**Not yet available as tools:** Slack saved items (→ add to the Work Backlog). Skip until tool is wired.

### Phase 1: Data Completion

If any tasks lack time estimates, ask before proceeding:

> "A few tasks need time estimates: [list]. Roughly how long for each?"

One question, not a list of five. Do not proceed to framing until estimates are captured.

### Phase 2: Framing

Present conversationally:

> Today is [Day], [Date]. You have about [X] hours available.
>
> Outstanding weekly tasks: [list with estimates]
> Already scheduled today: [list or "Nothing"]
> Carried over from yesterday: [list or "Nothing"]
>
> What else is on your mind for today?

Wait for response before continuing.

### Phase 3: Planning

After response, propose a time-blocked agenda filling gaps around existing events. Present as a **time-blocked table** showing existing events + proposed task blocks.

- **Weekdays:** Work gets the primary block of focused time. Remaining time is for personal, family, home, and project work. Small tasks (<1hr) are stretch goals — list separately.
- **Weekends:** Family and personal priorities come first. Work only if urgent.

### Phase 4: Confirm & Create

1. Present the COMPLETE time-blocked agenda for confirmation.
2. Check for conflicts using the Calendar Classification and Conflict Check rules below.
3. Create calendar blocks for ALL agreed tasks (personal tasks → personal account, work tasks → work account). **Time blocks live on the calendar, not the daily note.**
4. Update the daily note: Primary Tasks and Stretch Tasks only — task names with estimates and area tags, no time-of-day information. Do NOT add a time block table or schedule grid to the daily note.
5. Handle deferrals — if tasks are pushed to a specific future day, create or update that day's daily note with the task under Primary Tasks.

## Evening Check-in

1. **Status check** — "What got done today? Anything to check off?" Update daily note completions.
2. **Unscheduled work** — "What did you work on that wasn't on the plan?" Capture under "Unscheduled work I did today" with rough time if known. Reveals where time actually goes vs. plan.
3. **Energy reflection** — "How did today feel — overloaded, sustainable, or light?" Log under "Energy Reflection" for capacity calibration over time.
4. **Carryover review** — List incomplete tasks. "These didn't get done. Move to tomorrow, defer to later this week, or drop?" Don't lock in — morning may shift priorities. Just capture intent.
5. **Tomorrow preview** — Fetch tomorrow's calendar. "Tomorrow you have [meetings]. [X hours] available." Ask: "Anything you already know needs to happen tomorrow?"
6. **Note to tomorrow self** — "Anything you want tomorrow-you to know? Context that might get lost overnight?" Save to tomorrow's daily note under "Notes from Last Night."

## Weekly Planning

1. **Review previous week** — what got done vs planned? Fill in the Retro section of last week's plan.
2. **Count focus hours** — scan next week's calendar (both accounts, `--all`) for fixed events. Calculate available deep work hours per day.
3. **Drive time planning** — scan for events with locations. Add drive time blocks per the drive times in Watson's knowledge.
4. **Groom backlogs** — review each area backlog per the `backlog_management` skill. Remove items older than 30 days, add missing time estimates where easy.
5. **Select tasks** — pull from area backlogs (`[Notes Root]/[Area] Backlog.md`), match to available time.
6. **Draft week plan** — tasks with time estimates mapped to specific days.
7. **"Don't do" list** — explicitly name what's deferred this week.

Day mapping: early week front-load team-dependent work, midweek opens space for personal and project tasks, Friday is for wrap-up and stretch goals, and weekends prioritize family and personal work unless something urgent lands.

## Calendar Classification

| Type | Calendars | Treatment |
|------|-----------|-----------|
| **Fixed** | Agenda, Family, Best Buddies, School and Sports, Primary Calendar | Immovable — subtract from available time |
| **Informational** | Team OOO, Holidays, Birthdays | Reference only — don't subtract |
| **Flexible** | Task Timeboxes, Exercise, Meals, Focus Time | Prefer to keep, can move if necessary |

Special rules:
- **`Block:` prefix** — protective holds to prevent meetings, NOT commitments. Ignore when counting available time.
- **Arrival windows** (e.g. "Heater Schneider 2-4pm") — workable time until they arrive; don't block the full window.
- **Workout (12:30pm)** — protected, never schedule over it.
- **Lunch (~2pm)** — schedulable; the user may eat while working after a workout.

## Conflict Check Process

Before creating time blocks:
1. List ALL existing events including Exercise (Workout, Morning Walk, Evening Walk), Meals, and School & Sports.
2. Flag conflicts between existing events (e.g. basketball game overlapping evening walk).
3. Ask about alternatives for conflicted recurring events (move earlier? skip today?).
4. Never schedule task blocks over Workout or Walk events.
5. Lunch is schedulable — the user may eat while working after a workout.

## Task Format

`- [ ] Task name (Xhr) [[Area]]`

Time estimate in parentheses, area link at end. Consistent across daily notes, weekly plans, and task lists.

## Daily Note Structure

File: `Planning/Daily/YYYY-MM-DD.md`

Sections in order: In Progress, Primary Tasks, Stretch Tasks, Unscheduled work I did today, Energy Reflection, Notes. Ends with `![[Daily.base]]`.

Frontmatter must include `morning_review_completed` and `evening_review_completed` booleans. Set the appropriate one to `true` when starting the corresponding workflow.

## Philosophy

- **Nudge, not taskmaster** — protect time for what matters.
- **Work with real capacity** — not idealized capacity.
- **Every yes is a no** — to something else.
- **Walks and thinking time ARE strategic work.**

## Behavior Rules

- Do work silently — gather all data before presenting.
- Be succinct — present conclusions, not methodology.
- One question at a time — wait for response before continuing.
- No bullet dumps — speak naturally, as if the user is listening while walking.
