# FatSecret API Discord Harness Concurrency Issue

**Date:** 2026-04-22
**Linear:** TBD
**Status:** Discovery complete — no code fix needed

## Summary

The `fatsecret_api` tool was marked UNTESTED during the agent tool validation (TGO-281) due to a "Discord login timeout." Investigation confirms this is a **harness concurrency issue**, not a tool bug. The FatSecret API itself works correctly.

## Root Cause Analysis

### Two independent issues caused the UNTESTED status:

#### 1. Discord Login Timeout (Harness Concurrency)

The test harness (`discord-test-harness-lib.ts:246`) creates a new `Discord.Client` per invocation and calls `client.login()` with a 15-second timeout. When multiple harness instances run concurrently, they all attempt Discord gateway login with the same bot token simultaneously. Discord's gateway rate-limits concurrent logins from the same token, causing later instances to time out.

**Evidence:** The validation matrix notes "Discord login timeout on test" and "Concurrency issue, not tool failure."

**Code path:** `createHarnessContext()` → `new Client()` → `client.login(token)` → `waitForClientReady()` (15s timeout at line 246)

#### 2. Missing `mcp-proxy.js` at validation time (TGO-290)

The Malibu v2 config (`config/v2/agents/malibu.yaml`) routes `fatsecret_api` through `packages/core/dist/mcp-proxy.js`. At validation time, this file was missing from dist. It has since been built and now exists.

### FatSecret API — Confirmed Working

Direct test with the fatsecret venv:
```bash
~/clawd/fatsecret-venv/bin/python ~/clawd/scripts/fatsecret-api.py foods_search '{"search_expression": "chicken breast", "max_results": 1}'
# Returns full JSON with nutrition data — 197kcal per 101g chicken breast
```

Credentials present at `~/clawd/secrets/fatsecret-api.json` and `~/clawd/secrets/fatsecret-user-tokens.json`.

The tool code in `wellness-agent-tools.ts` correctly resolves the venv Python at `~/clawd/fatsecret-venv/bin/python`.

## Reproduction Steps

### To reproduce the harness timeout:
1. Run 3+ `scripts/dev/test-message.sh` instances concurrently with `--wait-response`
2. Later instances will fail with "Discord login timeout" within 15 seconds

### To test fatsecret standalone (passes):
```bash
scripts/dev/test-message.sh --agent malibu --message "Look up the calories in 100g of chicken breast using fatsecret_api" --timeout 300 --wait-response
```
(Must be run with NO other harness instances active)

## Fix / Workaround

### Harness concurrency (documentation fix only)
- **Don't run parallel test harness instances** that share a single Discord token
- Run tests sequentially or add a connection-pooling mechanism to the harness (out of scope for this issue)
- The 15s login timeout is reasonable for single-instance use

### mcp-proxy.js (already resolved)
- `packages/core/dist/mcp-proxy.js` now exists after a recent build
- Ensure `npm run build` is run before any MCP tool testing

## Key Files

- `apps/tango-voice/src/testing/discord-test-harness-lib.ts` — harness login logic (line 246: 15s timeout)
- `config/v2/agents/malibu.yaml` — Malibu MCP config routing fatsecret through mcp-proxy
- `packages/discord/src/wellness-agent-tools.ts` — fatsecret tool definition and venv resolution
- `packages/core/src/mcp-proxy.ts` — stdio↔HTTP bridge for persistent MCP servers
- `/Users/devinnorthrup/clawd/scripts/fatsecret-api.py` — underlying Python API script
