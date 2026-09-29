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
// m1: w01 witnessed by a member (hc layout); w02 not; w03 opts out; w04 finished; w06 has only a feature NAMED witness
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
// m2 shares global wave w02 (still unwitnessed) and witnesses w05 with a follow-on wave (mta layout)
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
  assert.match(rules, /Never `pkill -f`\/`killall` by a pattern/);
  const agents = fs.readFileSync(join(repo, "starter-kit/AGENTS.md"), "utf8");
  for (const cmd of ["agent-heavy build -- npm test", "agent-heavy browser -- npx playwright test"]) assert.ok(agents.includes(cmd), cmd);
  assert.doesNotMatch(agents, /`npx playwright test`/, "no bare playwright run left in How to run");
  for (const role of ["implementer", "qa", "test-author", "integrator", "lead"]) {
    const t = fs.readFileSync(join(repo, `rig/template/agents/${role}/guidance/role.md`), "utf8");
    assert.match(t, /agent-heavy (build|browser) --/, role);
    assert.doesNotMatch(t, /(?<!-- )`npx playwright test/, `${role}: bare playwright run`);
  }
});
