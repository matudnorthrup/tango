#!/usr/bin/env node
/**
 * OwnTracks Location Receiver
 *
 * Lightweight HTTP server that accepts OwnTracks location updates and saves
 * the latest position to a JSON file. Tango-native replacement for the
 * OpenClaw location server.
 *
 * OwnTracks config:
 *   Mode: HTTP
 *   URL:  http://<tailscale-ip>:3456/pub
 *   Auth: HTTP Basic (any username, password = OWNTRACKS_AUTH_TOKEN)
 *
 * Env vars:
 *   OWNTRACKS_AUTH_TOKEN  — Auth password (required)
 *   OWNTRACKS_PORT        — Listen port (default: 3456)
 *   TANGO_LOCATION_DIR    — Directory for latest.json + history.jsonl
 *                           (default: ~/.tango/profiles/default/data/location)
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = parseInt(process.env.OWNTRACKS_PORT || '3456', 10);
const AUTH_TOKEN = process.env.OWNTRACKS_AUTH_TOKEN || '';
const DATA_DIR = process.env.TANGO_LOCATION_DIR
  || path.join(os.homedir(), '.tango/profiles/default/data/location');
const LATEST_FILE = path.join(DATA_DIR, 'latest.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.jsonl');

if (!AUTH_TOKEN) {
  console.warn('[owntracks] OWNTRACKS_AUTH_TOKEN is not set — running without authentication.');
}

fs.mkdirSync(DATA_DIR, { recursive: true });

function checkAuth(req) {
  const auth = req.headers.authorization;
  if (!auth) return false;
  if (auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString();
    const password = decoded.split(':').slice(1).join(':');
    return password === AUTH_TOKEN;
  }
  if (auth.startsWith('Bearer ')) {
    return auth.slice(7) === AUTH_TOKEN;
  }
  return false;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url.startsWith('/pub')) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  if (AUTH_TOKEN && !checkAuth(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="OwnTracks"' });
    res.end('Unauthorized');
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    res.writeHead(400);
    res.end('Invalid JSON');
    return;
  }

  // Only process location events
  if (payload._type !== 'location') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('[]');
    return;
  }

  const record = {
    lat: payload.lat,
    lon: payload.lon,
    accuracy: payload.acc,
    altitude: payload.alt,
    velocity: payload.vel,
    heading: payload.cog,
    battery: payload.batt,
    timestamp: payload.tst,
    trigger: payload.t,
    connection: payload.conn,
    receivedAt: new Date().toISOString(),
    raw: payload,
  };

  try {
    fs.writeFileSync(LATEST_FILE, JSON.stringify(record, null, 2));
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(record) + '\n');
    console.log(`[owntracks] lat=${record.lat} lon=${record.lon} vel=${record.velocity} bat=${record.battery}%`);
  } catch (err) {
    console.error('[owntracks] Failed to write location:', err.message);
    res.writeHead(500);
    res.end('Write error');
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('[]');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[owntracks] Receiver listening on :${PORT}`);
  console.log(`[owntracks] Writing to ${DATA_DIR}`);
});

server.on('error', err => {
  console.error('[owntracks] Server error:', err.message);
  process.exit(1);
});
