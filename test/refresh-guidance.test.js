// agent-refresh-guidance names blocks the way OpenRig does, by the declared path (startup/context.md), and repairs the
// stray basename copy ("context.md") an earlier version appended (WO22 addendum). A fixture workspace in a throwaway HOME.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "refresh-"));
process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
const W = join(home, "Projects/P-work"), WT = join(home, "Projects/P.worktrees");
const B = (n, body) => `<!-- BEGIN OpenRig MANAGED BLOCK: ${n} -->\n${body}\n<!-- END OpenRig MANAGED BLOCK: ${n} -->\n`;
function setup(seatText) {
  fs.rmSync(join(home, "Projects"), { recursive: true, force: true });
  fs.mkdirSync(join(W, "rig/startup"), { recursive: true });
  fs.writeFileSync(join(W, "rig/CULTURE.md"), "culture v2");
  fs.writeFileSync(join(W, "rig/startup/context.md"), "context v2");
  fs.writeFileSync(join(W, "rig/team.yaml"), `name: p\nmanaged_blocks:\n  claude-code: CLAUDE.local.md\nstartup:\n  files:\n    - path: startup/context.md\n      delivery_hint: guidance_merge\npods:\n  - id: coord\n    members:\n      - id: lead\n        cwd: "${WT}/coord-lead"\n`);
  fs.mkdirSync(join(WT, "coord-lead"), { recursive: true });
  fs.writeFileSync(join(WT, "coord-lead/CLAUDE.local.md"), seatText);
}
const run = (...a) => spawnSync(join(repo, "bin/agent-refresh-guidance"), ["P", ...a], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: home } });
const seat = () => fs.readFileSync(join(WT, "coord-lead/CLAUDE.local.md"), "utf8");
const own = "# my own notes\nkeep me\n\n";

test("refreshes the startup/context.md block by its declared path, and never appends a context.md copy", () => {
  setup(own + B("CULTURE.md", "culture v1") + "\n" + B("startup/context.md", "context v1") + "\n" + B("openrig-start.md", "shipped"));
  const r = run("--apply");
  assert.equal(r.status, 0, r.stderr);
  const t = seat();
  assert.match(t, /BLOCK: startup\/context\.md -->\ncontext v2\n/);
  assert.match(t, /BLOCK: CULTURE\.md -->\nculture v2\n/);
  assert.doesNotMatch(t, /BLOCK: context\.md -->/);
  assert.ok(t.startsWith(own), "text outside blocks untouched");
  assert.match(t, /BLOCK: openrig-start\.md -->\nshipped\n/);
  assert.equal(run("--apply").stdout.match(/APPLIED: (\d+)\//)[1], "0", "idempotent");
});

test("repair: the stray context.md block is removed when startup/context.md exists; a backup is kept", () => {
  const before = own + B("CULTURE.md", "culture v2") + "\n" + B("startup/context.md", "context v2") + "\n" + B("openrig-start.md", "shipped") + "\n" + B("context.md", "context v1 stray");
  setup(before);
  const dry = run();
  assert.match(dry.stdout, /would remove stray basename blocks \(context\.md\) in: coord-lead\/CLAUDE\.local\.md/);
  assert.equal(seat(), before, "dry run writes nothing");
  const r = run("--apply");
  const t = seat();
  assert.doesNotMatch(t, /BLOCK: context\.md -->/);
  assert.equal((t.match(/BLOCK: startup\/context\.md -->/g) || []).length, 2, "one begin + one end");
  assert.ok(t.startsWith(own));
  const bk = r.stdout.match(/backups: (\S+)/)[1];
  assert.equal(fs.readFileSync(join(bk, "coord-lead/CLAUDE.local.md"), "utf8"), before);
});

test("repair: a lone context.md block (no startup/context.md) becomes the declared block and is refreshed", () => {
  setup(own + B("CULTURE.md", "culture v2") + "\n" + B("context.md", "old"));
  run("--apply");
  const t = seat();
  assert.match(t, /BLOCK: startup\/context\.md -->\ncontext v2\n<!-- END OpenRig MANAGED BLOCK: startup\/context\.md -->/);
  assert.doesNotMatch(t, /BLOCK: context\.md -->/);
});
