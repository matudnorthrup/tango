# finance_review

Unified finance review workflow for Foxtrot. Use this for scheduled rolling
reviews, month-end close prep, final month close, and ad-hoc dry runs.

The review is one process with conditional depth. Weekly and monthly schedules
are just different phases of the same workflow.

## Review phases

Use an explicit phase from the task when provided. Otherwise infer it from the
confirmed current date and user intent.

| Phase | When | Purpose |
| --- | --- | --- |
| `rolling` | Normal weekly or ad-hoc check | Keep entropy low and catch drift early |
| `close_prep` | Final week or scheduled 28th/29th | Identify what must be cleaned up before month close |
| `close` | Explicit final close | Seal the month and carry decisions forward |
| `post_close` | After close if late data arrives | Repair late transactions/reimbursements without reopening everything |

The same sections run in every phase. The phase changes strictness:
- `rolling`: surface backlog and recommend actions; avoid fussy small transfers.
- `close_prep`: make true-up actions concrete and time-sensitive.
- `close`: every unresolved item must be cleared or explicitly carried forward.
- `post_close`: only handle late-arriving exceptions.

## Write policy

Default review runs may:
- Trigger Lunch Money/Plaid account refreshes with `POST /plaid_accounts/fetch`
  when account data is stale.
- Create or overwrite the review note in Obsidian.

Default review runs must not:
- Submit Ramp reports.
- Create Ramp drafts.
- Mutate Lunch Money categories/status except when the user explicitly asks for
  a correction during the review.

Dry runs may refresh account data but must not mutate Lunch Money categories,
Ramp, or persistent Obsidian records unless the task explicitly asks for a
dry-run note. A dry-run note should be named:

```
Records/Finance/Reviews/YYYY-MM-DD Finance Review Dry Run.md
```

## Current-status and stale-note guard

When the user asks what is left, what is still open, what remains from a weekly
review, or asks to resume a review, do not summarize the most recent review note
as if it is current state.

Use old review notes and Finance job logs only to build a candidate list. Then
verify current state before answering:
- Query Lunch Money for current uncleared/uncategorized transactions in the
  relevant window. Use `status=uncleared` for the review inbox; do not use
  `status=unreviewed`.
- For reimbursements, run the required `receipt_registry` checks and reconcile
  against live Ramp history before reporting pending/submitted/reimbursed state.
- For sinking fund contributions or draws, refresh stale account data and check
  both checking-side and savings-side activity before calling an item missing.
- For budget-target items, read `Budget Targets.md` and distinguish a target
  update decision from a categorization or transaction backlog item.

If live data contradicts a review note, live data wins. Append a timestamped
status correction to the current review record before answering so the next run
does not repeat the stale item. If a live check cannot verify state, report
`unverified` rather than carrying forward the old flag.

## Step 1: Confirm date, phase, and record path

Always confirm the current date first. Do not assume.

Create or overwrite the review record:

```
Records/Finance/Reviews/YYYY-MM-DD Finance Review.md
```

For `close` phase, use:

```
Records/Finance/Reviews/YYYY-MM Finance Close.md
```

Use `--overwrite` so reruns repair the same artifact.

Record:
- confirmed date
- review phase
- review window
- lookback window since the most recent review note
- dry-run status

## Step 2: Refresh and validate source data

Fetch `/plaid_accounts` before drawing conclusions from transaction absence.

For each relevant account, inspect:
- `last_import`
- `last_fetch`
- `plaid_last_successful_update`

At minimum check:
- Devin's Checking
- main credit card account
- House SB
- Vehicles SB
- Recreation SB
- Spending SB when discretionary spending is in scope

If a relevant account has not fetched/imported data after a date needed for the
review, trigger:

```json
{
  "method": "POST",
  "endpoint": "/plaid_accounts/fetch",
  "body": {
    "plaid_account_id": 123,
    "start_date": "YYYY-MM-DD",
    "end_date": "YYYY-MM-DD"
  }
}
```

Wait about 20-60 seconds, then re-fetch `/plaid_accounts` and the transaction
window. If data remains stale, report `unverified - account data stale` instead
of calling the item missing.

## Step 3: Job health and backlog

Read the Finance job log for the lookback window:

```
Records/Jobs/Finance/YYYY-MM.md
```

Capture:
- failed jobs
- `**Flagged:**` sections
- stale `Needs review` / `Needs input` items
- receipt cataloger gaps
- transaction categorizer holdovers

