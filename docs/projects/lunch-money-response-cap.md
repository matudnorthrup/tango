# Watson Lunch Money Thread Timeout — Response Cap

**Status:** Shipped
**Date:** 2026-04-24
**Linear:** TGO-345, TGO-346, TGO-347, TGO-348, TGO-349, TGO-350

## Problem

Watson timed out (120s) handling a Lunch Money query in channel 1481116631613706260. The `lunch_money` MCP tool returned 598,165 characters of transaction data — a `GET /transactions` call with no date filtering that dumped all historical transactions.

## Root Cause

The `lunch_money` tool in `packages/discord/src/personal-agent-tools.ts` was a raw passthrough to the Lunch Money REST API with no response size limits or default date range. Any unbounded query would return the full transaction history.

## Fix

Two safeguards added to the `lunch_money` tool handler:

1. **Default date range**: `GET /transactions` collection requests (not `/transactions/:id`) without `start_date`/`end_date` params now default to the last 14 days (originally 30, reduced in round 2).

2. **Response size cap**: Any response exceeding 15,000 characters is truncated and returned with a warning message suggesting more specific filters (originally 50K, reduced in round 2 because Watson makes ~4 calls per turn: 4 × 50K = 230K context caused timeouts).

## Key Files

- `packages/discord/src/personal-agent-tools.ts` — lunch_money tool handler (lines 500-560)

## Validation

- Code review: diff verified correct
- Build: `npm run build` passes
- Deploy: bot restarted cleanly with new code
- Live test: test harness messages not processable (bot ignores own messages); organic validation pending on next real user query

## Commits

- `bd478d6` — Add default date range (30d) and response size cap (50K) to lunch_money tool (TGO-349)
- `6868598` — Round 2: lower cap to 15K, date range to 14 days (TGO-350)
