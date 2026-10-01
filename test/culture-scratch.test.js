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

test("CULTURE.md's TMPDIR example parses, and puts TMPDIR on disk under ~/.cache/<rig>-tmp/<seat>, removed on exit", () => {
  const culture = fs.readFileSync(join(repo, "rig/template/CULTURE.md"), "utf8");
  const example = (culture.match(/`(s=\$\{OPENRIG_SESSION_NAME[^`]*)`/) || [])[1];
  assert.ok(example, "the example is in CULTURE.md");
  assert.equal(spawnSync("bash", ["-n", "-c", example]).status, 0, "bash -n");
  const home = fs.mkdtempSync(join(os.tmpdir(), "culture-"));
  try {
    const r = spawnSync("bash", ["-c", `${example}\necho "TMPDIR=$TMPDIR"; [ -d "$TMPDIR" ] && echo made`], { encoding: "utf8",
      env: { HOME: home, PATH: "/usr/bin:/bin", OPENRIG_SESSION_NAME: "impl-claude@shop", USER: "u" } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`^TMPDIR=${home}/\\.cache/shop-tmp/impl-claude$`, "m")); assert.match(r.stdout, /^made$/m);
    assert.equal(fs.existsSync(join(home, ".cache/shop-tmp/impl-claude")), false, "removed by the trap on exit");
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
