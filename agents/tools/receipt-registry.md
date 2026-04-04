# receipt_registry

Structured access to cataloged receipt reimbursement state for Watson.

## Purpose

Use this tool instead of ad hoc note parsing when you need to:

- find Walmart receipt notes that include a delivery driver tip
- see whether a reimbursement has already been submitted
- update a receipt note after a Ramp submission succeeds

## Actions

### `list_walmart_delivery_candidates`

Returns Walmart receipt notes that:

- include a delivery summary
- include a `Driver tip`
- do not already have reimbursement status `submitted` or `reimbursed` unless `include_submitted=true`

Useful fields in the response:

- `filePath`
- `noteName`
- `orderId`
- `date`
- `driverTip`
- `deliverySummary`
- `reimbursement`

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

1. List outstanding Walmart reimbursement candidates.
2. Use browser evidence and Ramp submission to complete the reimbursement.
3. Immediately update the corresponding receipt note with submitted status and evidence path.
