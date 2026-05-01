# Finance Process Lessons Learned

Captured from the April 2026 full financial review session.

## Sinking Fund Reconciliation

- SB draws come in as a single transfer. They must be split into child transactions using the Lunch Money API via `parent_id` — one child per expense category being offset.
- Only create child transactions tied to REAL money transfers. Never create synthetic/fake offset transactions to zero out budgets. That hides real money and sets a dangerous precedent.
- If supplemental draws are needed (e.g., a purchase was missed in the original draw estimate), make the actual bank transfer first, then create children when the transfer lands in Lunch Money.
- Ally transfers typically sync overnight or next business day — don't expect same-day visibility.
- The monthly reconciliation log lives at `Records/Finance/Sinking Fund Reconciliation Log.md`.
- The full mechanism (API payload format, rules, process steps) is documented in `References/Finance/Sinking Fund Budget System.md`.

## Pending as of April 27

- Two supplemental transfers in flight: $24.99 from House SB and $19.18 from Recreation SB.
- When they land in Lunch Money, create child transactions: House SB child covers Home Improvement (ball pump), Recreation SB child splits into Amazon Prime and Subway under Family Spending.
- After that, April is fully zeroed out.

## Receipt Notes and Evidence

- Create Obsidian receipt notes for: Amazon, Walmart, Costco, and any reimbursable transactions.
- Evidence PDFs go in `Records/Finance/Receipts/Evidence/`.
- Reimbursable notes need frontmatter: `reimbursable: true`, `ramp_submitted` (date or null), `ramp_report_id`.
- The Obsidian Base view for tracking reimbursements lives at `Records/Finance/Receipts/Latitude Reimbursements.base`.
- Always use the actual PDF invoice when available — not screenshots.
- For Venmo, use the official Venmo confirmation email rendered to PDF.

## Lunch Money Rules

- Keep only Tier 1 rules: specific amount AND date window, for known recurring charges.
- Delete or ignore broad payee-only rules — those cause surprise miscategorizations.
- Never accept Lunch Money's auto-suggested rules without reading them carefully. The suggestion engine can't know our categories.
- The categorizer rules source of truth is `References/Finance/Lunch Money Rules.md`.

## Transaction Categorizer

- The nightly categorizer skips transactions that are already "cleared" — so if Lunch Money auto-clears via a rule, the categorizer won't re-evaluate them.
- Design gap: transactions cleared by Lunch Money rules in under 48 hours never get touched by the categorizer.
- Future improvement: add a weekly recategorization audit sweep for transactions that were auto-cleared with low-confidence rules.

## File Organization

- `References/Finance/` — strategy and process docs (rules, budget targets, process guides)
- `Records/Finance/` — transactional records (receipt notes, reconciliation logs, reimbursement base)

## Splits via API

- Amazon and Walmart parent records are split using child transactions with `parent_id` in the Lunch Money API.
- SB draw splits use the same mechanism — but require a real transfer to exist first.
- There is no DELETE endpoint in the Lunch Money v1 API — bad transactions must be deleted manually in the UI.

## Daily Brief (Pending Victor)

- Spec written at `docs/projects/daily-brief-architecture.md`.
- Finance and email channels should stop posting directly to Discord — those jobs should write to domain logs in Obsidian instead.
- Morning brief job runs at 5:15am, posts to personal channel and daily note.

## General Lessons

- Do the process manually a couple of times before automating — this session surfaced several design decisions that would have been wrong if automated too early.
- The sinking fund split process is now well-understood and is a good candidate for automation after one or two more manual cycles.
