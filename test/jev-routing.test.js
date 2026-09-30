// WO35: model defaults, and Jev as the decision layer (merge evidence, seat picking, stuck seats). Jev is never called
// for real here: AGENT_JEV_STUB supplies its answers, and gh, rig and tmux are stubs.
process.env.AGENT_STACK_STATE = (await import("node:fs")).mkdtempSync("/tmp/claude-1000/agst-wo35-");
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const { buildMergeInput, passes, outcome, gateProblems, parseDiff, brbCutoff, brbNotApplicable, blastNotApplicable, flagOnly, mergeStateLine } = await import("../orchestration/merge-evidence.js");
const { seatCandidates, nextStep } = await import("../orchestration/pickseat.js");
const st = await import("../orchestration/stuck.js");
const root = fs.mkdtempSync("/tmp/claude-1000/wo35-");
process.on("exit", () => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(process.env.AGENT_STACK_STATE, { recursive: true, force: true }); });
const bin = join(root, "bin"); fs.mkdirSync(bin);
const stub = (answers) => { const f = join(root, `jev-${Math.random().toString(36).slice(2)}.json`); fs.writeFileSync(f, JSON.stringify(answers)); return f; };
const H = "a".repeat(40), B = "b".repeat(40);

// ---- model defaults ------------------------------------------------------------------------------------------------
test("templates: architects on claude-fable-5-1, Codex implementers on gpt-6-astra, reviewers unchanged", () => {
  for (const t of ["core", "small", "build", "full-stack"]) {
    const s = fs.readFileSync(join(repo, `rig/template/${t}.yaml`), "utf8");
    for (const [, body] of s.matchAll(/      - id: [^\n]+\n((?:        [^\n]*\n)+)/g)) {
      const role = body.match(/agents\/([\w-]+)"/)?.[1], model = body.match(/model: "?([^"\n]+)"?/)?.[1], rt = body.match(/runtime: (\S+)/)?.[1];
      if (role === "architect") assert.equal(model, "claude-fable-5-1", `${t} architect`);
      if (role === "implementer" && rt === "codex") assert.equal(model, "gpt-6-astra", `${t} codex implementer`);
      if (role === "reviewer") assert.ok(["claude-opus-5-5", "gpt-6-sol", "kimi-k3[1m]"].includes(model), `${t} reviewer ${model}`);
    }
  }
});

test("the Jev catalog has intake.seat and seat.stuck", () => {
  const y = fs.readFileSync(join(repo, "config/decisions.yaml"), "utf8");
  assert.match(y, /\n  intake\.seat:\n[\s\S]*?from_candidates: true[\s\S]*?uncertain_labels: \[none_fit\]/);
  const stuck = y.slice(y.indexOf("\n  seat.stuck:"), y.indexOf("\n  comms.triage_update:"));
  for (const l of ["progressing", "looping", "rate_limited", "stalled", "unclear"]) assert.match(stuck, new RegExp(`\\n            ${l}: "`), l);
  assert.match(stuck, /cache_ttl_s: 0/);
});

// ---- merge evidence ------------------------------------------------------------------------------------------------
const facts = (over = {}) => ({ pr: 42, head: H, base: B, baseRef: "main", headRef: "agent/x", mergeable: "MERGEABLE", mergeState: "CLEAN", isDraft: false,
  change: "Adds login", checks: [{ name: "verify", bucket: "pass" }, { name: "qa-evidence", bucket: "pass" }],
  independentReview: { state: "success", description: "QA PASS", creator: "rev" },
  brb: { file: "/w/proof/brb-a.md", artifact_type: "qa", verdict: "PASS", candidate_sha: H, money_evidence: "Ship: YES, 5 criteria passed" },
  blastRadius: { url: "https://x/c1", at: "2026-09-30T10:00Z", namesHead: true, excerpt: "## Blast radius Safe because: nullable column" },
  reviewNote: { url: "https://x/c2", at: "2026-09-30T10:05Z", author: "rev", excerpt: "Lenses applied: correctness. Verified 12 tests on aaaaaaa." },
  deploy: "merges deploy to production", ...over });

test("merge evidence: exact-head facts in, every gap named MISSING, never smoothed over", () => {
  const ok = buildMergeInput(facts());
  assert.equal(ok.head, H); assert.equal(ok.base, B);
  assert.match(ok.ci, /2 required check\(s\) on a{40}: verify=pass, qa-evidence=pass; all pass/);
  assert.match(ok.review, /independent-review status on a{40}: success "QA PASS" \(by rev\)/);
  assert.match(ok.review, /bug-review-board proof \/w\/proof\/brb-a\.md: artifact_type=qa verdict=PASS candidate_sha=a{40}; Ship: YES/);
  assert.match(ok.review, /independent review report, linked from the independent-review status \(https:\/\/x\/c2, .*by rev\): Lenses applied/);
  assert.match(ok.review, /blast radius \(https:\/\/x\/c1, .*names this head\): ## Blast radius/);
  assert.match(ok.limits, /target branch main at b{40}[\s\S]*deploy effect: merges deploy to production[\s\S]*rollback: not stated \(proposed default: revert the squash commit on main\)/);
  const gaps = buildMergeInput(facts({ checks: [{ name: "verify", bucket: "fail" }], independentReview: null, reviewNote: null, brb: null, brbWhere: "/w/proof/brb-x.md", blastRadius: null, deploy: undefined }));
  assert.match(gaps.review, /MISSING: the independent-review status links no review report \(no target_url\)/);
  const unlinked = buildMergeInput(facts({ reviewNote: null, unlinkedNote: { url: "https://x/c9", at: "t", author: "builder", excerpt: "Implementation update: my tests pass" } }));
  assert.match(unlinked.review, /UNVERIFIED, not linked from the status and not treated as the review: .*by builder\): Implementation update/);
  assert.doesNotMatch(unlinked.review, /independent review report, linked/);
  assert.match(gaps.ci, /NOT passing: verify/);
  assert.match(gaps.review, /MISSING: no independent-review status/); assert.match(gaps.review, /MISSING: no bug-review-board proof .* \(looked for \/w\/proof\/brb-x\.md\)/);
  assert.match(gaps.review, /MISSING: no blast-radius comment/); assert.match(gaps.limits, /deploy effect: MISSING/);
  assert.match(buildMergeInput(facts({ blastRadius: { ...facts().blastRadius, namesHead: false } })).review, /does NOT name this head/);
  const leaky = buildMergeInput(facts({ change: "uses postgresql://app:hunter2@db/app", reviewNote: { ...facts().reviewNote, excerpt: "token ghp_ABCDEFGHIJKLMNOPQRST ok" } }));
  assert.doesNotMatch(JSON.stringify(leaky), /hunter2|ghp_ABC/); assert.match(leaky.head, /^a{40}$/, "shas are kept");
  assert.match(buildMergeInput(facts({ brb: { ...facts().brb, candidate_sha: "c".repeat(40) } })).review, /\(NOT this head\)/);
  assert.match(buildMergeInput(facts({ checks: [] })).ci, /MISSING: no required checks/);
});

test("merge gate passes only for live Jev merge in the act band", () => {
  assert.ok(passes({ decided_by: "jev", band: "act", result: { decision: "merge" } }));
  for (const r of [{ decided_by: "jev", band: "review", result: { decision: "merge" } }, { decided_by: "cache", band: "act", result: { decision: "merge" } },
    { decided_by: "fallback_model", band: "act", result: { decision: "merge" } }, { decided_by: "jev", band: "act", result: { decision: "hold" } },
    { decided_by: "jev", band: "act", result: { decision: "merge" }, stubbed: true }, null])
    assert.ok(!passes(r), JSON.stringify(r));
});

test("agent-merge-evidence --decide: reads gh and the proof file, exits 0 only on a live act merge", () => {
  const work = join(root, "work"), proof = join(work, "missions/m1/slices/s1/proof"); fs.mkdirSync(proof, { recursive: true });
  fs.writeFileSync(join(proof, `brb-${H}.md`), `---\nslice: m1.s1\ncandidate_sha: ${H}\nartifact_type: qa\nverdict: PASS\nmoney_evidence: "Ship: YES, all criteria passed\n  in the browser"\n---\nbody\n`);
  fs.writeFileSync(join(bin, "gh"), `#!/bin/sh
case "$*" in
  "pr view 42 -R o/r --json headRefOid,baseRefOid") n=$(cat "${root}/views" 2>/dev/null || echo 0); echo $((n+1)) > "${root}/views"; h=${H}; [ -f "${root}/move" ] && h=${"c".repeat(40)}; printf '{"headRefOid":"%s","baseRefOid":"${B}"}\\n' "$h" ;;
  "pr diff 42 -R o/r") printf 'diff --git a/src/login.ts b/src/login.ts\\n--- a/src/login.ts\\n+++ b/src/login.ts\\n@@ -1 +1 @@\\n-old\\n+new\\n' ;;
  "pr view 42 -R o/r --json"*) echo '{"number":42,"title":"Adds login","createdAt":"2026-09-30T14:00:00Z","headRefOid":"${H}","baseRefOid":"${B}","baseRefName":"main","headRefName":"agent/x","mergeable":"MERGEABLE","isDraft":false,"comments":[{"body":"looks good","url":"https://x/c0","createdAt":"2026-09-30T09:00:00Z","author":{"login":"a"}},{"body":"## Blast radius\\nSafe because: only a nullable column (${H.slice(0, 7)}).","url":"https://x/c1","createdAt":"2026-09-30T10:00:00Z","author":{"login":"rev"}},{"body":"Implementation update on ${H.slice(0, 7)}: my tests pass, all fixes are ready for review.","url":"https://x/c3","createdAt":"2026-09-30T11:00:00Z","author":{"login":"builder"}}],"reviews":[{"body":"Lenses applied: correctness, security. Verified the login tests pass on ${H.slice(0, 7)}; one finding fixed.","url":"https://x/r1","submittedAt":"2026-09-30T10:05:00Z","author":{"login":"rev"},"commit":{"oid":"${H}"}}]}' ;;
  "pr checks 42 -R o/r --required --json"*) echo '[{"name":"verify","state":"FAILURE","bucket":"fail"},{"name":"qa-evidence","state":"SUCCESS","bucket":"pass"}]'; exit 1 ;;
  "api repos/o/r/commits/${H}/statuses") echo '[{"context":"independent-review","state":"success","description":"QA PASS","creator":{"login":"rev"},"target_url":"https://x/r1"}]' ;;
  *) echo "unexpected gh $*" >&2; exit 9 ;;
esac
`, { mode: 0o755 });
  const run = (answer) => spawnSync(process.execPath, [join(repo, "orchestration/merge-evidence.js"), "42", "--repo", "o/r", "--mission", "m1", "--slice", "s1", "--deploy", "none", "--decide"],
    { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}`, OPENRIG_WORK_ROOT: work, AGENT_JEV_STUB: stub({ "review.merge_gate": answer }) } });
  let r = run({ decided_by: "jev", band: "act", result: { decision: "merge" } });
  const out = JSON.parse(r.stdout);
  assert.match(out.input.ci, /verify=fail[\s\S]*NOT passing: verify/, "a failing check (gh exits 1) is still reported");
  assert.match(out.input.review, /Ship: YES, all criteria passed in the browser/, "wrapped YAML evidence read whole");
  assert.match(out.input.review, /blast radius \(https:\/\/x\/c1, 2026-09-30T10:00:00Z, names this head\): ## Blast radius Safe because: only a nullable column/);
  assert.match(out.input.review, /independent review report, linked from the independent-review status \(https:\/\/x\/r1, .*by rev\): Lenses applied: correctness, security\. Verified the login tests/);
  assert.doesNotMatch(out.input.review, /Implementation update|UNVERIFIED/, "a later author comment never displaces the linked review (QA round 2)");
  assert.match(r.stderr, /merge gate: HOLD \(a STUBBED answer, not a live Jev decision/, "a stub never passes (QA round 1)");
  assert.equal(r.status, 1); assert.equal(out.decision.stubbed, true);
  fs.writeFileSync(join(root, "move"), "");   // a push lands while the evidence is collected
  r = run({ decided_by: "jev", band: "act", result: { decision: "merge" } });
  assert.equal(r.status, 2); assert.match(r.stderr, /the PR moved while its evidence was collected \(head aaaaaaaaaaaa -> cccccccccccc/, "QA round 1: no mixed-head evidence");
  fs.rmSync(join(root, "move"));
  r = run({ decided_by: "jev", band: "review", result: { decision: "merge" } });
  assert.equal(r.status, 1); assert.match(r.stderr, /merge gate: HOLD \(a STUBBED answer, not a live Jev decision: jev\/review\/merge\)/);
});

// ---- seat picking --------------------------------------------------------------------------------------------------
const seatRows = [
  { seat: "impl-codex-1@shop", role: "implementer", family: "codex", runtime: "codex", running: true, idle: true, assigned: 0, pending: 0 },
  { seat: "impl-codex-2@shop", role: "implementer", family: "codex", runtime: "codex", running: true, idle: false, assigned: 1, pending: 0 },
  { seat: "impl-claude-ui@shop", role: "implementer", family: "claude", runtime: "claude-code", running: true, idle: true, assigned: 0, pending: 0 },
  { seat: "impl-codex-3@shop", role: "implementer", family: "codex", runtime: "codex", running: false, idle: false, assigned: 0, pending: 0 },
  { seat: "review-codex@shop", role: "reviewer", family: "codex", runtime: "codex", running: true, idle: true, assigned: 0, pending: 0 },
];

test("pick-seat candidates: running seats of the role with no open work, on an available account family", () => {
  assert.deepEqual(seatCandidates(seatRows, "implementer").map((c) => c.id), ["impl-codex-1@shop", "impl-claude-ui@shop"]);
  const busyUntracked = { ...seatRows[0], seat: "impl-codex-9@shop", idle: false };   // working, but no tracked work (QA round 1)
  assert.ok(!seatCandidates([busyUntracked], "implementer").length, "a working seat is never a candidate");
  assert.deepEqual(seatCandidates(seatRows, "implementer", { claude: 0, codex: 2 }).map((c) => c.id), ["impl-codex-1@shop"], "no claude account free");
  assert.match(seatCandidates(seatRows, "implementer")[0].text, /codex seat \(codex\), idle, no open work, quality 0\.50/);
});

test("pick-seat next step: dispatch on act; otherwise the lead decides and records why", () => {
  const c = seatCandidates(seatRows, "implementer");
  const act = nextStep({ band: "act", result: { seat: "impl-codex-1@shop" } }, c, "03-login: sign-in");
  assert.equal(act.action, "dispatch"); assert.match(act.command, /^rig queue create --destination impl-codex-1@shop --mission <mission> --slice <slice>/);
  for (const rec of [{ band: "review", result: { seat: "impl-codex-1@shop" } }, { band: "uncertain", result: { seat: "none_fit" } }, { band: "act", result: { seat: "not-a-candidate@shop" } }]) {
    const n = nextStep(rec, c, "x");
    assert.equal(n.action, "lead decides"); assert.match(n.note, /write why in the queue row/);
  }
});

test("agent-dispatch pick-seat end to end (stub rig, stub Jev)", () => {
  const nodes = [
    { canonicalSessionName: "coord-lead-claude@shop", logicalId: "coord.lead-claude", runtime: "claude-code", lifecycleState: "running", sessionStatus: "running", agentActivity: { state: "idle" }, assignedWorkCount: 0, pendingWorkCount: 0 },
    { canonicalSessionName: "impl-codex-1@shop", logicalId: "impl.codex-1", runtime: "codex", lifecycleState: "running", sessionStatus: "running", agentActivity: { state: "idle" }, assignedWorkCount: 0, pendingWorkCount: 0 },
    { canonicalSessionName: "impl-codex-2@shop", logicalId: "impl.codex-2", runtime: "codex", lifecycleState: "running", sessionStatus: "running", agentActivity: { state: "working" }, assignedWorkCount: 1, pendingWorkCount: 0 },
  ];
  fs.writeFileSync(join(bin, "rig"), `#!/bin/sh\ncase "$*" in "ps --nodes --rig shop --json") echo '${JSON.stringify(nodes)}' ;; esac\n`, { mode: 0o755 });
  const r = spawnSync(process.execPath, [join(repo, "orchestration/dispatch.js"), "pick-seat", "--rig", "shop", "--role", "implementer", "--task", "03-login: sign-in"],
    { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}`, AGENT_STACK_STATE: process.env.AGENT_STACK_STATE, AGENT_JEV_STUB: stub({ "intake.seat": { decided_by: "jev", band: "act", result: { seat: "impl-codex-1@shop" } } }) } });
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.deepEqual(o.candidates, ["impl-codex-1@shop"]); assert.equal(o.next.action, "dispatch");
});

// ---- stuck seats ---------------------------------------------------------------------------------------------------
const RATE_LIMIT = "● Running the focused tests now.\n  ⎿  2 skills available\n\n● API Error: Request rejected (429) · All credentials for model\n  claude-opus-5-5 are cooling down (last error: rate_limit_error: This\n  request would exceed your account's rate limit. Please try again\n  later.)\n\n> ";

test("stuck rules: digits don't count as change, decoration isn't a repeat, thresholds ask only for seats with work", () => {
  assert.equal(st.screenHash("working (1m 02s · esc)"), st.screenHash("working (9m 57s · esc)"));
  assert.notEqual(st.screenHash("step one"), st.screenHash("step two"));
  assert.equal(st.repeatedLine("────────────────\n────────────────\n────────────────\n>"), null);
  assert.deepEqual(st.repeatedLine("Error: Cannot find module x\nfix\nError: Cannot find module x\nError: Cannot find module x"), { line: "Error: Cannot find module x", n: 3 });
  assert.equal(st.unchangedRuns(["a", "b", "b", "b"]), 3);
  assert.ok(st.cycling(["a", "b", "a", "b", "a", "b"])); assert.ok(!st.cycling(["a", "b", "c", "d", "e", "f"])); assert.ok(!st.cycling(["a", "a", "a", "a", "a", "a"]));
  assert.ok(!st.shouldAsk({ openWork: false, hashes: ["a", "a", "a"], repeat: null }), "no open work: never asked");
  assert.ok(!st.shouldAsk({ openWork: true, hashes: ["a"], repeat: null }), "first sight: not yet");
  assert.ok(st.shouldAsk({ openWork: true, hashes: ["a", "a"], repeat: null }));
});

test("stuck evidence: the facts Jev needs, with credentials redacted", () => {
  const e = st.buildEvidence({ state: "idle", minutesInState: 40, hashes: ["x", "y", "y", "y"], intervalMin: 10, repeat: null,
    openRows: [{ id: "qitem-1", state: "in-progress", ageMin: 95, summary: "Build 03-login; DB postgresql://app:summarysecret@db/app" }],
    tail: RATE_LIMIT + "\nDATABASE_URL=postgresql://app:hunter2@db.example/app\ntoken sk-live_ABCDEFGHIJKLMNOP" });
  assert.match(e, /^state: idle for about 40 min/); assert.match(e, /unchanged for the last 3 checks \(about 20 min; digits ignored\)/);
  assert.match(e, /open queue work: qitem-1 in-progress for 95 min \(Build 03-login; DB postgres:\/\/<redacted>\)/);
  assert.match(e, /rate_limit_error/); assert.doesNotMatch(e, /hunter2|sk-live_|summarysecret/, "queue summaries are redacted too (QA round 1)");
});

test("stuck warnings: looping, rate-limited or stalled warn the lead; progressing never; unclear only after 3 same screens", () => {
  const w = (verdict, band, unchanged = 2) => st.warning("impl-x@shop", { band, result: { verdict } }, "state: idle\nscreen output: unchanged", { unchanged });
  for (const v of ["looping", "rate_limited", "stalled"]) { assert.match(w(v, "act").text, new RegExp(`impl-x@shop looks ${v.replace("_", "-")}`)); assert.ok(w(v, "review")); }
  assert.match(w("rate_limited", "act").text, /Nothing was done/);
  assert.equal(w("progressing", "act"), null);
  assert.equal(w("stalled", "uncertain"), null);
  assert.equal(w("unclear", "uncertain", 2), null); assert.ok(w("unclear", "uncertain", 3));
});

test("agent-stuck-check end to end: warns the lead once for today's rate-limit stall; --dry-run sends nothing", () => {
  const calls = join(root, "rig-calls");
  const nodes = [
    { canonicalSessionName: "coord-lead-claude@shop", logicalId: "coord.lead-claude", runtime: "claude-code", lifecycleState: "running", sessionStatus: "running", agentActivity: { state: "idle" }, assignedWorkCount: 0, pendingWorkCount: 0 },
    { canonicalSessionName: "impl-claude-ui@shop", logicalId: "impl.claude-ui", runtime: "claude-code", lifecycleState: "running", sessionStatus: "running", agentActivity: { state: "idle" }, assignedWorkCount: 1, pendingWorkCount: 0 },
  ];
  const rows = [{ qitemId: "qitem-9", state: "in-progress", destinationSession: "impl-claude-ui@shop", summary: "Build 03-login", claimedAt: new Date(Date.now() - 95 * 60_000).toISOString() }];
  fs.writeFileSync(join(bin, "rig"), `#!/bin/sh
echo "rig $*" >> "${calls}"
case "$*" in
  "ps --json") echo '[{"name":"shop","isArchived":false,"runningCount":2}]' ;;
  "ps --nodes --rig shop --json") echo '${JSON.stringify(nodes)}' ;;
  "queue list -A --limit 500 --json") echo '${JSON.stringify(rows)}' ;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(join(root, "screen.txt"), RATE_LIMIT);
  fs.writeFileSync(join(bin, "tmux"), `#!/bin/sh\ncat "${join(root, "screen.txt")}"\n`, { mode: 0o755 });
  const env = { PATH: `${bin}:${process.env.PATH}`, AGENT_STACK_STATE: join(root, "state"), AGENT_JEV_STUB: stub({ "seat.stuck": { decided_by: "jev", band: "act", result: { verdict: "rate_limited" } } }) };
  const run = (...a) => { fs.rmSync(calls, { force: true }); const r = spawnSync(process.execPath, [join(repo, "orchestration/stuck.js"), ...a], { encoding: "utf8", env });
    return { ...r, out: r.status === 0 ? JSON.parse(r.stdout) : null, calls: fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "" }; };
  let r = run(); assert.equal(r.status, 0, r.stderr); assert.equal(r.out.asked, 0, "first sight: nothing to compare yet");
  r = run("--dry-run"); assert.equal(r.out.asked, 1); assert.equal(r.out.results[0].verdict, "rate_limited"); assert.doesNotMatch(r.calls, /^rig send/m, "dry run sends nothing");
  r = run(); assert.match(r.calls, /^rig send coord-lead-claude@shop stuck-check: impl-claude-ui@shop looks rate-limited \(Jev act\)/m);
  assert.doesNotMatch(r.calls, /send impl-claude-ui/, "only the lead is told");
  r = run(); assert.equal(r.out.asked, 1); assert.doesNotMatch(r.calls, /^rig send/m, "at most once an hour per seat and verdict");
});

// ---- Fable consent -------------------------------------------------------------------------------------------------
test("agent-project-check WARNs when a Fable seat's screen asks for the usage-credits consent", () => {
  const home = join(root, "home"), W = join(home, "Projects/P-work"); fs.mkdirSync(join(W, "rig"), { recursive: true });
  fs.writeFileSync(join(W, "project.yaml"), "kind: project\n");
  fs.writeFileSync(join(W, "rig/small.yaml"), `name: shop\npods:\n  - id: arch\n    members:\n      - id: claude\n        agent_ref: "path:/x/agents/architect"\n        model: "claude-fable-5-1"\n        cwd: "${home}"\n`);
  const pb = join(root, "pcbin"); fs.mkdirSync(pb, { recursive: true });
  fs.writeFileSync(join(pb, "rig"), `#!/bin/sh\ncase "$*" in "ps --json") echo '[{"name":"shop"}]' ;; "ps") echo "shop  running" ;; *) echo "[]" ;; esac\n`, { mode: 0o755 });
  const check = (screen) => { fs.writeFileSync(join(pb, "tmux"), `#!/bin/sh\nprintf '%s\\n' "${screen}"\n`, { mode: 0o755 });
    return JSON.parse(spawnSync("python3", [join(repo, "bin/agent-project-check"), W, "--json"], { encoding: "utf8", timeout: 60000,
      env: { PATH: `${pb}:${process.env.PATH}`, HOME: home, OPENRIG_URL: "http://127.0.0.1:9" } }).stdout).find((x) => x.check.startsWith("Fable seats can use their model")); };
  let row = check("Using claude-fable-5-1 requires usage credits. Run /model fable to confirm.");
  assert.equal(row.level, "WARN"); assert.match(row.check, /arch-claude@shop/); assert.match(row.detail, /run `\/model fable` once/);
  row = check("● Reading the repo's AGENTS.md");
  assert.equal(row.level, "OK");
  row = check("Finished updating the usage credits documentation. Tests passed.");
  assert.equal(row.level, "OK", "ordinary work that mentions usage credits is not a consent prompt (QA round 1)");
  fs.writeFileSync(join(pb, "tmux"), "#!/bin/sh\necho \"can't find session\" >&2; exit 1\n", { mode: 0o755 });
  row = JSON.parse(spawnSync("python3", [join(repo, "bin/agent-project-check"), W, "--json"], { encoding: "utf8", timeout: 60000,
    env: { PATH: `${pb}:${process.env.PATH}`, HOME: home, OPENRIG_URL: "http://127.0.0.1:9" } }).stdout).find((x) => x.check.startsWith("Fable seats can use their model"));
  assert.equal(row.level, "WARN"); assert.match(row.detail, /screen not readable .* not verified/);
});


test("agent-stuck-check: no flagged seat starves behind --max-asks, and a failed send is retried, not deduplicated (QA round 1)", () => {
  const calls = join(root, "rig-calls-2"), state = join(root, "state-2");
  const lead = { canonicalSessionName: "coord-lead-claude@big", logicalId: "coord.lead-claude", runtime: "claude-code", lifecycleState: "running", sessionStatus: "running", agentActivity: { state: "idle" }, assignedWorkCount: 0, pendingWorkCount: 0 };
  const workers = Array.from({ length: 12 }, (_, i) => ({ canonicalSessionName: `impl-codex-${i + 1}@big`, logicalId: `impl.codex-${i + 1}`, runtime: "codex",
    lifecycleState: "running", sessionStatus: "running", agentActivity: { state: "idle" }, assignedWorkCount: 1, pendingWorkCount: 0 }));
  const writeRig = (sendRc) => fs.writeFileSync(join(bin, "rig"), `#!/bin/sh
echo "rig $*" >> "${calls}"
case "$*" in
  "ps --json") echo '[{"name":"big","isArchived":false,"runningCount":13}]' ;;
  "ps --nodes --rig big --json") echo '${JSON.stringify([lead, ...workers])}' ;;
  "queue list -A --limit 500 --json") echo '[]' ;;
  send*) exit ${sendRc} ;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(join(root, "screen.txt"), RATE_LIMIT);
  fs.writeFileSync(join(bin, "tmux"), `#!/bin/sh\ncat "${join(root, "screen.txt")}"\n`, { mode: 0o755 });
  const env = { PATH: `${bin}:${process.env.PATH}`, AGENT_STACK_STATE: state, AGENT_JEV_STUB: stub({ "seat.stuck": { decided_by: "jev", band: "act", result: { verdict: "rate_limited" } } }) };
  const run = () => { fs.rmSync(calls, { force: true }); const r = spawnSync(process.execPath, [join(repo, "orchestration/stuck.js"), "--max-asks", "10"], { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr); return { out: JSON.parse(r.stdout), calls: fs.readFileSync(calls, "utf8") }; };
  writeRig(1);                                   // every send fails
  run();                                         // first sight: nothing flagged
  const a = run(), b = run();
  assert.equal(a.out.flagged, 12); assert.equal(a.out.asked, 10);
  const asked = new Set([...a.out.results, ...b.out.results].map((r) => r.seat));
  assert.equal(asked.size, 12, "the two seats left out of the first run are asked first in the next");
  assert.deepEqual(b.out.results.slice(0, 2).map((r) => r.seat).sort(), ["impl-codex-11@big", "impl-codex-12@big"]);
  assert.ok(a.out.results.every((r) => r.sent === false && r.sendFailed === true), "a failed send is not recorded as sent");
  writeRig(0);                                   // sends work again
  const c = run();
  assert.ok(c.out.results.some((r) => r.sent === true), "not deduplicated after a failed send");
});


test("redaction covers credential assignments whole: unprefixed keys, both quote styles, key: value (QA round 2)", async () => {
  const { redact } = await import("../orchestration/redact.js");
  const cases = {
    "PASSWORD=FAKE_SECRET": "PASSWORD=<redacted>",
    'DB_PASSWORD="fake secret words" next': "DB_PASSWORD=<redacted> next",
    "api_key='fake key words' x": "api_key=<redacted> x",
    "CLIENT_SECRET=fakevalue": "CLIENT_SECRET=<redacted>",
    "token: fake-token-value": "token: <redacted>",
    "clientSecret=fake;other": "clientSecret=<redacted>;other",
  };
  for (const [input, want] of Object.entries(cases)) assert.equal(redact(input), want, input);
  const sha = "a".repeat(40);
  assert.equal(redact(`candidate_sha=${sha} head ${sha}`), `candidate_sha=${sha} head ${sha}`, "shas and ordinary keys stay");
  assert.doesNotMatch(redact('x DB_PASSWORD="fake secret words" y', { longTokens: true }), /fake|secret words/);
});


// WO36: the integrator's below-bar path. A live Jev merge below the act bar, every deterministic gate green, is
// NEEDS CONFIRM (a one-line exact-head "confirm <sha>" from the other-family reviewer), not HOLD.
test("merge outcome: act -> PASS; review band with every gate green -> NEEDS CONFIRM (exit 3); otherwise HOLD", () => {
  const green = facts();
  const live = (band, decision = "merge") => ({ decided_by: "jev", band, result: { decision } });
  assert.equal(outcome(live("act"), green).code, 0);
  for (const band of ["review", "uncertain"]) {   // "below the act bar" is both bands (QA round 1)
    const nc = outcome(live(band), green);
    assert.equal(nc.code, 3, band); assert.match(nc.text, new RegExp(`NEEDS CONFIRM \\(Jev merge below the act bar, ${band} band.*repository's own gates.*"confirm ${H}".*--match-head-commit ${H}`));
  }
  assert.doesNotMatch(outcome(live("review"), green).text, /every deterministic gate/, "no claim beyond what it checked");
  for (const [why, f] of [["a failing check", facts({ checks: [{ name: "verify", bucket: "fail" }] })], ["review not success", facts({ independentReview: { ...facts().independentReview, state: "failure" } })],
    ["no QA verdict", facts({ brb: null })], ["QA verdict for another head", facts({ brb: { ...facts().brb, candidate_sha: "c".repeat(40) } })],
    ["not a qa artifact", facts({ brb: { ...facts().brb, artifact_type: "implementation" } })], ["a draft", facts({ isDraft: true })],
    ["conflicting", facts({ mergeable: "CONFLICTING" })], ["mergeability unknown", facts({ mergeable: "UNKNOWN" })],
    ["behind its base", facts({ mergeState: "BEHIND" })], ["dirty", facts({ mergeState: "DIRTY" })], ["merge state unknown", facts({ mergeState: undefined })]]) {
    for (const band of ["review", "uncertain"]) {
      const o = outcome(live(band), f);
      assert.equal(o.code, 1, `${band}: ${why}`); assert.match(o.text, /HOLD \(Jev merge below the act bar, .* band, and a gate this helper checks is not green/, why);
    }
  }
  assert.deepEqual(gateProblems(green), []);
  for (const st of ["UNSTABLE", "BLOCKED", "HAS_HOOKS"]) assert.deepEqual(gateProblems(facts({ mergeState: st })), [], `${st} (required checks are checked separately)`);
  assert.equal(outcome(live("uncertain", "hold"), green).code, 1);
  assert.equal(outcome(live("review", "hold"), green).code, 1);
  assert.equal(outcome({ ...live("review"), stubbed: true }, green).code, 1, "a stub never confirms");
  assert.equal(outcome({ decided_by: "cache", band: "review", result: { decision: "merge" } }, green).code, 1, "only live Jev");
});

test("the CULTURE template keeps the below-bar confirm path (WO36)", () => {
  const c = fs.readFileSync(join(repo, "rig/template/CULTURE.md"), "utf8").replace(/\s+/g, " ");
  assert.match(c, /only live Jev `merge` in the act band merges on its own; a merge below the act bar, with every deterministic gate green, merges after a one-line exact-head `confirm <sha>` from the other-family independent reviewer, as the integrator role says/);
  assert.doesNotMatch(c, /only live Jev `merge` in the act band merges\)/);
});


// ---- WO37: N/A instead of MISSING, from verified facts only -------------------------------------------------------
const diffOf = (files) => files.map(([path, removed = [], added = [], oldPath = path]) =>
  `diff --git a/${oldPath} b/${path}\n--- a/${oldPath}\n+++ b/${path}\n@@ -1 +1 @@\n${removed.map((l) => "-" + l).join("\n")}\n${added.map((l) => "+" + l).join("\n")}`).join("\n");
const CULTURE = "## Owner decisions\n- Transition (operator, 2026-09-30 12:55Z): PRs opened before 13:00Z may merge on their existing QA and witness\n  evidence; PRs opened from 13:00Z need the bug-review-board verdict (proof brb-<head>.md).\n";

test("the bug-review-board cutoff comes from AGENT_BRB_REQUIRED_SINCE, else the rig CULTURE's transition bullet", () => {
  assert.deepEqual(brbCutoff({ env: {}, culture: CULTURE }), { iso: "2026-09-30T13:00:00.000Z", source: "the rig CULTURE's transition bullet" });
  assert.equal(brbCutoff({ env: { AGENT_BRB_REQUIRED_SINCE: "2026-10-01T08:00Z" }, culture: CULTURE }).source, "AGENT_BRB_REQUIRED_SINCE");
  assert.equal(brbCutoff({ env: { AGENT_BRB_REQUIRED_SINCE: "not a time" }, culture: CULTURE }).iso, "2026-09-30T13:00:00.000Z");
  assert.equal(brbCutoff({ env: {}, culture: "- Transition (op): PRs opened before 2026-11-02T09:30Z keep their evidence" }).iso, "2026-11-02T09:30:00.000Z");
  assert.equal(brbCutoff({ env: {}, culture: "## Operating rules\n- nothing here\n" }), null);
});

test("bug-review-board N/A: before the cutoff, or docs-only; a mixed or renamed-from-code PR still needs it", () => {
  const cutoff = brbCutoff({ env: {}, culture: CULTURE });
  const src = parseDiff(diffOf([["src/a.ts", ["x"], ["y"]]]));
  assert.equal(brbNotApplicable({ createdAt: "2026-09-30T11:02:00Z", cutoff, files: src }), "N/A: PR created 2026-09-30T11:02:00Z, before the bug-review-board cutoff 2026-09-30T13:00:00.000Z (the rig CULTURE's transition bullet)");
  assert.equal(brbNotApplicable({ createdAt: "2026-09-30T13:05:00Z", cutoff, files: src }), null);
  assert.match(brbNotApplicable({ createdAt: "2026-09-30T15:00:00Z", cutoff, files: parseDiff(diffOf([["docs/a.md"], ["README.md"], ["docs/img/x.png"]])) }), /^N\/A: 3 changed path\(s\), all docs/);
  assert.equal(brbNotApplicable({ createdAt: "2026-09-30T15:00:00Z", cutoff, files: parseDiff(diffOf([["docs/a.md"], ["src/a.ts"]])) }), null, "mixed: required");
  assert.equal(brbNotApplicable({ createdAt: "2026-09-30T15:00:00Z", cutoff, files: parseDiff(diffOf([["docs/moved.md", [], [], "src/code.ts"]])) }), null, "a rename out of code is not docs-only");
  assert.equal(brbNotApplicable({ createdAt: "2026-09-30T15:00:00Z", cutoff: null, files: src }), null, "no cutoff configured: required");
});

test("blast radius N/A: acceptance tests, docs, or features.json flag flips only (checked in the hunks); anything else needs it", () => {
  assert.equal(blastNotApplicable({ files: parseDiff(diffOf([["tests/acceptance/a.spec.ts"], ["tests/acceptance/b.spec.ts"], ["tests/acceptance/c.spec.ts"], ["tests/acceptance/d.spec.ts"]])) }),
    "N/A: 4 changed path(s), all tests/acceptance/ (checked in the diff): tests/acceptance/a.spec.ts, tests/acceptance/b.spec.ts, tests/acceptance/c.spec.ts, tests/acceptance/d.spec.ts");
  const flip = parseDiff(diffOf([["features.json", ['    "passes": false,'], ['    "passes": true,']]]));
  assert.ok(flagOnly(flip[0])); assert.match(blastNotApplicable({ files: flip }), /all features\.json flag flips only/);
  const notFlip = parseDiff(diffOf([["features.json", ['    "passes": false,'], ['    "passes": true,', '    "owner": "impl-codex-1",']]]));
  assert.equal(blastNotApplicable({ files: notFlip }), null, "a features.json edit that isn't only flag flips");
  const renamedKey = parseDiff(diffOf([["features.json", ['    "passes": false,'], ['    "shipped": true,']]]));
  assert.equal(blastNotApplicable({ files: renamedKey }), null, "a different key is not a flip");
  assert.match(blastNotApplicable({ files: parseDiff(diffOf([["docs/x.md"], ["tests/acceptance/y.spec.ts"]])) }), /all tests\/acceptance\/ or docs|all docs or tests\/acceptance\//);
  assert.equal(blastNotApplicable({ files: parseDiff(diffOf([["docs/x.md"], ["src/app.ts"]])) }), null, "mixed docs + src: required");
  assert.equal(blastNotApplicable({ files: [] }), null, "no diff read: required");
});

test("N/A replaces MISSING in the evidence and in the gate check, and only there", () => {
  const na = buildMergeInput(facts({ brb: null, brbNA: "N/A: PR created 2026-09-30T11:02:00Z, before the bug-review-board cutoff 2026-09-30T13:00:00.000Z (env)", blastRadius: null, blastNA: "N/A: 2 changed path(s), all docs (checked in the diff): a.md, b.md" }));
  assert.match(na.review, /\nN\/A: PR created .* before the bug-review-board cutoff/);
  assert.match(na.review, /blast radius N\/A: 2 changed path\(s\), all docs/);
  assert.doesNotMatch(na.review, /MISSING: no bug-review-board|MISSING: no blast-radius/);
  assert.deepEqual(gateProblems(facts({ brb: null, brbNA: "N/A: docs only" })), [], "a N/A proof is not a red gate");
  assert.deepEqual(gateProblems(facts({ brb: null })), ["no bug-review-board qa PASS for this head"]);
});

test("agent-merge-evidence end to end: a docs-only PR from before the cutoff gets N/A for both, a mixed PR gets MISSING", () => {
  const W2 = join(root, "work2"); fs.mkdirSync(join(W2, "rig"), { recursive: true }); fs.writeFileSync(join(W2, "rig/CULTURE.md"), CULTURE);
  const ghStub = (created) => fs.writeFileSync(join(bin, "gh"), `#!/bin/sh
case "$*" in
  "pr view 7 -R o/r --json headRefOid,baseRefOid") printf '{"headRefOid":"${H}","baseRefOid":"${B}"}\\n' ;;
  "pr view 7 -R o/r --json"*) printf '%s\\n' '{"number":7,"title":"Docs","createdAt":"${created}","headRefOid":"${H}","baseRefOid":"${B}","baseRefName":"main","headRefName":"d","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","isDraft":false,"comments":[],"reviews":[]}' ;;
  "pr diff 7 -R o/r") cat "${join(root, "diff7")}" ;;
  "pr checks 7 -R o/r --required --json"*) echo '[]' ;;
  "api repos/o/r/commits/${H}/statuses") echo '[]' ;;
  *) echo "unexpected gh $*" >&2; exit 9 ;;
esac
`, { mode: 0o755 });
  const setDiff = (diff) => fs.writeFileSync(join(root, "diff7"), diff);
  const run = () => JSON.parse(spawnSync(process.execPath, [join(repo, "orchestration/merge-evidence.js"), "7", "--repo", "o/r"],
    { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}`, OPENRIG_WORK_ROOT: W2, AGENT_BRB_REQUIRED_SINCE: "" } }).stdout);
  ghStub("2026-09-30T11:02:00Z"); setDiff(diffOf([["docs/guide.md"], ["README.md"]]));
  let r = run();
  assert.match(r.review, /N\/A: PR created 2026-09-30T11:02:00Z, before the bug-review-board cutoff 2026-09-30T13:00:00\.000Z/);
  assert.match(r.review, /blast radius N\/A: 2 changed path\(s\), all docs/);
  ghStub("2026-09-30T14:00:00Z"); setDiff(diffOf([["docs/guide.md"], ["src/app.ts"]]));
  r = run();
  assert.match(r.review, /MISSING: no bug-review-board proof/); assert.match(r.review, /MISSING: no blast-radius comment/);
});


test("diff parsing fails closed: quoted (non-ASCII) paths, binary files and unparseable headers never make a mixed change docs-only (QA round 1)", async () => {
  const { gitUnquote } = await import("../orchestration/merge-evidence.js");
  assert.equal(gitUnquote('"a/src/caf\\303\\251.js"'), "a/src/café.js");
  assert.equal(gitUnquote('"b/a \\"q\\" \\\\x"'), 'b/a "q" \\x');
  const readme = "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-a\n+b\n";
  const quoted = readme + 'diff --git "a/src/caf\\303\\251.js" "b/src/caf\\303\\251.js"\n--- "a/src/caf\\303\\251.js"\n+++ "b/src/caf\\303\\251.js"\n@@ -1 +1 @@\n-x\n+y\n';
  const binary = readme + 'diff --git "a/src/caf\\303\\251.png" "b/src/caf\\303\\251.png"\nindex 1..2 100644\nBinary files "a/src/caf\\303\\251.png" and "b/src/caf\\303\\251.png" differ\n';
  const garbled = readme + "diff --git something odd\n@@ -1 +1 @@\n-x\n+y\n";
  for (const [name, d, path] of [["quoted text", quoted, "src/café.js"], ["quoted binary", binary, "src/café.png"], ["unparseable header", garbled, "<unparsed diff header>"]]) {
    const files = parseDiff(d);
    assert.deepEqual(files.map((f) => f.path), ["README.md", path], name);
    assert.deepEqual(files[0].added, ["b"], `${name}: README keeps only its own lines`);
    assert.equal(brbNotApplicable({ createdAt: "2026-10-01T00:00:00Z", cutoff: null, files }), null, `${name}: BRB required`);
    assert.equal(blastNotApplicable({ files }), null, `${name}: blast radius required`);
  }
  assert.ok(parseDiff(binary)[1].binary);
});

test("features.json exemption needs an in-place text edit: a rename into it, a new file or a mode change needs a blast radius (QA round 1)", () => {
  const flip = '@@ -1 +1 @@\n-    "passes": false,\n+    "passes": true,\n';
  const renamed = parseDiff(`diff --git a/runtime-config.json b/features.json\nsimilarity index 95%\nrename from runtime-config.json\nrename to features.json\n--- a/runtime-config.json\n+++ b/features.json\n${flip}`);
  const created = parseDiff(`diff --git a/features.json b/features.json\nnew file mode 100644\n--- /dev/null\n+++ b/features.json\n${flip}`);
  const moded = parseDiff(`diff --git a/features.json b/features.json\nold mode 100644\nnew mode 100755\n--- a/features.json\n+++ b/features.json\n${flip}`);
  for (const [name, files] of [["rename", renamed], ["new file", created], ["mode change", moded]]) {
    assert.ok(!flagOnly(files[0]), name); assert.equal(blastNotApplicable({ files }), null, name);
  }
  assert.ok(flagOnly(parseDiff(`diff --git a/features.json b/features.json\nindex 1..2 100644\n--- a/features.json\n+++ b/features.json\n${flip}`)[0]), "an in-place flip still qualifies");
});

test("NEEDS CONFIRM names an N/A QA verdict as not required, not as a PASS (QA round 1)", () => {
  const o = outcome({ decided_by: "jev", band: "review", result: { decision: "merge" } }, facts({ brb: null, brbNA: "N/A: 2 changed path(s), all docs" }));
  assert.equal(o.code, 3); assert.match(o.text, /QA verdict not required \(2 changed path\(s\), all docs\)/); assert.doesNotMatch(o.text, /qa PASS/);
});

test("paths with spaces (Git leaves them unquoted) parse exactly; renames resolve only when the header rebuilds (QA round 2)", () => {
  const T = "\t";
  const docs = `diff --git a/docs/guide one.md b/docs/guide one.md\nindex 90be1f3..294186e 100644\n--- a/docs/guide one.md${T}\n+++ b/docs/guide one.md${T}\n@@ -1 +1 @@\n-before\n+after\n`;
  const src = `diff --git a/src/two words.ts b/src/two words.ts\nindex 1..2 100644\n--- a/src/two words.ts${T}\n+++ b/src/two words.ts${T}\n@@ -1 +1 @@\n-x\n+y\n`;
  const renameDocs = `diff --git a/docs/guide one.md b/docs/guide two.md\nsimilarity index 90%\nrename from docs/guide one.md\nrename to docs/guide two.md\n--- a/docs/guide one.md${T}\n+++ b/docs/guide two.md${T}\n@@ -1 +1,2 @@\n a\n+b\n`;
  const renameOut = `diff --git a/src/old name.ts b/docs/new name.md\nsimilarity index 90%\nrename from src/old name.ts\nrename to docs/new name.md\n`;
  const lying = `diff --git a/docs/x y.md b/docs/z w.md\nrename from src/secret.ts\nrename to docs/z w.md\n`;
  const at = { createdAt: "2026-10-01T00:00:00Z", cutoff: null };
  let f = parseDiff(docs);
  assert.deepEqual(f.map((x) => [x.path, x.oldPath, Boolean(x.unknown)]), [["docs/guide one.md", "docs/guide one.md", false]]);
  assert.match(brbNotApplicable({ ...at, files: f }), /^N\/A: 1 changed path\(s\), all docs/); assert.match(blastNotApplicable({ files: f }), /^N\/A: .*all docs/);
  f = parseDiff(docs + src);
  assert.deepEqual(f.map((x) => x.path), ["docs/guide one.md", "src/two words.ts"]);
  assert.equal(brbNotApplicable({ ...at, files: f }), null, "mixed with a spaced source file: required"); assert.equal(blastNotApplicable({ files: f }), null);
  f = parseDiff(renameDocs);
  assert.deepEqual(f.map((x) => [x.oldPath, x.path, Boolean(x.unknown), Boolean(x.renamed)]), [["docs/guide one.md", "docs/guide two.md", false, true]]);
  assert.match(brbNotApplicable({ ...at, files: f }), /^N\/A: .*all docs/, "a docs-to-docs rename with spaces is docs");
  f = parseDiff(renameOut);
  assert.deepEqual([f[0].oldPath, f[0].path, Boolean(f[0].unknown)], ["src/old name.ts", "docs/new name.md", false]);
  assert.equal(brbNotApplicable({ ...at, files: f }), null, "a rename out of source is not docs-only");
  f = parseDiff(lying);
  assert.ok(f[0].unknown, "rename lines that don't rebuild the header leave it unknown"); assert.equal(brbNotApplicable({ ...at, files: f }), null);
  assert.ok(parseDiff("diff --git something odd\n@@ -1 +1 @@\n-x\n+y\n")[0].unknown, "still fails closed");
});


// ---- WO38: BLOCKED only by the gate itself is "pending this gate" -------------------------------------------------
test("merge state: only jev-merge unmet reads as pending this gate; anything else stays BLOCKED with its reasons", () => {
  const base = { mergeState: "BLOCKED", mergeable: "MERGEABLE", reviewDecision: "", requiredContexts: ["verify", "qa-evidence", "jev-merge"], passingContexts: ["verify", "qa-evidence", "independent-review"] };
  assert.equal(mergeStateLine(base), "merge state: pending this gate (jev-merge not yet posted; every other required context passes)");
  assert.equal(mergeStateLine({ ...base, passingContexts: ["verify"] }), "merge state: BLOCKED (required context(s) not passing: qa-evidence; jev-merge not yet posted)");
  assert.match(mergeStateLine({ ...base, mergeable: "CONFLICTING" }), /^merge state: BLOCKED \(mergeable CONFLICTING; jev-merge not yet posted\)$/);
  assert.match(mergeStateLine({ ...base, reviewDecision: "REVIEW_REQUIRED" }), /BLOCKED \(review decision REVIEW_REQUIRED; jev-merge not yet posted\)/);
  assert.match(mergeStateLine({ ...base, requiredContexts: null }), /BLOCKED \(the required contexts could not be read\)/, "unknown facts keep BLOCKED");
  assert.match(mergeStateLine({ ...base, requiredContexts: ["verify"] }), /BLOCKED \(reason not visible to this helper\)/, "BLOCKED with nothing unmet: not called pending");
  for (const st of ["CLEAN", "BEHIND", "UNSTABLE"]) assert.equal(mergeStateLine({ ...base, mergeState: st }), `merge state: ${st}`);
  assert.match(buildMergeInput(facts({ ...base })).limits, /merge state: pending this gate/);
});

test("agent-merge-evidence end to end: required contexts from the ruleset and protection, passing ones from checks and statuses", () => {
  const status = (ir) => `[{"context":"independent-review","state":"${ir}","description":"ok","creator":{"login":"rev"}},{"context":"verify","state":"success"}]`;
  const ghFor = (ir) => fs.writeFileSync(join(bin, "gh"), `#!/bin/sh
case "$*" in
  "pr view 8 -R o/r --json headRefOid,baseRefOid") printf '{"headRefOid":"${H}","baseRefOid":"${B}"}\\n' ;;
  "pr view 8 -R o/r --json"*) printf '%s\\n' '{"number":8,"title":"Tests only","createdAt":"2026-09-30T15:00:00Z","headRefOid":"${H}","baseRefOid":"${B}","baseRefName":"master","headRefName":"t","mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED","reviewDecision":"","isDraft":false,"comments":[],"reviews":[]}' ;;
  "pr diff 8 -R o/r") printf 'diff --git a/tests/acceptance/a.spec.ts b/tests/acceptance/a.spec.ts\\n--- a/tests/acceptance/a.spec.ts\\n+++ b/tests/acceptance/a.spec.ts\\n@@ -1 +1 @@\\n-x\\n+y\\n' ;;
  "pr checks 8 -R o/r --required --json"*) echo '[{"name":"qa-evidence","state":"SUCCESS","bucket":"pass"}]' ;;
  "api repos/o/r/commits/${H}/statuses") echo '${status(ir)}' ;;
  "api repos/o/r/rules/branches/master") echo '[{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"verify"},{"context":"qa-evidence"},{"context":"jev-merge"}]}},{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"independent-review"}]}}]' ;;
  "api repos/o/r/branches/master/protection") echo "gh: Branch not protected (HTTP 404)" >&2; exit 1 ;;
  *) echo "unexpected gh $*" >&2; exit 9 ;;
esac
`, { mode: 0o755 });
  const run = () => spawnSync(process.execPath, [join(repo, "orchestration/merge-evidence.js"), "8", "--repo", "o/r"], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}`, OPENRIG_WORK_ROOT: root } });
  ghFor("success");
  let r = run(); assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).limits, /merge state: pending this gate \(jev-merge not yet posted; every other required context passes\)/);
  ghFor("failure");
  r = run(); assert.equal(r.status, 0, r.stderr);
  assert.match(JSON.parse(r.stdout).limits, /merge state: BLOCKED \(required context\(s\) not passing: independent-review; jev-merge not yet posted\)/);
});
