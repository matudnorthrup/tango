# Travel Tools

Shared doc for `location_read` and `find_diesel`.

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
