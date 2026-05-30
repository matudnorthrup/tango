# Finance Process Hardening Audit

**Date:** 2026-05-24
**Status:** Initial hardening fixes implemented; Foxtrot weekly review walkthrough live-tested
**Scope:** Foxtrot weekly/monthly finance review process, Obsidian finance runbook, scheduled jobs, receipt records, reimbursement tracking, and finance job logs.

## Summary

The finance workflow has the right high-level shape: Foxtrot owns the domain, scheduled jobs handle receipts/categorization/reviews, Obsidian stores rules and records, and the daily brief is intended to surface only exceptions.

The biggest hardening gap is not data capture itself. It is exception visibility. Jobs regularly produce "needs review" output, but the deterministic Finance job log appends `No flagged items.` to every entry and truncates summaries. That makes the morning brief and weekly review record unreliable as control surfaces.

## What Was Inspected

- `References/Finance/Financial Process Runbook.md`
- `References/Finance/Budget Targets.md`
- `References/Finance/Lunch Money Rules.md`
- `References/Finance/Reimbursement Tracking Process.md`
- `References/Finance/Sinking Fund Budget System.md`
- `Records/Jobs/Finance/2026-05.md`
- `Records/Finance/Receipts/` receipt notes and reimbursement metadata
- `config/defaults/schedules/*finance*`, `receipt-cataloger`, and sinking fund schedules
- Foxtrot config and assistant docs
- Scheduler executor/logging code
- Receipt catalog precheck and reimbursement registry code

## Findings

### 1. Finance exceptions are hidden by the job log writer

`packages/core/src/scheduler/executor.ts` appends a fixed `No flagged items.` line for every configured Obsidian job log entry. It does not parse the job summary for `Flagged`, `Needs review`, `Need your input`, `held`, failures, missing budgets, or other exception markers.

Observed in `Records/Jobs/Finance/2026-05.md`: multiple Nightly Transaction Categorizer runs contain "Needs your review" or "Need your input" sections, but the entry still ends with `No flagged items.`

Impact:
- The daily brief can report a clean night while finance work is blocked.
- Weekly review Step 0 cannot reliably identify unresolved items from logs.
- Foxtrot does not get a durable feedback loop from user decisions.

Recommended fix:
- Replace the fixed line with a structured log format:
  - `**Flagged:**` block extracted from the summary when exception markers exist.
  - `No flagged items.` only when no exception markers are found.
  - `**Needs Review:**` and `**Pending Decisions:**` as first-class sections for finance jobs.
- Stop truncating finance summaries to 500 characters before flag extraction.

### 2. Weekly finance review ignores the canonical Budget Targets fallback

The runbook says weekly review compares Lunch Money category totals against `[[Budget Targets]]`. The schedule and skill fetch Lunch Money budgets only. The latest weekly run reported that most Lunch Money budgets are `null`, so threshold checks could not run even though `References/Finance/Budget Targets.md` has targets.

Impact:
- Budget review is currently weaker than the documented process.
- "No budgets configured" becomes a recurring warning instead of an actionable comparison.

Recommended fix:
- Make `Budget Targets.md` the fallback source when Lunch Money budget fields are null.
- Report both: Lunch Money budget status and target-doc variance.
- Add a job warning if Lunch Money and `Budget Targets.md` diverge.

### 3. Sinking fund docs overstate automation

The runbook says Sinking Fund Reconciliation "submits Ramp drafts." The actual sinking fund skill explicitly uses only Obsidian and Lunch Money and outputs recommended transfers. The schedule has no Ramp intent and no `obsidian_log` config.

Impact:
- The process implies drafts are created when the system only recommends transfers.
- Weekly/monthly close records may miss sinking fund job health because these runs do not write Finance domain logs.

Recommended fix:
- Decide the intended behavior:
  - If recommendation-only, update the runbook and template wording.
  - If draft creation is desired, add an explicit reviewed/dry-run first implementation with Ramp safety gates.
- Add `obsidian_log` to sinking fund weekly and month-end schedules.

### 4. Review records are documented but not yet operationalized

The runbook now requires `Records/Finance/Reviews/`, but that directory did not exist during the audit. Weekly and monthly templates exist, but no review-note creation helper or Foxtrot command appears to enforce the record lifecycle.

