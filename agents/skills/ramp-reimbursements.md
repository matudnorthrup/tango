# ramp_reimbursements

Watson workflow for preparing or submitting Ramp reimbursements with either Gmail-hosted invoice evidence or Walmart delivery-tip evidence, and recording the result when a receipt note exists.

## When to use

Use this when the user wants reimbursement drafts prepared for review or filed in Ramp and the task requires gathering evidence.

## Core policy

- For Walmart delivery reimbursements: reimbursable amount is the Walmart **driver tip only**
- For generic reimbursements: use the amount and merchant the user specified, plus the matching invoice or receipt evidence
- `receipt_registry` plus live Ramp reconciliation is the source of truth for pending/submitted/reimbursed status.
- Obsidian Base files, previous review notes, and broad note search are context only. Do not use them to claim that a reimbursement is pending, unsubmitted, submitted, or reimbursed.
- Default to preparing a draft for Devin to review. Only submit a reviewed draft when Devin explicitly says to submit.
- Interpret broad wording like "submit any pending or draft reimbursements" in two lanes:
  pending verified candidates get Ramp drafts prepared; already-prepared drafts
  may be submitted only after expected fields are verified.
- For batch reimbursement work, fail closed. If any candidate or draft has a
  missing receipt, field mismatch, duplicate risk, or unverifiable state, stop
  and report that issue before preparing or submitting more reimbursements.
- A hard dedup gate runs automatically before every Ramp draft preparation. If a matching date::amount exists in recent Ramp history, the draft is blocked. Use `skip_dedup_check: true` only for intentional re-submissions.
- The memo field auto-resolves from `reimbursement-config.yaml`. Prepare the draft without explicit memo and the correct default will be used (for example `Exec Buy Back Time` for all exec buy back vendors). Only provide an explicit memo to override.
- If the user explicitly requests a different memo, pass that exact memo as the override
- Evidence must be a real invoice/receipt file or a real Walmart order-detail screenshot with an explicit visible date/order header so Ramp can verify it

## Tooling

- `receipt_registry`
  - `list_reimbursement_candidates` to find pending receipts across all configured reimbursement vendors
    - use this first for any vendor reimbursement request before deciding whether you need the Walmart-only or Gmail-only branch
    - add `vendor` when the request is scoped to one merchant or reimbursement program
  - `reconcile_reimbursements` to verify configured reimbursement notes against live Ramp history and repair stale tracking blocks
  - `upsert_reimbursement` to create or repair the `## Reimbursement Tracking` block on any configured vendor receipt note
  - `generate_monthly_ledger` to build a month or date-range ledger grouped by vendor, category, and status
  - `detect_gaps` to find missing tracking blocks, stale submitted notes, recurring monthly gaps, and other coverage issues
  - `list_walmart_delivery_candidates` to find cataloged Walmart receipts with delivery tips and no reimbursement recorded yet
    - this should verify against live Ramp history before treating anything as still pending unless you intentionally opt out
  - `reconcile_walmart_reimbursements` to repair stale Walmart note status fields from live Ramp submission history
  - `upsert_walmart_reimbursement` to record submission status back into the receipt note
  - `vendor` param guidance:
    - `vendor` accepts the configured vendor key, receipt directory, or merchant alias from `reimbursement-config.yaml`
    - examples: `maid_in_newport`, `Venmo`, `Factor`
    - prefer passing `vendor` when you know it because that resolves the merchant and default memo consistently
- `gog_email`
  - `gmail search` or `gmail messages search` to find the matching invoice/receipt email
  - `gmail get <messageId> --format full` to inspect the selected message and its attachment metadata
  - `gmail attachment <messageId> <attachmentId> --out /tmp --name <filename>` to download the invoice/receipt to an absolute local path for Ramp upload
- `ramp_reimbursement`
  - `capture_walmart_tip_evidence` to grab the correct archived Walmart order-detail screenshot with driver tip and date/order context
  - `capture_email_reimbursement_evidence` to turn a raw Gmail message body into an uploadable screenshot evidence file only when the receipt lives in the email body instead of an attachment
  - `prepare_ramp_reimbursement_draft` to upload evidence and fill a Ramp reimbursement draft with the chosen amount, date, merchant, and memo, then stop before final submission
    - accepts PDF attachments directly; do not down-convert attached PDFs into screenshots
  - `submit_reviewed_ramp_reimbursement` to submit an already-prepared draft after Devin explicitly approves and the expected amount/date/memo/merchant checks pass
  - `submit_ramp_reimbursement` is a deprecated alias for `prepare_ramp_reimbursement_draft`; it does not click final Submit
  - `repair_ramp_reimbursement_draft` to repair an existing draft in place when Ramp OCR or a previous automation run created a draft with the wrong date, memo, merchant, or missing evidence
  - `replace_ramp_reimbursement_receipt` to repair a submitted reimbursement with better evidence if needed and capture a fresh Ramp confirmation screenshot
    - accepts PDF attachments directly
- `browser`
  - not part of the default submission path
  - only use it if the runtime explicitly reruns with broader tool access for debugging or backfill discovery
