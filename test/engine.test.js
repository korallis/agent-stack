// Unit tests: Jev response validation + policy, and recovery permission rules (no network).
process.env.AGENT_STACK_STATE = (await import("node:fs")).mkdtempSync(`${(await import("node:os")).tmpdir()}/agst-`);
import { test } from "node:test";
import assert from "node:assert/strict";
const { buildRequest, validateResponse, applyPolicy, ValidationError, InputError } = await import("../jev/lib/engine.js");
const { redactString } = await import("../jev/lib/redact.js");

const req = buildRequest("recovery.classify_error", { error: "boom" });
const labels = Object.keys(req.questions.class.criteria);
const good = { model: "jev-1.13.0", usage: {}, answers: { class: { type: "choice", choice: "network", confidence: 0.9,
  probabilities: Object.fromEntries(labels.map((l) => [l, l === "network" ? 0.95 : 0.05 / (labels.length - 1)])) } } };

test("valid choice passes and maps to act band", () => {
  validateResponse(req, good);
  assert.deepEqual(applyPolicy(req, good.answers).band, "act");
});
test("choice outside the candidate set is rejected", () => {
  const bad = structuredClone(good); bad.answers.class.choice = "delete_everything";
  assert.throws(() => validateResponse(req, bad), ValidationError);
});
test("probabilities must sum to ~1", () => {
  const bad = structuredClone(good); bad.answers.class.probabilities.network = 3;
  assert.throws(() => validateResponse(req, bad), ValidationError);
});
test("missing answer is malformed", () => {
  assert.throws(() => validateResponse(req, { model: "jev-1.13.0", answers: {} }), ValidationError);
});
test("unclear label is always uncertain even at high confidence", () => {
  const a = structuredClone(good.answers); a.class.choice = "unclear"; a.class.confidence = 1;
  assert.equal(applyPolicy(req, a).band, "uncertain");
});
test("noul carrying a confidence field is rejected (Noul has none)", () => {
  const r = buildRequest("review.completion_claim", { claim: "done", evidence: "x" });
  const answers = Object.fromEntries(Object.keys(r.questions).map((k) => [k, { type: "noul", noul: 0.9, confidence: 0.9 }]));
  assert.throws(() => validateResponse(r, { model: "m", answers }), ValidationError);
});
test("noul thresholds: only critical items escalate", () => {
  const r = buildRequest("intake.paths", { task: "x" });
  const answers = Object.fromEntries(Object.keys(r.questions).map((k) => [k, { type: "noul", noul: 0.5 }]));
  assert.equal(applyPolicy(r, answers).band, "review");          // intake.paths: critical: []
  const r2 = buildRequest("review.completion_claim", { claim: "c", evidence: "e" });
  const a2 = Object.fromEntries(Object.keys(r2.questions).map((k) => [k, { type: "noul", noul: 0.5 }]));
  assert.equal(applyPolicy(r2, a2).band, "uncertain");           // critical: all
});
test("unknown input fields are never forwarded; secrets are redacted", () => {
  const r = buildRequest("recovery.classify_error", { error: "token=sk-abcdefghijklmnopqrstuv failed", password: "hunter2", extra: "x" });
  assert.equal(r.state.password, undefined); assert.equal(r.state.extra, undefined);
  assert.ok(!r.stateJson.includes("sk-abcdefghijklmnopqrstuv"));
});
test("oversized candidate sets are refused (pre-filter with search first)", () => {
  const cands = Array.from({ length: 41 }, (_, i) => ({ id: `f${i}`, text: "x" }));
  assert.throws(() => buildRequest("context.rerank", { query: "q", candidates: cands }), InputError);
});
test("redaction covers common credential shapes", () => {
  for (const s of ["ghp_abcdefghijklmnopqrstuvwxyz123456", "AKIAABCDEFGHIJKLMNOP", "Bearer abcdefghijklmnopqrstuvwxyz", "apikey_abcdef0123456789abcdef"])
    assert.ok(!redactString(`x ${s} y`).includes(s), s);
});

// Owner rule 2026-10-02 "Jev decides; research feeds Jev": the generic bounded choice for scope and option rulings.
test("decide.option: question and criteria required, 2-12 caller options, picks only among them; none_fit and low confidence never act", () => {
  const input = { question: "Which scope for the login slice?", criteria: "Ships this week; no schema change", evidence: "spike notes",
    candidates: [{ id: "email", text: "Email and password only" }, { id: "sso", text: "Add SSO now" }] };
  const r = buildRequest("decide.option", input);
  assert.equal(r.def.version, 1);
  assert.deepEqual(Object.keys(r.questions.option.criteria).sort(), ["email", "none_fit", "sso"], "the caller's options plus none_fit, nothing else");
  assert.throws(() => buildRequest("decide.option", { ...input, criteria: undefined }), InputError);
  assert.throws(() => buildRequest("decide.option", { question: "q", criteria: "c" }), InputError, "options are required");
  assert.throws(() => buildRequest("decide.option", { ...input, candidates: [{ id: "only", text: "x" }] }), /too few candidates \(1 < 2\)/, "one option is not a choice");
  assert.throws(() => buildRequest("decide.option", { ...input, candidates: Array.from({ length: 13 }, (_, i) => ({ id: `o${i}`, text: "x" })) }), InputError);
  const answer = (choice, confidence) => ({ option: { type: "choice", choice, confidence,
    probabilities: { email: choice === "email" ? confidence : (1 - confidence) / 2, sso: choice === "sso" ? confidence : (1 - confidence) / 2, none_fit: choice === "none_fit" ? confidence : (1 - confidence) / 2 } } });
  validateResponse(r, { model: "jev-1.13.0", usage: {}, answers: answer("email", 0.8) });
  assert.equal(applyPolicy(r, answer("email", 0.8)).band, "act");
  assert.equal(applyPolicy(r, answer("email", 0.4)).band, "review");
  assert.equal(applyPolicy(r, answer("none_fit", 0.99)).band, "uncertain", "none of the options fits: never an act");
  assert.throws(() => validateResponse(r, { model: "jev-1.13.0", usage: {}, answers: answer("rewrite_everything", 0.9) }), ValidationError, "never outside the caller's options");
  assert.deepEqual(r.def.fallback, [{ kind: "code", result: { option: "none_fit" } }], "no model guesses when Jev is out: the caller escalates");
});
