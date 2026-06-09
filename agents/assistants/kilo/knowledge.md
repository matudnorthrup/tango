# Kilo Knowledge

Kilo is the dedicated kid-facing agent for the profile-configured child
spending system.

## Channels

- Production Discord channel: `kilo`
- Test Discord channel: `kilo-test`
- The account owner can read and post in the production channel.
- Movement reports go to Foxtrot for finance oversight.

## Ledger

The Kilo ledger is the source of truth for the child-facing buckets. It is
backed by one profile-configured Lunch Money account, but Kilo does not move
real bank money.

The runtime ledger lives in the active Tango profile data directory:

`~/.tango/profiles/<profile>/data/kilo/ledger.json`

Kid-facing web page details, including any private host URL, belong in the
active Tango profile or private runbook rather than repo defaults.

## Buckets

Protected buckets:

- Tithing
- Savings

Protected buckets cannot be deleted and cannot transfer money out.

The `Unallocated` bucket is a holding bucket for money the child can divide
into other allowed buckets.

Reserved ledger bucket ids:

- Tithing: `tithing`
- Savings: `savings`
- Unallocated: `to-allocate`

Discretionary buckets are dynamic. The child can create and delete them, so the
current active bucket list must come from the Kilo ledger tool or web API.
Historical entries may mention old bucket names that are no longer active.

## Bucket Growth

Kilo buckets do not have target balances or caps. The child can keep saving in
discretionary buckets as long as desired, subject only to protected-bucket
rules.

The ledger keeps recent movement history for contributions, deductions, transfers, and bucket changes. Historical spending entries are context-only and do not change current balances.

## Monthly Funding

The monthly contribution amount, start date, and split are ledger-configured and
are not kid-triggered actions. Read the Kilo ledger summary for the current
values.

The account owner or a background task initiates monthly funding. Kilo should
not offer to apply it for the child.

## Foxtrot Review

Foxtrot handles weekly review of Lunch Money transactions in the
profile-configured Kilo spending category.

When the account owner approves a reviewed transaction, Foxtrot records an
internal Kilo ledger debit against the best matching active discretionary Kilo
bucket. This immediately lowers the spendable ledger balance even if the real
bank/Lunch Money movement happens later.

The later bank/Lunch Money transfer is recorded as a settlement of
already-recorded spending. Settlements do not debit buckets again.

Foxtrot should use `record_spend` for approved current transactions and
`settle_spending` when the later bank transfer posts. Use
`record_historical_spend` only for old/context purchases that should appear in
history without changing current balances.
