#!/usr/bin/env node
/**
 * find-diesel.js — Diesel fuel finder for road trips
 *
 * Finds the best-value diesel stations along a route from your current GPS
 * location to a destination. Scores by price × detour factor.
 *
 * Usage:
 *   node find-diesel.js "Salt Lake City, UT"
 *   node find-diesel.js 40.7608,-111.8910 --pretty
 *   node find-diesel.js --help
 *
 * Env vars:
 *   HERE_API_KEY         — HERE Fuel Prices API key (required for HERE source)
 *   TANGO_LOCATION_FILE  — Path to OwnTracks latest.json
 *                          (default: <repo-root>/data/location/latest.json)
 *
 * Data Sources (in priority order):
 *   1. HERE Fuel Prices API (if HERE_API_KEY is set)
 *   2. GasBuddy GraphQL (fallback, no API key needed)
 *
 * Dependencies: @mapbox/polyline, geolib (native fetch, Node 18+)
 */

const fs = require('fs');
const path = require('path');
const polyline = require('@mapbox/polyline');
const geolib = require('geolib');

// ── Config ──────────────────────────────────────────────────────────────────
const LOCATION_FILE = process.env.TANGO_LOCATION_FILE
  || path.join(__dirname, '../data/location/latest.json');
const CORRIDOR_WIDTH = 5000; // meters from route centerline
const MAX_CORRIDOR_POINTS = 50;
const TOP_N = 5;
const GASBUDDY_GRAPHQL_URL = 'https://www.gasbuddy.com/graphql';
const GASBUDDY_STATION_URL = 'https://www.gasbuddy.com/station/90477';
const WAYPOINT_INTERVAL_MILES = 50;
const GASBUDDY_DELAY_MS = 800;

// ── CLI parsing ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const positional = args.filter(a => !a.startsWith('--'));

if (flags.has('--help') || positional.length === 0) {
  console.log(`
find-diesel — Find best-value diesel stations along your route

Usage:
  node find-diesel.js <destination> [options]

  <destination>   Address string or lat,lon pair
                  Examples: "Portland, OR"  or  44.9778,-93.2650

Options:
  --pretty        Human-readable output instead of JSON
  --near          Search radius around destination (no routing, ignores GPS)
  --from=PLACE    Override start location (e.g. --from="Tonopah, NV")
  --width=METERS  Corridor width in meters (default: ${CORRIDOR_WIDTH})
  --top=N         Number of results (default: ${TOP_N})
  --source=SOURCE Force data source: "gasbuddy" or "here" (default: auto)
  --help          Show this help

Environment:
  HERE_API_KEY         HERE API key (required for HERE source)
  TANGO_LOCATION_FILE  Path to OwnTracks latest.json
`);
  process.exit(0);
}

const destination = positional.join(' ');
const pretty = flags.has('--pretty');
const corridorWidth = parseInt([...flags].find(f => f.startsWith('--width='))?.split('=')[1]) || CORRIDOR_WIDTH;
const topN = parseInt([...flags].find(f => f.startsWith('--top='))?.split('=')[1]) || TOP_N;
const forceSource = [...flags].find(f => f.startsWith('--source='))?.split('=')[1] || null;
const nearMode = flags.has('--near');
const fromOverride = [...flags].find(f => f.startsWith('--from='))?.split('=').slice(1).join('=') || null;

// ── Helpers ─────────────────────────────────────────────────────────────────

function getApiKey() {
  return process.env.HERE_API_KEY?.trim() || null;
}

function getCurrentPosition() {
  try {
    const data = JSON.parse(fs.readFileSync(LOCATION_FILE, 'utf-8'));
    if (!data.lat || !data.lon) throw new Error('Missing lat/lon');
    const ageSec = (Date.now() / 1000) - data.timestamp;
    return { lat: data.lat, lon: data.lon, ageSec };
  } catch (err) {
    throw new Error(`Cannot read GPS location from ${LOCATION_FILE}: ${err.message}`);
  }
}

