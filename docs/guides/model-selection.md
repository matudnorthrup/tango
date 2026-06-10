# Per-Task Model Selection

**Hallmark strategy: match the model to the task; do not standardize on one.**

Tango runs agents on multiple backends (Claude, and a catalog of open-weight
Ollama Cloud models). The right model is **task-dependent**. The cheapest model
that meets the quality bar for a given task is the correct choice — and that
varies by task, so we choose **per persona / per task**, not once for the whole
fleet.

This is a first-class operating practice, on the same footing as
[Done Means Live Tested](agent-operating-model.md#done-means-live-tested).

## Reliability-adjusted cost

Use raw model cost only after the task contract is satisfied. The actual cost of
a model includes retries, repair turns, failed jobs, manual checking, and lost
trust. For low-risk bounded tasks, cheap and fast models should win. For travel,
finance, health, calendar commitments, purchases, and ambiguous planning, paying
for a slower/deeper model is correct when it materially improves accuracy,
consistency, or dependability.

Tool-grounded tasks must also pass their tool contract. A model that gives a
plausible route, price, finance, health, or schedule answer without the required
verification tool has failed even if the prose looks good.

## The operating rule: defaults are safe, downgrades require evidence

Decided 2026-06-09 (after the spectrum-suite bake-offs kept finding the same
shape: bounded well-tooled tasks are model-insensitive; ambiguity, composition,
and long horizons are where models separate):

1. **Default = dependability tier.** Every agent's `runtime.model` fallback is
   the most consistent portfolio-safe model (currently `deepseek-v4-pro:cloud`).
   No bake-off is needed to be *safe* — only to save money.
2. **Downgrades require evidence.** Pinning a cheaper/faster model on any job,
   task, or agent requires a fixture + verdict first. Bake-offs are the permit
   process for economy, not a census — the corpus grows exactly where it pays.
3. **Tier-0 tasks get proactive fixtures regardless** (finance writes, purchases,
   comms-sending, travel, anything with a safety gate): even the default model
   needs standing regression coverage there.
4. **Production is the continuous eval.** The weekly model scorecard aggregates
   `model_runs` (error rates, cap hits, latency, tokens per agent × model) and
   flags regressions and never-evaluated assignments for re-bake-off. Incidents
   always become regression fixtures.

## The golden-path-first workflow

When you stand up a **new** task or workflow:

1. **Establish the golden path with a capable model first.** Use Claude (or work
   it by hand) to discover the *correct process* — the tool sequence, the prompt,
   the edge cases, the verification. Don't optimize the model until the process
   is right. (Most of this repo's clone capabilities — scripture marking, the
   schedule audit, the cart flow — were established this way.)
2. **Bake off cheaper candidates on that *same* process.** Run the identical task
   across several models and compare completion, tool-call efficiency, latency,
   and output quality.
3. **Assign the cheapest model that clears the bar** for that task, via
   `runtime.model` in `config/v2/agents/<agent>.yaml`. Keep a baseline model on a
   sibling agent so you can A/B by `model_runs.model`.

## The bake-off harness (v2)

`scripts/model-bakeoff.mjs` measures **reliability first**: each candidate runs
the same fixture N times (defaults by safety tier — read tasks 3 runs @ 0.8
pass-rate bar, write tasks 5 runs @ 1.0); each run is machine-scored against the
fixture's gates (tool contract with argument checks, output assertions,
forbidden actions) and quality-scored by a blind Claude-CLI judge against the
fixture rubric. The verdict gates on pass-rate AND on rubric consistency (both
the mean and the worst single run must clear their bars — variance is a
reliability property), ranks eligible candidates by pass rate →
cost-per-successful-run → latency, and applies incumbent hysteresis (a
challenger must strictly beat the current assignment, never tie into it).
Policy changes re-apply to stored runs with `--recompute <results.json>` — no
model re-runs needed.

