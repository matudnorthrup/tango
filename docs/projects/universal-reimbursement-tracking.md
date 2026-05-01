# Project: Universal Reimbursement Tracking

**Date:** 2026-04-16
**Priority:** High
**Linear:** Universal Reimbursement Tracking (completed), Ramp Submission Automation Hardening (planned)
**Status:** Core system shipped. Ramp browser automation needs hardening before Watson can run submissions autonomously.

## Problem

Tango's receipt/reimbursement tracking was Walmart-only. Non-Walmart reimbursable expenses (Venmo payments, Maid in Newport, Factor meals) had no dedup check, no automated tracking state, and no default memo policy.

## What shipped (2026-04-16)

All 7 phases merged to main across 4 commits:

### Phase 1: Pre-flight Dedup Gate
- Hard dedup check in `submit_ramp_reimbursement` — calls `listRampReimbursementHistory` and blocks if `date::amount` matches
- `skip_dedup_check: true` for intentional overrides
- Standalone `check_submission_dedup` action on `receipt_registry`
- **Validated:** Confirmed blocking on matching date::amount, passing on new submissions

### Phase 2: Vendor Config + Default Memo
- `config/defaults/reimbursement-config.yaml` — categories map to memos, vendors map to categories
- `loadReimbursementConfig()`, `resolveDefaultMemo()`, `resolveVendorConfig()` in `receipt-universal-registry.ts`
- Submit handler resolves: vendor/merchant → category → memo automatically
- Memo field now optional — auto-fills from config, explicit memo overrides
- **Validated:** All candidates resolve "executive buy back time" from config

### Phase 3: Universal Receipt Record + Scanner
- `UniversalReceiptRecord` interface with vendor-specific parsers (Venmo, generic)
- `loadAllReceiptRecords()` walks all subdirs of `Records/Finance/Receipts/`
- `upsertReimbursementTracking()` — universal upsert for any note
- 1495 lines in `receipt-universal-registry.ts`
- **Validated:** 57 records across Amazon/Walmart/Venmo/Costco, vendorKeys resolve correctly

### Phase 4: Universal Tool Actions
- 6 new actions on `receipt_registry`: `list_reimbursement_candidates`, `reconcile_reimbursements`, `upsert_reimbursement`, `generate_monthly_ledger`, `detect_gaps`, `check_submission_dedup`
- Existing Walmart-specific actions preserved for backward compat
- **Validated:** Candidates list returns Venmo + Walmart together

### Phase 5: Gap Detection + Cataloger Extension
- `detectReimbursementGaps()` — missing tracking sections, stale submitted status, missing recurring receipts
- `buildReimbursementGapCandidates()` in `receipt-catalog-precheck.ts`
- RETAILER_PATTERN extended with `maid in newport|factor`
- Cataloger task template updated for non-Walmart receipt creation
- **Validated:** Found 6 real gaps (2 missing Venmo tracking, 1 Walmart, 3 Maid in Newport recurring)

### Phase 6: Skill Updates
- `ramp-reimbursements.md` — dedup gate policy, memo auto-resolution, universal actions documented, vendor param guidance
- `receipt-logging.md` — tracking section for all reimbursable vendors

### Ramp Browser Automation Fixes
- Timing fix: wait for draft form fields to render before filling (`waitFor visible`)
- Overlay fix: Ramp's receipt analysis overlay blocks form inputs; added trial click wait
- **Partially validated:** Fresh submissions succeed (April 10 Walmart $27.19 submitted with auto-resolved memo). Retries with stale state fail.

## What's broken — pick up in Ramp Submission Automation Hardening

