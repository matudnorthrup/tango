# Malibu TDEE Undercount Fix

## Status: SHIPPED (2026-04-18)

## Problem

Stakeholder's phone shows 1,116 active calories for April 17, but Malibu reports TDEE of only ~2,492. Phone shows 2,808. Gap of 316 calories.

## Root Cause

The `getBasalCal()` function in `health-query.js` filters `basal_energy_burned` records by Apple Watch source (`/Apple.?Watch/i`). This misses "Sleep Watch"-only records that cover time periods when the Apple Watch isn't the primary contributor.

### MongoDB data for April 17 (`basal_energy_burned`):

| Source | Calories | Records | Matches `/Apple.?Watch/`? |
|--------|---------|---------|--------------------------|
| Sleep Watch\|Devin's Apple Watch Ultra | 1,367 | 66,981 | Yes |
| Sleep Watch | 385 | 18,802 | **No** |
| **Total** | **1,752** | | |

The "Sleep Watch" records (385 cal) cover time periods when only the Sleep Watch app is active (e.g., when Apple Watch is charging, during sleep transitions). These are non-overlapping with the Watch records — the Health Auto Export app exports deduplicated records from Apple Health.

### Impact on TDEE:

| Calculation | Basal | Active | TDEE | Gap vs Phone (2,808) |
|------------|-------|--------|------|---------------------|
| Current (Watch-filtered) | 1,367 | 1,125 | 2,492 | **-316 cal** |
| Fixed (all sources) | 1,752 | 1,131 | 2,883 | -75 cal (within dedup rounding) |

### Not a timezone issue

The TDEE formula itself is correct (`basal + active`). The health-query.js script already uses `America/Los_Angeles` for date boundaries. The issue is purely the source filter dropping valid basal energy records.

## Proposed Fix

### File: `~/clawd/skills/health-data/scripts/health-query.js`

**Function `getBasalCal()` (lines 178-201):** Remove the Watch-first source filter. Always aggregate all sources for `basal_energy_burned`. Keep the `< 1000` fallback to `TYPICAL_BASAL` (1,744) as a safety net.

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

Active energy Watch filtering is fine — the main Watch source covers 99% of active calories (1,118 of 1,131 total). The non-Watch sources add only ~13 cal. Not worth the risk of double-counting.

## Scope

- 1 file: `~/clawd/skills/health-data/scripts/health-query.js` (outside Tango repo)
- No build or restart needed — the health_query tool calls this script directly
- No prompt changes

## Linear

- Project: Malibu TDEE Undercount Fix
- Issues: DEV-36 (Discovery, Done), DEV-37 (Implementation), DEV-38 (Validation)
