// agent-project-check WARNs when an open mission has no W witness slice (agent witness default).
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
const slice = (m, s, fm) => write(join(W, "missions", m, "slices", s, "SPEC.md"),
  `---\nid: ${m}.${s}\n${fm}\ndepends_on: []\n---\n## Intent\nx\nTerritory: x\n## Mini-requirements\n## Proof contract\n`);
const MISSIONS = ["open-no-w", "open-with-w", "all-done", "mtd-style", "empty-open", "empty-done", "feature-named-witness", "marker-with-comment"];
for (const m of MISSIONS) for (const f of ["SPEC.md", "PROGRESS.md", "NOTES.md"]) write(join(W, "missions", m, f), "x\n");
for (const m of MISSIONS) write(join(W, "missions", m, "mission.yaml"),
  `kind: mission\nmetadata:\n  name: ${m}\n  status: ${m === "all-done" || m === "empty-done" ? "done" : "active"}\n`);
slice("open-no-w", "01-feature", "status: building");
slice("open-with-w", "01-feature", "status: building");
slice("open-with-w", "02-close", "status: shaped\nwitness: true");
slice("all-done", "01-feature", "status: done");
slice("mtd-style", "01-feature", "status: building");
slice("mtd-style", "08-1-w-staging-witness", "status: shaped");
// no slices yet: "empty-open" (active) must be named, "empty-done" must not
slice("feature-named-witness", "01-witness-account-setup", "status: building\nwitness: false"); // a feature, not the W slice
slice("marker-with-comment", "01-close", "status: shaped\nwitness: true # the final witness");
// stub rig/gh/systemctl: every call answers nothing, so only the file checks matter here
fs.mkdirSync(bin);
for (const t of ["rig", "gh", "systemctl", "curl"]) fs.writeFileSync(join(bin, t), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

test("WARN names each open mission (by slices or by its own status) that has no W witness slice; W recognised precisely", () => {
  const r = spawnSync("python3", [join(repo, "bin/agent-project-check"), W, "--json"], { encoding: "utf8",
    // a closed port: the daemon checks fail fast, and the live daemon is never touched
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, OPENRIG_URL: "http://127.0.0.1:9" }, timeout: 60000 });
  const rows = JSON.parse(r.stdout);
  const w = rows.find(x => x.check.startsWith("every open mission ends with a W witness slice"));
  assert.ok(w, r.stdout.slice(0, 400) + r.stderr.slice(0, 400));
  assert.equal(w.level, "WARN");
  assert.match(w.detail, /^missing in empty-open, feature-named-witness, open-no-w; copy agent-stack rig\/template\/witness-slice\/$/);
});

test("the W slice template carries the marker the check looks for", () => {
  const spec = fs.readFileSync(join(repo, "rig/template/witness-slice/SPEC.md"), "utf8");
  assert.match(spec, /^witness: true$/m);
  assert.match(spec, /agent-witnessed \(YYYY-MM-DD, by <agent>, <model>\)/);
  assert.match(spec, /## Intent[\s\S]*Territory:[\s\S]*## Mini-requirements[\s\S]*## Proof contract/);
});
