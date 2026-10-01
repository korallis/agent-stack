// WO75 (owner decision, 2026-10-01): review.merge_gate v2 lets a tests-first PR merge when its only failing tests fail
// at the step that needs the not-yet-built feature, and still holds the look-alikes. Live Jev results (diagnosis calls)
// are in test/fixtures/merge-gate-tests-first/RESULTS.md; this pins the rule's text and the fixtures it was measured on.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const YAML = createRequire(join(repo, "jev/package.json"))("yaml");
const gate = YAML.parse(fs.readFileSync(join(repo, "config/decisions.yaml"), "utf8")).decisions["review.merge_gate"];
const q = gate.outputs.decision.question;
const instr = q.instructions.join(" ");
const dir = join(repo, "test/fixtures/merge-gate-tests-first");
const fx = Object.fromEntries(fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => [f.replace(/\.json$/, ""), JSON.parse(fs.readFileSync(join(dir, f), "utf8"))]));

test("review.merge_gate is version 2 and states the tests-first rule and every exception", () => {
  assert.equal(gate.version, 2);
  assert.deepEqual(gate.outputs.decision.uncertain_labels, ["hold"]);
  assert.deepEqual(gate.fallback, [{ kind: "code", result: { decision: "hold" } }], "unchanged: no Jev, no merge");
  assert.match(instr, /Test-first process: acceptance tests for a feature are reviewed and merged BEFORE the feature is built/);
  assert.match(instr, /only tests, journeys, their fixtures and test helpers change; no application, schema, build or production file/);
  assert.match(instr, /fail exactly at the step needing the unbuilt feature/);
  assert.match(instr, /when the PR changes any non-test file/);
  assert.match(instr, /a bare count such as '2 failed' names no step/);
  assert.match(instr, /a test fails at a step that is already built/);
  assert.match(instr, /The exception never covers CI: every required CI check must pass on this head, tests-first included/);
  assert.match(q.criteria.merge, /for a tests-only PR, tests failing only at the step that needs the unbuilt feature, as the evidence says, are expected/);
  assert.match(q.criteria.hold, /non-test code changed, a test fails at an already-built step, or the evidence does not say where its tests fail/);
});

test("the measured fixtures are complete gate inputs, anonymised, and each negative differs from the positive only in its case", () => {
  const required = gate.inputs.required;
  assert.deepEqual(Object.keys(fx).sort(), ["app-file-changed", "failure-at-built-step", "missing-review", "no-failure-location", "positive", "red-ci"]);
  for (const [name, input] of Object.entries(fx)) {
    for (const k of required) assert.equal(typeof input[k], "string", `${name}.${k}`);
    assert.doesNotMatch(JSON.stringify(input), /\/home\/|github\.com\/|@[a-z]+\.(com|io)/i, `${name} carries no paths, links or addresses`);
  }
  const p = fx.positive;
  assert.match(p.change, /Tests only/); assert.match(p.ci, /all pass/);
  assert.match(p.review, /failed at the absent, not-yet-built Export report page/);
  assert.match(fx["app-file-changed"].change, /app\/reports\/export\.ts/);
  assert.match(fx["failure-at-built-step"].review, /failed at the sign-in step, which is already built/);
  assert.match(fx["red-ci"].ci, /acceptance=fail/);
  assert.match(fx["missing-review"].review, /^review verdict: none for this head/);
  assert.doesNotMatch(fx["no-failure-location"].review, /failed at/);
  assert.match(fx["no-failure-location"].review, /Runner: 2 failed/);
});
