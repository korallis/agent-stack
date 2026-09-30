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

// WO46: agent-project-check reported seats as stale that agent-refresh-guidance said were current (it looked for a
// basename block, "context.md"). Now the check asks the refresh itself (--json), so the two can't disagree.
test("--json: current seats report nothing; stale ones say which block and why; nothing is written", () => {
  setup(own + B("CULTURE.md", "culture v2") + "\n" + B("startup/context.md", "context v2") + "\n" + B("openrig-start.md", "shipped"));
  let j = JSON.parse(run("--json").stdout);
  assert.deepEqual(j, { total: 1, changed: [] }, "blocks named by path, as OpenRig names them: current");
  const stale = own + B("CULTURE.md", "culture v1") + "\n" + B("openrig-start.md", "shipped");
  setup(stale);
  j = JSON.parse(run("--json").stdout);
  assert.deepEqual(j.changed, [{ seat: "coord-lead", file: "CLAUDE.local.md", reasons: ["missing block startup/context.md", "CULTURE.md out of date"] }]);
  assert.equal(seat(), stale, "--json alone is a dry run");
});

test("agent-project-check agrees with agent-refresh-guidance, and ignores Jev decision ids the spec audit reads as seats", () => {
  const bin = join(home, "bin"); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(join(bin, "rig"), `#!/bin/sh
case "$1 $2" in
  "ps --json") echo '[{"name":"p","status":"running"}]' ;;
  "spec audit") printf 'Spec audit: 2 advisory findings for x\\n  - culture references seat id %s, which is not a current seat\\n%s\\n' "'review.merge_gate'" "\${AUDIT_EXTRA:-}" ;;
  "doctor --spec") echo "[OK] spec_live_conformance" ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
  const check = (extra = {}) => JSON.parse(spawnSync("python3", [join(repo, "bin/agent-project-check"), "P", "--json"], { encoding: "utf8", timeout: 120000,
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, OPENRIG_URL: "http://127.0.0.1:9", AGENT_OWNER_ADDRESS: "owner@external", ...extra } }).stdout);
  const row = (rows, p) => rows.find((x) => x.check.startsWith(p));
  setup(own + B("CULTURE.md", "culture v2") + "\n" + B("startup/context.md", "context v2") + "\n" + B("openrig-start.md", "shipped"));
  fs.writeFileSync(join(W, "project.yaml"), "kind: project\n");
  let rows = check();
  assert.equal(row(rows, "rig p is running").level, "OK");
  assert.equal(row(rows, "seat instructions carry the current CULTURE.md and startup files").level, "OK", "the live case: startup/context.md by path is current");
  const audit = row(rows, "rig spec audit (OpenRig authoring check) is clean");
  assert.equal(audit.level, "OK"); assert.match(audit.check, /ignoring 1 Jev decision id\(s\) read as seat ids/);
  rows = check({ AUDIT_EXTRA: "  - culture references seat id 'lead-old', which is not a current seat" });
  assert.equal(row(rows, "rig spec audit").level, "WARN");
  assert.match(row(rows, "rig spec audit").detail, /seat id 'lead-old'/, "a real finding still WARNs");
  setup(own + B("CULTURE.md", "culture v1") + "\n" + B("openrig-start.md", "shipped"));
  const stale = row(check(), "seat instructions carry the current CULTURE.md and startup files");
  assert.equal(stale.level, "WARN");
  assert.match(stale.detail, /^run agent-refresh-guidance --apply: coord-lead\/CLAUDE\.local\.md \(missing block startup\/context\.md; CULTURE\.md out of date\)$/);
});

test("an explicit workspace path is checked, not ~/Projects/<name>-work (QA PR50)", () => {
  // A current namesake under ~/Projects and a stale workspace elsewhere with the same name.
  setup(own + B("CULTURE.md", "culture v2") + "\n" + B("startup/context.md", "context v2"));
  const ext = join(home, "external/P-work"), extWT = join(home, "external/P.worktrees");
  fs.mkdirSync(join(ext, "rig/startup"), { recursive: true }); fs.mkdirSync(join(extWT, "coord-lead"), { recursive: true });
  fs.writeFileSync(join(ext, "project.yaml"), "kind: project\n");
  fs.writeFileSync(join(ext, "rig/CULTURE.md"), "culture v3"); fs.writeFileSync(join(ext, "rig/startup/context.md"), "context v3");
  fs.writeFileSync(join(ext, "rig/team.yaml"), fs.readFileSync(join(W, "rig/team.yaml"), "utf8").replaceAll(WT, extWT));
  fs.writeFileSync(join(extWT, "coord-lead/CLAUDE.local.md"), own + B("CULTURE.md", "culture v2") + "\n" + B("startup/context.md", "context v2"));
  const j = JSON.parse(spawnSync(join(repo, "bin/agent-refresh-guidance"), [ext, "--json"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: home } }).stdout);
  assert.deepEqual(j.changed.map((c) => [c.seat, c.reasons]), [["coord-lead", ["CULTURE.md out of date", "startup/context.md out of date"]]]);
  assert.deepEqual(JSON.parse(run("--json").stdout).changed, [], "the namesake by project name is still current");
  const bin = join(home, "bin"); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(join(bin, "rig"), `#!/bin/sh\ncase "$1 $2" in\n  "ps --json") echo '[{"name":"p","status":"running"}]' ;;\n  "doctor --spec") echo "[OK] spec_live_conformance" ;;\n  *) exit 0 ;;\nesac\n`, { mode: 0o755 });
  const rows = JSON.parse(spawnSync("python3", [join(repo, "bin/agent-project-check"), ext, "--json"], { encoding: "utf8", timeout: 120000,
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, OPENRIG_URL: "http://127.0.0.1:9", AGENT_OWNER_ADDRESS: "owner@external" } }).stdout);
  const row = rows.find((x) => x.check.startsWith("seat instructions carry the current CULTURE.md and startup files"));
  assert.equal(row.level, "WARN"); assert.match(row.detail, /coord-lead\/CLAUDE\.local\.md \(CULTURE\.md out of date; startup\/context\.md out of date\)/);
});
