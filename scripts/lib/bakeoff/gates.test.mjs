import { test } from "node:test";
import assert from "node:assert/strict";

import { evaluateGates, getPath } from "./gates.mjs";

const baseFixture = {
  toolContract: [],
  outputAssertions: [],
  forbiddenTools: [],
};

const run = (overrides = {}) => ({ text: "", toolCalls: [], ...overrides });

test("getPath walks nested paths and '.' targets the whole object", () => {
  const obj = { a: { b: [{ c: 7 }] } };
  assert.equal(getPath(obj, "a.b.0.c"), 7);
  assert.equal(getPath(obj, "."), obj);
  assert.equal(getPath(obj, "a.x"), undefined);
});

test("toolContract: missing required tool fails, present passes", () => {
  const fixture = { ...baseFixture, toolContract: [{ name: "osrm_route" }] };
  assert.equal(evaluateGates(fixture, run()).pass, false);
  assert.equal(evaluateGates(fixture, run({ toolCalls: [{ name: "osrm_route", input: {} }] })).pass, true);
});

test("toolContract: minCalls enforced", () => {
  const fixture = { ...baseFixture, toolContract: [{ name: "t", minCalls: 2 }] };
  const one = run({ toolCalls: [{ name: "t", input: {} }] });
  const two = run({ toolCalls: [{ name: "t", input: {} }, { name: "t", input: {} }] });
  assert.equal(evaluateGates(fixture, one).pass, false);
  assert.equal(evaluateGates(fixture, two).pass, true);
});

test("argChecks: each check satisfied by at least one call (different calls allowed)", () => {
  const fixture = {
    ...baseFixture,
    toolContract: [{
      name: "osrm_route",
      argChecks: [
        { path: ".", matches: "san ?mateo" },
        { path: ".", matches: "sacramento" },
      ],
    }],
  };
  const split = run({
    toolCalls: [
      { name: "osrm_route", input: { destination: "San Mateo, CA" } },
      { name: "osrm_route", input: { waypoints: ["Sacramento, CA"] } },
    ],
  });
  assert.equal(evaluateGates(fixture, split).pass, true);

  const garbage = run({ toolCalls: [{ name: "osrm_route", input: { destination: "Portland" } }] });
  const result = evaluateGates(fixture, garbage);
  assert.equal(result.pass, false);
  assert.equal(result.failures.length, 2);
});

test("argChecks: equals and exists modes", () => {
  const fixture = {
    ...baseFixture,
    toolContract: [{
      name: "t",
      argChecks: [
        { path: "mode", equals: "dry_run" },
        { path: "confirm", exists: false },
      ],
    }],
  };
  assert.equal(evaluateGates(fixture, run({ toolCalls: [{ name: "t", input: { mode: "dry_run" } }] })).pass, true);
  assert.equal(evaluateGates(fixture, run({ toolCalls: [{ name: "t", input: { mode: "live", confirm: true } }] })).pass, false);
});

test("anyOf: passes when any branch passes, fails when none do", () => {
  const fixture = {
    ...baseFixture,
    toolContract: [{
      name: "osrm_route",
      anyOf: [
        { minCalls: 2 },
        { argChecks: [{ path: "routes.1", exists: true }] },
      ],
    }],
  };
  const twoCalls = run({ toolCalls: [{ name: "osrm_route", input: {} }, { name: "osrm_route", input: {} }] });
  const oneCallWithRoutes = run({ toolCalls: [{ name: "osrm_route", input: { routes: [{ label: "a" }, { label: "b" }] } }] });
  const oneBareCall = run({ toolCalls: [{ name: "osrm_route", input: { destination: "x" } }] });
  assert.equal(evaluateGates(fixture, twoCalls).pass, true);
  assert.equal(evaluateGates(fixture, oneCallWithRoutes).pass, true);
  assert.equal(evaluateGates(fixture, oneBareCall).pass, false);
});

test("forbiddenTools fail the run", () => {
  const fixture = { ...baseFixture, forbiddenTools: ["submit_order"] };
  assert.equal(evaluateGates(fixture, run({ toolCalls: [{ name: "submit_order", input: {} }] })).pass, false);
  assert.equal(evaluateGates(fixture, run()).pass, true);
});

test("outputAssertions: includes / notMatches", () => {
  const fixture = {
    ...baseFixture,
    outputAssertions: [
      { type: "includes", value: "I-5" },
      { type: "notMatches", value: "i (have )?verified" },
    ],
  };
  assert.equal(evaluateGates(fixture, run({ text: "Take I-5 south." })).pass, true);
  assert.equal(evaluateGates(fixture, run({ text: "I verified the route; take I-5." })).pass, false);
  assert.equal(evaluateGates(fixture, run({ text: "no highway mentioned" })).pass, false);
});

test("infraError short-circuits as infra, not a model failure", () => {
  const result = evaluateGates(baseFixture, run({ infraError: "ECONNREFUSED 127.0.0.1:9100" }));
  assert.equal(result.pass, false);
  assert.equal(result.infra, true);
});

test("model-level error fails the completion gate", () => {
  const result = evaluateGates(baseFixture, run({ error: "prompt too long" }));
  assert.equal(result.pass, false);
  assert.equal(result.infra, false);
  assert.equal(result.failures[0].gate, "completion");
});
