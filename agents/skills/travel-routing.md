# travel_routing

Workflow guidance for travel, navigation, and road trip tasks.

## Core tools

- `location_read` — Current GPS from OwnTracks (lat, lon, velocity km/h, heading degrees, ageSec). Always check this first when the user's current position affects the answer. Warn if ageSec > 3600 (stale).
- `driving_route` — Real driving routes: distance, traffic-aware ETA (HERE Router v8 primary, OSRM fallback), major roads (`via`), and towns along the way (`passesThrough`). **Always use this for driving route, drive-time, detour, or "is this on the way by car" answers.** If `source` is `osrm` the ETA has no traffic and runs high — say so.
- `walking_route` — Real walking routes: walking distance and walking ETA. Use this, not `driving_route`, for walking, walkability, or walk-safety questions. If `source` is `osrm`, the distance is routed but the duration is estimated at 3 mph and sidewalk/safety conditions are not verified.
- `find_diesel` — Fuel station finder. Route mode: diesel-only along GPS→destination, scored by price × detour penalty. Near mode (`near: true` + place, or no destination for current GPS): all fuel grades around a place or station, including POI names like "Costco, Medford, OR". Sources fall back HERE→GasBuddy automatically.
- `open_meteo_weather` skill — Weather at any coordinates. Wind comes back in km/h, convert to mph.
- `exa_search` / `exa_answer` — Rest areas, businesses, scenic stops, road conditions.

## Routing evidence rules

- Do not answer a route/directions/drive-time question from mental geography when `driving_route` is available.
- Do not answer a walking distance, walking ETA, or walk-safety question from `driving_route`; call `walking_route`.
- Before stating a distance, read `routeMode` and `resolvedPoints`. If the origin or destination resolved wrong, say the route could not be verified.
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

Vehicle specifics — fuel type, tank capacity, tire/economy adjustments, and fuel
preferences — are profile-configured. Read the profile-configured vehicle profile
and apply it: use the configured fuel type even when the user says "gas"
casually, derate economy per the configured tire/load notes, and use the low end
of the MPG range for mountain/headwind driving. Always maintain a 50+ mile
cushion beyond the next fuel stop. When the user reports "miles to empty" from
the dash, use THAT for range calculations.

## Real-time navigation rules

- Always call `location_read` first, then route from current position with `driving_route`.
- For walking from the user's current place, call `location_read` first, then `walking_route` from `current location`; prefer fresh GPS over a remembered hotel address.
- Verify recommendations are AHEAD on the route, not behind.
- Check current local time — account for time zone based on coordinates.
- State the user's approximate location and local time so they can verify.
- Confirm businesses are ahead and check hours for current local time. Don't suggest backtracking unless asked.

**Rest stops:** In remote rural areas, formal rest areas are rare. Search for day-use areas, public-land recreation sites, boat launches (always have restrooms + parking). Filter for restrooms explicitly mentioned.

**Voice responses while driving:** Concise (1-3 points), no markdown, natural language, round numbers ("about 85 miles", "roughly an hour and a half").

## Pre-trip planning workflow

1. Gather: origin, destination, departure date, driving preferences, lodging preferences, errands
2. Route comparison: generate 2-4 options with `driving_route`, document distance/time/fuel availability/passes
3. Fuel gap analysis: identify legs > 150 miles between stations carrying the configured fuel type (critical in remote rural regions)
4. Build itinerary: departure times, fuel stops with prices, meal stops, overnight lodging
5. Create or update an Obsidian trip doc using the `obsidian` tool and the `obsidian_note_conventions` frontmatter standard
6. Validate: all distances via `driving_route`, fuel range covers every leg with 50+ mile cushion (against the configured tank capacity and fuel type)

Trip planning notes should use YAML-list wikilink frontmatter. Use `types` with a `[[Project Plan]]` list item, choose the best approved `areas` value, and use `collections` for the finite trip or trip hub. Do not create a `Travel/` folder and do not use `areas: Travel`; travel is a collection concept, not an approved area.

**Lodging:** Check the user's configured hotel loyalty programs first; direct hotel sites beat OTAs for loyalty rates. Apply the user's configured lodging preferences (e.g. non-smoking, mobile check-in). The specific loyalty programs and preferences are profile-configured.

**Time zones:** Determine the time zone from coordinates and account for DST and zone boundaries crossed along the route. (Region-specific zone-boundary notes are profile-configured.)

**Seasonal:** Check chain/traction requirements for mountain passes in winter months and the relevant state/regional DOT sources for road conditions.

## Lessons learned

- Rural fuel prices can vary $1+/gal within 2 miles — always search specific stations
- Not all warehouse-club (e.g. Costco) locations carry every fuel grade — verify before recommending
- Rural fuel prices vary wildly. A station 2 miles away can be much cheaper
- A neighboring state's fuel isn't automatically cheaper — depends on the station
- Frequent stops are welcome on long drives — don't optimize purely for speed
- Overnight stops that preserve bedtime are better than pushing late to reduce total days
- Build 15-30 min buffer per stop into timing estimates — stops always take longer than planned
