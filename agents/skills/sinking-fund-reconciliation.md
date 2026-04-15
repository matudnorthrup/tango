# sinking_fund_reconciliation

Reconcile Watson's sinking-fund-backed Lunch Money spending against the three
Ally sinking fund balances. Use this for weekly tracking, month-end pre-close,
and ad-hoc requests like "run a sinking fund reconciliation for April."

## Source of truth

Start every run by reading the Obsidian note titled `Sinking Fund Budget System`.
Treat that note as the authoritative source for fund names, account suffixes,
targets, floors, monthly contributions, and covered categories.

Execution order for the note:
- First try `print 'Records/Finance/Sinking Fund Budget System' --vault main`.
- If that exact print fails, search for the exact title and then print the
  matching note path.
- Do not conclude "note not found" if search results already show the dedicated
  `Sinking Fund Budget System` note.
- Do not substitute `Net Income Financial Plan` for the dedicated sinking fund
  note when the dedicated note is present.

Current baseline config from the note plus later user corrections:

| Fund | Ally account | Covered categories | Target | Floor | Monthly contribution |
| --- | --- | --- | --- | --- | --- |
| House SB | Ally `...5721` | Home Improvement, Home Repair | $20,000 | $10,000 | $700 |
| Vehicles SB | Ally `...3271` | Auto Repair, Boat | $10,000 | $5,000 | $350 |
| Recreation SB | Ally `...5846` | Fishing and Outdoors (`Fishing & Outdoors` in some reports) | $10,000 | none | $300 |

Important exclusions and context:
- `Gas & Charging` is **not** covered by any sinking fund.
- `Spending SB` is outside this workflow unless the user explicitly asks.
- Historical back-payments may exist, so do not assume older months were
  fully reconciled already.
- Contributions land on the 16th of each month and should total $1,350.

If the note conflicts with a newer explicit user instruction, prefer the newer
instruction and call out the override in the report.

## Time window

Always confirm today's date first.

Use this reporting window logic:
- If the user names a month, reconcile that month.
- If the named month is the current month, use month-to-date through today.
- If no month is specified, default to the current month-to-date.
- Scheduled Sunday runs are still month-to-date reports; they should be useful
  as rolling progress checks, not just final monthly snapshots.

## Data to fetch

Use only `obsidian` and `lunch_money`.

At minimum:
- Read `Sinking Fund Budget System` from Obsidian.
- Fetch Lunch Money categories so category names and ids are current.
- Fetch Lunch Money transactions for the reporting window.
- Fetch current balances for the three Ally sinking fund accounts using the
  account or asset endpoints available in this installation.

Balances are required output fields for this workflow. If one Lunch Money
balance endpoint fails, try another available account or asset endpoint before
you finish. If balances still cannot be retrieved, say that explicitly.

When you need contribution verification:
- Check the current month's transaction history for the three SB contribution
  categories instead of relying on recurring-item data.

## Reconciliation rules

### 1. Map only the in-scope categories

Reconcile only these category-to-fund mappings unless the note has changed:
- House SB: `Home Improvement`, `Home Repair`
- Vehicles SB: `Auto Repair`, `Boat`
- Recreation SB: `Fishing and Outdoors` (or `Fishing & Outdoors`)

Do not pull `Gas & Charging` into any sinking fund totals.
Do not include `Spending SB` in tables, totals, contribution checks, or
follow-up recommendations unless the user explicitly asks for it.

### 2. Calculate category spending

For each covered category in the reporting window:
- Sum expense-side outflows as spending.
- Ignore non-expense inflows that are not reimbursements.
- If Lunch Money returns mixed signs, normalize to actual spend rather than
  relying on one sign convention blindly.

### 3. Calculate already-logged reimbursements

The reimbursement leg is the key mechanic:
- Inbound transfers from an SB account are categorized to the expense category
  they offset, not to `Transfer`.
- For each covered category, sum positive or inbound transactions already
  categorized to that category when they represent an SB reimbursement.

Use notes, payees, account names, and transfer-like transaction details to
distinguish reimbursements from true income. If the classification is
ambiguous, state the ambiguity instead of silently guessing.

### 4. Compute the outstanding reimbursement

For each covered category:
- `outstanding = max(spend - reimbursed, 0)`

Then aggregate by fund:
- `fund_spend = sum(category spend)`
- `fund_reimbursed = sum(category reimbursed)`
- `fund_outstanding = sum(category outstanding)`

This `fund_outstanding` number is the amount required to "clear the books"
today if the user wants categories brought back toward zero via the SB
reimbursement flow.

### 5. Compare against current balances, floors, and targets

For each fund:
- Record the current Ally balance.
- Calculate `after_reimbursement = current_balance - fund_outstanding`.
- Compare `after_reimbursement` to the configured floor.
- Compare the current balance to the target and note the remaining target gap.

Warnings:
- If `after_reimbursement` is below zero, flag the fund as insufficient.
- If `after_reimbursement` falls below the floor, flag it clearly.
- If the fund is already below the floor before any reimbursement, call that
  out as a stronger warning.
- For House and Vehicles, remind the user that below-floor use should be
  essential-only based on the configured floor philosophy.

### 6. Check the monthly contribution status

Expected contribution timing:
- House SB: $700 on the 16th
- Vehicles SB: $350 on the 16th
- Recreation SB: $300 on the 16th

Contribution reporting rules:
- If the run date is before the 16th of the current month, mark each
  contribution as `not due yet`.
- Otherwise, verify whether the expected amount posted this month and flag
  anything missing or mismatched.
- For historical month requests, verify the contribution inside that month when
  possible and label any uncertainty.

## Output format

Return a compact finance-style report with these sections.

### 1. Header

Use a title like:

`## Sinking Fund Reconciliation — April 2026 (MTD through 2026-04-14)`

If this is a month-end pre-close run, say so in one line under the title.

### 2. Fund Summary Table

Include:

| Fund | Spend | Reimbursed | Outstanding | Current Balance | After Reimbursing | Floor | Target Gap | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |

Only include `House SB`, `Vehicles SB`, and `Recreation SB`.

Status should be concise:
- `On track`
- `Below floor after reimbursement`
- `Already below floor`
- `Insufficient funds`
- `No activity`

### 3. Category Detail Table

Include:

| Category | Fund | Spend | Reimbursed | Outstanding |
| --- | --- | --- | --- | --- |

Only include in-scope categories, even if some rows are zero.

### 4. Contribution Check

Include:

| Fund | Expected | Status |
| --- | --- | --- |

Only include `House SB`, `Vehicles SB`, and `Recreation SB` unless the user
explicitly asks for another fund.

Status examples:
- `posted`
- `not due yet`
- `missing`
- `amount mismatch`

### 5. Recommended Transfers

If any outstanding reimbursement exists, say exactly what would clear the books
today, for example:
- `House SB -> checking: $206.85, categorize inbound transfer to Home Improvement / Home Repair as needed`

If nothing is outstanding, say:
- `No sinking fund reimbursement transfers are needed right now.`

### 6. Notes / Warnings

Use a short flat list for:
- floor warnings
- missing contributions
- ambiguous reimbursement matching
- any note/config mismatch

If there are no issues, say:
- `No warnings. Reconciliation is clean.`
