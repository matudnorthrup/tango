# Health Sync Chunked Pull

**Status:** Shipped (2026-04-28)
**Linear:** TGO-427 through TGO-433

## Problem

The `health-tcp-pull.sh` script pulled health data every 15 min with a fixed 2-hour lookback window. Any gap (restart, network issue, TCP timeout) caused permanent data loss. The iPad TCP server times out on windows >2 hours for metrics, preventing a simple window increase.

## Solution

Rewrote the script to:

1. **Detect last sync timestamp** from MongoDB by querying the most recent metric data point across all non-workout collections
2. **Calculate gap** from last sync to now, capped at 24 hours
3. **Chunk metrics** into 2-hour windows pulled sequentially — each chunk is ingested independently
4. **Graceful fallback** — if MongoDB is unavailable or gap is non-positive, falls back to the original `--hours` window (default 2h)
5. **Manual override** — `--hours N` still works as a single-window pull, bypassing chunked mode

Workouts remain unchanged (always 24h lookback, single request).

## Key Changes

- `detect_last_sync_timestamp()` — queries MongoDB for latest metric timestamp (handles BSON Date objects)
- `build_metric_windows()` — Python helper that calculates 2-hour chunk windows
- `build_request()` and `query_tcp_tool()` now take explicit start/end params
- `write_ingest_payload()` — handles metrics-only or workouts-only payloads
- `post_ingest_payload()` — extracted ingest POST logic for per-chunk posting
- Main loop iterates metric chunks, POSTs each independently (ingest is idempotent)

## Key Files

- `~/clawd/skills/health-data/scripts/health-tcp-pull.sh` — the rewritten script
- `~/Library/LaunchAgents/com.tango.health-tcp-pull.plist` — launchd job (unchanged, still runs every 15 min with default args)

## Test Results

- `bash -n` syntax check: pass
- Dry-run with MongoDB detection: correctly detected last sync, planned 1 chunk for ~70-min gap
- Dry-run with `--hours 1` override: correctly used manual single-window mode
- Full live run: metrics ingested (HTTP 200, 2 metrics saved), workouts ingested (HTTP 200, 4 workouts saved)
- MongoDB fallback: when last sync unavailable, correctly falls back to 2h window

## Known Considerations

- The launchd plist still passes no `--hours` flag — this is correct, as the script now defaults to auto-chunked mode
- Collections excluded from last-sync detection: `workouts`, `workout_routes` (no date field), `daily_summary` (different date format)
- BSON Date objects are converted via `.toISOString()` in the mongosh query
