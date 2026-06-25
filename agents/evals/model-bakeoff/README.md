# Model Bake-Off Evals

First-class model selection fixtures for Tango.

## Principle

Choose the cheapest and fastest model that **consistently** completes the task
contract. Reliability dominates: a failed job costs trust, redone tokens, and
the user's attention — far more than the price difference between models. So the
harness gates on pass-rate across repeated runs first; cost and speed only rank
the models that pass.

## How a bake-off works (harness v2)

```
fixture (eval contract)
  → N runs per candidate model (sequential, identical task)
      → GATES  per run: machine-checked — tool contract incl. argument checks,
               output assertions, forbidden actions   → pass/fail
      → RUBRIC per run: blind Claude-CLI judge scores the fixture's weighted
               quality dimensions 0..1
  → eligibility: passRate ≥ passRateThreshold AND rubric mean ≥ rubricThreshold
                 AND worst-run rubric ≥ rubricFloor (default threshold − 0.1) —
                 consistency is a reliability property: a model that swings
                 between brilliant and below-bar is not dependable
  → ranking: pass rate desc, then cost-per-successful-run, then latency
  → hysteresis: a challenger only displaces `incumbentModel` by strictly beating
    it (never ties) — assignments don't churn on marginal wins
```

Infra failures (MCP server down, auth, rate limits) are detected, retried once,
and excluded from the pass-rate denominator — environment flakiness never
masquerades as model unreliability. If a fixture's contract tools aren't visible
to the worker on :9100, the harness aborts with an INFRA error *before* running
any model, so missing governance permissions can't fail every candidate.

## Running

```bash
npm run eval:validate          # fixture contract check (CI-gateable)
npm run eval:test              # harness unit tests (gates + verdict logic)

# Full bake-off from a fixture (runs, candidates, judge all from the fixture):
node scripts/model-bakeoff.mjs --task agents/evals/model-bakeoff/tasks/<fixture>.json

# Overrides:
#   --models a,b,c        candidate set        --runs N        runs per candidate
#   --benchmarks claude:sonnet,claude:opus     subscription benchmarks (never assignable)
#   --no-judge --judge-model <m> --full --no-tools --results-dir <dir>

# Quick ad-hoc comparison (v1-style):
node scripts/model-bakeoff.mjs --prompt "<task>" --worker watson-ollama --full
```

Requires `OLLAMA_API_KEY` in `.env`, the `:9100` MCP server for tool fixtures,
and a logged-in `claude` CLI for the judge and `claude:*` benchmarks.

## Where results go

- **Full per-run records** (transcripts, tool outputs — may contain personal
  data): `~/.tango/evals/results/<fixture-id>/<stamp>.json`. Never committed.
- **Verdict summaries** (stats only, committed-safe): `verdicts/<fixture-id>.json`
  with a capped history, so assignments stay reviewable and trendable in git.
- **Prices**: `pricing.json`. Only verified prices — unknown prices stay null and
  the harness ranks by measured tokens instead. Never guess a price.

## Fixture contract (schema v2)

Required: `id, title, category, worker, taskShape, safetyTier, tools,
candidateModels, system, prompt, successCriteria, knownFailureModes, rubric`
(weights sum to 1).

Scoring fields:

- `toolContract`: `[{ name, minCalls?, argChecks?, anyOf? }]` — argument-level
  gates. `argChecks: [{ path, exists?|equals?|matches? }]`; path `"."` matches
  against the whole argument object's JSON. `anyOf` branches let a contract
  accept alternative shapes (e.g. "two driving_route calls OR one call with a
  routes[] comparison array"). Legacy `requiredTools` still works.
- `outputAssertions`: `[{ type: includes|notIncludes|matches|notMatches, value }]`
- `forbiddenTools`: tools that must NOT be called (e.g. submit/purchase paths)
- `runs` / `passRateThreshold`: default by `safetyTier` — read tiers 3 runs @ 0.8,
  write tiers 5 runs @ 1.0 (failure on write paths is unacceptable)
- `rubricThreshold` (default 0.7), `judge: { model }` (default sonnet)
- `incumbentModel`: current production assignment, enables hysteresis
- `benchmarkModels`: e.g. `["claude:sonnet", "claude:opus"]` — run for comparison,
  never recommended (subscription print mode, not an assignable runtime)

Validate with `npm run eval:validate`. Per-category contract rules (e.g. travel
route fixtures must gate on `driving_route`) live in the validator's
`CATEGORY_RULES` table — add rules as data, not code.

## Coverage Strategy

Use the Obsidian "Tango Jobs — Manual Test Checklist" as the coverage inventory.
Tier jobs before running expensive bake-offs:

- **Tier 0: high trust impact** — travel, finance, health, calendar commitments,
  live purchasing, and anything that can waste the user's time or money.
- **Tier 1: recurring operations** — scheduled jobs and common assistant tasks
  where consistency matters more than creativity.
- **Tier 2: ad hoc research/judgment** — ambiguous planning or synthesis where
  deeper models may be worth the latency.
- **Tier 3: low-risk bounded tasks** — cheap models should win unless they miss
  required tools or formatting.

For each job family, first establish the golden path with the most capable
process (Claude/Fable or by hand), then bake off candidate models against that
fixed contract, then record the assignment. **No new scheduled job or intent
ships without a fixture** — the golden-path transcript is the fixture draft.

Write-path fixtures may touch live services for the user's OWN data with cleanup
baked into the task (create-then-delete an Obsidian note, update-then-revert a
Notion page). Never third parties, never the `-ollama` Discord channels (the user
dogfoods those); Discord-loop evals go through `-test` channels.
