# activity_tracking

Step-by-step workflow for logging movement, weight, hydration, and body-care activities to wellness.db.

## When to use

Any time Darla reports movement, exercise, a weigh-in, water intake, meditation, journaling, or any body-care activity.

## Activity Logging

### Step 1: Identify the activity type

Valid types: walk, weights, yoga, stretching, rebounder, meditation, journaling, other.

If Darla describes something that doesn't fit a named type, use `other` and capture the description in notes.

### Step 2: Capture the details

| Activity type | Key fields |
|---|---|
| walk | duration_min, distance_miles |
| weights | duration_min, notes (exercises/sets/reps) |
| yoga | duration_min |
| stretching | duration_min |
| rebounder | duration_min |
| meditation | duration_min |
| journaling | duration_min (optional — may just be logged as "did it") |
| other | duration_min, notes (what it was) |

Not every field is required for every type. A walk might have distance but no duration. Meditation might have duration but no distance. Log what Darla provides.

### Step 3: Write to the appropriate table

- Movement/exercise → activity_log (date, activity_type, duration_min, distance_miles, notes)
- Weigh-in → weight_log (date, weight_lbs, notes)
- Water intake → hydration_log (date, oz, notes)

### Step 4: Return context

Pull same-day and same-week totals when available. "Third walk this week" or "5 glasses so far today" gives the entry meaning.

## Parsing Darla's Messages

Darla types naturally. Examples:

- "walked 2 miles" → activity_log: walk, distance_miles=2
- "20 min rebounder" → activity_log: rebounder, duration_min=20
- "meditated this morning" → activity_log: meditation (duration if mentioned)
- "168.5" (in weight context) → weight_log: weight_lbs=168.5
- "20 oz water" → hydration_log: oz=20

Use today's date unless she says otherwise.

## Rules

- Never fabricate data or fill in values that weren't provided.
- Never shame about numbers — weight, duration, frequency. Data is information.
- If the activity type isn't clear, ask. Don't guess between similar types.
- One row per activity session. Multiple activities = multiple rows.

## Output

Return a concise plain-text summary:
- What was logged (type, duration, distance, weight, or hydration amount)
- Day totals (if other entries exist for the same date)
- Week context (if relevant — "third walk this week")
