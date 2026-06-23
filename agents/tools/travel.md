# Travel Tools

Shared doc for `location_read`, `driving_route`, `walking_route`, and `find_diesel`.
Sierra owns the full travel tool bundle. Charlie may use `location_read` only
for ephemeral location narration.

## `location_read`

Reads current GPS state from the latest OwnTracks payload.

Input:

```json
{}
```

Typical output fields:
- `lat`
- `lon`
- `velocity`
- `heading`
- `battery`
- `timestamp`
- `receivedAt`
- `ageSec`

`ageSec` is seconds since the last GPS update.

## `driving_route`

Computes real driving routes: distance, traffic-aware ETA, the major roads the
route follows (`via`), and the towns it passes through (`passesThrough`).
HERE Router v8 is the primary engine (live traffic); the public OSRM server is
the fallback when HERE is unavailable (no traffic, rural ETAs run 20-50% high —
the result carries a `warning` and `source: "osrm"` in that case).

Use this for:
- route planning
- drive-time estimates
- overnight-stop planning
- comparing whether a waypoint is on-route or a detour
- grounding any "what's along the way" answer in the actual route path

Do not use this for walking distance or walking ETA. Use `walking_route`.

Input, single route:

```json
{
  "origin": "Yachats, OR",
  "destination": "San Mateo, CA"
}
```

Input, route comparison:

```json
{
  "routes": [
    {
      "label": "direct via CA-505",
      "origin": "Yachats, OR",
      "destination": "San Mateo, CA",
      "waypoints": ["Dunnigan, CA", "Vacaville, CA"]
    },
    {
      "label": "via Sacramento",
      "origin": "Yachats, OR",
      "destination": "San Mateo, CA",
      "waypoints": ["Sacramento, CA"]
    }
  ]
}
```

Optional fields:
- `origin` as a place, address, `lat,lon`, or `current location`
- `destination`
- `waypoints`
- `routes` for 2-6 options in one call

Typical output fields:
- `distanceMiles`
- `durationHours` — includes current traffic (HERE) ; free-flow baseline in `baseDurationHours`
- `durationText`
- `via` — major roads in route order with miles (e.g. `I-5: 304`)
- `passesThrough` — towns along the route, in order
- `source` — `here` or `osrm` (fallback; check `warning`)
- `resolvedPoints`
- `googleMapsUrl`
- `fastest`

Notes:
- Coordinates are resolved by the tool; agent input should use normal `lat,lon` or place names.
- Do not claim a route, ETA, detour, or "on the way" conclusion unless `driving_route` output supports it.
- Only name towns/stops/landmarks as "on the route" if they appear in `via`/`passesThrough` or in `find_diesel` output. For any other place, run a route comparison (direct vs via-that-place) and report the added time.
- `durationHours` already includes traffic — never add a traffic multiplier on top. Add time only for planned stops.
- If current location matters, call `location_read` first or use `origin: "current location"` and report stale-location warnings.

## `walking_route`

Computes real walking routes for walking distance and walking ETA. HERE Router
v8 pedestrian routing is primary. When HERE is unavailable, the fallback uses
OSRM foot routed distance and estimates walking time at 3 mph; the result
carries a warning because sidewalk quality and personal safety are not verified.

Use this for:
- walking-distance questions
- walking ETA
- checking whether a route is reasonable on foot
- walk-safety questions, paired with separate local safety evidence

Input shape matches `driving_route`:

```json
{
  "origin": "current location",
  "destination": "Arena Pepe Cisneros, Oaxaca"
}
```

Typical output fields:
- `routeMode` — `walking`
- `routes[].mode` — `walking`
- `distanceMiles`
- `durationHours`
- `durationText`
- `durationBasis`
- `source` — `here` or `osrm`
- `resolvedPoints`
- `googleMapsUrl`
- `warning` when fallback or safety caveats apply

Notes:
- If the user says "from here" or "from my hotel" and GPS is fresh, prefer
  `origin: "current location"` over geocoding a remembered street address.
- Read `resolvedPoints` before stating distance. If the origin or destination
  resolved to the wrong place, say the walking route could not be verified.
- Do not claim a route is safe merely because `walking_route` returned a path.

## `find_diesel`

Finds fuel stations and prices — along a route, near a place, or near the
current GPS location.

Input, route mode (diesel along GPS→destination):

```json
{
  "destination": "Salt Lake City, UT",
  "top": 5
}
```

Input, near a place or specific station (all fuel grades):

```json
{
  "destination": "Costco, Medford, OR",
  "near": true
}
```

Input, near current GPS position:

```json
{
  "near": true
}
```

Optional fields:
- `destination` — address, place/POI name, or `lat,lon`; omit for current GPS
- `near`
- `from`
- `top`
- `source` as `here` or `gasbuddy`

Typical output fields:
- `name`
- `address`
- `dieselPrice`
- `prices` (near modes — regular/midgrade/premium/diesel when available)
- `detourMiles` (route mode) / `distanceMiles` (near modes)
- `googleMapsLink`
- `source`, `sourcesTried`

Notes:
- Route mode is diesel-specific; near modes return all fuel grades.
- Geocoding chain: Nominatim → HERE Discover (GPS-anchored POI search) →
  HERE Geocode, so station names like "Costco, Medford, OR" resolve even when
  the postal city differs (that Costco is in Central Point).
- Sources fall back automatically: HERE first, then GasBuddy if HERE returns
  no priced stations.
- It can use the current location file in `data/location/latest.json`.
- Route-planning guidance lives in `agents/skills/travel-routing.md`.