async function parseDestination(dest) {
  const match = dest.match(/^(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)$/);
  if (match) return { lat: parseFloat(match[1]), lon: parseFloat(match[2]) };
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(dest)}&format=json&limit=1`;
  const res = await fetch(url, { headers: { 'User-Agent': 'find-diesel/1.0' } });
  const results = await res.json();
  if (!results.length) throw new Error(`Could not geocode destination: "${dest}"`);
  return { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon) };
}

async function getRoute(from, to) {
  const url = `https://router.project-osrm.org/route/v1/driving/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=polyline`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.code !== 'Ok' || !data.routes?.length) {
    throw new Error(`OSRM routing failed: ${data.code || 'no route'}`);
  }
  const route = data.routes[0];
  const coords = polyline.decode(route.geometry);
  return { coords, distanceM: route.distance, durationS: route.duration };
}

function downsample(coords, maxPoints) {
  if (coords.length <= maxPoints) return coords;
  const step = (coords.length - 1) / (maxPoints - 1);
  const result = [];
  for (let i = 0; i < maxPoints; i++) result.push(coords[Math.round(i * step)]);
  return result;
}

function distanceFromRoute(stationLat, stationLon, routeCoords) {
  let minDist = Infinity;
  const point = { latitude: stationLat, longitude: stationLon };
  const step = Math.max(1, Math.floor(routeCoords.length / 500));
  for (let i = 0; i < routeCoords.length; i += step) {
    const d = geolib.getDistance(point, { latitude: routeCoords[i][0], longitude: routeCoords[i][1] });
    if (d < minDist) minDist = d;
  }
  return minDist;
}

function scoreStation(price, detourMeters) {
  return price * (1 + (detourMeters / 1000) * 0.1);
}

function mapsLink(lat, lon) {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sampleWaypoints(routeCoords, intervalMiles) {
  const intervalM = intervalMiles * 1609.34;
  const waypoints = [routeCoords[0]];
  let accumulated = 0;
  for (let i = 1; i < routeCoords.length; i++) {
    const d = geolib.getDistance(
      { latitude: routeCoords[i - 1][0], longitude: routeCoords[i - 1][1] },
      { latitude: routeCoords[i][0], longitude: routeCoords[i][1] },
    );
    accumulated += d;
    if (accumulated >= intervalM) { waypoints.push(routeCoords[i]); accumulated = 0; }
  }
  const last = routeCoords[routeCoords.length - 1];
  const lastWP = waypoints[waypoints.length - 1];
  if (last[0] !== lastWP[0] || last[1] !== lastWP[1]) waypoints.push(last);
  return waypoints;
}

// ── GasBuddy ─────────────────────────────────────────────────────────────────

const GASBUDDY_HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  'Origin': 'https://www.gasbuddy.com',
  'Referer': 'https://www.gasbuddy.com/home',
  'apollo-require-preflight': 'true',
};

const GASBUDDY_QUERY = `query LocationBySearchTerm($brandId: Int, $cursor: String, $fuel: Int, $lat: Float, $lng: Float, $maxAge: Int, $search: String) {
  locationBySearchTerm(lat: $lat, lng: $lng, search: $search) {
    stations(brandId: $brandId cursor: $cursor fuel: $fuel lat: $lat lng: $lng maxAge: $maxAge) {
      results {
        id name
        address { line1 locality region postalCode country }
        latitude longitude
        prices { fuelProduct longName credit { price postedTime } cash { price postedTime } }
      }
    }
  }
}`;

async function getGasBuddyAuth() {
  const res = await fetch(GASBUDDY_STATION_URL, { headers: { 'User-Agent': GASBUDDY_HEADERS['User-Agent'] } });
  if (!res.ok) throw new Error(`Failed to fetch GasBuddy station page: ${res.status}`);
  const html = await res.text();
  const csrfMatch = html.match(/window\.gbcsrf\s*=\s*"([^"]+)"/);
  if (!csrfMatch) throw new Error('Could not extract GasBuddy CSRF token');
  const cookies = (res.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
  return { csrf: csrfMatch[1], cookies };
}

async function queryGasBuddyNear(lat, lng, auth) {
  const res = await fetch(GASBUDDY_GRAPHQL_URL, {
    method: 'POST',
    headers: { ...GASBUDDY_HEADERS, 'gbcsrf': auth.csrf, 'Cookie': auth.cookies },
    body: JSON.stringify({
      operationName: 'LocationBySearchTerm',
      variables: { fuel: 4, maxAge: 0, lat, lng },
      query: GASBUDDY_QUERY,
    }),
  });
  if (!res.ok) throw new Error(`GasBuddy GraphQL ${res.status}`);
  const data = await res.json();
  if (data.errors) throw new Error(`GasBuddy errors: ${JSON.stringify(data.errors).slice(0, 200)}`);
  return data.data?.locationBySearchTerm?.stations?.results || [];
}

