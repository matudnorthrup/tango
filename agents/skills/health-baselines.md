# health_baselines

Reusable interpretation guidance for daily health summaries.

## Baselines

- Resting heart rate: normal `46-48`, good `40-43`
- HRV: normal `35-40`, good `47-55`
- Steps: normal `8000-10000`, good `15000+`
- Sleep: normal `6-7h`, good `8h+`

## Interpretation rules

- Always anchor claims to the returned date or date range.
- State whether a metric is below baseline, within baseline, or above baseline.
- Distinguish a single-day snapshot from a multi-day trend.
- Do not infer missing measurements or give medical advice.