```bash
# Full bake-off from a fixture (candidates, runs, judge from the fixture):
node scripts/model-bakeoff.mjs --task agents/evals/model-bakeoff/tasks/<fixture>.json

# Add subscription benchmarks (comparison only, never assignable):
node scripts/model-bakeoff.mjs --task <fixture> --benchmarks claude:sonnet,claude:opus

# Quick ad-hoc comparison:
node scripts/model-bakeoff.mjs --prompt "<the task>" --worker watson-ollama --full
```

Runs sequentially so timings are comparable. Needs `OLLAMA_API_KEY` in `.env`,
the `:9100` MCP server up when the task uses tools, and a logged-in `claude` CLI
for the judge/benchmarks. Infra failures (MCP down, auth, rate limits) are
retried once and excluded from pass rates — they never count against a model.
List the live Ollama Cloud catalog with:
`curl -s -H "Authorization: Bearer $OLLAMA_API_KEY" https://ollama.com/v1/models`.

Fixtures live in `agents/evals/model-bakeoff/tasks/` (contract documented in the
README there); committed-safe verdict summaries land in
`agents/evals/model-bakeoff/verdicts/`; full transcripts stay private under
`~/.tango/evals/results/`. Validate fixtures with `npm run eval:validate`; the
harness's own logic tests run with `npm run eval:test`.

## New-model intake (screening catalog entrants)

The Ollama Cloud catalog grows continuously; new models are intake candidates,
not automatic upgrades. Screening is cheap (subscription pricing — the cost is
usage volume and wall clock), so the process is: **screen on two fixtures,
then earn assignments through the normal permit process.**

1. **Diff the catalog against what we know.** Every evaluated model has a
   `pricing.json` entry (null prices for subscription models, by design), so:
   `curl -s -H "Authorization: Bearer $OLLAMA_API_KEY" https://ollama.com/v1/models`
   vs `pricing.json` keys. New ids = candidates. Add entries for whatever you
   screen.
2. **Screen, don't census.** Run candidates through two read-tier fixtures via
   the `--models` override, with the fixture's current winner included so every
   comparison shares one blind-judge pass:
   - `travel-route-sacramento-detour` — bounded; catches tool-contract or
     formatting misses, and prices the candidate against the cheap incumbent.
   - `travel-diesel-route-aware` — judgment-discriminating; most models fail
     its rubric, so clearing it is real signal.
3. **Interpret by tier.** Fails the bounded screen → drop. Passes bounded only
   → candidate for bounded per-task pins (bake off on the specific task's
   fixture before pinning). Clears the diesel rubric → dependability-tier
   candidate; run the full travel portfolio + email triage before considering
   any agent-default change. Hysteresis applies throughout: a newcomer needs a
   >10% cost margin (or a pass-rate win) over the incumbent, with no meaningful
   rubric regression.
4. **Expect non-monotonic generations.** The 2026-06-10 screen of the new
   MiniMax line: m2.7 came out ~46% cheaper than m2.5 but meaningfully *worse*
   (0.78 vs 0.90 rubric); m3 came out better (0.96) *and* ~17% cheaper. Version
   number is not evidence; the verdict is.
5. **Outage resilience.** Judge failures (timeouts, network) leave runs
   unscored; the verdict marks `judgeIncomplete` and unscored candidates are
   ineligible (missing evidence is not a pass). Repair with
   `--rejudge <stored results.json>` — re-judges transcripts without re-running
   models. Policy changes re-apply with `--recompute`.

## What the data shows (and why it generalizes)

A bake-off (2026-06-08, [DEV-57]) established the pattern we expect to keep seeing:

- **Bounded / clear tasks** (a fixed recipe of tool calls): every candidate
  completes *identically correctly*. There is no quality difference — **take the
  fastest.** MiniMax M2.5 was ~1.8× faster than `deepseek-v4-pro`; "thinking"
  models just pay overhead for nothing (Kimi K2.6 came last).
