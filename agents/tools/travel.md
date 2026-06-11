# Travel Tools

Shared doc for `location_read`, `osrm_route`, and `find_diesel`.

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

## `osrm_route`

Computes real driving distance and duration with OSRM.

Use this for:
- route planning
- drive-time estimates
- overnight-stop planning
- comparing whether a waypoint is on-route or a detour

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
- `durationHours`
- `durationText`
- `resolvedPoints`
- `googleMapsUrl`
- `fastest`

Notes:
- OSRM coordinates are resolved by the tool; agent input should use normal `lat,lon` or place names.
- Do not claim a route, ETA, detour, or "on the way" conclusion unless `osrm_route` output supports it.
- If current location matters, call `location_read` first or use `origin: "current location"` and report stale-location warnings.

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
