// A risky feature (features.json risk_tier, starter-kit repos) needs two independent reviews from two families other
// than the author's, plus the owner-approved label, before agent-merge-evidence asks Jev (2026-10-04: a risky PR merged
// with one review and no label because the helper couldn't see tiers).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { featureTier, reviewFamilies, riskProblems, OWNER_LABEL, statusReviewers, branchSeat, familyOf, carryProblems, buildMergeInput, REDUCED_LABEL } from "../orchestration/merge-evidence.js";

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

// 2026-10-04: every reviewer posts the independent-review status from ONE GitHub account, so the combined status shows
// only the newest. The full list (one project's PR at 96b7d3a: three successes) must count every seat.
test("independent-review statuses: every seat's newest, bound to this head, by the description's seat prefix", () => {
  const H = "96b7d3a86d1af4b7862f260cc182641ced03de25", pr = 68, u = (x) => `https://github.com/o/r/pull/68#${x}`;
  const st = (at, state, desc, url) => ({ context: "independent-review", created_at: at, state, description: desc, target_url: url });
  const statuses = [
    st("2026-10-04T05:43:16Z", "success", "review-codex (Codex): clean at exact head 96b7d3a", u("pullrequestreview-1")),
    st("2026-10-04T04:27:56Z", "success", "review-kimi (Kimi K3): merge-only refresh clean at exact head 96b7d3a", u("pullrequestreview-2")),
    st("2026-10-04T04:02:45Z", "success", "arch-claude (Opus): delta confirm at exact head 96b7d3a", u("issuecomment-3")),
    { context: "jev-merge", created_at: "2026-10-04T05:50:00Z", state: "success", description: "review-grok: other context" },
  ];
  assert.deepEqual(statusReviewers(statuses, { head: H, pr }).map((r) => [r.seat, r.family, r.state]),
    [["review-codex", "codex", "success"], ["review-kimi", "kimi", "success"], ["arch-claude", "claude", "success"]]);
  assert.deepEqual(reviewFamilies({ head: H, authorFamily: "grok", statuses, pr }).map((r) => r.family).sort(), ["claude", "codex", "kimi"]);
  assert.deepEqual(reviewFamilies({ head: H, authorFamily: "claude", statuses, pr }).map((r) => r.family).sort(), ["codex", "kimi"], "the author's family never counts");
  // the author of that PR, from its branch: tests/impl-claude-ui-... is a claude seat's
  assert.equal(familyOf(branchSeat("tests/impl-claude-ui-f006-tighten")), "claude");
  for (const b of ["agent/impl-codex-2-x", "wp/impl-kimi-1-y", "plan/arch-grok-z"]) assert.ok(familyOf(branchSeat(b)), b);
  assert.equal(branchSeat("feature/x"), null);
  // a seat's newer non-success withdraws its older success; a status naming another head, or none and off this PR, doesn't count
  const blocked = [...statuses, st("2026-10-04T06:00:00Z", "failure", "review-kimi (Kimi K3): BLOCK at exact head 96b7d3a", u("x"))];
  assert.deepEqual(reviewFamilies({ head: H, authorFamily: "claude", statuses: blocked, pr }).map((r) => r.family), ["codex"]);
  const other = [st("2026-10-04T05:00:00Z", "success", "review-kimi (Kimi K3): clean at exact head 1234567", u("y")), st("2026-10-04T05:00:00Z", "success", "review-grok: clean", "https://github.com/o/r/pull/69#z")];
  assert.deepEqual(statusReviewers(other, { head: H, pr }), [], "another head, or another PR's link");
  assert.deepEqual(statusReviewers([st("2026-10-04T05:00:00Z", "success", "review-grok: clean, no sha", u("w"))], { head: H, pr }).map((r) => r.family), ["grok"], "no sha but a link on this PR");
  // statuses and comments of one seat: the newest wins
  const comment = (at, verdict) => ({ body: `## review-kimi\nhead: ${H}\nVerdict: ${verdict}`, at, url: "c" });
  assert.deepEqual(reviewFamilies({ notes: [comment("2026-10-04T07:00:00Z", "BLOCK")], head: H, authorFamily: "claude", statuses, pr }).map((r) => r.family), ["codex"], "a later BLOCK comment withdraws the seat's earlier status");
});

