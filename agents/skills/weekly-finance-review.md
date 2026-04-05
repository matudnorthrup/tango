# weekly_finance_review

Weekly review of Lunch Money budgets, spending pace, sinking fund transfers, and
fixed cost anomalies. Return the summary to the orchestrator or scheduler; the
delivery destination is installation-specific.

## When to use

When performing the weekly finance review (scheduled or ad-hoc). Also useful when the user asks "how's spending looking?" or wants a budget check mid-month.

## Step 1: Confirm date and fetch categories

**Always confirm the current date first** — do not assume. Use the confirmed date for all calculations.

Fetch all categories:
```json
{ "method": "GET", "endpoint": "/categories" }
```

Note the category IDs and names for matching against budgets.

## Step 2: Fetch month-to-date budgets

```json
{
  "method": "GET",
  "endpoint": "/budgets?start_date=YYYY-MM-01&end_date=YYYY-MM-DD"
}
```

Use the first day of the current month as `start_date` and today as `end_date`. The response includes `spending` (actual) and `budget` (target) per category.

## Step 3: Analyze spending pace

For each budgeted category:
- Calculate % of budget spent: `spending / budget * 100`
- Calculate % of month elapsed: `day_of_month / days_in_month * 100`
- **Flag** if % spent > % elapsed + 10 points (spending ahead of pace)
- **Warn** if % spent > 80% and month is less than 80% elapsed

### Special attention: discretionary spending

This is a discretionary category with a monthly disbursement backstop. Flag if:
- Spending pace suggests the full amount will be exceeded before month end
- Already over 90% of budget regardless of timing

## Step 4: Verify sinking fund transfers

Use month-to-date transaction history in the known sinking-fund categories to verify the expected transfers actually posted. Do not call a recurring-items endpoint in this environment.

Recommended checks:
- Query the month-to-date transactions for each sinking-fund category configured in the current system.
- Cross-reference those transactions against the planned transfers and flag any expected transfer that is missing or materially off.

## Step 5: Scan fixed costs for anomalies

Fetch last month's transactions for Fixed Costs categories and compare:
```json
{
  "method": "GET",
  "endpoint": "/transactions?start_date=YYYY-MM-01&end_date=YYYY-MM-DD&category_id=FIXED_COST_ID"
}
```

**Anomaly threshold:** Flag any fixed-cost payee whose amount differs by >20% from the same payee last month. Common causes: rate increases, double charges, missed payments.

Fixed cost categories are installation-specific. Common examples include:
- Cell Phones
- Insurance
- Electricity
- Internet
- Software & Subscriptions

## Step 6: Format the summary (returned as output, NOT posted to Slack)

### Budget Status Table
```
| Category              | Budget | Spent  | Left   | Pace |
|-----------------------|--------|--------|--------|------|
| Groceries             | $800   | $423   | $377   | ✅   |
| Eating Out            | $200   | $185   | $15    | ⚠️   |
| Discretionary Spending | $300  | $142   | $158   | ✅   |
```

Pace indicators:
- ✅ On track or under
- ⚠️ Spending ahead of pace (flag threshold met)
- 🔴 Over budget

### Flags section
List any warnings from steps 3-5, or "No flags — looking good."

### All-clear format
If nothing is flagged, still include the budget table with a brief note:
> "Weekly finance check — all categories on track, transfers verified, no anomalies."
