# receipt_registry

Structured access to cataloged receipt reimbursement state for Watson.

## Purpose

Use this tool instead of ad hoc note parsing when you need to:

- find itemized receipt notes by Lunch Money transaction ID, amount, date,
  merchant, or store/item text
- find pending reimbursement candidates across configured vendors
- build a reimbursement ledger for a review window
- detect missing/stale reimbursement tracking fields
- find Walmart receipt notes that include a delivery driver tip
- verify whether a reimbursement has already been submitted in Ramp
- update a receipt note after a Ramp submission succeeds

Do not use Obsidian Base files, old review notes, or broad note search as the
source of truth for whether a Ramp reimbursement is pending. They are context
only. If this tool cannot verify the state, report the item as unverified.

## Actions

### `lookup_receipts`

Finds cataloged receipt notes by linked Lunch Money transaction ID, amount,
date, merchant/vendor, or text query. Use this before saying no receipt exists,
before asking the user for itemized split amounts, and when a user references a
store/location/item from an earlier review.

Optional params:

- `transaction_id`
- `amount`
- `date` or `transaction_date`
- `merchant`
- `query`
- `max_results`

Useful fields in the response:

- `record.filePath`
- `record.date`
- `record.total`
- `record.fields`
- `record.linkedTransactions`
- `record.lineItems`
- `record.categoryNotes`

### `list_reimbursement_candidates`

Lists configured reimbursement candidates across receipt folders using
`reimbursement-config.yaml`.

Use this first for reimbursement review, unless the task is explicitly limited
to Walmart delivery tips.

Optional params:

- `since`
- `until`
- `vendor`
- `include_submitted`
- `verify_with_ramp`
- `max_pages`

### `reconcile_reimbursements`

Verifies configured reimbursement notes against live Ramp reimbursement history
and updates stale tracking blocks in place.

Use before telling the user that an item is pending, unsubmitted, submitted, or
reimbursed when the note state looks stale, disputed, older than 30 days, or
important for close.

Optional params:

- `since`
- `until`
- `vendor`
- `max_pages`

### `upsert_reimbursement`

Creates or updates the standardized `## Reimbursement Tracking` block inside
any configured vendor receipt note.

Required fields:

- `note_path`
- `status`

Optional fields:

- `vendor`
- `system`
- `reimbursable_item`
- `amount`
- `submitted`
- `note`
- `evidence_path`
- `ramp_report_id`

### `generate_monthly_ledger`

Builds a reimbursement ledger for a month or date range, grouped by vendor,
category, and status.

Use this during finance reviews and close prep before summarizing reimbursement
state.

Optional params:

- `month`
- `since`
- `until`
- `vendor`
- `verify_with_ramp`
- `max_pages`

### `detect_gaps`

Detects missing tracking blocks, stale submitted notes, missing recurring
receipts, missing Ramp IDs, and other reimbursement coverage gaps.

Use this during every finance review. Treat its output as the queue to repair,
not as permission to invent missing amounts.

Optional params:

- `since`
- `until`
- `vendor`
- `lookback_months`
- `verify_with_ramp`
- `max_pages`

### `check_submission_dedup`

Checks whether a proposed reimbursement already appears in local receipt notes
or live Ramp history.

Use this before manual repairs or any unusual re-submission path.

Optional params:

- `note_path`
- `vendor`
- `merchant`
- `amount`
- `transaction_date`
- `memo`
- `verify_with_ramp`
- `max_pages`

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

### Finance review / close prep

1. Run `lookup_receipts` for retailer transactions that have a transaction ID,
   amount/date/store clue, or user-mentioned item before asking for amounts.
   If item rows plus subtotal/tax are present, compute item-group totals and
   allocate tax proportionally so the split sums to the transaction total.
2. Run `detect_gaps`.
3. Run `generate_monthly_ledger`.
4. Run `list_reimbursement_candidates`.
5. For Walmart delivery tips, run `list_walmart_delivery_candidates`.
6. Reconcile before making any confident stale/pending/submitted claim.
7. If verification fails, say `unverified`; do not fill gaps with guesses.

### Ramp submission

1. Reconcile or list reimbursement candidates with Ramp verification enabled.
2. Use evidence collection and Ramp submission tools to complete the reimbursement.
3. Let the Ramp reimbursement tool update the corresponding receipt note
   automatically after a successful submission.
4. Use `upsert_reimbursement` or `upsert_walmart_reimbursement` only for
   repairs or manual note correction.
