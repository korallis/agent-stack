// QA's bug-review-board proof lives in the rig workspace (<Project>-work/missions/<m>/slices/<s>/proof/), not in the
// checkout the integrator runs from (<Project>.worktrees/<seat>): agent-merge-evidence reported "MISSING: no
// bug-review-board proof" for a PR whose proof was there (2026-10-04). It searches the workspace roots and accepts
// brb-<full or short sha>.md and -rN revisions.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { workspaceRoots, findBrb } from "../orchestration/merge-evidence.js";

const root = fs.mkdtempSync(join(os.tmpdir(), "brb-path-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const HEAD = "09f6d32de3a0554b3e3f69ba2d46fe1aca34fe51";

test("workspaceRoots: OPENRIG_WORK_ROOT, then <P>-work beside a worktree or a checkout, then <projects>/<repo>-work, then .", () => {
  assert.deepEqual(workspaceRoots({ env: {}, cwd: "/h/Projects/App.worktrees/integ-codex/src", nwo: "o/App", projects: "/h/Projects" }), ["/h/Projects/App-work", "."]);
  assert.deepEqual(workspaceRoots({ env: { OPENRIG_WORK_ROOT: "/h/Projects/App-work" }, cwd: "/elsewhere", nwo: "o/App", projects: "/h/Projects" }), ["/h/Projects/App-work", "."]);
  const checkout = join(root, "Proj"); fs.mkdirSync(join(checkout, ".git"), { recursive: true }); fs.mkdirSync(join(checkout, "src"));
  assert.deepEqual(workspaceRoots({ env: {}, cwd: join(checkout, "src"), nwo: "o/Other", projects: "/p" }), [`${checkout}-work`, "/p/Other-work", "."]);
});

test("findBrb: the full sha or a 7+ prefix, the highest -rN revision; another head, a too-short prefix or no dir: null", () => {
  const d = join(root, "proof"); fs.mkdirSync(d);
  const w = (f) => fs.writeFileSync(join(d, f), "---\nverdict: PASS\n---\n");
  assert.equal(findBrb(d, HEAD), null);
  w("brb-09f6d32.md"); assert.equal(findBrb(d, HEAD), join(d, "brb-09f6d32.md"), "a short sha");
  w(`brb-${HEAD}.md`); assert.equal(findBrb(d, HEAD), join(d, `brb-${HEAD}.md`), "the full sha beats the short one at the same revision");
  w(`brb-${HEAD}-r2.md`); w("brb-09f6d32-r1.md"); assert.equal(findBrb(d, HEAD), join(d, `brb-${HEAD}-r2.md`), "the highest revision");
  w("brb-1234567-r9.md"); w("brb-09f6d3-r9.md"); assert.equal(findBrb(d, HEAD), join(d, `brb-${HEAD}-r2.md`), "another head, or a 6-char prefix, never counts");
  w("brb-09f6d32-r3.md"); assert.equal(findBrb(d, HEAD), join(d, "brb-09f6d32-r3.md"), "the revision decides before the sha's length");
  assert.equal(findBrb(join(root, "nope"), HEAD), null);
});

test("gather searches every workspace root's slice proof dir (not the checkout alone)", () => {
  const src = fs.readFileSync(new URL("../orchestration/merge-evidence.js", import.meta.url), "utf8");
  assert.match(src, /const dirs = workspaceRoots\(\{ nwo \}\)\.map\(\(r\) => join\(r, "missions", mission, "slices", slice, "proof"\)\);/);
  assert.match(src, /const found = dirs\.map\(\(d\) => findBrb\(d, v\.headRefOid\)\)\.find\(Boolean\);/);
});
