# Malibu TDEE Undercount Fix

## Status: SHIPPED (2026-04-18)

## Problem

Stakeholder's phone shows the day's active calories, but Malibu reports a TDEE that is materially lower than the phone's figure for the same day (April 17). Gap of ~316 calories. (Specific calorie values redacted.)

## Root Cause

The `getBasalCal()` function in `health-query.js` filters `basal_energy_burned` records by Apple Watch source (`/Apple.?Watch/i`). This misses "Sleep Watch"-only records that cover time periods when the Apple Watch isn't the primary contributor.

### MongoDB data for April 17 (`basal_energy_burned`):

| Source | Calories | Records | Matches `/Apple.?Watch/`? |
|--------|---------|---------|--------------------------|
| Sleep Watch\|<Apple Watch source> | (redacted) | 66,981 | Yes |
| Sleep Watch | (redacted) | 18,802 | **No** |
| **Total** | **(redacted)** | | |

The "Sleep Watch"-only records cover time periods when only the Sleep Watch app is active (e.g., when the watch is charging, during sleep transitions). These are non-overlapping with the Watch records — the Health Auto Export app exports deduplicated records from Apple Health.

### Impact on TDEE (calorie values redacted):

| Calculation | Basal | Active | TDEE | Gap vs Phone |
|------------|-------|--------|------|---------------------|
| Current (Watch-filtered) | (redacted) | (redacted) | (redacted) | **-316 cal** |
| Fixed (all sources) | (redacted) | (redacted) | (redacted) | -75 cal (within dedup rounding) |

### Not a timezone issue

The TDEE formula itself is correct (`basal + active`). The health-query.js script already uses `America/Los_Angeles` for date boundaries. The issue is purely the source filter dropping valid basal energy records.

## Proposed Fix

### File: external health-data `health-query.js`

**Function `getBasalCal()` (lines 178-201):** Remove the Watch-first source filter. Always aggregate all sources for `basal_energy_burned`. Keep the `< 1000` fallback to `TYPICAL_BASAL` (value redacted) as a safety net.

Current:
```javascript
async function getBasalCal(db, dayStart, dayEnd, dateStr) {
  // Try Watch source first
  const watchResult = await db.collection('basal_energy_burned').aggregate([
    { $match: { $and: [dateFilter(dayStart, dayEnd, dateStr), { source: WATCH_SOURCE }] } },
    { $group: { _id: null, total: { $sum: '$qty' } } }
  ]).toArray();
  let basal = watchResult[0]?.total ? Math.round(watchResult[0].total) : 0;

  // If no Watch data, try any source
  if (basal === 0) { ... }

  if (basal < 1000) return TYPICAL_BASAL;
  return basal;
}
```

Fixed:
```javascript
async function getBasalCal(db, dayStart, dayEnd, dateStr) {
  // Sum all sources — Health Auto Export already deduplicates from Apple Health.
  // Watch-only filtering misses Sleep Watch records (~20-25% of daily basal).
  const result = await db.collection('basal_energy_burned').aggregate([
    { $match: dateFilter(dayStart, dayEnd, dateStr) },
    { $group: { _id: null, total: { $sum: '$qty' } } }
  ]).toArray();
  const basal = result[0]?.total ? Math.round(result[0].total) : 0;

  if (basal < 1000) return TYPICAL_BASAL;
  return basal;
}
```

### Why not fix `getActiveCal()` too?

Active energy Watch filtering is fine — the main Watch source covers ~99% of active calories. The non-Watch sources add only a handful of calories. Not worth the risk of double-counting. (Calorie values redacted.)

## Scope

- 1 external health-data script outside the Tango repo
- No build or restart needed — the health_query tool calls this script directly
- No prompt changes

## Linear

- Project: Malibu TDEE Undercount Fix
- Issues: historical discovery, implementation, and validation records
