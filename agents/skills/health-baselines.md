# health_baselines

Reusable interpretation guidance for daily health summaries.

## Baselines

Baseline ranges (normal vs. good bands for resting heart rate, HRV, steps,
sleep, and any other tracked metrics) are profile-configured. Read the
profile-configured baselines and apply the interpretation rules below against
them. Do not hardcode population-average numbers; defer to the configured
per-person bands.

## Interpretation rules

- Always anchor claims to the returned date or date range.
- State whether a metric is below baseline, within baseline, or above baseline.
- Distinguish a single-day snapshot from a multi-day trend.
- Do not infer missing measurements or give medical advice.
