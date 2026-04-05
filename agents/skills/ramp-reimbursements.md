# ramp_reimbursements

Watson workflow for submitting Walmart delivery-tip reimbursements through Ramp and recording the result back into the receipt catalog.

## When to use

Use this when the user wants reimbursement submissions prepared or filed in Ramp for Walmart delivery orders where the driver tip is reimbursable.

## Core policy

- Reimbursable amount: the Walmart **driver tip only**
- Reimbursement note / memo: follow the installation's reimbursement policy or
  profile-owned template
- Evidence: archived screenshot of the Walmart order-detail area showing the driver tip plus an explicit visible date/order header so Ramp can verify it

## Tooling

- `receipt_registry`
  - `list_walmart_delivery_candidates` to find cataloged Walmart receipts with delivery tips and no reimbursement recorded yet
  - `upsert_walmart_reimbursement` to record submission status back into the receipt note
- `ramp_reimbursement`
  - `capture_walmart_tip_evidence` to grab the correct archived Walmart order-detail screenshot with driver tip and date/order context
  - `submit_ramp_reimbursement` to create and submit the Ramp reimbursement draft and return the archived evidence path plus Ramp confirmation screenshot path
  - `replace_ramp_reimbursement_receipt` to repair a submitted reimbursement with better evidence if needed and capture a fresh Ramp confirmation screenshot
- `browser`
  - not part of the default submission path
  - only use it if the runtime explicitly reruns with broader tool access for debugging or backfill discovery
- `onepassword`
  - retrieve Walmart or Ramp credentials if a login page appears
- `obsidian`
  - only if you need to inspect the underlying receipt note directly

## Workflow

1. Use `receipt_registry list_walmart_delivery_candidates`.
   - If the catalog clearly does not cover the requested history window, use `receipt_registry backfill_walmart_delivery_candidates` with an explicit date window before submitting reimbursements.
   - If the user pinned a specific order or note, resolve that exact receipt first instead of browsing general history.
2. Work oldest-first unless the user specifies another order.
3. For each candidate:
   - verify the driver tip matches the receipt note amount
   - use `ramp_reimbursement capture_walmart_tip_evidence`
   - use `ramp_reimbursement submit_ramp_reimbursement`
   - use the driver tip as the reimbursement amount
   - use Ramp transaction dates in `MM/DD/YYYY` format
   - set the memo/note according to the installation's configured reimbursement policy
   - do not use generic `browser` actions in the normal submission path
4. After successful submission, update the receipt note with `receipt_registry upsert_walmart_reimbursement`.
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
- If the screenshot or Ramp submission is ambiguous, stop and report the specific blocker instead of guessing.
- Do not mark a note `submitted` unless the Ramp submission actually completed.
- Do not treat a Ramp sign-in page or missing-auth redirect as an upload-control failure.
- If a submitted reimbursement has bad or missing evidence, use `ramp_reimbursement replace_ramp_reimbursement_receipt` on the existing review URL instead of filing a duplicate reimbursement.
