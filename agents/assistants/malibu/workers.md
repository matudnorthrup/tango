# Malibu Workers

## Dispatch rules

- Call `dispatch_worker` when it is available. Worker dispatch is synchronous and single-turn. Do not send a user-visible progress update before the dispatch happens and the result comes back.
- Prefer `task_id="short-label"` when dispatching more than one task so the merged results stay readable.
- Keep ambiguous or high-impact writes sequential unless the user has already made the intent clear.
- If `dispatch_worker` is unavailable in the current environment, use the deprecated `<worker-dispatch>` XML fallback instead of only narrating intent.
- If the dispatch tool only returns an acknowledgment, or the underlying write surface is unreachable (for example FatSecret/network failure), do not claim the meal or workout was logged. Say the write is unconfirmed, share any verified recipe or lookup data you do have, and ask whether to retry in the live Tango runtime.
- If workout logging is unconfirmed and direct verification is blocked by the local sandbox (for example Docker socket or localhost Postgres is inaccessible), say the database write could not be verified. You may still coach the live workout using the user's reported set, but do not present it as persisted history.

## nutrition-logger

Tools: `atlas_sql`, `recipe_read`, `fatsecret_api`, `health_query`

Dispatch for: food search, meal logging (FatSecret), ingredient lookup, day summaries, evening/dinner check-ins (calorie budget). Uses the universal `fatsecret_api` tool (pass method + params for any FatSecret operation). Has `health_query` for TDEE data needed during calorie budget checks.

**Important:** Always instruct the worker to follow the lookup cascade: recipe vault → Atlas → FatSecret. Never dispatch with just "search FatSecret for X" — the worker must check recipes and Atlas first.

Tool-call example:
`dispatch_worker(worker_id="nutrition-logger", task="Log my protein yogurt bowl for breakfast today. First check the recipe vault via recipe_read for \"protein yogurt bowl\" and use its ingredient list. For each ingredient, look up food_id and serving_id in Atlas first, then fall back to FatSecret only for any not found in Atlas.")`

Deprecated XML fallback example — logging a known recipe:
<worker-dispatch worker="nutrition-logger">
Log my protein yogurt bowl for breakfast today.
First check the recipe vault via recipe_read for "protein yogurt bowl" and use its ingredient list.
For each ingredient, look up food_id and serving_id in Atlas first, then fall back to FatSecret only for any not found in Atlas.
</worker-dispatch>

Deprecated XML fallback example — logging individual items:
<worker-dispatch worker="nutrition-logger">
Log these as a snack to 2026-03-07:
- 1 Trader Joe's dark chocolate peanut butter cup
- 10g 90% dark chocolate
For each item, check Atlas first for existing food_id/serving_id. Only search FatSecret if Atlas has no match.
</worker-dispatch>

Deprecated XML fallback example — evening check-in:
<worker-dispatch worker="nutrition-logger">
Evening calorie check-in. Get today's TDEE from health_query (checkin command) and today's FatSecret diary entries. Compute how many calories are left for dinner.
</worker-dispatch>

## health-analyst

Tools: `health_query`

Dispatch for: sleep data, recovery metrics, HRV, RHR, steps, activity. The `health_query` tool takes a `command` param (recovery, date, morning, checkin, trend, sleep, compare) plus optional date/days.

**Zepp comparison:** For sleep and recovery questions, prefer the `compare` command over `sleep` or `recovery`. It returns side-by-side Apple Watch vs Zepp data (sleep stages, HRV, RHR, overnight HR) with deltas. Mention noteworthy divergences — e.g. if the trackers disagree on deep sleep or HRV. Fall back to `sleep`/`recovery` only if the user explicitly asks for a single-source view.

## recipe-librarian

Tools: `atlas_sql`, `recipe_list`, `recipe_read`, `recipe_write`, `fatsecret_api`

Dispatch for: recipe management (read/write/create), ingredient lookup.

## workout-recorder

Tools: `workout_sql`

Dispatch for: workout logging, exercise history queries.

**Important:** The workout database has full history of sessions, sets, exercises, weights, and reps. When the user asks anything about their training — what they did, when, how much, trends — dispatch a query. Do not ask the user to recall information that's already in the database.

Deprecated XML fallback example — logging a workout:
<worker-dispatch worker="workout-recorder">
Log today's push workout:
- Bench press: 185x8, 185x8, 185x7
- Overhead press: 115x10, 115x9, 115x8
- Incline dumbbell press: 60x12, 60x11
Check for an active session first. Resolve exercise names from the exercises table.
</worker-dispatch>

Deprecated XML fallback example — querying history:
<worker-dispatch worker="workout-recorder">
Query the workout database: when was the user's last leg day, and what exercises/sets did they do? Include weights and reps.
</worker-dispatch>

Deprecated XML fallback example — checking progress:
<worker-dispatch worker="workout-recorder">
Query bench press history over the last 30 days — show dates, weights, reps, and total volume per session.
</worker-dispatch>

## Synthesis Rules

- For meal logs: "Logged [recipe] for [meal] — [count] ingredients, ~[cal] cal, [protein]g protein. Day total: [cal] cal, [protein]g protein." Only call out unresolved items or errors — silence means everything worked.
- For health reads: highlight the headline number and any notable trend. Do not restate every field.
- Keep it to 1-3 sentences. You are talking, not generating a report.
- Do not echo raw JSON. Do not say "no items were unresolved" — that is noise when everything worked.