Impact:
- The process depends on manual note creation.
- Decisions and corrections may stay in Discord/job logs rather than becoming training data for future runs.

Recommended fix:
- Add a Foxtrot command or deterministic helper to create the weekly/monthly review note from the template.
- Add a "decision capture" step that writes categorized choices and new rules back to the review note and, when appropriate, `Lunch Money Rules.md`.

### 5. Receipt and reimbursement schemas are inconsistent

The reimbursement process requires reimbursable receipt frontmatter (`reimbursable: true`, `ramp_submitted`, `ramp_report_id`, `merchant`, `amount`) and the Base view filters on `reimbursable == true`.

Observed counts:
- 133 receipt notes.
- 34 notes have `## Reimbursement Tracking`.
- Only 3 notes have `reimbursable: true`.
- 13 notes appear to be unsubmitted or have null Ramp metadata.
- Several notes still contain `Pending match in Lunch Money` or `uncategorized`.

Impact:
- The Base view is not a complete reimbursement control surface.
- Receipt notes can be valid enough for one tool but invisible to another.
- Foxtrot can hallucinate a pending Ramp queue if it falls back to Base rows,
  old review notes, or broad note search instead of structured registry checks.

Recommended fix:
- Define one canonical receipt schema and enforce it in `receipt_logging.md`, reimbursement docs, and registry upserts.
- Add a deterministic receipt audit that reports:
  - reimbursement section without reimbursable frontmatter
  - not-submitted items older than N days
  - pending Lunch Money matches
  - duplicate-looking receipt notes
- Treat `receipt_registry` plus live Ramp reconciliation as authoritative for
  reimbursement status. The Base view is QA/display only.

### 6. Candidate windows can let old unresolved work fall out

The receipt cataloger precheck scans the last 7 days and processes at most 3 retailer candidates per run. The categorizer precheck scans the last 48 hours for `uncleared` transactions.

Impact:
- A failed login, 2FA prompt, browser failure, or candidate backlog can let work age out of nightly processing.
- Weekly/monthly review depends on logs to find these holdovers, but flags are currently unreliable.

Recommended fix:
- Add weekly "aging backlog" audits:
  - uncleared/uncategorized transactions older than 48 hours
  - receipt candidates older than 7 days
  - receipt notes with pending Lunch Money links
  - reimbursement items older than 30 days

### 7. Status vocabulary is inconsistent

The runbook says `unreviewed = new, cleared = manually reviewed`. Current code and schedules use `status=uncleared`. Some skill text still references `unreviewed`. Logs mention `pending`, `uncleared`, `held`, and `cleared`.

Impact:
- Easy place for agent/tool drift.
- New hardening work may query the wrong status unless the canonical Lunch Money status model is documented in one place.

Recommended fix:
- Add a short "Lunch Money status model" section to the runbook and `transaction-categorization.md`.
- Update manual-test schedules and skill text to match the API terms actually in use.

## Recommended Hardening Backlog

1. **Structured Finance Job Logs**
   - Parse summary for flagged/needs-review sections before truncation.
   - Make `**Flagged:**` reliable for the daily brief.
   - Add tests against real example summaries from May logs.

2. **Read-Only Finance Health Audit**
   - New deterministic or scheduled audit that reads Lunch Money, receipt notes, reimbursement registry, and Finance logs.
   - Produces a single exception table with no writes.

3. **Budget Target Fallback**
   - Weekly finance review reads `Budget Targets.md` when Lunch Money budgets are null.
   - Report target variance and missing budget setup separately.

4. **Receipt/Reimbursement Schema Migration**
   - Backfill frontmatter for reimbursable notes.
   - Align receipt templates, receipt registry, and Base view expectations.
   - Add validation tests for new notes.

5. **Review Record Automation**
   - Create `Records/Finance/Reviews/` if missing.
   - Add Foxtrot-assisted weekly/monthly review note creation.
   - Append decisions during the review, not afterward.

6. **Safe Foxtrot Walkthrough Harness**
   - Add dry-run/manual-test schedules that do not mutate Lunch Money, Ramp, or receipt notes.
   - Capture transcript, tool calls, expected-vs-actual checklist, and deviations.
   - Only run mutating tests after dry-run validation passes.

