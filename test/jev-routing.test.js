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
const { buildMergeInput, passes, outcome, gateProblems } = await import("../orchestration/merge-evidence.js");
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
const facts = (over = {}) => ({ pr: 42, head: H, base: B, baseRef: "main", headRef: "agent/x", mergeable: "MERGEABLE", isDraft: false,
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
  "pr view 42 -R o/r --json"*) echo '{"number":42,"title":"Adds login","headRefOid":"${H}","baseRefOid":"${B}","baseRefName":"main","headRefName":"agent/x","mergeable":"MERGEABLE","isDraft":false,"comments":[{"body":"looks good","url":"https://x/c0","createdAt":"2026-09-30T09:00:00Z","author":{"login":"a"}},{"body":"## Blast radius\\nSafe because: only a nullable column (${H.slice(0, 7)}).","url":"https://x/c1","createdAt":"2026-09-30T10:00:00Z","author":{"login":"rev"}},{"body":"Implementation update on ${H.slice(0, 7)}: my tests pass, all fixes are ready for review.","url":"https://x/c3","createdAt":"2026-09-30T11:00:00Z","author":{"login":"builder"}}],"reviews":[{"body":"Lenses applied: correctness, security. Verified the login tests pass on ${H.slice(0, 7)}; one finding fixed.","url":"https://x/r1","submittedAt":"2026-09-30T10:05:00Z","author":{"login":"rev"},"commit":{"oid":"${H}"}}]}' ;;
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
  const nc = outcome(live("review"), green);
  assert.equal(nc.code, 3); assert.match(nc.text, new RegExp(`NEEDS CONFIRM .*"confirm ${H}".*--match-head-commit ${H}`));
  for (const [why, f] of [["a failing check", facts({ checks: [{ name: "verify", bucket: "fail" }] })], ["review not success", facts({ independentReview: { ...facts().independentReview, state: "failure" } })],
    ["no QA verdict", facts({ brb: null })], ["QA verdict for another head", facts({ brb: { ...facts().brb, candidate_sha: "c".repeat(40) } })]]) {
    const o = outcome(live("review"), f);
    assert.equal(o.code, 1, why); assert.match(o.text, /HOLD \(Jev merge below the act bar, and not every deterministic gate is green/, why);
  }
  assert.deepEqual(gateProblems(green), []);
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
