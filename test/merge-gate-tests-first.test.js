// WO75 (owner decision, 2026-10-01): review.merge_gate v2 lets a tests-first PR merge when its only failing tests fail
// at the step that needs the not-yet-built feature, and still holds the look-alikes. Live Jev results (diagnosis calls)
// are in test/fixtures/merge-gate-tests-first/RESULTS.md; this pins the rule's text and the fixtures it was measured on.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { testScope, outcome } from "../orchestration/merge-evidence.js";

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
  assert.match(instr, /its change carries the line 'scope \(from the diff\): tests-only', computed from the diff/);
  assert.match(instr, /tests that QA actually ran \(on this head, or on an earlier commit when the evidence shows the test files unchanged since, a carried run\) and saw fail exactly at the step needing the unbuilt feature, with the run's result in the evidence/);
  assert.match(instr, /QA's verdict for this head is FAIL or there is no QA verdict for it at all \(the exception never replaces the QA gate\)/);
  assert.match(instr, /when the scope line says NOT tests-only, says unknown, or is absent/);
  assert.match(instr, /when QA did not run the tests \(a predicted or inferred failure/);
  assert.match(instr, /a bare count such as '2 failed' names no step/);
  assert.match(instr, /a test fails at a step that is already built/);
  assert.match(instr, /The exception never covers CI: every required CI check must pass on this exact head, tests-first included/);
  assert.match(instr, /or CI results that name another commit than head, are a blocker/);
  assert.match(q.criteria.merge, /for a tests-only PR, tests failing only at the step that needs the unbuilt feature, as the evidence says, are expected/);
  assert.match(q.criteria.hold, /non-test code changed, a test fails at an already-built step, or the evidence does not say where its tests fail/);
});

test("the measured fixtures are complete gate inputs, anonymised, carry the builder's scope line, and differ from the positive only in their case", () => {
  assert.deepEqual(Object.keys(fx).sort(), ["app-file-changed", "failure-at-built-step", "failure-not-observed", "missing-review", "no-failure-location",
    "positive", "qa-fail", "qa-missing", "red-ci", "stale-ci"]);
  for (const [name, input] of Object.entries(fx)) {
    for (const k of gate.inputs.required) assert.equal(typeof input[k], "string", `${name}.${k}`);
    assert.doesNotMatch(JSON.stringify(input), /\/home\/|github\.com\/|@[a-z]+\.(com|io)/i, `${name} carries no paths, links or addresses`);
    assert.match(input.change, name === "app-file-changed" ? /\nscope \(from the diff\): NOT tests-only, 1 non-test path\(s\): app\/reports\/export\.ts/ : /\nscope \(from the diff\): tests-only, 3 path\(s\)/, name);
  }
  const p = fx.positive;
  assert.match(p.ci, /all pass/); assert.match(p.review, /QA actually executed .* then failed at the absent, not-yet-built Export report page/);
  assert.match(fx["failure-at-built-step"].review, /failed at the sign-in step, which is already built/);
  assert.match(fx["failure-not-observed"].review, /QA did not run the journeys\. Source inspection suggests/);
  assert.match(fx["qa-fail"].review, /verdict=FAIL .* QA verdict FAIL: Ship NO/);
  assert.match(fx["qa-missing"].review, /QA proof: MISSING for this head/);
  assert.match(fx["red-ci"].ci, /acceptance=fail/);
  assert.match(fx["stale-ci"].ci, /no CI results exist on the current PR head/); assert.doesNotMatch(fx["stale-ci"].ci, new RegExp(p.head));
  assert.match(fx["missing-review"].review, /^review verdict: none for this head/);
  assert.doesNotMatch(fx["no-failure-location"].review, /failed at/);
});

test("testScope: tests-only from the diff, or the non-test paths named; a rename counts only when both sides are tests", () => {
  const f = (path, oldPath = path) => ({ path, oldPath, added: [], removed: [] });
  assert.match(testScope([f("tests/acceptance/F-1/a.spec.ts"), f("tests/acceptance/fixtures/seed/F-1.json"), f("src/x.test.ts"), f("e2e/flow.ts")]),
    /^scope \(from the diff\): tests-only, 4 path\(s\), all tests, fixtures or test helpers: /);
  assert.equal(testScope([f("tests/a.spec.ts"), f("app/reports/export.ts")]), "scope (from the diff): NOT tests-only, 1 non-test path(s): app/reports/export.ts (plus 1 test path(s))");
  assert.equal(testScope([f("tests/x.ts", "src/x.ts")]), "scope (from the diff): NOT tests-only, 1 non-test path(s): src/x.ts → tests/x.ts");
  assert.equal(testScope([{ ...f("tests/a.ts"), unknown: true }]).startsWith("scope (from the diff): NOT tests-only"), true, "an unreadable entry is never tests-only");
  assert.equal(testScope([]), "scope (from the diff): unknown, the diff could not be read");
  // QA PR80: runtime specs, API schemas, CI under a test-named dir, manifests, configs and migrations are never tests
  for (const p of ["packages/daemon/specs/rigs/launch/kernel/rig.yaml", "spec/openapi.yaml", ".github/workflows/test/ci.yaml", "tests/package.json",
    "tests/playwright.config.ts", "test/migrations/0001.sql", "e2e/Dockerfile", "tests/schema/user.json", "db/schema.prisma"])
    assert.match(testScope([f(p)]), /^scope \(from the diff\): NOT tests-only/, p);
  assert.match(testScope([f("tests/acceptance/fixtures/seed/F-1.json"), f("tests/acceptance/F-1/flow.spec.ts")]), /tests-only, 2 path/);
});

test("outcome (QA PR80): a live Jev merge in the act band still HOLDs when a deterministic gate isn't green", () => {
  const rec = { decided_by: "jev", band: "act", result: { decision: "merge" }, signals: { decision: { confidence: 0.9 } } };
  const green = { head: "a".repeat(40), isDraft: false, mergeable: "MERGEABLE", mergeState: "CLEAN", checks: [{ name: "ci", bucket: "pass" }],
    reviewVerdict: { state: "success" }, brb: { artifact_type: "qa", verdict: "PASS", candidate_sha: "a".repeat(40) },
    scope: "scope (from the diff): tests-only, 1 path(s), all tests, fixtures or test helpers: tests/a.spec.ts" };
  assert.equal(outcome(rec, green).code, 0);
  for (const [why, facts] of [["QA FAIL", { ...green, brb: { ...green.brb, verdict: "FAIL" } }], ["no QA", { ...green, brb: null }],
    ["red check", { ...green, checks: [{ name: "ci", bucket: "fail" }] }], ["no checks", { ...green, checks: [] }],
    ["review missing", { ...green, reviewVerdict: { state: null, why: "none" } }],
    ["diff unreadable", { ...green, scope: "scope (from the diff): unknown, the diff could not be read" }], ["no scope line", { ...green, scope: undefined }]]) {
    const o = outcome(rec, facts);
    assert.equal(o.code, 1, why); assert.match(o.text, /live Jev merge in the act band, but a gate this helper checks is not green/, why);
  }
});