## Monitoring Plan For A Foxtrot Walkthrough

Use a read-only walkthrough first:

1. Trigger/read the weekly review path and capture output.
2. Check Finance job log entry created for the run.
3. Verify whether flags are extractable by the daily brief parser.
4. Compare output against:
   - `Financial Process Runbook.md`
   - `Budget Targets.md`
   - `Lunch Money Rules.md`
   - receipt/reimbursement state
5. Record deviations in a review note and this project doc.

Do not use the existing manual-test receipt cataloger or categorizer as a safe dry-run. They are validation clones, but the task prompts still instruct the agent to update Lunch Money and Obsidian.

## Bottom Line

The current system is close, but the control loop is incomplete. The next hardening pass should prioritize reliable exception capture and read-only health auditing before adding more automation.

## Fixes Applied 2026-05-24

- Finance job logs now emit `**Flagged:**` when summaries contain review/exception signals instead of always writing `No flagged items.`
- Weekly finance review instructions now treat `References/Finance/Budget Targets.md` as the source of truth; Lunch Money budgets are optional diagnostics only.
- Sinking fund weekly/month-end schedules now write to the Finance domain log and explicitly do not create/manage Ramp drafts.
- The finance runbook now separates SB transfer/draw review from Latitude/Ramp reimbursements.
- Receipt registry `upsert_reimbursement` now repairs frontmatter (`reimbursable`, `ramp_submitted`, `ramp_report_id`, `merchant`, `amount`) when it writes a reimbursable tracking section.
- Receipt logging guidance now requires reimbursement frontmatter for Base view visibility.
- Created the missing Obsidian directory: `Records/Finance/Reviews/`.
- Weekly finance review runs are now idempotent: the review note is created with overwrite semantics so retries repair `Records/Finance/Reviews/YYYY-MM-DD Weekly Finance Review.md`.
- Weekly finance review timeout increased from 300s to 600s after live validation showed the full review could write the note but time out before returning the scheduler summary.
- Lunch Money status vocabulary was corrected in the transaction-categorization skill, default schedules, active profile schedules, and runbook: fetch `status=uncleared`, set `status=cleared`.
- Human correction from the 2026-05-24 review was captured: House SB ($700) and Recreation SB ($300) did post on May 17 in savings accounts, so weekly/sinking-fund guidance now requires savings-side transfer checks before flagging missing contributions.
- The HERE Europe B.V. charge was confirmed as a location/diesel lookup service under Software & Subscriptions, and the finance rules description was tightened.
- Follow-up API verification found the May 17 Ally transfers were initially unavailable through Lunch Money `/transactions`; relevant Ally accounts reported last import/fetch timestamps around May 15. Triggering `POST /plaid_accounts/fetch` for the stale Ally accounts refreshed the data and exposed the May 17 transfer rows. The process now requires account-freshness checks, API refresh for stale accounts, and `unverified` rather than `missing` if refreshed data remains stale.
- Corrected Lunch Money rows after refresh: House/Recreation checking-side contribution legs are categorized to their SB categories and cleared; savings-side mirror legs are categorized as `Transfer` and cleared.
- Replaced separate weekly/month-end review semantics with a unified `finance_review` workflow. Weekly review is now the `rolling` phase, month-end is `close_prep`, and final close is stricter exit criteria rather than a separate process.
- Disabled the standalone weekly sinking fund schedule because sinking fund contribution/draw review is now part of the rolling Finance Review.
- Added a manual dry-run Finance Review schedule that validates the unified workflow without Lunch Money category/status writes, Ramp actions, or canonical review-note overwrites.

## Fixes Applied 2026-05-25

- Hardened Finance Review reimbursement instructions: Foxtrot must use
  `receipt_registry` gap, ledger, candidate, and reconciliation actions before
  claiming Ramp/Latitude reimbursement status.
- Updated router guardrails so finance budget-review and sinking-fund review
  paths have read access to `receipt_registry` and explicit instructions not to
  infer reimbursement status from Base views, old review notes, or note search.
- Updated the active Foxtrot weekly/dry-run/close-prep schedules with the same
  reimbursement verification rule.
- Updated Obsidian reimbursement/runbook docs: `Latitude Reimbursements.base` is
  a human QA view; `receipt_registry` plus live Ramp reconciliation is the agent
  source of truth.
