// WO60: the seat rule's TMPDIR example is real shell (QA PR67: placeholders in it parsed as redirections). It is taken
// from CULTURE.md as written, syntax-checked, and run in a throwaway HOME: TMPDIR lands in ~/.cache/<rig>-tmp/<seat>.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

test("CULTURE.md's TMPDIR example parses; each job gets its own dir under ~/.cache/<rig>-tmp/<seat> and removes only that", () => {
  const culture = fs.readFileSync(join(repo, "rig/template/guidance/host-operations.md"), "utf8");
  const example = (culture.match(/`(s=\$\{OPENRIG_SESSION_NAME[^`]*)`/) || [])[1];
  assert.ok(example, "the example is in host-operations.md");
  assert.equal(spawnSync("bash", ["-n", "-c", example]).status, 0, "bash -n");
  const home = fs.mkdtempSync(join(os.tmpdir(), "culture-")), root = join(home, ".cache/shop-tmp/impl-claude");
  try {
    // QA PR67: another job of the same seat is using the root; this job must leave it alone
    fs.mkdirSync(join(root, "other-active-job"), { recursive: true }); fs.writeFileSync(join(root, "other-active-job/keep"), "x");
    const job = (tail) => spawnSync("bash", ["-c", `${example}\necho "TMPDIR=$TMPDIR"; touch "$TMPDIR/mine"; ${tail}`], { encoding: "utf8",
      env: { HOME: home, PATH: "/usr/bin:/bin", OPENRIG_SESSION_NAME: "impl-claude@shop", USER: "u" } });
    for (const [tail, rc] of [["true", 0], ["exit 3", 3], ["export TMPDIR=/nonexistent-elsewhere; true", 0]]) {
      const r = job(tail);
      assert.equal(r.status, rc, `${tail}: ${r.stderr}`);
      const mine = (r.stdout.match(/^TMPDIR=(.*)$/m) || [])[1];
      assert.match(mine, new RegExp(`^${root}/job\\.[A-Za-z0-9]{6}$`), "its own directory under the seat root");
      assert.equal(fs.existsSync(mine), false, `${tail}: its own directory is removed`);
      assert.ok(fs.existsSync(join(root, "other-active-job/keep")), `${tail}: the other job's files stay`);
      assert.ok(fs.existsSync(root), `${tail}: the seat root stays`);
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("CULTURE's Operating rules start with claim-first on a queue handoff, and short turns", () => {
  const culture = fs.readFileSync(join(repo, "rig/template/CULTURE.md"), "utf8");
  const ops = culture.slice(culture.indexOf("## Operating rules"), culture.indexOf("\n## ", culture.indexOf("## Operating rules") + 5));
  assert.match(ops.replace(/\s+/g, " "), /- On any Queue handoff, your first action is `rig queue claim <id>` \(work it later if needed\); keep turns short: one row, then end the turn\./);
});
