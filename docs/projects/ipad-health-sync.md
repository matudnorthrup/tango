# iPad Health Auto-Sync

**Status:** Implementation — building TCP pull script
**Owner:** PM (assigned 2026-04-28)
**Requested:** 2026-04-27
**Linear:** iPad Health Auto-Sync (TGO-413 through TGO-421)
**Approach:** Option B — Mac pulls from iPad TCP server (stakeholder direction 2026-04-28)

## Problem

Malibu's health data depends on manual syncing. The iPhone's HAE app runs in background but iOS suspends it, causing stale data. Devin has to manually open the app or run backfill scripts.

## Solution

Dedicated iPad running Health Auto Export as an always-on health data server. iPad stays plugged in and awake, providing reliable automated sync to the local MongoDB via REST push.

## Infrastructure

### iPad Health Server
- **Local IP:** 192.168.1.40
- **Tailscale IP:** 100.113.22.53
- **HAE TCP Server port:** 9000
- **Status:** TCP server confirmed reachable on both routes (2026-04-27)
- **Data status:** iCloud health data synced — iPad has data (confirmed 2026-04-28)

### Local Stack (Mac)
- **Mac Tailscale IP:** `100.87.221.107`
- **hae-server:** localhost:3001 (REST ingest at **`POST /api/data`**)
- **MongoDB:** localhost:27017 (database: `health-auto-export`)
- **Docker containers:** hae-mongo, hae-server (both running, 5+ days uptime)
- **Auth:** Pass-through (no authentication required)
- **hae-server source:** Inside Docker container at `/usr/src/server/`

### Data Format
HAE sends and hae-server accepts:
```json
{
  "data": {
    "metrics": [{ "name": "step_count", "units": "count", "data": [...] }],
    "workouts": [...]
  }
}
```
Ingest uses bulkWrite with upsert — safe for duplicates. 200mb payload limit configured.

## Discovery Findings (2026-04-28)

### Current Data State
- iPhone HAE is still syncing intermittently but unreliably
- Step count: ~9 hours stale (last: 04:02 UTC when checked at 13:04 UTC)
- Heart rate: ~1.5 hours stale (last: 11:42 UTC)
- Workouts: yesterday's workouts present (ingested at 03:20 UTC)
- MongoDB has 65+ collections with comprehensive health data

### Correct API Endpoint
The discovery doc originally stated `/api/ingest` — this is **wrong**. The actual endpoint is:
- **URL:** `POST /api/data`
- **Verified working** on both `localhost:3001` and `100.87.221.107:3001` (Tailscale)
- Routes: `/api/data` (POST, write), `/api/metrics` (GET, read), `/api/workouts` (GET, read)

### HAE REST Push (Option A — NOT USED)
Stakeholder directed Option B instead. Option A was viable but requires iPad app configuration.

### HAE TCP Server Protocol (Option B — ACTIVE, PROTOCOL DECODED)
The iPad HAE app runs a TCP server using **JSON-RPC 2.0** over raw TCP on port 9000.

**Protocol details:**
- One JSON-RPC request per TCP connection; server closes socket after response
- Method: `callTool` with `params.name` and `params.arguments`
- Date format: `yyyy-MM-dd HH:mm:ss Z` (e.g., "2026-04-28 00:00:00 -0700")

**Available tools:**
| Tool | Arguments | Purpose |
|------|-----------|---------|
| `health_metrics` | start, end, metrics?, interval?, aggregate? | All health data |
| `workouts` | start, end | Workout sessions |
| `symptoms` | start, end | Symptom logs |
| `state_of_mind` | start, end | Mood data (iOS 18+) |
| `medications` | start, end | Medication dosages |
| `cycle_tracking` | start, end | Menstrual cycle |
| `ecg` | start, end | ECG recordings |
| `heart_notifications` | start, end | Heart alerts |

**Example request:**
```bash
echo -n '{"jsonrpc":"2.0","id":"1","method":"callTool","params":{"name":"health_metrics","arguments":{"start":"2026-04-28 00:00:00 -0700","end":"2026-04-28 23:59:59 -0700","interval":"hours","aggregate":false}}}' | nc -w 10 100.113.22.53 9000
```

**Key finding:** The TCP response format (`result.data.metrics[]`) matches exactly what the hae-server `POST /api/data` endpoint expects. No data transformation needed — just extract `result.data` and POST it.

**Verified working:** Got step_count, heart_rate, workouts, and 16+ metric types from the iPad on 2026-04-28.

## Architecture (Option B — TCP Pull)

```
iPad (HAE app, TCP server :9000)
    ↕ JSON-RPC 2.0 over TCP
Mac (health-tcp-pull.sh, runs on cron)
    ↓ POST /api/data
hae-server (localhost:3001)
    ↓ bulkWrite upsert
MongoDB (health-auto-export)
    ↑ read queries
Malibu (MCP wellness tools)
```

No iPad app configuration needed — the TCP server runs automatically when HAE is open on iPad.

## Implementation Plan

1. ~~Infrastructure audit~~ ✅ (TGO-413)
2. ~~Document HAE config steps~~ ✅ (TGO-414) — Option A docs, superseded by Option B
3. ~~Health data freshness check script~~ ✅ (TGO-415)
4. ~~Update Malibu knowledge.md~~ ✅ (TGO-416)
5. ~~Reverse-engineer TCP protocol~~ ✅ (TGO-420) — JSON-RPC 2.0, fully decoded
6. ~~Build TCP pull script~~ ✅ (TGO-421) — `health-tcp-pull.sh`, verified working
7. ~~Deploy as launchd job~~ ✅ (TGO-417) — `com.tango.health-tcp-pull.plist`, every 15 min, 2h lookback
8. Live test with Malibu (TGO-418) — NEXT
9. Ship — docs + report (TGO-419)

## Deployed Services

### Launchd: com.tango.health-tcp-pull
- **Plist:** `~/Library/LaunchAgents/com.tango.health-tcp-pull.plist`
- **Runs:** Every 15 minutes (900s interval)
- **Command:** `health-tcp-pull.sh --hours 2`
- **Logs:** `~/clawd/skills/health-data/logs/health-tcp-pull.log`
- **First run:** 2026-04-28 06:44 PDT — 9 metrics, 318 records, HTTP 200

## Key Files

| File | Purpose |
|---|---|
| `packages/discord/src/mcp-wellness-server.ts` | MCP server exposing health tools |
| `packages/discord/src/wellness-direct-step-executor.ts` | Health query execution (~1700 lines) |
| `~/clawd/skills/health-data/scripts/health-query.js` | CLI health query tool (reads MongoDB) |
| `~/clawd/skills/health-data/references/collections.md` | MongoDB schema reference |
| `config/defaults/schedules/health-daily-reset.yaml` | Midnight daily reset job |
| `agents/assistants/malibu/knowledge.md` | Malibu domain knowledge (update when done) |
