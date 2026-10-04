// A risky feature (features.json risk_tier, starter-kit repos) needs two independent reviews from two families other
// than the author's, plus the owner-approved label, before agent-merge-evidence asks Jev (2026-10-04: a risky PR merged
// with one review and no label because the helper couldn't see tiers).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { featureTier, reviewFamilies, riskProblems, OWNER_LABEL } from "../orchestration/merge-evidence.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const HEAD = "c".repeat(40), OTHER = "d".repeat(40);
const features = [{ id: "F-001", risk_tier: "standard" }, { id: "F-007", risk_tier: "risky" }, { id: "F-009", risk_tier: "trivial" }];

test("featureTier: the highest tier among the features the PR title names; unknown or no F-ids: no tier", () => {
  assert.equal(featureTier(features, "F-007 WP-03: billing").tier, "risky");
  assert.equal(featureTier({ features }, "F-001 F-007: both").tier, "risky", "a { features } file too; the highest wins");
  assert.equal(featureTier(features, "F-001 WP-00: docs").tier, "standard");
  assert.deepEqual(featureTier(features, "F-404: unknown").tier, null);
  assert.deepEqual(featureTier(features, "fix: no feature").ids, []);
  assert.equal(featureTier(null, "F-007: unreadable file").tier, null);
});

const comment = (seat, head, verdict = "PASS") => ({ body: `## ${seat} exact-head review\nhead: ${head}\nVerdict: ${verdict}`, url: `u-${seat}`, kind: undefined });
test("reviewFamilies: distinct passing reviews on this head from families other than the author's", () => {
  const notes = [comment("review-claude-1", HEAD), comment("review-claude-2", HEAD), comment("review-codex-1", HEAD), comment("review-kimi", OTHER),
    comment("review-grok-1", HEAD, "BLOCK"), comment("impl-kimi-1", HEAD)];
  assert.deepEqual(reviewFamilies({ notes, head: HEAD, authorFamily: "codex" }).map((r) => r.family), ["claude"], "same family twice counts once; author's family, another head, a BLOCK and a non-review seat don't count");
  // a GitHub review on the head (family by identity) and the review status (family from its signer) count too
  const gh = { kind: "review", author: "kimi-bot", commit: HEAD, reviewState: "APPROVED", body: "", url: "r1" };
  const status = { state: "success", description: "review-grok-1: exact head PASS", url: "s1" };
  assert.deepEqual(reviewFamilies({ notes: [...notes, gh], head: HEAD, authorFamily: "codex", identities: { "kimi-bot": "kimi" }, status }).map((r) => r.family).sort(), ["claude", "grok", "kimi"]);
  assert.deepEqual(reviewFamilies({ notes: [{ ...gh, commit: OTHER }], head: HEAD, authorFamily: "codex", identities: { "kimi-bot": "kimi" } }), [], "a review of another commit");
  // QA PR174: dismissed or pending GitHub reviews never count, even when their body says PASS
  for (const reviewState of ["DISMISSED", "PENDING"])
    assert.deepEqual(reviewFamilies({ notes: [{ ...gh, reviewState, body: `## review-kimi\nhead: ${HEAD}\nVerdict: PASS` }], head: HEAD, authorFamily: "codex", identities: { "kimi-bot": "kimi" } }), [], reviewState);
  // a reviewer's later BLOCK on this head withdraws its earlier PASS (by seat, for comments and reviews alike)
  assert.deepEqual(reviewFamilies({ notes: [comment("review-kimi", HEAD), comment("review-kimi", HEAD, "BLOCK")], head: HEAD, authorFamily: "codex" }), []);
  assert.deepEqual(reviewFamilies({ notes: [comment("review-kimi", HEAD, "BLOCK"), comment("review-kimi", HEAD)], head: HEAD, authorFamily: "codex" }).map((r) => r.family), ["kimi"], "a PASS after the BLOCK counts");
  assert.deepEqual(reviewFamilies({ notes: [gh, { ...gh, reviewState: "CHANGES_REQUESTED", url: "r2" }], head: HEAD, authorFamily: "codex", identities: { "kimi-bot": "kimi" } }), [], "the same login's later change request");
  assert.deepEqual(reviewFamilies({ notes: [comment("review-claude-1", HEAD), comment("review-claude-2", HEAD, "BLOCK")], head: HEAD, authorFamily: "codex" }).map((r) => r.family), ["claude"], "another seat's BLOCK doesn't withdraw this seat's PASS");
  // an unknown author family counts nothing (the other collectors refuse it too)
  assert.deepEqual(reviewFamilies({ notes, head: HEAD, authorFamily: null }), []);
});