// 2026-10-04: a risky feature's PR named it only in its body ("Implement F-006 ...", title "feat: ..."), so the tier was
// never read and the gate passed without the owner-approved label.
test("the risk tier comes from the F-ids in the PR's title OR body (the highest wins)", () => {
  const pr = { title: "feat: dispatch assignments from native evidence", body: "Implement F-007 dispatch.\n\n- F-001 journeys pass" };
  const t = featureTier(features, `${pr.title}\n${pr.body}`);
  assert.deepEqual([t.tier, t.ids], ["risky", ["F-007", "F-001"]]);
  assert.match(riskProblems({ ...t, featuresFile: "read", authorFamily: "codex", reviewFamilies: [{ family: "claude" }, { family: "kimi" }], ownerApproved: false })[0], /^MISSING: the owner-approved label/);
  const src = fs.readFileSync(join(repo, "orchestration/merge-evidence.js"), "utf8");
  assert.match(src, /const named = `\$\{v\.title \|\| ""\}\\n\$\{v\.body \|\| ""\}`;\n  if \(\/\\bF-\\d\{3,\}\\b\/\.test\(named\)\) \{/);
  assert.match(src, /const t = featureTier\(features, named\);/);
});

// Review carry (operator 2026-10-04): a review of commit A counts for head B only when the helper proves (1) A is an
// ancestor of B, (2) the PR's own files are byte-identical, (3) A..B changed only base-branch paths, (4) required CI is
// green on B, and the seat itself passed at A. Risky: at least one family must still be fresh.
const ok = { ancestor: true, filesA: { "src/a.ts": "b1", "test/a.ts": "b2" }, filesB: { "src/a.ts": "b1", "test/a.ts": "b2" }, abPaths: ["docs/x.md", "lib/y.ts"],
  basePaths: ["docs/x.md", "lib/y.ts", "lib/z.ts"], ciGreen: true, seatPassedAtA: true, seat: "review-kimi", from: "e311017" };
test("carryProblems: each of (1) to (4), and the seat's own pass at A, fails on its own", () => {
  assert.deepEqual(carryProblems(ok), []);
  const one = (patch, re) => { const p = carryProblems({ ...ok, ...patch }); assert.equal(p.length, 1, JSON.stringify(p)); assert.match(p[0], re); };
  one({ ancestor: false }, /^\(1\) e311017 is not an ancestor of the head/);
  one({ filesB: { ...ok.filesB, "src/a.ts": "CHANGED" } }, /^\(2\) the PR's own files differ between e311017 and the head: src\/a\.ts/);
  one({ filesB: { ...ok.filesB, "src/new.ts": "b9" } }, /^\(2\) .*src\/new\.ts/);
  one({ abPaths: [...ok.abPaths, "src/a.ts"] }, /^\(3\) changes from e311017 to the head that didn't come from the base branch: src\/a\.ts/);
  one({ ciGreen: false }, /^\(4\) required CI isn't green on the head/);
  one({ seatPassedAtA: false }, /^review-kimi has no passing review of its own at e311017/);
  one({ filesA: null }, /^\(2\) the PR's change set couldn't be read/);
  one({ basePaths: null }, /^\(3\) what changed .* couldn't be read/);
});

test("a 'carried from' status counts only when proven, is marked carried, and a risky PR needs one fresh family", () => {
  const H = "547a9683551509c3097cd677d44beb0e1b9d6f12", pr = 92, u = (x) => `https://github.com/o/r/pull/92#${x}`;
  const st = (desc, at = "2026-10-04T10:00:00Z") => ({ context: "independent-review", created_at: at, state: "success", description: desc, target_url: u(at) });
  const statuses = [st("review-kimi (Kimi K3): carried from e311017; PR files byte-identical at 547a968", "2026-10-04T11:00:00Z"), st("review-codex (Codex): clean exact-head review at 547a968")];
  assert.deepEqual(statusReviewers(statuses, { head: H, pr }).map((r) => [r.seat, r.carriedFrom]), [["review-kimi", "e311017"], ["review-codex", null]], "the carried-from sha doesn't unbind it from the head");
  const proven = []; const fams = reviewFamilies({ head: H, authorFamily: "claude", statuses, pr, carries: proven, carry: () => ({ ok: true, problems: [] }) });
  assert.deepEqual(fams.map((f) => [f.family, f.carried ?? null]).sort(), [["codex", null], ["kimi", "e311017"]]);
  assert.deepEqual(proven.map((c) => [c.seat, c.from, c.ok]), [["review-kimi", "e311017", true]]);
  const refused = []; const only = reviewFamilies({ head: H, authorFamily: "claude", statuses, pr, carries: refused, carry: () => ({ ok: false, problems: ["(3) changes that didn't come from the base branch: src/a.ts"] }) });
  assert.deepEqual(only.map((f) => f.family), ["codex"], "an unproven carry counts for nothing");
  assert.deepEqual(reviewFamilies({ head: H, authorFamily: "claude", statuses, pr }).map((f) => f.family), ["codex"], "no prover: no carry");
  // risky: two families but both carried: a fresh one is MISSING; one fresh plus one carried: fine
  const risky = { tier: "risky", features: [{ id: "F-010" }], authorFamily: "claude", ownerApproved: true };
  assert.match(riskProblems({ ...risky, reviewFamilies: [{ family: "kimi", carried: "e311017" }, { family: "codex", carried: "e311017" }] })[0], /^MISSING: a fresh exact-head review from at least one family/);
  assert.deepEqual(riskProblems({ ...risky, reviewFamilies: [{ family: "kimi", carried: "e311017" }, { family: "codex" }] }), []);
  // Jev sees it as carried, proven or refused, never as a fresh review
  const base = { head: H, pr, base: "b".repeat(40), checks: [], reviewVerdict: null, independentReview: null };
  const inp = (carries) => String(buildMergeInput({ ...base, risk: { carries } }).review);
  assert.match(inp([{ seat: "review-kimi", from: "e31101734cf0316850418909455b6b13b7645af2", ok: true, problems: [] }]), /carried review: review-kimi, carried from e31101734cf0 to 547a968[0-9a-f]+: proven by this helper .*NOT a fresh review of this head/);
  assert.match(inp([{ seat: "review-kimi", from: "e311017", ok: false, problems: ["(1) e311017 is not an ancestor of the head"] }]), /carried review NOT accepted: review-kimi, claimed carried from e311017: \(1\) e311017 is not an ancestor/);
});

test("proveCarry fails closed on GitHub's 300-file compare cap (a truncated list could hide a changed PR file)", () => {
  const src = fs.readFileSync(join(repo, "orchestration/merge-evidence.js"), "utf8");
  assert.match(src, /const full = \(c\) => \(Array\.isArray\(c\?\.files\) && c\.files\.length < 300 \? c\.files : null\);/);
  assert.match(src, /abPaths: full\(ab\) \? full\(ab\)\.map/); assert.match(src, /basePaths: full\(baseCmp\) \? full\(baseCmp\)\.map/);
  // unreadable lists fail (2) and (3) in carryProblems
  assert.match(carryProblems({ ...ok, filesB: null }).join(), /\(2\) the PR's change set couldn't be read/);
  assert.match(carryProblems({ ...ok, abPaths: null }).join(), /\(3\) what changed .* couldn't be read/);
});

// Owner decision 2026-10-04 (interim, while Kimi and Grok are unavailable): with the reduced-review label a risky PR needs
// ONE review from a family other than the author's plus ONE by a same-family seat that wrote none of the PR.
test("reduced-review label: one other-family plus one same-family non-writer review; without the label the two-family rule stands", () => {
  const H = "547a9683551509c3097cd677d44beb0e1b9d6f12", pr = 92;
  const st = (desc, at) => ({ context: "independent-review", created_at: at, state: "success", description: desc, target_url: `https://github.com/o/r/pull/92#${at}` });
  const statuses = [st("review-codex (Codex): clean at 547a968", "2026-10-04T10:00:00Z"), st("review-claude-2 (Opus): clean at 547a968", "2026-10-04T10:05:00Z")];
  const seats = []; const fams = reviewFamilies({ head: H, authorFamily: "claude", statuses, pr, seatsOut: seats });
  assert.deepEqual(fams.map((f) => f.family), ["codex"], "two-family count: claude-2 is the author's family");
  assert.deepEqual(seats.map((x) => [x.seat, x.family]).sort(), [["review-claude-2", "claude"], ["review-codex", "codex"]], "every passing seat, for the reduced rule");
  const risky = { tier: "risky", features: [{ id: "F-010" }], authorFamily: "claude", ownerApproved: true, reviewSeats: seats, reviewFamilies: fams, writers: ["impl-claude-ui-1"] };
  // without the label: still MISSING a second family
  assert.match(riskProblems(risky).join(), /MISSING: a second independent review from another family/);
  // with it: codex (other family) + claude-2 (same family, not a writer): passes
  assert.deepEqual(riskProblems({ ...risky, reducedReview: true }), []);
  // the same-family reviewer wrote the PR: refused; no other family: refused; a carried review doesn't count
  assert.match(riskProblems({ ...risky, reducedReview: true, writers: ["review-claude-2"] }).join(), /MISSING: a fresh exact-head review by a claude seat that wrote none of the PR/);
  assert.match(riskProblems({ ...risky, reducedReview: true, reviewSeats: seats.filter((x) => x.family === "claude") }).join(), /MISSING: a fresh exact-head review from a family other than the author's/);
  assert.match(riskProblems({ ...risky, reducedReview: true, reviewSeats: seats.map((x) => (x.family === "claude" ? { ...x, carried: "e311017" } : x)) }).join(), /by a claude seat that wrote none/);
  assert.match(riskProblems({ ...risky, reducedReview: true, ownerApproved: false }).join(), /MISSING: the owner-approved label/);
  // Jev is told which rule applied
  const inp = String(buildMergeInput({ head: H, pr, base: "b".repeat(40), checks: [], reviewVerdict: null, independentReview: null, risk: { reducedReview: true, authorFamily: "claude" } }).review);
  assert.match(inp, /^reduced review: Kimi\/Grok unavailable, owner decision 2026-10-04: this risky PR needs one review from a family other than the author's plus one by a claude seat that wrote none of it \(reduced-review label\)/m);
  assert.doesNotMatch(String(buildMergeInput({ head: H, pr, base: "b".repeat(40), checks: [], reviewVerdict: null, independentReview: null, risk: {} }).review), /reduced review/);
  assert.equal(REDUCED_LABEL, "reduced-review");
  const src = fs.readFileSync(join(repo, "orchestration/merge-evidence.js"), "utf8");
  assert.match(src, /reducedReview: \(v\.labels \|\| \[\]\)\.some\(\(l\) => l\.name === REDUCED_LABEL\)/);
});

// Labels don't move with the head: a risky PR also needs the approver's comment naming the EXACT head (2026-10-04).
test("owner approval at the exact head: the approver's 'owner-approved … by <approver> at head <sha>' comment; otherwise MISSING", async () => {
  const { ownerApprovalAtHead } = await import("../orchestration/merge-evidence.js");
  const H = "1fdda5e53f917277732d5a0d0fd4d33e0cb48fef", OLD = "ec4dfb3d6b3b63600d0a1c733340083220f197c2";
  const c = (body) => ({ body });
  assert.equal(ownerApprovalAtHead([c(`owner-approved applied by operator-agent@kernel at head ${H} under the standing approval`)], H), true);
  assert.equal(ownerApprovalAtHead([c(`reduced-review plus owner-approved re-confirmed by operator-agent@kernel at refreshed head ${H} (the old approval is superseded)`)], H), true);
  assert.equal(ownerApprovalAtHead([c(`reduced-review plus owner-approved applied by operator-agent@kernel at head ${H}: arch-claude (non-author)`)], H), true, "the reduced-review form");
  assert.equal(ownerApprovalAtHead([c(`reduced-review plus owner-approved re-applied by operator-agent@kernel at refreshed head ${H}`)], H), true, "re-applied");
  for (const [why, body] of [["the old head", `owner-approved applied by operator-agent@kernel at head ${OLD}`], ["another seat", `owner-approved applied by coord-lead-claude@app at head ${H}`],
    ["a short sha", `owner-approved applied by operator-agent@kernel at head 1fdda5e`], ["quoted", `> owner-approved applied by operator-agent@kernel at head ${H}`],
    ["not on its first line", `Summary\nowner-approved applied by operator-agent@kernel at head ${H}`], ["no owner-approved", `reviewed by operator-agent@kernel at head ${H}`]])
    assert.equal(ownerApprovalAtHead([c(body)], H), false, why);
  // the operator's approval often also mentions the merge gate, so it reads as a gate report: gather must still see it
  const src = fs.readFileSync(join(repo, "orchestration/merge-evidence.js"), "utf8");
  assert.match(src, /approvedAtHead: ownerApprovalAtHead\(allNotes\.filter\(\(n\) => n\.kind !== "review"\), v\.headRefOid\)/, "read from all comments, not the gate-report-filtered ones");
  const risky = { tier: "risky", features: [{ id: "F-010" }], authorFamily: "claude", ownerApproved: true, reviewFamilies: [{ family: "codex" }, { family: "kimi" }] };
  assert.deepEqual(riskProblems({ ...risky, approvedAtHead: true }), []);
  assert.match(riskProblems({ ...risky, approvedAtHead: false }).join(), /MISSING: owner approval not confirmed at this head/);
  const reduced = { ...risky, reducedReview: true, writers: [], reviewSeats: [{ seat: "review-codex", family: "codex" }, { seat: "review-claude-2", family: "claude" }] };
  assert.deepEqual(riskProblems({ ...reduced, approvedAtHead: true }), []);
  assert.match(riskProblems({ ...reduced, approvedAtHead: false }).join(), /MISSING: owner approval not confirmed at this head/, "the reduced mode too");
});

test("per-repo config: a repo with a standing owner approval needs neither the label nor the exact-head comment, and says so to Jev", async () => {
  const { resolveConfig } = await import("../orchestration/merge-evidence.js");
  assert.equal(resolveConfig(null, "o/r").risk.ownerApproval, "label", "the default");
  const cfg = resolveConfig({ repos: { "o/m": { risk: { ownerApproval: "standing", standing: "CULTURE D-29" } } } }, "o/m");
  assert.deepEqual([cfg.risk.ownerApproval, cfg.risk.standing], ["standing", "CULTURE D-29"]);
  assert.throws(() => resolveConfig({ risk: { ownerApproval: "standing" } }, "o/r"), /needs risk\.standing/);
  assert.throws(() => resolveConfig({ risk: { ownerApproval: "maybe" } }, "o/r"), /must be "label" or "standing"/);
  const risky = { tier: "risky", features: [{ id: "F-010" }], authorFamily: "claude", reviewFamilies: [{ family: "codex" }, { family: "kimi" }], ownerApproved: false, approvedAtHead: false };
  assert.equal(riskProblems(risky).length, 2, "label repo: the label and the head approval are MISSING");
  assert.deepEqual(riskProblems({ ...risky, standingApproval: "CULTURE D-29" }), [], "standing repo: neither is required");
  const inp = String(buildMergeInput({ head: "a".repeat(40), pr: 1, base: "b".repeat(40), checks: [], reviewVerdict: null, independentReview: null, risk: { tier: "risky", standingApproval: "CULTURE D-29" } }).review);
  assert.match(inp, /^owner approval: standing for this repository \(CULTURE D-29\); no owner-approved label or exact-head approval comment is required/m);
});