- **Ambiguous / judgment tasks** (interpretation, prioritization, planning):
  models *diverge*, and the **thinking models earn their overhead.** GLM-5 and
  Kimi K2.6 produced the deepest, most insightful reads; the fast models were
  shallower.

So the default split:

| Task shape | Use | Examples |
| --- | --- | --- |
| Bounded, tool-driven, latency-sensitive | **fast agentic** — MiniMax M2.5, `deepseek-v4-flash` | browse/shop, calendar, scripture marking, scheduled jobs |
| Ambiguous, judgment, "what matters and why" | **thinking** — GLM-5 / `deepseek-v4-pro` (peers) | chief-of-staff prioritization, morning briefing, finance-review reasoning |

### Judgment-model bake-off (2026-06-08)

A head-to-head on judgment tasks (emotional advice; open-ended, constraint-laden
trip planning) settled which "thinking" model to route judgment to:

- **GLM-5 and `deepseek-v4-pro` are peers** — both produced deep, well-structured,
  specific answers at comparable latency (~30s advice, ~70–75s planning). GLM-5
  leaned slightly more interpretive/"surprising"; `deepseek-v4-pro` was slightly
  better at grounding hard constraints (e.g. explicit fuel-range math). Either is
  an excellent judgment target.
- **Kimi K2.6 is too slow for interactive routing** — same task took **204s**
  (~3× the others). Great prose, wrong tool for a per-turn path.

Consequence: the earlier "`deepseek-v4-pro` is best for Juliet/Porter" finding was
about the *alternatives that failed* (MiniMax deflected / made 0 tool calls; Flash
500'd) — **not** GLM-5 losing. GLM-5 is the per-task judgment target; an agent
already on `deepseek-v4-pro` loses nothing by staying (see "don't downgrade").

## Per-task auto-routing (the runtime safety net)

Static `runtime.model` is only the **default for operational (OTHER) turns**. On
every Ollama turn, `ollama-runtime-adapter.ts` runs a cheap `ministral-3:3b`
classifier (~0.9s, example-driven prompt, fully stable on the 16-task gold set)
that labels the turn **JUDGMENT / DATA / OTHER**, then:

- **JUDGMENT** → upgrade to GLM-5 *if* the agent's model isn't already strong at
  judgment (`STRONG_JUDGMENT_MODELS`).
- **DATA** (analyzing the user's own records) → upgrade to `deepseek-v4-pro` *if*
  the agent's model isn't already strong at data (`STRONG_DATA_MODELS`).
- **OTHER** → keep the agent's configured model.

The "don't downgrade" guard is the key: the router only ever **upgrades a weak/fast
fallback** for its weak shape; it never replaces a deliberately-assigned strong
model with a worse one. It fails safe to the fallback on no-key / disabled / error,
so it can never block a turn. Toggle with `TANGO_PER_TASK_MODEL_ROUTING=false`;
override targets with `TANGO_MODEL_JUDGMENT` / `TANGO_MODEL_DATA` /
`TANGO_TASK_ROUTER_MODEL`.

Net effect: a per-persona default that's right for that persona's *common* work,
with a per-turn correction for the off-shape turns — so even a fast operational
persona handles an occasional "help me think through X" on a thinking model.

## Notes / gotchas

- Per-agent model is just `runtime.model` (Ollama path reads it on the v2/scheduler
  runtime). Flipping a persona is a one-line YAML change + bot restart.
- Model ids work **bare** (no `:cloud`) via the OpenAI-compat `/v1` endpoint
  (e.g. `glm-5`, `minimax-m2.5`). `kimi-k2-thinking` errors "prompt too long" on
  that endpoint — use `kimi-k2.6`.
- A capable model can also fail *fast* flows it would ace given more turns: the
  real constraint for long/auth-in-turn flows is architectural (stateless single
  turn + iteration cap), not just the model. Model choice raises the ceiling;
  keeping sessions authenticated / decomposing the flow is the rest of the fix.

[DEV-57]: https://linear.app/latitudegames/issue/DEV-57