test("riskProblems: a risky PR needs two review families and the owner-approved label; other tiers need nothing more", () => {
  const risky = { tier: "risky", features: [{ id: "F-007", tier: "risky" }] };
  const p = riskProblems({ ...risky, authorFamily: "codex", reviewFamilies: [{ family: "claude" }], ownerApproved: false });
  assert.equal(p.length, 2);
  assert.match(p[0], /^MISSING: a second independent review from another family \(risky F-007 .*have claude\)/);
  assert.match(p[1], new RegExp(`^MISSING: the ${OWNER_LABEL} label`));
  assert.deepEqual(riskProblems({ ...risky, authorFamily: "codex", reviewFamilies: [{ family: "claude" }, { family: "kimi" }], ownerApproved: true }), []);
  assert.deepEqual(riskProblems({ ...risky, authorFamily: "codex", reviewFamilies: [{ family: "claude" }, { family: "kimi" }], ownerApproved: false }).length, 1);
  assert.deepEqual(riskProblems({ tier: "standard", features: [], reviewFamilies: [], ownerApproved: false }), []);
  assert.match(riskProblems({ ...risky, authorFamily: null, reviewFamilies: [], ownerApproved: true })[0], /^MISSING: the PR author's model family \(unknown/);
  assert.deepEqual(riskProblems(null), []);
});

test("fail closed (operator 2026-10-04): a features.json that exists but is unreadable, or an F-id not in it, is 'tier unknown'; no features.json keeps no tier", () => {
  const unreadable = riskProblems({ ...featureTier(null, "F-007: x"), featuresFile: "unreadable", featuresError: "HTTP 500" });
  assert.deepEqual(unreadable, ["MISSING: the risk tier of F-007 (features.json exists but couldn't be read: HTTP 500)"]);
  const notIn = riskProblems({ ...featureTier(features, "F-001 F-404: x"), featuresFile: "read", reviewFamilies: [], ownerApproved: false });
  assert.deepEqual(notIn, ["MISSING: the risk tier of F-404 (not in features.json; fix the PR title's F-id or add the feature)"]);
  assert.deepEqual(riskProblems({ ...featureTier(null, "F-007: x"), featuresFile: "absent" }), [], "no features.json: no tier, nothing more required");
  assert.deepEqual(riskProblems({ ...featureTier(features, "F-001: x"), featuresFile: "read" }), [], "every F-id known, standard");
  // the CLI: a 404 is absent, anything else unreadable
  const src = fs.readFileSync(join(repo, "orchestration/merge-evidence.js"), "utf8");
  assert.match(src, /featuresFile = \/HTTP 404\|Not Found\/i\.test\(why\) \? "absent" : "unreadable"/);
});

test("the CLI holds a risky PR with MISSING lines before Jev is asked; gather reads features.json on the base and the labels", () => {
  const src = fs.readFileSync(join(repo, "orchestration/merge-evidence.js"), "utf8");
  assert.ok(src.indexOf("const riskMissing = riskProblems(facts.risk);") < src.indexOf('const rec = await decideOrStub("review.merge_gate"'), "the risk check comes before the Jev call");
  assert.match(src, /if \(riskMissing\.length\) \{[\s\S]{0,300}Jev was not asked[\s\S]{0,120}process\.exit\(1\)/);
  assert.match(src, /contents\/features\.json\?ref=\$\{encodeURIComponent\(v\.baseRefName\)\}/); assert.match(src, /mergeStateStatus,reviewDecision,isDraft,comments,reviews,labels"/);
  const role = fs.readFileSync(join(repo, "rig/template/agents/integrator/guidance/role.md"), "utf8");
  assert.match(role, /a risky feature .*agent-merge-evidence holds it .*two independent reviews from two families .*owner-approved/);
});