- `onepassword`
  - retrieve Walmart or Ramp credentials if a login page appears
- `obsidian`
  - only if you need to inspect the underlying receipt note directly

## Workflow

1. Decide which branch applies.
   - For any vendor reimbursement: use `receipt_registry list_reimbursement_candidates` to find pending receipts across all configured vendors.
     If status matters, reconcile with live Ramp history before reporting the item as pending or filing a new request.
   - Walmart delivery-tip reimbursement:
     use `receipt_registry list_walmart_delivery_candidates`
     and if Obsidian note status looks suspicious or the user questions the pending list, use `receipt_registry reconcile_walmart_reimbursements`
     and `receipt_registry backfill_walmart_delivery_candidates` if the catalog does not cover the requested history window.
   - Generic invoice or receipt in Gmail:
     use `gog_email` to search the specified account, inspect the matching message, and download the attachment to an absolute local path.
2. For Walmart candidates:
   - verify the driver tip matches the receipt note amount
   - use `ramp_reimbursement capture_walmart_tip_evidence`
   - use the driver tip as the reimbursement amount
3. For generic Gmail-backed reimbursements:
   - search the mailbox the user named, or the best inferred account if they named one
   - normalize known mailbox aliases before searching. For example, `matu.northrup` should resolve to `matu.dnorthrup@gmail.com`.
   - identify the matching message by merchant, amount, and approximate date
   - fetch the message details and attachment metadata
   - if there is a real attachment, download it with `gmail attachment ... --out /tmp --name ...`
   - if the attachment is a PDF, use that PDF directly as the Ramp evidence file
   - if there is no attachment but the email body itself is the receipt, feed the raw `gog gmail get --format full` output into `ramp_reimbursement capture_email_reimbursement_evidence` and use that generated screenshot as the evidence file
4. For every reimbursement draft:
   - use `ramp_reimbursement prepare_ramp_reimbursement_draft`
   - use Ramp transaction dates in `MM/DD/YYYY` format
   - let the tool resolve the configured default memo unless the user asked for a specific override
   - use `skip_dedup_check: true` only when intentionally re-submitting something that the automatic dedup gate would otherwise block
   - do not use generic `browser` actions in the normal submission path
   - if a draft already exists but has wrong or missing fields, use `ramp_reimbursement repair_ramp_reimbursement_draft` instead of creating another draft
5. Return the draft URL and a review checklist:
   - merchant
   - amount
   - transaction date
   - memo
   - evidence file/receipt preview
   - duplicate check result
6. If Devin explicitly says to submit the reviewed draft:
   - use `ramp_reimbursement submit_reviewed_ramp_reimbursement`
   - pass the draft URL plus expected amount, transaction date, memo, merchant, and `submission_confirmation: DEVIN_REVIEWED_AND_APPROVED_SUBMISSION`
   - do not submit if any check fails
   - if a batch includes multiple drafts, stop at the first mismatch or
     unverifiable draft and report before touching the rest
7. After successful Walmart draft preparation or submission, the Ramp tool should update the receipt note automatically.
   - Use `receipt_registry upsert_walmart_reimbursement` only for repairs or manual correction.
   - If a receipt replacement or submission fails, do not overwrite the note’s evidence path or report id with speculative values.
   - Only update reimbursement tracking after the Ramp tool returns success and every expected field was verified. If the Ramp action returns an error, or if amount/date/memo/merchant/evidence cannot be verified, fail closed and leave the receipt note unchanged.

## Reimbursement tracking

Record the result in the note's `## Reimbursement Tracking` section with:

- status
- system
- reimbursable item
- amount
- submitted date only after final Ramp submission; draft preparation must not create a submitted date
- note
- evidence path
- Ramp report id if available

## Safety

- If Ramp or Walmart is logged out, pause and let the user authenticate in the managed Brave profile.
- If the evidence lives in email and no matching message or attachment can be found, stop and report exactly what was missing instead of guessing.
- If the screenshot or Ramp submission is ambiguous, stop and report the specific blocker instead of guessing.
- If `receipt_registry` or live Ramp reconciliation cannot verify reimbursement state, call it unverified instead of inferring from Obsidian Base files, old review notes, or raw note search.
- Do not mark a note `submitted` unless the Ramp submission actually completed.
- Do not tell Devin a draft was submitted. Say `draft prepared` until `submit_reviewed_ramp_reimbursement` succeeds.
- Treat `submission_confirmation: DEVIN_REVIEWED_AND_APPROVED_SUBMISSION` as allowed only after Devin has explicitly approved final submission in the current reimbursement task.
- Do not treat a Ramp sign-in page or missing-auth redirect as an upload-control failure.
- If a submitted reimbursement has bad or missing evidence, use `ramp_reimbursement replace_ramp_reimbursement_receipt` on the existing review URL instead of filing a duplicate reimbursement.
- Never call `receipt_registry upsert_reimbursement` to mark a draft or submission after a failed Ramp action. Report the exact blocker and preserve the previous tracking state.
