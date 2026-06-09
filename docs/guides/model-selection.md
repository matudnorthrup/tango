# Per-Task Model Selection

**Hallmark strategy: match the model to the task; do not standardize on one.**

Tango runs agents on multiple backends (Claude, and a catalog of open-weight
Ollama Cloud models). The right model is **task-dependent**. The cheapest model
that meets the quality bar for a given task is the correct choice — and that
varies by task, so we choose **per persona / per task**, not once for the whole
fleet.

This is a first-class operating practice, on the same footing as
[Done Means Live Tested](agent-operating-model.md#done-means-live-tested).

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

## The bake-off harness

`scripts/model-bakeoff.mjs` runs one task across N models and prints a comparison
(stop reason, tool-call count, wall-clock) plus, with `--full`, the complete
outputs so you can judge quality.

```bash
# Quick: one prompt across the default candidate set, with tools + full outputs
node scripts/model-bakeoff.mjs --prompt "<the task>" --worker watson-ollama --full

# Specific models, no tools
node scripts/model-bakeoff.mjs --prompt "<task>" --models minimax-m2.5,glm-5 --no-tools

# Reusable task spec: { "worker", "system", "prompt", "tools" }
node scripts/model-bakeoff.mjs --task path/to/task.json --full
```

Runs sequentially so timings are comparable. Needs `OLLAMA_API_KEY` in `.env`,
and the `:9100` MCP server up when the task uses tools. List the live Ollama
Cloud catalog with:
`curl -s -H "Authorization: Bearer $OLLAMA_API_KEY" https://ollama.com/v1/models`.

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
