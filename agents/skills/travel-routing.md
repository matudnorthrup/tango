# travel_routing

Workflow guidance for travel, navigation, and road trip tasks.

## Core tools

- `location_read` — Current GPS from OwnTracks (lat, lon, velocity km/h, heading degrees, ageSec). Always check this first for any location-based query. Warn if ageSec > 3600 (stale).
- `find_diesel` — Diesel-only station finder. Scores by price × detour penalty. Returns name, price, detour miles, Google Maps link.
- `osrm_routing` skill — OSRM API for real driving distances. **Always use this — never estimate.**
- `open_meteo_weather` skill — Weather at any coordinates. Wind comes back in km/h, convert to mph.
- `exa_search` / `exa_answer` — Rest areas, businesses, scenic stops, road conditions.

## Vehicle

This workflow assumes the user's primary road-trip vehicle is a diesel truck. Even if they say "gas" casually, interpret it as diesel unless they specify otherwise. Tank ~26 gallons. Big tires (35"+) reduce fuel economy ~10-15% from factory specs. Mountain/headwind driving: use low end of MPG range. Always maintain 50+ mile cushion beyond the next fuel stop. When the user reports "miles to empty" from the dash, use THAT for range calculations.

## Real-time navigation rules

- Always call `location_read` first, then route from current position via OSRM.
- Verify recommendations are AHEAD on the route, not behind.
- Check current local time — account for time zone based on coordinates.
- State the user's approximate location and local time so they can verify.
- Confirm businesses are ahead and check hours for current local time. Don't suggest backtracking unless asked.

**Rest stops:** In rural Nevada/Utah, formal rest areas are rare. Search for day-use areas, BLM recreation sites, boat launches (always have restrooms + parking). Filter for restrooms explicitly mentioned.

**Voice responses while driving:** Concise (1-3 points), no markdown, natural language, round numbers ("about 85 miles", "roughly an hour and a half").

## Pre-trip planning workflow

1. Gather: origin, destination, departure date, driving preferences, lodging preferences, errands
2. Route comparison: generate 2-4 options via OSRM, document distance/time/fuel availability/passes
3. Fuel gap analysis: identify legs > 150 miles between diesel stations (critical for rural NV/UT/OR)
4. Build itinerary: departure times, fuel stops with prices, meal stops, overnight lodging
5. Create Obsidian trip doc using the `obsidian` tool
6. Validate: all distances via OSRM, fuel range covers every leg with 50+ mile cushion

**Lodging:** Check loyalty programs (Marriott Bonvoy, Hilton Honors, Best Western Rewards). Direct hotel sites beat OTAs for loyalty rates. Non-smoking, mobile check-in preferred.

**Time zones (Western US):**
- Pacific: CA, OR, WA, NV
- Mountain: UT, AZ (no DST), CO, MT, ID, WY, NM
- NV/UT border = Pacific → Mountain (lose 1 hour heading east)
- OR/ID border = Pacific → Mountain

**Seasonal:** Check chain requirements for mountain passes Oct-Apr. Caltrans, NDOT, UDOT for road conditions.

## Lessons learned

- California rural diesel can vary $1.50/gal within 2 miles — always search specific stations
- Not all Costco locations carry diesel — verify before recommending
- Rural fuel prices vary wildly. A station 2 miles away can be much cheaper
- Nevada gas isn't automatically cheaper than California — depends on the station
- Frequent stops are welcome on long drives — don't optimize purely for speed
- Overnight stops that preserve bedtime are better than pushing late to reduce total days
- Build 15-30 min buffer per stop into timing estimates — stops always take longer than planned
