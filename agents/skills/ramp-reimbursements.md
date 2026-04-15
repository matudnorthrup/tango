# ramp_reimbursements

Watson workflow for submitting Ramp reimbursements with either Gmail-hosted invoice evidence or Walmart delivery-tip evidence, and recording the result when a receipt note exists.

## When to use

Use this when the user wants reimbursement submissions prepared or filed in Ramp and the task requires gathering evidence and submitting a real reimbursement request.

## Core policy

- For Walmart delivery reimbursements: reimbursable amount is the Walmart **driver tip only**
- For generic reimbursements: use the amount and merchant the user specified, plus the matching invoice or receipt evidence
- Reimbursement note / memo: use the exact memo text the user requested; otherwise fall back to the installation's reimbursement policy or profile-owned template
- Evidence must be a real invoice/receipt file or a real Walmart order-detail screenshot with an explicit visible date/order header so Ramp can verify it

## Tooling

- `receipt_registry`
  - `list_walmart_delivery_candidates` to find cataloged Walmart receipts with delivery tips and no reimbursement recorded yet
    - this should verify against live Ramp history before treating anything as still pending unless you intentionally opt out
  - `reconcile_walmart_reimbursements` to repair stale Walmart note status fields from live Ramp submission history
  - `upsert_walmart_reimbursement` to record submission status back into the receipt note
- `gog_email`
  - `gmail search` or `gmail messages search` to find the matching invoice/receipt email
  - `gmail get <messageId> --format full` to inspect the selected message and its attachment metadata
  - `gmail attachment <messageId> <attachmentId> --out /tmp --name <filename>` to download the invoice/receipt to an absolute local path for Ramp upload
- `ramp_reimbursement`
  - `capture_walmart_tip_evidence` to grab the correct archived Walmart order-detail screenshot with driver tip and date/order context
  - `capture_email_reimbursement_evidence` to turn a raw Gmail message body into an uploadable screenshot evidence file only when the receipt lives in the email body instead of an attachment
  - `submit_ramp_reimbursement` to create and submit a Ramp reimbursement draft with the chosen evidence file, amount, merchant, and memo
    - accepts PDF attachments directly; do not down-convert attached PDFs into screenshots
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
4. For every submission:
   - use `ramp_reimbursement submit_ramp_reimbursement`
   - use Ramp transaction dates in `MM/DD/YYYY` format
   - use the exact memo text the user asked for when one is provided
   - do not use generic `browser` actions in the normal submission path
5. After successful Walmart submission, the Ramp tool should update the receipt note automatically.
   - Use `receipt_registry upsert_walmart_reimbursement` only for repairs or manual correction.
   - If a receipt replacement or submission fails, do not overwrite the note’s evidence path or report id with speculative values.

## Reimbursement tracking

Record the result in the note's `## Reimbursement Tracking` section with:

- status
- system
- reimbursable item
- amount
- submitted date
- note
- evidence path
- Ramp report id if available

## Safety

- If Ramp or Walmart is logged out, pause and let the user authenticate in the managed Brave profile.
- If the evidence lives in email and no matching message or attachment can be found, stop and report exactly what was missing instead of guessing.
- If the screenshot or Ramp submission is ambiguous, stop and report the specific blocker instead of guessing.
- Do not mark a note `submitted` unless the Ramp submission actually completed.
- Do not treat a Ramp sign-in page or missing-auth redirect as an upload-control failure.
- If a submitted reimbursement has bad or missing evidence, use `ramp_reimbursement replace_ramp_reimbursement_receipt` on the existing review URL instead of filing a duplicate reimbursement.
