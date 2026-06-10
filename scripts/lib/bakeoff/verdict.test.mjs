import { test } from "node:test";
import assert from "node:assert/strict";

import { summarizeCandidate, computeVerdict, isEligible } from "./verdict.mjs";

const fixture = (overrides = {}) => ({
  id: "test.fixture",
  passRateThreshold: 0.8,
  rubricThreshold: 0.7,
  rubricFloor: 0.6,
  incumbentModel: null,
  ...overrides,
});

function mkRun({ pass = true, infra = false, seconds = 10, outTok = 500, cost = null, rubric = null, judgeError = null } = {}) {
  return {
    gates: { pass, infra, failures: pass ? [] : [{ gate: "tool:x", detail: "missed" }] },
    rubricScore: rubric,
    judge: judgeError != null ? { error: judgeError } : rubric != null ? { weighted: rubric } : undefined,
    seconds,
    usage: { outputTokens: outTok },
    costUsd: cost,
  };
}

function candidate(model, runs, benchmarkOnly = false) {
  return summarizeCandidate(fixture(), { model, benchmarkOnly, runs });
}

test("infra runs are excluded from the pass-rate denominator", () => {
  const s = candidate("m", [mkRun(), mkRun(), mkRun({ infra: true, pass: false })]);
  assert.equal(s.validRuns, 2);
  assert.equal(s.infraRuns, 1);
  assert.equal(s.passRate, 1);
});

test("eligibility respects passRateThreshold and rubricThreshold", () => {
  const f = fixture();
  const flaky = candidate("flaky", [mkRun(), mkRun(), mkRun({ pass: false })]); // 2/3 = 0.667
  const solid = candidate("solid", [mkRun(), mkRun(), mkRun()]);
  const shallow = candidate("shallow", [mkRun({ rubric: 0.5 }), mkRun({ rubric: 0.6 }), mkRun({ rubric: 0.55 })]);
  assert.equal(isEligible(f, flaky), false);
  assert.equal(isEligible(f, solid), true);
  assert.equal(isEligible(f, shallow), false);
});

test("worst-run rubric floor gates eligibility even when the mean clears the bar", () => {
  const f = fixture();
  // mean 0.73 but one run at 0.58 — below the 0.6 floor (the glm-5 itinerary case)
  const swingy = candidate("swingy", [mkRun({ rubric: 0.58 }), mkRun({ rubric: 0.85 }), mkRun({ rubric: 0.76 })]);
  const steady = candidate("steady", [mkRun({ rubric: 0.8 }), mkRun({ rubric: 0.92 }), mkRun({ rubric: 0.88 })]);
  assert.equal(isEligible(f, swingy), false);
  assert.equal(isEligible(f, steady), true);
  const v = computeVerdict(f, [swingy, steady]);
  assert.equal(v.recommendation, "steady");
});

test("benchmark candidates are never eligible", () => {
  const s = candidate("claude:opus", [mkRun(), mkRun(), mkRun()], true);
  assert.equal(isEligible(fixture(), s), false);
});

test("ranking falls back to tokens-per-success when prices are unknown", () => {
  const cheapTok = candidate("small", [mkRun({ outTok: 200 }), mkRun({ outTok: 220 }), mkRun({ outTok: 210 })]);
  const bigTok = candidate("large", [mkRun({ outTok: 900 }), mkRun({ outTok: 950 }), mkRun({ outTok: 880 })]);
  const v = computeVerdict(fixture(), [bigTok, cheapTok]);
  assert.equal(v.recommendation, "small");
});

test("pass rate dominates ranking even above the eligibility gate", () => {
  // 100% reliable but pricier beats 80% reliable and cheap: failure costs trust,
  // not just retry tokens.
  const reliable = candidate("reliable", Array.from({ length: 5 }, () => mkRun({ cost: 0.02 })));
  const flakyCheap = candidate("flaky-cheap", [
    ...Array.from({ length: 4 }, () => mkRun({ cost: 0.001 })),
    mkRun({ cost: 0.001, pass: false }),
  ]);
  const v = computeVerdict(fixture(), [flakyCheap, reliable]);
  assert.equal(v.recommendation, "reliable");
});

test("at equal pass rate, cost-per-successful-run decides", () => {
  const pricey = candidate("pricey", Array.from({ length: 3 }, () => mkRun({ cost: 0.02 })));
  const cheap = candidate("cheap", Array.from({ length: 3 }, () => mkRun({ cost: 0.002 })));
  const v = computeVerdict(fixture(), [pricey, cheap]);
  assert.equal(v.recommendation, "cheap");
});

test("hysteresis: challenger that merely ties (not cheaper) does not displace incumbent", () => {
  const f = fixture({ incumbentModel: "incumbent" });
  const incumbent = candidate("incumbent", [mkRun({ outTok: 300 }), mkRun({ outTok: 300 }), mkRun({ outTok: 300 })]);
  const challenger = candidate("challenger", [mkRun({ outTok: 300 }), mkRun({ outTok: 300 }), mkRun({ outTok: 300 })]);
  const v = computeVerdict(f, [challenger, incumbent]);
  assert.equal(v.recommendation, "incumbent");
  assert.match(v.reason, /hysteresis/);
});

