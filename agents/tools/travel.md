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

Finds diesel stations along a route using current GPS by default.

Input:

```json
{
  "destination": "Salt Lake City, UT",
  "top": 5
}
```

Optional fields:
- `near`
- `from`
- `top`
- `source` as `here` or `gasbuddy`

Typical output fields:
- `name`
- `address`
- `dieselPrice`
- `detourMiles`
- `googleMapsLink`

Notes:
- The tool is diesel-specific.
- It can use the current location file in `data/location/latest.json`.
- Route-planning guidance lives in `agents/skills/travel-routing.md`.