**Linear project:** [Ramp Submission Automation Hardening](https://linear.app/latitudegames/project/ramp-submission-automation-hardening-fdcb472f6d94)

### 1. Stale browser state on retry
When `submitRampReimbursement` fails and Watson retries, the browser page is on a wrong URL (old draft, `/home`, or `/drafts`). The retry navigates to `/new` but `.catch(() => undefined)` swallows navigation failures. Evidence upload then happens on whatever page the browser is actually on, and `waitForURL(/draft/)` matches an old draft URL instead of creating a new one.

**Fix:** Before uploading evidence, verify the page is actually on `/new`. After `waitForURL`, verify the draft ID is new (not seen before in this session). Reset browser to a neutral page between retry attempts.

**File:** `browser-manager.ts` ~line 1952-1962

### 2. Ramp overlay blocking
After evidence upload, Ramp shows a processing overlay (`<div class="RyuPadRoot-...">`) while OCR-analyzing the receipt. Form inputs are visible in DOM but blocked by the overlay. `fill()` waits for the element to be actionable and times out after 30s.

Current fix (trial click wait on amount input) works for fresh drafts but not when navigating to an existing draft that's already been partially processed.

**Fix:** Wait for the overlay div to detach/hide: `page.locator('div[class*="RyuPadRoot"]').waitFor({ state: "hidden", timeout: 60_000 }).catch(() => {})` or wait for no intercepting elements on the form area.

**File:** `browser-manager.ts` ~line 1970-1972

### 3. No draft cleanup capability
Failed submission attempts create orphan Ramp drafts. No `delete_ramp_draft` action exists. Watson can't clean them up. 15 accumulated during testing on 2026-04-16 (manually deleted by Devin).

**Fix:** Add `delete_ramp_draft` action to `ramp_reimbursement` tool — navigate to draft URL, click overflow menu, click delete/discard.

### 4. Retry budget
Watson retries Ramp submissions indefinitely when they fail, creating more stale drafts each time. The channel work timeout (5 min) eventually kills the worker but by then multiple drafts are orphaned.

**Fix:** Add a retry counter to `submitRampReimbursement` — max 2 attempts, then throw a clear error for Watson to report.

### 5. Smoke test channel access
Watson's per-agent allowlist didn't include the smoke test parent channel. Fixed by adding `~/.tango/profiles/default/config/sessions/smoke-testing.yaml` with `discord:1488248022335881390`. This is a config-level fix, not a code fix.

## Live test results (2026-04-16)

| Test | Result |
|------|--------|
| Dedup gate (offline) | Pass — blocks matching date::amount |
| Memo auto-fill (offline) | Pass — all candidates resolve "executive buy back time" |
| Universal scan (offline) | Pass — 57 records, correct vendorKeys |
| Gap detection (offline) | Pass — 6 real gaps found |
| Walmart tip submission (live) | Pass — $27.19 submitted with auto-resolved memo, receipt note updated |
| Venmo submission (live) | Fail — Watson hit overlay timeout, fell back to old PNG flow instead of PDF |
| Maid in Newport submission (live) | Fail — Watson couldn't find invoice autonomously |
| Stale draft cleanup (live) | Fail — Watson couldn't navigate Ramp draft deletion UI |

Venmo and Maid in Newport were submitted manually by Devin after Watson failed.

## Key files

- `packages/discord/src/receipt-universal-registry.ts` — universal system (1495 lines): config loader, scanner, parsers, dedup, reconciliation, gap detection, ledger generation
- `packages/discord/src/personal-agent-tools.ts` — tool actions: 6 new universal actions + dedup gate on submit handler
- `packages/discord/src/browser-manager.ts` — Ramp browser automation: submitRampReimbursement with overlay/timing fixes
- `packages/discord/src/receipt-catalog-precheck.ts` — extended gap detection for cataloger
- `config/defaults/reimbursement-config.yaml` — vendor/category/memo config
- `agents/skills/ramp-reimbursements.md` — Watson skill with dedup + memo guidance
- `agents/skills/receipt-logging.md` — receipt template with universal tracking section
- `~/.tango/profiles/default/config/sessions/smoke-testing.yaml` — smoke test channel access

## Commits

1. `d529468` — Add universal reimbursement tracking: vendor config, multi-vendor scanner, and universal tool actions
2. `db7c652` — Add gap detection, extend cataloger, and update skill guidance for universal reimbursements
3. `34a3810` — Fix Ramp form timing: wait for draft fields to render before filling
4. `a9b1ef4` — Fix Ramp form overlay blocking: wait for receipt analysis to complete