Check Lunch Money for uncleared/uncategorized transactions:
- recent `status=uncleared`
- any uncleared transaction older than 48 hours
- any uncategorized transaction regardless of age

For a `rolling` review, report the backlog and suggested decisions. For
`close_prep` and `close`, unresolved transaction backlog is a close blocker
unless explicitly carried forward.

## Step 4: Budget pace and rolling signals

Read:

```
~/Documents/main/References/Finance/Budget Targets.md
```

Use Budget Targets as source of truth. Lunch Money budgets are optional
diagnostics only.

Fetch `/categories`, resolve category IDs, and query:
- month-to-date actuals for target categories
- rolling 30-day totals for behavior signals
- prior-month totals for anomaly context when useful

Flag:
- actuals over 110% of target
- spending pace more than 10 percentage points ahead of month elapsed
- rolling 30-day trend that indicates ungoverned spending even if MTD is still
  technically under target
- target values that are clearly stale versus recurring reality

Do not treat every overage as a problem. Classify:
- one-time anomaly
- behavior signal
- target needs update
- classification/data issue

## Step 5: Sinking funds

Use `agents/skills/sinking-fund-reconciliation.md` as the detailed module.

Always check:
- contribution status if the contribution date has passed
- current fund balances when available
- covered-category spend
- outstanding SB draw/reimbursement needs

Contribution rule:
- Contributions are monthly and should be verified after their due date.
- Refresh stale Lunch Money/Plaid data before deciding.
- Check both checking-side outflows and savings-side mirror activity.
- Report stale data as unverified, not missing.

Draw recommendation thresholds:
- Under $50: monitor or defer.
- $50-$250: recommend, optional.
- Over $250 or older than 14 days: recommend `do now`.
- `close_prep` and `close`: true up all intentional remaining draws unless the
  user explicitly carries them forward.

Do not create or manage Ramp drafts. Ramp is only for Latitude reimbursements.

## Step 6: Reimbursements and receipts

Use `receipt_registry` as the source of truth for reimbursement state. The
Obsidian Base view is a human-facing display, not an authoritative source for
agent decisions, because stale frontmatter or path issues can hide valid notes.

Required structured checks:
- Run `receipt_registry detect_gaps` for the review window or recent lookback.
- Run `receipt_registry generate_monthly_ledger` for the current month or
  requested review range.
- Run `receipt_registry list_reimbursement_candidates` for configured vendors.
- For Walmart delivery tips, use `receipt_registry list_walmart_delivery_candidates`.
- If any item appears stale, disputed, older than 30 days, or already possibly
  submitted, run `receipt_registry reconcile_reimbursements` or
  `receipt_registry reconcile_walmart_reimbursements` before claiming it is
  pending, unsubmitted, submitted, or reimbursed.

Check receipt/reimbursement gaps:
- reimbursement tracking section without reimbursable frontmatter
- `ramp_submitted` missing or false
- missing Ramp report IDs
- reimbursable notes older than 30 days
- receipt notes with pending Lunch Money links

If `receipt_registry` is unavailable, errors, or cannot verify live Ramp state,
report reimbursement state as `unverified - receipt registry/Ramp check failed`.
Do not infer pending reimbursement amounts from `Latitude Reimbursements.base`,
Obsidian search results, old review notes, or loose receipt-note text.

For `rolling`, surface and prioritize gaps. For `close_prep` and `close`,
unsubmitted or untracked reimbursables must be submitted, carried forward, or
explicitly marked not applicable.

Do not submit to Ramp unless the user explicitly approves.

## Step 7: Close criteria by phase

For `rolling`, the review is complete when:
- data freshness is known
- backlog and flags are listed
- decisions needed from Devin are clear
- review note is written

For `close_prep`, the review is complete when:
- close blockers are named
- SB true-up recommendations are concrete
- reimbursement and transaction blockers are listed
- Budget Target changes are proposed

For `close`, the review is complete only when:
- transactions are cleared or explicitly carried forward
- reimbursements are submitted, received, pending, or carried forward
- SB contributions and draws are verified or carried forward
- final budget variance is recorded
- target/rule changes are written or listed as follow-up

## Output format

Return a concise scheduler/Discord summary:
- review phase
- data freshness / refreshes performed
- top open flags
- sinking fund recommendation summary
- reimbursement/receipt gaps
- budget pace signals
- review note path

If the review is blocked, say exactly what is blocking it.