test("hysteresis: challenger tying at 100% while cheaper does displace incumbent", () => {
  const f = fixture({ incumbentModel: "incumbent" });
  const incumbent = candidate("incumbent", [mkRun({ outTok: 900 }), mkRun({ outTok: 900 }), mkRun({ outTok: 900 })]);
  const challenger = candidate("challenger", [mkRun({ outTok: 200 }), mkRun({ outTok: 200 }), mkRun({ outTok: 200 })]);
  const v = computeVerdict(f, [challenger, incumbent]);
  assert.equal(v.recommendation, "challenger");
});

test("hysteresis: challenger strictly beating incumbent pass rate displaces it", () => {
  const f = fixture({ incumbentModel: "incumbent", passRateThreshold: 0.6 });
  const incumbent = candidate("incumbent", [mkRun(), mkRun(), mkRun({ pass: false })]); // 0.667
  const challenger = candidate("challenger", [mkRun({ outTok: 2000 }), mkRun({ outTok: 2000 }), mkRun({ outTok: 2000 })]); // 1.0, more expensive
  const v = computeVerdict(f, [challenger, incumbent]);
  assert.equal(v.recommendation, "challenger");
});

test("no eligible model yields a null recommendation, infra-only yields infraIncomplete", () => {
  const f = fixture();
  const broken = candidate("broken", [mkRun({ pass: false }), mkRun({ pass: false }), mkRun({ pass: false })]);
  const v1 = computeVerdict(f, [broken]);
  assert.equal(v1.recommendation, null);
  assert.equal(v1.infraIncomplete, false);

  const infraOnly = candidate("unreachable", [mkRun({ infra: true, pass: false })]);
  const v2 = computeVerdict(f, [infraOnly]);
  assert.equal(v2.infraIncomplete, true);
});

test("benchmarks-only run is not infra-incomplete", () => {
  const bench = candidate("claude:sonnet", [mkRun()], true);
  const v = computeVerdict(fixture(), [bench]);
  assert.equal(v.infraIncomplete, false);
  assert.equal(v.recommendation, null);
});

test("a cheap quality-regressed candidate does not shadow a runner-up that dominates the incumbent", () => {
  // The Sacramento new-model screen: m2.7 ranked cheapest but sat >0.05 below
  // the incumbent on rubric (can't displace), while glm-5.1 was both >10%
  // cheaper AND better than the incumbent. Testing only eligible[0] against
  // the incumbent wrongly retained it.
  const f = fixture({ incumbentModel: "incumbent" });
  const incumbent = candidate("incumbent", Array.from({ length: 3 }, () => mkRun({ rubric: 0.9, outTok: 2533 })));
  const shadow = candidate("shadow-cheap", Array.from({ length: 3 }, () => mkRun({ rubric: 0.78, outTok: 1358 })));
  const dominator = candidate("dominator", Array.from({ length: 3 }, () => mkRun({ rubric: 0.92, outTok: 1689 })));
  const v = computeVerdict(f, [shadow, dominator, incumbent]);
  assert.equal(v.winner, "shadow-cheap"); // cost-rank winner is unchanged
  assert.equal(v.recommendation, "dominator"); // but assignment goes to the displacer
  assert.match(v.reason, /dominator beats incumbent/);
  // and when nobody can displace, the incumbent is retained as before
  const v2 = computeVerdict(f, [shadow, incumbent]);
  assert.equal(v2.recommendation, "incumbent");
  assert.match(v2.reason, /hysteresis/);
});

test("judge failures disqualify: an unscored challenger never displaces the incumbent", () => {
  // The 2026-06-10 outage case: model runs completed, every judge call timed
  // out, and the cost-winning challenger was recommended with zero quality
  // evidence. A judge error is missing evidence, not a pass.
  const f = fixture({ incumbentModel: "incumbent" });
  const incumbent = candidate("incumbent", [
    mkRun({ rubric: 0.9, outTok: 2500 }),
    mkRun({ rubric: 0.95, outTok: 2500 }),
    mkRun({ rubric: 0.92, outTok: 2500 }),
  ]);
  const unjudged = candidate(
    "challenger",
    Array.from({ length: 3 }, () => mkRun({ outTok: 1300, judgeError: "judge timed out after 180000ms" })),
  );
  assert.equal(isEligible(f, unjudged), false);
  const v = computeVerdict(f, [unjudged, incumbent]);
  assert.equal(v.recommendation, "incumbent");
  assert.equal(v.judgeIncomplete, true);
});

test("partial judge failures also disqualify — a missing score can hide a below-floor run", () => {
  const partial = candidate("partial", [
    mkRun({ rubric: 0.9 }),
    mkRun({ rubric: 0.95 }),
    mkRun({ judgeError: "judge timed out after 180000ms" }),
  ]);
  assert.equal(isEligible(fixture(), partial), false);
});

test("runs with no judge attempt at all (--no-judge) stay eligible on gates alone", () => {
  const s = candidate("gates-only", [mkRun(), mkRun(), mkRun()]);
  assert.equal(s.judgeErrors, 0);
  assert.equal(isEligible(fixture(), s), true);
});

test("hysteresis: marginal cost advantage (<10%) does not displace incumbent", () => {
  const f = fixture({ incumbentModel: "incumbent" });
  const incumbent = candidate("incumbent", Array.from({ length: 3 }, () => mkRun({ outTok: 1320 })));
  const challenger = candidate("challenger", Array.from({ length: 3 }, () => mkRun({ outTok: 1306 })));
  const v = computeVerdict(f, [challenger, incumbent]);
  assert.equal(v.recommendation, "incumbent");
});
