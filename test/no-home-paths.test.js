// agent-stack is public: nothing tracked may carry an absolute path into a real home directory (it names the user).
// WO54: rig/template/openrig-shared was a tracked symlink into the owner's OpenRig install; it is a local link now.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const tracked = spawnSync("git", ["ls-files", "-s"], { cwd: repo, encoding: "utf8" }).stdout.split("\n").filter(Boolean)
  .map((l) => { const [meta, path] = l.split("\t"); return { mode: meta.split(" ")[0], path }; });
// Placeholder homes used in docs and tests; any other /home/<name> is somebody's real home.
const PLACEHOLDERS = new Set(["you", "user", "u", "seat", "runner", "me", "username", "example"]);

test("no tracked symlink points at an absolute path", () => {
  const abs = tracked.filter((f) => f.mode === "120000")
    .map((f) => ({ path: f.path, target: spawnSync("git", ["cat-file", "-p", `:${f.path}`], { cwd: repo, encoding: "utf8" }).stdout }))
    .filter((f) => f.target.startsWith("/"));
  assert.deepEqual(abs, [], "make it a local link created at install (see rig/template/openrig-shared in install.sh)");
});

test("no tracked file names a real home directory (/home/<name>)", () => {
  const hits = [];
  for (const f of tracked) {
    if (f.mode === "120000" || f.mode === "160000") continue;
    let text;
    try { text = fs.readFileSync(join(repo, f.path)); } catch { continue; }
    if (text.includes(0)) continue;   // binary
    for (const m of text.toString("utf8").matchAll(/(?<![\w$.])\/home\/([A-Za-z0-9._-]+)/g))
      if (!PLACEHOLDERS.has(m[1].toLowerCase())) hits.push(`${f.path}: /home/${m[1]}`);
  }
  assert.deepEqual(hits, [], `use a placeholder (/home/<you>, $HOME or ~) instead`);
});

test("install.sh creates rig/template/openrig-shared as a local link, and git ignores it", () => {
  const install = fs.readFileSync(join(repo, "install.sh"), "utf8");
  assert.match(install, /orsh=\$L\/openrig\/lib\/node_modules\/@openrig\/cli\/daemon\/specs\/agents\/shared\n.*link "\$orsh" "\$S\/rig\/template\/openrig-shared"/);
  assert.match(fs.readFileSync(join(repo, ".gitignore"), "utf8"), /^\/rig\/template\/openrig-shared$/m);
  assert.equal(spawnSync("git", ["check-ignore", "-q", "rig/template/openrig-shared"], { cwd: repo }).status, 0, "ignored");
  assert.ok(!tracked.some((f) => f.path === "rig/template/openrig-shared"), "not tracked");
});
