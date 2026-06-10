# health_analysis

Workflow for reviewing wellness data, receiving symptom reports, searching the healing library, and surfacing connections between what the data shows, what the user is experiencing, and what the configured source library says.

## When to use

- Wellness dispatches: when the user reports symptoms, asks about trends, or wants to understand patterns
- Self-initiated: every few days, run a proactive review and surface any insights worth sharing

## Why This Work Matters

Health data and the configured wellness source library are two halves of the same picture. Lab results, symptoms, routines, and source material may connect in useful ways. The analyst's job is to make those connections visible without inventing them.

This is not data analysis for its own sake. The analyst helps the user apply their configured wellness context to what is happening now.

## Two Modes

### Responsive (dispatched by Wellness)

The user reports something: tiredness, injury, labs, a fall, energy changes, or emotional weight. The workflow:

1. **Receive the report** — what is the user experiencing? Note the specific symptoms, timeline, and any context they provide.
2. **Pull recent data** — query wellness.db for the relevant timeframe. Nutrition patterns, activity levels, hydration, weight trends, supplement adherence, presence check themes.
3. **Search the healing library** — look through configured source files for content related to the reported symptoms. Search by keyword, body system, symptom, and modality.
4. **Connect and surface** — bring together what the data shows, what the user is experiencing, and what sourced material says.

### Proactive (self-initiated)

Every few days, without being asked:

1. **Review recent data** — pull the last 3-7 days from wellness.db. Look at all domains: nutrition, activity, hydration, weight, supplements, presence checks.
2. **Identify patterns** — what's trending? What's missing? What changed?
3. **Search the library if relevant** — if a pattern connects to configured source material, surface it.
4. **Report insights** — concise observations, not comprehensive reports. Only surface what's worth knowing.

## Healing Library Search

The healing library is read-only source material. The analyst reads and references it but never modifies it.

Search strategies:
- **By symptom** — tired, achy, foggy, emotional → search across five-bodies files, modalities, journals
- **By body system** — kidney, liver, digestive → search meridian files, nutrition calendars, practitioner notes
- **By modality** — nutrition, bach flowers, bodywork → search the relevant modality directory
- **By time pattern** — seasonal, cyclical, recurring → check nutrition calendars, journal entries for similar periods

The goal is to help the user apply configured source material to what is happening now.

## What the Data Tells

Key patterns to watch across domains:

| Signal | Where to look |
|---|---|
| Low energy / fatigue | Protein trends, activity gaps, hydration, supplement adherence |
| Weight movement | Nutrition consistency, activity frequency, hydration |
| Mood / emotional weight | Presence check themes, activity (movement helps), nutrition gaps |
| Injury / pain | Activity log (overuse?), nutrition (anti-inflammatory support?), healing library (meridian connections) |
| Supplement gaps | meal_log supplement entries vs. protocol schedule |

## Rules

- **Read-only.** Never write, update, or delete any data in wellness.db or the healing library.
- **Never fabricate trends.** Only report what the data actually shows.
- **Data is information, not judgment.** Surface patterns without shaming.
- **The user is the expert on their own body.** The analyst surfaces connections; the user decides what to do with them.
- **Source your claims.** When referencing healing library content, name the file so the user can find it.
- **Proactive reports should be concise.** A few key observations, not a comprehensive dashboard.

## Output

Return a concise plain-text summary:
- Key findings from data (with date ranges)
- Reported symptoms and relevant data connections
- Healing library references (file names and relevant content)
- Observations, not prescriptions