async function queryGasBuddyAlongRoute(routeCoords) {
  if (pretty) process.stderr.write('🔑 Getting GasBuddy auth token...\n');
  const auth = await getGasBuddyAuth();
  const waypoints = sampleWaypoints(routeCoords, WAYPOINT_INTERVAL_MILES);
  if (pretty) process.stderr.write(`📍 Querying ${waypoints.length} waypoints...\n`);
  const stationMap = new Map();
  for (let i = 0; i < waypoints.length; i++) {
    const [lat, lng] = waypoints[i];
    try {
      const stations = await queryGasBuddyNear(lat, lng, auth);
      for (const s of stations) { if (!stationMap.has(s.id)) stationMap.set(s.id, s); }
      if (pretty) process.stderr.write(`  ✓ Waypoint ${i + 1}/${waypoints.length}\n`);
    } catch (err) {
      if (pretty) process.stderr.write(`  ✗ Waypoint ${i + 1}/${waypoints.length}: ${err.message}\n`);
    }
    if (i < waypoints.length - 1) await sleep(GASBUDDY_DELAY_MS);
  }
  const allStations = [];
  for (const s of stationMap.values()) {
    const dieselPrice = s.prices?.find(p => p.fuelProduct === 'diesel');
    const price = dieselPrice?.credit?.price || dieselPrice?.cash?.price;
    if (!price || price <= 0 || !s.latitude || !s.longitude) continue;
    const addr = s.address || {};
    allStations.push({
      name: s.name || 'Unknown Station',
      address: [addr.line1, addr.locality, addr.region, addr.postalCode].filter(Boolean).join(', '),
      lat: s.latitude, lon: s.longitude, dieselPrice: price,
    });
  }
  return allStations;
}

// ── HERE Fuel Prices v3 ───────────────────────────────────────────────────────

async function queryHereFuelAlongRoute(routeCoords, apiKey, width) {
  const waypoints = sampleWaypoints(routeCoords, WAYPOINT_INTERVAL_MILES);
  const seen = new Set();
  const allStations = [];
  for (let i = 0; i < waypoints.length; i++) {
    const [lat, lon] = waypoints[i];
    const url = `https://fuel.hereapi.com/v3/stations?in=circle:${lat},${lon};r=${width}&apiKey=${apiKey}`;
    try {
      const res = await fetch(url);
      if (!res.ok) { if (pretty) process.stderr.write(`  ⚠ Waypoint ${i + 1}: HTTP ${res.status}\n`); continue; }
      const data = await res.json();
      let count = 0;
      for (const s of (data.stations || [])) {
        if (seen.has(s.id)) continue;
        seen.add(s.id); allStations.push(s); count++;
      }
      if (pretty) process.stderr.write(`  ✓ Waypoint ${i + 1}/${waypoints.length}: ${count} stations\n`);
    } catch (err) {
      if (pretty) process.stderr.write(`  ✗ Waypoint ${i + 1}: ${err.message}\n`);
    }
    if (i < waypoints.length - 1) await sleep(300);
  }
  return allStations;
}