- Marked the reimbursement table in the 2026-05-24 dry-run review as
  unverified because it was created from receipt-note/Base fallback rather than
  registry/Ramp evidence.
- Ran read-only registry/Ramp verification for 2026-05-01 through 2026-05-25:
  universal configured-vendor gap detection returned 0 gaps; configured-vendor
  candidates show Maid in Newport Invoice 1738 ($350) pending; Walmart
  delivery-tip candidates show 2026-05-02 ($16.53 tip, missing tracking) and
  2026-05-09 order 2000146-30847351 ($28.90 tip, not submitted). The previously
  reported May 19 / May 10 Walmart reimbursement rows were not present in the
  verified May registry query.
- Split Ramp reimbursement automation into an explicit draft-first review gate:
  `prepare_ramp_reimbursement_draft` uploads evidence and fills the Ramp draft
  without final submission; `submit_reviewed_ramp_reimbursement` submits only
  after Devin explicitly approves and the expected amount, date, memo, and
  optional merchant checks pass. The old `submit_ramp_reimbursement` action is
  now documented as a deprecated draft-only alias.
- Added stale-review-note hardening after Foxtrot repeated resolved review
  items from historical notes. The May 24 review artifacts now have superseded
  notices, the May 25 working review record has a current-status guard and
  corrected reimbursement status, and Foxtrot/router guidance requires live
  Lunch Money + `receipt_registry`/Ramp verification before answering "what is
  left?" from a prior finance review.
- Corrected stale Lunch Money tool guidance that still suggested
  `status=unreviewed`; finance review and tool docs now require
  `status=uncleared` for the review inbox.
- Standardized finance review Obsidian metadata on broad `types: [[Record]]`
  plus explicit fields (`record_kind: finance_review`, `review_phase`,
  `dry_run`) instead of using narrow schema types such as `[[Financial Review]]`
  or missing generic types such as `[[Review]]`.

## Validation 2026-05-24

- `npm run test -w @tango/core -- test/config.test.ts test/scheduler-executor.test.ts`
- `npm run test -w @tango/discord -- test/receipt-universal-registry.test.ts test/receipt-catalog-precheck.test.ts`
- `npm run build -w @tango/core`
- `npm run build -w @tango/discord`
- `git diff --check`

Live validation:

- First trigger of `manual-test-weekly-finance-review` exposed stale active-profile overrides: the schedule still routed to Watson and timed out after 300s.
- Active profile schedule overrides under `~/.tango/profiles/default/config/schedules/` were repaired to route finance jobs to Foxtrot and use the updated finance prompts.
- Second trigger routed correctly to Foxtrot, loaded finance tools, read `References/Finance/Budget Targets.md`, queried Lunch Money by category ID, and created `Records/Finance/Reviews/2026-05-24 Weekly Finance Review.md`.
- The second trigger still hit the 300s V2 timeout after the Obsidian write, so the Discord/scheduler return path did not complete. The generated review content was materially useful and surfaced real flags: Gas & Charging over target, Insurance target outdated, missing House/Recreation SB contributions, ambiguous Vehicles SB contribution, and uncleared transaction backlog.
- After increasing the weekly review timeout to 600s and restarting the bot, a third trigger completed successfully in 195s. It returned through the scheduler, used `obsidian create ... --overwrite`, and updated `Records/Finance/Reviews/2026-05-24 Weekly Finance Review.md`.
- After unifying the workflow, `manual-test-weekly-finance-review` completed successfully in 274s as a dry-run rolling Finance Review. It fetched account freshness first, triggered only `POST /plaid_accounts/fetch` for stale Devin's Spending data, avoided Lunch Money category/status writes and Ramp actions, and wrote `Records/Finance/Reviews/2026-05-24 Finance Review Dry Run.md`.

Remaining validation:

- Production `weekly-finance-review` was not rerun because the scheduler correctly skipped it as already completed on 2026-05-24 at 07:05 PDT.
- Wait for the next Sunday run, or add a forced/manual log-writing test schedule, to confirm the production Finance job log captures the new `**Flagged:**` section for daily brief visibility. The parser has unit coverage, but the successful live run was the manual-test clone, which does not currently write an Obsidian job log.
