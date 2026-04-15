# receipt_registry

Structured access to cataloged receipt reimbursement state for Watson.

## Purpose

Use this tool instead of ad hoc note parsing when you need to:

- find Walmart receipt notes that include a delivery driver tip
- verify whether a reimbursement has already been submitted in Ramp
- update a receipt note after a Ramp submission succeeds

## Actions

### `list_walmart_delivery_candidates`

Returns Walmart receipt notes that:

- include a delivery summary
- include a `Driver tip`
- do not already have reimbursement status `submitted` or `reimbursed` unless `include_submitted=true`
- by default, verifies the pending list against live Ramp history before returning results

Useful fields in the response:

- `filePath`
- `noteName`
- `orderId`
- `date`
- `driverTip`
- `deliverySummary`
- `reimbursement`

The response may also include a `verification` block with:

- `matched`
- `unverified_submitted`
- `notes_examined`
- `history_entries_examined`

### `reconcile_walmart_reimbursements`

Verifies Walmart receipt notes against live Ramp reimbursement history and updates stale note fields in place.

Useful when:

- Obsidian still says `not_submitted` for notes that were already filed in Ramp
- Watson needs to trust actual Ramp history before claiming which Walmart tips are still pending
- you want the note state repaired without manually editing each receipt note

### `upsert_walmart_reimbursement`

Creates or updates the note's `## Reimbursement Tracking` section.

Provide either:

- `note_path`
- or `order_id`

and also:

- `status`

Optional fields:

- `system`
- `reimbursable_item`
- `amount`
- `submitted`
- `note`
- `evidence_path`
- `ramp_report_id`

## Expected usage

1. Reconcile or list Walmart reimbursement candidates with Ramp verification enabled.
2. Use browser evidence and Ramp submission to complete the reimbursement.
3. Let the Ramp reimbursement tool update the corresponding receipt note automatically after a successful submission.
4. Use `upsert_walmart_reimbursement` only for repairs or manual note correction.
