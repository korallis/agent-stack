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
  assert.equal(w.detail, "missing in m3, w02, w06; copy agent-stack rig/template/witness-slice/");
});

test("the W slice template carries the marker, the witness record and the required sections", () => {
  const spec = fs.readFileSync(join(repo, "rig/template/witness-slice/SPEC.md"), "utf8");
  assert.match(spec, /^witness: true$/m);
  assert.match(spec, /agent-witnessed \(YYYY-MM-DD, by <agent>, <model>\)/);
  assert.match(spec, /## Intent[\s\S]*Territory:[\s\S]*## Mini-requirements[\s\S]*## Proof contract/);
});