function getDieselPrice(station) {
  for (const p of (station.prices || [])) {
    if (p.fuelType === '4' || p.fuelType === 4) return p.price ?? null;
  }
  return null;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const apiKey = getApiKey();
  let source = forceSource || (apiKey ? 'here' : 'gasbuddy');
  if (source === 'here' && !apiKey) { console.error('❌ HERE source requested but HERE_API_KEY not set.'); process.exit(1); }
  if (pretty) process.stderr.write(`⛽ Using ${source === 'gasbuddy' ? 'GasBuddy' : 'HERE'} for fuel prices\n`);

  const dest = await parseDestination(destination);

  if (nearMode) {
    if (source !== 'here') { console.error('❌ --near requires HERE API'); process.exit(1); }
    const nearRadius = corridorWidth > 5000 ? corridorWidth : 16000;
    const url = `https://fuel.hereapi.com/v3/stations?in=circle:${dest.lat},${dest.lon};r=${nearRadius}&apiKey=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HERE API error: ${res.status}`);
    const data = await res.json();
    const scored = (data.stations || [])
      .map(s => {
        const lat = s.position?.lat; const lon = s.position?.lng;
        if (!lat || !lon) return null;
        const price = getDieselPrice(s);
        if (!price || price <= 0) return null;
        const distM = geolib.getDistance({ lat: dest.lat, longitude: dest.lon }, { lat, longitude: lon });
        return { name: s.name || s.brand || 'Unknown', address: s.address?.label || '', dieselPrice: Math.round(price * 1000) / 1000, detourMiles: Math.round(distM / 1609.34 * 10) / 10, score: price, lat, lon, googleMapsLink: mapsLink(lat, lon) };
      })
      .filter(Boolean).sort((a, b) => a.dieselPrice - b.dieselPrice).slice(0, topN);

    if (pretty) {
      console.log(`\n📍 Stations near ${destination}\n`);
      scored.forEach((s, i) => { console.log(`${i + 1}. ${s.name}\n   💰 $${s.dieselPrice.toFixed(3)}/gal  |  📏 ${s.detourMiles} mi away\n   📍 ${s.address}\n   🗺️  ${s.googleMapsLink}\n`); });
    } else {
      console.log(JSON.stringify({ mode: 'near', center: dest, source, stations: scored }));
    }
    return;
  }

  let pos;
  if (fromOverride) {
    pos = await parseDestination(fromOverride); pos.ageSec = 0;
  } else {
    pos = getCurrentPosition();
    if (pos.ageSec > 3600) console.error(`⚠️  GPS data is ${Math.round(pos.ageSec / 60)} minutes old`);
  }

  const route = await getRoute(pos, dest);
  const routeMiles = (route.distanceM / 1609.34).toFixed(1);
  const routeHours = (route.durationS / 3600).toFixed(1);

  let scored = [];
  if (source === 'gasbuddy') {
    const stations = await queryGasBuddyAlongRoute(route.coords);
    if (pretty) process.stderr.write(`🔍 Found ${stations.length} diesel stations\n`);
    scored = stations.map(s => {
      const detourM = distanceFromRoute(s.lat, s.lon, route.coords);
      return { name: s.name, address: s.address, dieselPrice: Math.round(s.dieselPrice * 1000) / 1000, detourMiles: Math.round(detourM / 1609.34 * 10) / 10, detourMeters: Math.round(detourM), score: Math.round(scoreStation(s.dieselPrice, detourM) * 1000) / 1000, lat: s.lat, lon: s.lon, googleMapsLink: mapsLink(s.lat, s.lon) };
    }).sort((a, b) => a.score - b.score).slice(0, topN);
  } else {
    const stations = await queryHereFuelAlongRoute(route.coords, apiKey, corridorWidth);
    if (pretty) process.stderr.write(`🔍 Found ${stations.length} stations total\n`);
    scored = stations.map(s => {
      const lat = s.position?.lat; const lon = s.position?.lng;
      if (!lat || !lon) return null;
      const price = getDieselPrice(s);
      if (!price || price <= 0) return null;
      const detourM = distanceFromRoute(lat, lon, route.coords);
      return { name: s.name || s.brand || 'Unknown', address: s.address?.label || '', dieselPrice: Math.round(price * 1000) / 1000, detourMiles: Math.round(detourM / 1609.34 * 10) / 10, detourMeters: Math.round(detourM), score: Math.round(scoreStation(price, detourM) * 1000) / 1000, lat, lon, googleMapsLink: mapsLink(lat, lon) };
    }).filter(Boolean).sort((a, b) => a.score - b.score).slice(0, topN);
  }

  const output = { route: { from: { lat: pos.lat, lon: pos.lon }, to: { lat: dest.lat, lon: dest.lon }, miles: parseFloat(routeMiles), hours: parseFloat(routeHours) }, source, stations: scored };
  if (pretty) {
    console.log(`\n🛣️  Route: ${routeMiles} miles, ~${routeHours} hours\n`);
    if (!scored.length) { console.log('No diesel stations with pricing found along this route.'); }
    else scored.forEach((s, i) => { console.log(`${i + 1}. ${s.name}\n   💰 $${s.dieselPrice.toFixed(3)}/gal  |  🔀 ${s.detourMiles} mi off route\n   📍 ${s.address}\n   🗺️  ${s.googleMapsLink}\n`); });
  } else {
    console.log(JSON.stringify(output));
  }
}

main().catch(err => { console.error(`❌ ${err.message}`); process.exit(1); });
