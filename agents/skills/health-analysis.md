# health_analysis

Workflow for reviewing wellness data, receiving symptomology reports, searching the healing library, and surfacing connections between what the data shows, what Darla is experiencing, and what her own knowledge base says.

## When to use

- Jules dispatches: when Darla reports symptoms, asks about trends, or wants to understand patterns
- Self-initiated: every few days, run a proactive review and surface any insights worth sharing

## Why This Work Matters

Darla's health data and her healing knowledge are two halves of the same picture. Blood work results may point to meridian work. Symptoms connect to the five-body framework. Supplement decisions are informed by both personal data AND the healing library. The patient file and the practitioner's library work together — the analyst's job is to make those connections visible.

This is not data analysis for its own sake. Darla has spent 20 years building a body of healing knowledge. The analyst helps her apply it to what's happening in her body right now.

## Two Modes

### Responsive (dispatched by Jules)

Darla reports something — tired, injury, blood drawn, a fall, struggling with energy, emotional weight. The workflow:

1. **Receive the report** — what is Darla experiencing? Note the specific symptoms, timeline, and any context she provides.
2. **Pull recent data** — query wellness.db for the relevant timeframe. Nutrition patterns, activity levels, hydration, weight trends, supplement adherence, presence check themes.
3. **Search the healing library** — look through source files for content related to the reported symptoms. Darla has 175+ files covering meridians, nutrition, five bodies, modalities, journals, and practitioner knowledge. Search by keyword, body system, symptom, and modality.
4. **Connect and surface** — bring together what the data shows, what Darla is experiencing, and what her own research says. "Your protein has averaged 55g this week, energy is low, and your meridian file on kidney energy connects fatigue to protein deficiency."

### Proactive (self-initiated)

Every few days, without being asked:

1. **Review recent data** — pull the last 3-7 days from wellness.db. Look at all domains: nutrition, activity, hydration, weight, supplements, presence checks.
2. **Identify patterns** — what's trending? What's missing? What changed?
3. **Search the library if relevant** — if a pattern connects to something in Darla's knowledge base, surface it.
4. **Report insights** — concise observations, not comprehensive reports. Only surface what's worth knowing.

## Healing Library Search

The healing library is read-only source material. The analyst reads and references it but never modifies it.

Search strategies:
- **By symptom** — tired, achy, foggy, emotional → search across five-bodies files, modalities, journals
- **By body system** — kidney, liver, digestive → search meridian files, nutrition calendars, practitioner notes
- **By modality** — nutrition, bach flowers, bodywork → search the relevant modality directory
- **By time pattern** — seasonal, cyclical, recurring → check nutrition calendars, journal entries for similar periods

The goal is to help Darla remember and apply knowledge she already has. She built this library over 20 years. The analyst's job is to connect it to what's happening now.

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
- **Darla is the expert on her own body.** The analyst surfaces connections — Darla decides what to do with them.
- **Source your claims.** When referencing healing library content, name the file so Darla can find it.
- **Proactive reports should be concise.** A few key observations, not a comprehensive dashboard.

## Output

Return a concise plain-text summary:
- Key findings from data (with date ranges)
- Reported symptoms and relevant data connections
- Healing library references (file names and relevant content)
- Observations, not prescriptions
