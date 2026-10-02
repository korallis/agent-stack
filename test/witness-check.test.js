// agent-project-check: every OPEN WAVE ends with a W witness slice (or says no-witness), wave ids are global across
// missions, W slices are recognised precisely, and a mission without waves needs one W slice of its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "witness-"));
process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
const W = join(home, "Projects/P-work"), bin = join(home, "bin");
const write = (p, text) => { fs.mkdirSync(dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
write(join(W, "project.yaml"), "kind: project\n");
const slice = (m, dir, id, fm) => write(join(W, "missions", m, "slices", dir, "SPEC.md"),
  `---\nid: ${id}\n${fm}\ndepends_on: []\n---\n## Intent\nx\nTerritory: x\n## Mini-requirements\n## Proof contract\n`);
const mission = (m, status, waves) => {
  for (const f of ["SPEC.md", "PROGRESS.md", "NOTES.md"]) write(join(W, "missions", m, f), "x\n");
  const wy = waves.map(w => `  - id: ${w.id}\n    slices: [${w.slices.join(", ")}]\n${w.extra ?? ""}`).join("");
  write(join(W, "missions", m, "mission.yaml"), `kind: mission\nmetadata:\n  name: ${m}\n  status: ${status}\n${waves.length ? `arrangement:\n  waves:\n${wy}` : ""}`);
};
// m1: w01 witnessed by a member (project A layout); w02 not; w03 opts out; w04 finished; w06 has only a feature NAMED witness
mission("m1", "active", [
  { id: "w01", slices: ["A1", "A2", "AW"] }, { id: "w02", slices: ["B1"] },
  { id: "w03", slices: ["C1"], extra: "    no-witness: docs only\n" }, { id: "w04", slices: ["D1"] },
  { id: "w06", slices: ["G1", "G2"] }, { id: "w07", slices: ["H1", "HW"] },
]);
slice("m1", "01-a1", "A1", "status: building"); slice("m1", "02-a2", "A2", "status: building");
slice("m1", "03-w01-witness", "AW", "status: shaped");                        // named W (no frontmatter flag)
slice("m1", "04-b1", "B1", "status: building"); slice("m1", "05-c1", "C1", "status: building");
slice("m1", "06-d1", "D1", "status: done");
slice("m1", "07-g1", "G1", "status: building");
slice("m1", "08-witness-account-setup", "G2", "status: building\nwitness: false"); // a feature, not a W slice
slice("m1", "09-h1", "H1", "status: building");
slice("m1", "10-close", "HW", "status: shaped\nwitness: true # the wave's witness");
// opt-outs: only a non-empty text reason, and never for a wave with a ui: true member; w00 names get no free pass
mission("m6", "active", [
  { id: "w00ui", slices: ["U0"] },                                          // user-facing work in a "w00" wave
  { id: "w10", slices: ["J1"], extra: "    no-witness: true\n" },          // not a reason
  { id: "w11", slices: ["K1"], extra: "    no-witness: ''\n" },            // empty
  { id: "w12", slices: ["L1"], extra: "    no-witness: '   '\n" },         // whitespace
  { id: "w13", slices: ["N1"], extra: "    no-witness: docs only\n" },     // ui: true member refuses the opt-out
]);
slice("m6", "01-u0", "U0", "status: building\nui: true");
for (const [d, id] of [["02-j1", "J1"], ["03-k1", "K1"], ["04-l1", "L1"]]) slice("m6", d, id, "status: building");
slice("m6", "05-n1", "N1", "status: building\nui: true # a screen");
// m2 shares global wave w02 (still unwitnessed) and witnesses w05 with a follow-on wave (project B layout)
mission("m2", "active", [{ id: "w02", slices: ["E1"] }, { id: "w05", slices: ["F1"] }, { id: "w05w", slices: ["FW"] }]);
slice("m2", "01-e1", "E1", "status: building"); slice("m2", "02-f1", "F1", "status: building");
slice("m2", "03-m2-w-witness", "FW", "status: shaped");
// missions without waves: m3 lacks a W slice, m4 has one, m5 is done
mission("m3", "active", []); slice("m3", "01-x", "X1", "status: building");
mission("m4", "active", []); slice("m4", "01-y", "Y1", "status: building"); slice("m4", "02-w-witness", "YW", "status: shaped");
mission("m5", "done", []);
fs.mkdirSync(bin);
for (const t of ["rig", "gh", "systemctl", "curl"]) fs.writeFileSync(join(bin, t), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

test("WARN names exactly the open waves (global across missions) and wave-less missions without a W slice", () => {
  const r = spawnSync("python3", [join(repo, "bin/agent-project-check"), W, "--json"], { encoding: "utf8",
    // a closed port: the daemon checks fail fast, and the live daemon is never touched
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, OPENRIG_URL: "http://127.0.0.1:9" }, timeout: 60000 });
  const w = JSON.parse(r.stdout).find(x => x.check.startsWith("every open wave ends with a W witness slice"));
  assert.ok(w, r.stdout.slice(0, 300) + r.stderr.slice(0, 300));
  assert.equal(w.level, "WARN");
  assert.equal(w.detail, "missing in m3, w00ui, w02, w06, w10, w11…; copy agent-stack rig/template/witness-slice/");
});

test("the full unwitnessed set (untruncated) is exactly m3, w00ui, w02, w06, w10, w11, w12, w13", () => {
  const r = spawnSync("python3", [join(repo, "bin/agent-project-check"), W, "--json"], { encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, OPENRIG_URL: "http://127.0.0.1:9", AGENT_PROJECT_CHECK_FULL: "1" }, timeout: 60000 });
  const w = JSON.parse(r.stdout).find(x => x.check.startsWith("every open wave ends with a W witness slice"));
  assert.equal(w.detail, "missing in m3, w00ui, w02, w06, w10, w11, w12, w13; copy agent-stack rig/template/witness-slice/");
});

test("the W slice template carries the marker, the witness record and the required sections", () => {
  const spec = fs.readFileSync(join(repo, "rig/template/witness-slice/SPEC.md"), "utf8");
  assert.match(spec, /^witness: true$/m);
  assert.match(spec, /agent-witnessed \(YYYY-MM-DD, by <agent>, <model>\)/);
  assert.match(spec, /## Intent[\s\S]*Territory:[\s\S]*## Mini-requirements[\s\S]*## Proof contract/);
});

// Heavy runs (2026-09-29: load 101 on 32 cores from parallel suites stalled the OpenRig daemon).
test("agent-project-check WARNs when the conventions don't require agent-heavy, OK once CULTURE.md does", () => {
  const check = () => JSON.parse(spawnSync("python3", [join(repo, "bin/agent-project-check"), W, "--json"], { encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, OPENRIG_URL: "http://127.0.0.1:9" }, timeout: 60000 }).stdout)
    .find(x => x.check.startsWith("conventions require agent-heavy"));
  const before = check();
  assert.equal(before.level, "WARN");
  assert.match(before.detail, /rig\/template\/CULTURE\.md/);
  write(join(W, "rig/CULTURE.md"), fs.readFileSync(join(repo, "rig/template/CULTURE.md"), "utf8"));
  try { assert.equal(check().level, "OK"); } finally { fs.rmSync(join(W, "rig"), { recursive: true, force: true }); }
});

test("templates require agent-heavy for heavy runs and forbid pattern pkill", () => {
  const culture = fs.readFileSync(join(repo, "rig/template/CULTURE.md"), "utf8");
  const rules = culture.split(/^## /m).find(s => s.startsWith("Operating rules"));
  assert.match(rules, /`agent-heavy build -- <cmd>`/);
  assert.match(rules, /`agent-heavy browser -- <cmd>`/);
  assert.match(rules, /no pattern-based killall or pkill/);
  const agents = fs.readFileSync(join(repo, "starter-kit/AGENTS.md"), "utf8");
  for (const cmd of ["agent-heavy build -- npm test", "agent-heavy browser -- npx playwright test"]) assert.ok(agents.includes(cmd), cmd);
  assert.doesNotMatch(agents, /`npx playwright test`/, "no bare playwright run left in How to run");
  for (const role of ["implementer", "qa", "test-author", "integrator", "lead"]) {
    const t = fs.readFileSync(join(repo, `rig/template/agents/${role}/guidance/role.md`), "utf8");
    assert.match(t, /agent-heavy (build|browser) --/, role);
    assert.doesNotMatch(t, /(?<!-- )`npx playwright test/, `${role}: bare playwright run`);
  }
});

// WO25 A: research -> plan -> implement is the template default.
test("templates carry Research, plan, implement: the CULTURE section and the four role lines", () => {
  const culture = fs.readFileSync(join(repo, "rig/template/CULTURE.md"), "utf8");
  const sec = culture.split(/^## /m).find((s) => s.startsWith("Research, plan, implement"));
  assert.ok(sec, "section present");
  assert.ok(culture.indexOf("## Research, plan, implement") < culture.indexOf("Prove user-facing work"), "before Done means");
  assert.match(sec, /Before code,[\s\S]*Record `## Research`[\s\S]*`## Plan`[\s\S]*slice PROGRESS\.md/);
  const role = (r) => fs.readFileSync(join(repo, `rig/template/agents/${r}/guidance/role.md`), "utf8");
  assert.match(role("implementer"), /`## Research` .* and `## Plan` .* into the slice's PROGRESS\.md/s);
  assert.match(role("implementer"), /writing-plans → test-driven-development/, "Superpowers line kept as the plan tool");
  assert.match(role("architect"), /SPEC .* carries the research/s);
  assert.match(role("lead"), /Never dispatch builders on a slice whose SPEC has no research/);
  assert.match(role("reviewer"), /Send the PR back to its author when its slice's PROGRESS\.md has no `## Research` and `## Plan`/);
});

test("agent-project-check WARNs when the rig's CULTURE.md lacks Research, plan, implement; OK with the template's", () => {
  const specDir = join(W, "rig"); fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(join(specDir, "team.yaml"), `name: t\npods:\n  - id: coord\n    members:\n      - id: lead\n        cwd: "${home}"\n`);
  const check = () => JSON.parse(spawnSync("python3", [join(repo, "bin/agent-project-check"), W, "--json"], { encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, OPENRIG_URL: "http://127.0.0.1:9" }, timeout: 60000 }).stdout)
    .find((x) => x.check.startsWith("CULTURE.md has the Research, plan, implement section"));
  try {
    fs.writeFileSync(join(specDir, "CULTURE.md"), "## Owner decisions\n## Operating rules\n");
    const w = check();
    assert.equal(w.level, "WARN");
    assert.match(w.detail, /copy the section from agent-stack rig\/template\/CULTURE\.md, then agent-refresh-guidance/);
    fs.writeFileSync(join(specDir, "CULTURE.md"), fs.readFileSync(join(repo, "rig/template/CULTURE.md"), "utf8"));
    assert.equal(check().level, "OK");
  } finally { fs.rmSync(specDir, { recursive: true, force: true }); }
});

// WO30: the workflow skills are the default. The CULTURE section, the role texts, and agent-project-check.
const WORKFLOW = ["bug-review-board", "verification-guide", "blast-radius", "review-lenses", "unslop", "technical-writing"];
test("templates carry the Workflow skills: the CULTURE section names each skill; every role names its skills and says when", () => {
  const culture = fs.readFileSync(join(repo, "rig/template/CULTURE.md"), "utf8");
  const sec = culture.split(/^## /m).find((s) => s.startsWith("Workflow skills"));
  assert.ok(sec, "section present");
  assert.ok(culture.indexOf("## Workflow skills") < culture.indexOf("Prove user-facing work"));
  for (const n of WORKFLOW) assert.match(sec, new RegExp("`" + n + "`"), n);
  const expect = { qa: ["bug-review-board", "verification-guide", "unslop"], reviewer: ["review-lenses", "blast-radius", "unslop"],
    integrator: ["blast-radius", "bug-review-board"], architect: ["verification-guide", "technical-writing"],
    lead: ["bug-review-board", "unslop"], implementer: ["unslop", "technical-writing"], "test-author": ["verification-guide"],
    deputy: ["unslop"], recovery: ["unslop"] };
  for (const [r, skills] of Object.entries(expect)) {
    const t = fs.readFileSync(join(repo, `rig/template/agents/${r}/guidance/role.md`), "utf8");
    const load = t.split("\n").find((l) => l.startsWith("Skills to load:"));
    const when = t.split("\n").find((l) => l.startsWith("Workflow skills (CULTURE.md"));
    assert.ok(load && when, r);
    for (const n of skills) { assert.ok(load.includes(n), `${r} loads ${n}`); assert.ok(when.includes("`" + n + "`"), `${r} says when to use ${n}`); }
  }
});

test("agent-project-check WARNs on a CULTURE without Workflow skills and on skills seats can't see; OK once both are there", () => {
  const specDir = join(W, "rig"); fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(join(specDir, "team.yaml"), `name: t\npods:\n  - id: coord\n    members:\n      - id: lead\n        cwd: "${home}"\n`);
  const rows = () => JSON.parse(spawnSync("python3", [join(repo, "bin/agent-project-check"), W, "--json"], { encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, OPENRIG_URL: "http://127.0.0.1:9" }, timeout: 60000 }).stdout);
  const find = (r, p) => r.find((x) => x.check.startsWith(p));
  const dirs = [join(home, ".claude/skills"), join(home, ".agents/skills")];
  try {
    fs.writeFileSync(join(specDir, "CULTURE.md"), "## Owner decisions\n## Operating rules\n");
    let r = rows();
    assert.equal(find(r, "CULTURE.md has the Workflow skills section").level, "WARN");
    assert.equal(find(r, "seats can see the workflow skills").level, "WARN");
    assert.match(find(r, "seats can see the workflow skills").detail, /run \.\/install\.sh --apply/);
    fs.writeFileSync(join(specDir, "CULTURE.md"), fs.readFileSync(join(repo, "rig/template/CULTURE.md"), "utf8"));
    for (const d of dirs) for (const n of WORKFLOW) { fs.mkdirSync(join(d, n), { recursive: true }); fs.writeFileSync(join(d, n, "SKILL.md"), "x"); }
    r = rows();
    assert.equal(find(r, "CULTURE.md has the Workflow skills section").level, "OK");
    assert.equal(find(r, "seats can see the workflow skills").level, "OK");
    fs.rmSync(join(dirs[1], "unslop"), { recursive: true });
    assert.match(find(rows(), "seats can see the workflow skills").detail, /\.agents\/skills\/unslop/);
  } finally { fs.rmSync(specDir, { recursive: true, force: true }); for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }
});

// WO41: Owner decisions hold only the owner's own decisions, with their source; a Jev HOLD in any band blocks.
test("templates: Owner decisions are the owner's only, with a source; operator and lead rules apart; HOLD in any band blocks", () => {
  const culture = fs.readFileSync(join(repo, "rig/template/CULTURE.md"), "utf8");
  const sec = (h) => culture.split(/^## /m).find((s) => s.startsWith(h));
  assert.match(sec("Owner decisions"), /the owner's own decisions only/);
  assert.match(sec("Owner decisions"), /ending with its\s+source: `- YYYY-MM-DD: <decision> \(scope\) \(owner, Slack HH:MMZ\)` or `\.\.\. \(owner, via operator relay of <ref>\)`/);
  assert.match(sec("Owner decisions"), /When an\s+owner answer is ambiguous, ask \(through the operator\) before recording it/);
  assert.ok(sec("Operator and lead rules (not the owner's decisions)"), "the separate section exists");
  assert.ok(culture.indexOf("## Owner decisions") < culture.indexOf("## Operator and lead rules") && culture.indexOf("## Operator and lead rules") < culture.indexOf("## Operating rules"));
  assert.match(fs.readFileSync(join(repo, "rig/template/guidance/delivery.md"), "utf8"), /A Jev HOLD in ANY band \(act, review or\s+uncertain\) blocks the merge unless the owner waives it[\s\S]*the\s+confirm path applies only to a Jev MERGE below the act bar, never to a HOLD/);
  const role = (r) => fs.readFileSync(join(repo, `rig/template/agents/${r}/guidance/role.md`), "utf8");
  assert.match(role("lead"), /"Owner decisions" holds ONLY the owner's own decisions[\s\S]*Never write your interpretation[\s\S]*ask \(through the operator\) before recording/);
  assert.match(role("integrator"), /Jev chose HOLD in ANY band \(act, review or uncertain\)[\s\S]*an operator or lead rule never overrides a HOLD/);
  assert.doesNotMatch(role("integrator"), /HOLD in the act band/);
  // the owner's 18:06Z row doesn't say who overrides Jev; that restriction is the operator's rule
  assert.doesNotMatch(sec("Owner decisions"), /overrides a Jev result/);
  assert.match(sec("Operator and lead rules"), /^- 2026-10-02: Only the owner overrides a Jev result[^\n]*\(operator, 18:07Z\)$/m);
  // reading a Jev result: only decided_by jev counts; anything else escalates to the operator
  const jev = sec("Reading a Jev result");
  assert.match(jev, /^Reading a Jev result \(operator rule, 2026-10-02 18:32Z\)/);
  assert.match(jev, /Only `decided_by: jev` is Jev's decision\. A `fallback_model` answer is not, whatever its top-level band/);
  assert.match(jev, /On `fallback_model`, review, uncertain or `none_fit`, change nothing and\s+escalate to the operator with the question, the options and the Jev record ids/);
  // the owner's 18:29Z standing order, recorded as given
  assert.match(sec("Owner decisions"), /^- 2026-10-02: Speed without losing quality: nothing waits unless it must; parallelise independent work across free seats; ship each change as soon as its checks pass \(no batching\); route reviews and QA to any free eligible reviewer; every quality gate stays\. \(standing: every seat, every rig\) \(owner, Slack 18:29Z\)$/m);
});

test("agent-project-check WARNs on an unsourced Owner decisions bullet and on one resting on docs/decisions/*", () => {
  const specDir = join(W, "rig"); fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(join(specDir, "team.yaml"), `name: t\npods:\n  - id: coord\n    members:\n      - id: lead\n        cwd: "${home}"\n`);
  const rows = (extra = {}) => JSON.parse(spawnSync("python3", [join(repo, "bin/agent-project-check"), W, "--json"], { encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, OPENRIG_URL: "http://127.0.0.1:9", AGENT_OWNER_ADDRESS: "alex@external", ...extra }, timeout: 60000 }).stdout);
  const find = (r, p) => r.find((x) => x.check.startsWith(p));
  const tmpl = fs.readFileSync(join(repo, "rig/template/CULTURE.md"), "utf8");
  // the template's own standing decisions stay; test bullets go at the end of the section
  const withDecisions = (bullets) => tmpl.replace(/(## Owner decisions[^\n]*\n(?:(?!## )[^\n]*\n)*?)(\n## Operator and lead rules)/, (_, a, b) => `${a}${bullets}${b}`);
  try {
    fs.writeFileSync(join(specDir, "CULTURE.md"), withDecisions([
      "- 2026-09-30: Merges need green CI (all PRs) (owner, Slack 14:05Z)",
      "- 2026-09-30: Plan approval is the owner's. (owner, via operator relay of qitem-20260930-1)",
      "- 2026-09-30: Only a confident Jev hold blocks a merge",
      "  (see docs/decisions/merge-gate.md)",
      "- 2026-09-30: Transition (operator, 12:55Z): PRs opened before 13:00Z keep their QA evidence", ""].join("\n")));
    let r = rows();
    const src = find(r, "every Owner decisions bullet ends with its owner source");
    assert.equal(src.level, "WARN");
    assert.match(src.detail, /^2 without \(owner or the owner's name, Slack HH:MMZ\) or \(…, via operator relay of <ref>\): 2026-09-30: Only a confident Jev hold blocks a merge \(see docs\/decisio…; 2026-09-30: Transition \(operator/);
    assert.match(src.detail, /move a rule that isn't the owner's to "Operator and lead rules"/);
    const doc = find(r, "no Owner decisions bullet rests on a lead doc");
    assert.equal(doc.level, "WARN"); assert.match(doc.detail, /Only a confident Jev hold blocks.*a lead's doc is not the owner's word/);
    assert.equal(find(r, "CULTURE.md has the Owner decisions, Operator and lead rules and Operating rules sections").level, "OK");
    // QA WO41 f2: a blank relay reference is no source; * and + bullets are bullets; a paragraph after a blank line
    // inside an item still belongs to it.
    for (const [bullets, level] of [
      ["- 2026-09-30: Policy. (owner, via operator relay of    )\n", "WARN"],
      ["* 2026-09-30: Policy.\n", "WARN"], ["+ 2026-09-30: Policy.\n", "WARN"],
      ["- 2026-09-30: Policy with a long reason\n\n  (owner, Slack 09:10Z)\n", "OK"],
      ["* 2026-09-30: Policy. (owner, via operator relay of qitem-7)\n", "OK"],
      // The operator's effect test: sources written with the owner's name (from agent-owner-address, not the repo).
      ["- 2026-09-30: Policy. (Alex, Slack 08:08Z)\n", "OK"], ["- 2026-09-30: Policy (alex approved, Slack 14:04Z); scope x.\n", "OK"],
      ["- 2026-09-30: Policy. (ALEX, via operator relay of qitem-9)\n", "OK"], ["- 2026-09-30: Alex confirmed (Slack 14:51Z, 'yes'): x.\n", "OK"],
      ["- 2026-09-30: Alex waived the hold on #9.\n", "WARN"],
      ["- 2026-09-30: Policy (Alex: \"just do it\").\n", "WARN"], ["- 2026-09-30: Policy. (Alexander, Slack 08:08Z)\n", "WARN"],
      ["- 2026-09-30: Policy (2026-09-30 10:00Z).\n", "WARN"]]) {
      fs.writeFileSync(join(specDir, "CULTURE.md"), withDecisions(bullets));
      assert.equal(find(rows(), "every Owner decisions bullet ends with its owner source").level, level, JSON.stringify(bullets));
    }
    fs.writeFileSync(join(specDir, "CULTURE.md"), withDecisions("- 2026-09-30: Policy. (Sam Park, Slack 08:08Z)\n"));
    assert.equal(find(rows(), "every Owner decisions bullet ends with its owner source").level, "WARN", "another person's name is not the owner's");
    assert.equal(find(rows({ AGENT_OWNER_NAMES: "Sam Park" }), "every Owner decisions bullet ends with its owner source").level, "OK", "extra names by config");
    fs.writeFileSync(join(specDir, "CULTURE.md"), tmpl);
    r = rows();
    assert.equal(find(r, "every Owner decisions bullet ends with its owner source").level, "OK", "(none yet) is fine");
    assert.equal(find(r, "no Owner decisions bullet rests on a lead doc").level, "OK");
    fs.writeFileSync(join(specDir, "CULTURE.md"), "## Owner decisions\n- (none yet)\n## Operating rules\n");
    const lacks = find(rows(), "CULTURE.md has the Owner decisions, Operator and lead rules and Operating rules sections");
    assert.equal(lacks.level, "WARN"); assert.match(lacks.detail, /missing Operator and lead rules/);
  } finally { fs.rmSync(specDir, { recursive: true, force: true }); }
});

// WO55: a failed queue read WARNs with its exit code (it used to skip the whole queue section silently), and a window
// with no rows says so.
test("agent-project-check: a failed queue read WARNs with the exit code; an empty window says so; recent rows are judged", () => {
  const specDir = join(W, "rig"); fs.mkdirSync(specDir, { recursive: true });
  fs.writeFileSync(join(specDir, "team.yaml"), `name: t\npods:\n  - id: coord\n    members:\n      - id: lead\n        cwd: "${home}"\n`);
  const rigStub = (queueScript) => fs.writeFileSync(join(bin, "rig"), `#!/bin/sh\ncase "$*" in\n  "queue list"*) ${queueScript} ;;\n  *) exit 1 ;;\nesac\n`, { mode: 0o755 });
  const rows = () => JSON.parse(spawnSync("python3", [join(repo, "bin/agent-project-check"), W, "--json"], { encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, OPENRIG_URL: "http://127.0.0.1:9", AGENT_OWNER_ADDRESS: "owner@external" }, timeout: 120000 }).stdout);
  const find = (r, p) => r.filter((x) => x.check.startsWith(p));
  const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
  const row = (at, extra = {}) => ({ qitemId: `qitem-${at}`, destinationSession: "impl-a@t", sourceSession: "lead@t", tsCreated: at, tags: ["project:P", "mission:m1"], body: "worktree_path=/x", ...extra });
  try {
    rigStub(`echo "daemon timed out" >&2; exit 3`);
    let r = rows();
    assert.deepEqual(find(r, "could not read the queue").map((x) => [x.level, x.detail]), [["WARN", "rig queue list exit 3: daemon timed out"]]);
    assert.equal(find(r, "queue rows").length, 0);
    rigStub(`echo 'not json'`);
    assert.match(find(rows(), "could not read the queue")[0].detail, /not JSON/);
    // QA PR60 f1: no rig on PATH at all: a report, with the queue WARN, not a crash
    fs.rmSync(join(bin, "rig"));
    const noRig = spawnSync("python3", [join(repo, "bin/agent-project-check"), W, "--json"], { encoding: "utf8",
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, OPENRIG_URL: "http://127.0.0.1:9", AGENT_OWNER_ADDRESS: "owner@external" }, timeout: 120000 });
    assert.doesNotMatch(noRig.stderr, /Traceback/, noRig.stderr.slice(-400));
    assert.match(find(JSON.parse(noRig.stdout), "could not read the queue")[0].detail, /rig queue list exit 127: rig: No such file/);
    rigStub(`exit 0`);   // QA PR60: exit 0 with no output is not an empty queue
    assert.match(find(rows(), "could not read the queue")[0].detail, /exited 0 with no output/);
    for (const [out, kind] of [["null", "NoneType"], ['{"rows": []}', "dict"]]) {
      rigStub(`echo '${out}'`);
      assert.match(find(rows(), "could not read the queue")[0].detail, new RegExp(`not a list of rows \\(${kind}\\)`), out);
    }
    rigStub(`echo '${JSON.stringify([row(iso(3 * 86400e3))])}'`);   // only rows older than the 24h window
    r = rows();
    assert.equal(find(r, "could not read the queue").length, 0);
    const empty = find(r, "queue rows since");
    assert.equal(empty.length, 1); assert.equal(empty[0].level, "OK"); assert.match(empty[0].check, /none for this project in the window/);
    assert.match(empty[0].detail, /^1 row\(s\) of this rig in total/);
    rigStub(`echo '${JSON.stringify([row(iso(3600e3)), row(iso(1800e3), { tags: ["mission:m1"] })])}'`);
    r = rows();
    assert.deepEqual(find(r, "queue rows").map((x) => x.level), ["WARN", "OK", "OK"], "recent rows: the three tag checks run");
    assert.match(find(r, "queue rows since")[0].detail, /^1\/2$/);
  } finally {
    fs.writeFileSync(join(bin, "rig"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    fs.rmSync(specDir, { recursive: true, force: true });
  }
});
