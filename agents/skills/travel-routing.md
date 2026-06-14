# travel_routing

Workflow guidance for travel, navigation, and road trip tasks.

## Core tools

- `location_read` — Current GPS from OwnTracks (lat, lon, velocity km/h, heading degrees, ageSec). Always check this first when the user's current position affects the answer. Warn if ageSec > 3600 (stale).
- `driving_route` — Real driving routes: distance, traffic-aware ETA (HERE Router v8 primary, OSRM fallback), major roads (`via`), and towns along the way (`passesThrough`). **Always use this for route, ETA, detour, or "is this on the way" answers.** If `source` is `osrm` the ETA has no traffic and runs high — say so.
- `find_diesel` — Fuel station finder. Route mode: diesel-only along GPS→destination, scored by price × detour penalty. Near mode (`near: true` + place, or no destination for current GPS): all fuel grades around a place or station, including POI names like "Costco, Medford, OR". Sources fall back HERE→GasBuddy automatically.
- `open_meteo_weather` skill — Weather at any coordinates. Wind comes back in km/h, convert to mph.
- `exa_search` / `exa_answer` — Rest areas, businesses, scenic stops, road conditions.

## Routing evidence rules

- Do not answer a route/directions/drive-time question from mental geography when `driving_route` is available.
- Only name towns, stops, or landmarks as "on the route" if they appear in the tool's `via`/`passesThrough` output or in `find_diesel` results. Recommending a place the route does not actually pass is worse than saying you need to check.
- The route the tool found may not be the corridor you imagine (e.g. US-199 vs I-5). Read `via` before describing the route.
- `durationHours` already includes live traffic. Do not add traffic padding or your own multipliers; add time only for planned stops (15-30 min each).
- If you say you are verifying, first call a tool that can verify the claim.
- For "where will we get by 8 or 9 p.m." tasks, call `driving_route` for the main route and compare likely overnight-stop corridors with real drive time.
- For "is X on the route" or "would X be a detour" tasks, call `driving_route` with at least two options: direct/best route and via-X.
- State route conclusions as tool-backed facts and label any preferences or hotel-quality judgments as synthesis.

## Diesel evidence rules

- A station's price is verified only when `find_diesel` returns that exact station with that price.
- Diesel availability from web search is not the same as a live diesel price.
- Do not call a station cheapest, closest, live-priced, or confirmed unless the tool output supports that exact claim.
- If a preferred brand is not returned by `find_diesel`, say its price is not verified and cite the nearest verified diesel price separately.
- For partial evidence, say: "Verified: ... Not verified: ... Recommendation: ..."

## Vehicle

This workflow assumes the user's primary road-trip vehicle is a diesel truck. Even if they say "gas" casually, interpret it as diesel unless they specify otherwise. Tank ~26 gallons. Big tires (35"+) reduce fuel economy ~10-15% from factory specs. Mountain/headwind driving: use low end of MPG range. Always maintain 50+ mile cushion beyond the next fuel stop. When the user reports "miles to empty" from the dash, use THAT for range calculations.

## Real-time navigation rules

- Always call `location_read` first, then route from current position with `driving_route`.
- Verify recommendations are AHEAD on the route, not behind.
- Check current local time — account for time zone based on coordinates.
- State the user's approximate location and local time so they can verify.
- Confirm businesses are ahead and check hours for current local time. Don't suggest backtracking unless asked.

**Rest stops:** In rural Nevada/Utah, formal rest areas are rare. Search for day-use areas, BLM recreation sites, boat launches (always have restrooms + parking). Filter for restrooms explicitly mentioned.

**Voice responses while driving:** Concise (1-3 points), no markdown, natural language, round numbers ("about 85 miles", "roughly an hour and a half").

## Pre-trip planning workflow

1. Gather: origin, destination, departure date, driving preferences, lodging preferences, errands
2. Route comparison: generate 2-4 options with `driving_route`, document distance/time/fuel availability/passes
3. Fuel gap analysis: identify legs > 150 miles between diesel stations (critical for rural NV/UT/OR)
4. Build itinerary: departure times, fuel stops with prices, meal stops, overnight lodging
5. Create or update an Obsidian trip doc using the `obsidian` tool and the `obsidian_note_conventions` frontmatter standard
6. Validate: all distances via `driving_route`, fuel range covers every leg with 50+ mile cushion

Trip planning notes should use YAML-list wikilink frontmatter. Use `types` with a `[[Project Plan]]` list item, choose the best approved `areas` value, and use `collections` for the finite trip or trip hub. Do not create a `Travel/` folder and do not use `areas: Travel`; travel is a collection concept, not an approved area.

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
