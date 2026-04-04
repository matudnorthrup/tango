# osrm_routing

OSRM (Open Source Routing Machine) — free driving distance and duration API. No API key required.

## Why use this

**Never estimate driving distances from coordinates.** Lat/lon math gives straight-line distance which underestimates mountain and winding routes by 20-40%. Always use OSRM for actual road distances.

## API

### Point-to-point route
```
https://router.project-osrm.org/route/v1/driving/{from_lon},{from_lat};{to_lon},{to_lat}?overview=false
```

**Parameter order is `lon,lat`** (not lat,lon).

### Response
```json
{
  "routes": [{
    "distance": 142350.5,
    "duration": 5823.2
  }]
}
```
- `distance` — meters (divide by 1609.34 for miles)
- `duration` — seconds (divide by 3600 for hours)

### Multi-waypoint route
Chain coordinates with semicolons:
```
https://router.project-osrm.org/route/v1/driving/{lon1},{lat1};{lon2},{lat2};{lon3},{lat3}?overview=false
```
Returns total distance/duration for the full route through all waypoints in order.

## Usage rules

- Always use OSRM when reporting distances or ETAs — no exceptions.
- When comparing route options, run each through OSRM separately.
- Pair with `location_read` for current-position routing.
- For fuel range calculations, use OSRM distance (not estimates) against tank capacity.
