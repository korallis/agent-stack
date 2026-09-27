// Unit tests: Jev response validation + policy, and recovery permission rules (no network).
process.env.AGENT_STACK_STATE = (await import("node:fs")).mkdtempSync("/tmp/claude-1000/agst-");
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
