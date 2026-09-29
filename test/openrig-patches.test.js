// bin/openrig-apply-patches: applies per-version OpenRig dist patches, is idempotent, refuses a conflicting patch
// whole, and warns (never fails) when a version has no patches. Also checks every shipped patch is well-formed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "orpatch-"));
// A throwaway agent-stack layout, so the script finds this test's patches, plus stubs that record warnings.
fs.mkdirSync(join(tmp, "stack/bin"), { recursive: true });
fs.copyFileSync(join(repo, "bin/openrig-apply-patches"), join(tmp, "stack/bin/openrig-apply-patches"));
fs.mkdirSync(join(tmp, "stubs"));
for (const s of ["logger", "notify-send"]) fs.writeFileSync(join(tmp, "stubs", s), `#!/bin/sh\necho "${s} $*" >> ${tmp}/warnings\n`, { mode: 0o755 });
const patchDir = join(tmp, "stack/patches/openrig/1.0.0");
fs.mkdirSync(patchDir, { recursive: true });
fs.writeFileSync(join(patchDir, "001-fix.patch"), "--- a/dist/a.js\n+++ b/dist/a.js\n@@ -1,2 +1,2 @@\n const x = 1;\n-export const y = x;\n+export const y = x + 1;\n");
fs.writeFileSync(join(patchDir, "002-other.patch"), "--- a/dist/b.js\n+++ b/dist/b.js\n@@ -1 +1 @@\n-export const z = 0;\n+export const z = 2;\n");

function pkg(version, files = { "dist/a.js": "const x = 1;\nexport const y = x;\n", "dist/b.js": "export const z = 0;\n" }) {
  const dir = fs.mkdtempSync(join(tmp, "pkg-"));
  fs.writeFileSync(join(dir, "package.json"), JSON.stringify({ version }));
  for (const [f, text] of Object.entries(files)) { fs.mkdirSync(join(dir, dirname(f)), { recursive: true }); fs.writeFileSync(join(dir, f), text); }
  return dir;
}
function run(dir) {
  fs.rmSync(join(tmp, "warnings"), { force: true });
  const out = execFileSync(join(tmp, "stack/bin/openrig-apply-patches"), [dir], { env: { ...process.env, PATH: `${tmp}/stubs:${process.env.PATH}` }, encoding: "utf8" });
  return { out, warnings: fs.existsSync(join(tmp, "warnings")) ? fs.readFileSync(join(tmp, "warnings"), "utf8") : "" };
}
const read = (dir, f) => fs.readFileSync(join(dir, f), "utf8");

test("applies every patch for the installed version, then reports them as already applied", () => {
  const dir = pkg("1.0.0");
  const first = run(dir);
  assert.match(first.out, /applied 001-fix 002-other;/);
  assert.equal(read(dir, "dist/a.js"), "const x = 1;\nexport const y = x + 1;\n");
  assert.equal(read(dir, "dist/b.js"), "export const z = 2;\n");
  assert.equal(first.warnings, "");
  const again = run(dir);
  assert.match(again.out, /applied none; already applied 001-fix 002-other/);
  assert.equal(read(dir, "dist/a.js"), "const x = 1;\nexport const y = x + 1;\n");
});

test("a conflicting patch is left out whole and warned about; the others still apply; exit stays 0", () => {
  const dir = pkg("1.0.0", { "dist/a.js": "const x = 1;\nexport const y = x * 3;\n", "dist/b.js": "export const z = 0;\n" });
  const { out, warnings } = run(dir);
  assert.match(out, /applied 002-other;/);
  assert.equal(read(dir, "dist/a.js"), "const x = 1;\nexport const y = x * 3;\n");
  assert.deepEqual(fs.readdirSync(join(dir, "dist")).sort(), ["a.js", "b.js"]); // no .rej/.orig litter
  assert.match(warnings, /notify-send .*--urgency=critical OpenRig 1\.0\.0 patch failed Did not apply: 001-fix/);
  assert.match(warnings, /logger -t openrig-patches/);
});

test("a version with no patches warns loudly while local fixes are carried, and changes nothing", () => {
  const dir = pkg("2.0.0");
  const { warnings } = run(dir);
  assert.match(warnings, /OpenRig 2\.0\.0 is unpatched .*have: 1\.0\.0/);
  assert.equal(read(dir, "dist/a.js"), "const x = 1;\nexport const y = x;\n");
});

// Two patches on one file where the second rewrites what the first produced (b -> B1 -> B2): once the second is
// applied, the first's reverse no longer matches the live file on its own (no fuzz bridges it). It must still count as
// applied, not "did not apply". 0.6.1's 135 and 136 overlap like this.
const overlapDir = join(tmp, "stack/patches/openrig/1.1.0");
fs.mkdirSync(overlapDir, { recursive: true });
const base11 = "a\nb\nc\nd\ne\n";
fs.writeFileSync(join(overlapDir, "010-first.patch"), "--- a/dist/s.js\n+++ b/dist/s.js\n@@ -1,4 +1,4 @@\n a\n-b\n+B1\n c\n d\n");
fs.writeFileSync(join(overlapDir, "020-second.patch"), "--- a/dist/s.js\n+++ b/dist/s.js\n@@ -1,3 +1,3 @@\n a\n-B1\n+B2\n c\n");

test("overlapping patches: both apply, and a rerun reports both already applied with no warning", () => {
  const dir = pkg("1.1.0", { "dist/s.js": base11 });
  const first = run(dir);
  assert.match(first.out, /applied 010-first 020-second; already applied none/);
  assert.equal(read(dir, "dist/s.js"), "a\nB2\nc\nd\ne\n");
  // the per-patch check alone fails here: 010's reverse needs "B1", which 020 rewrote
  assert.throws(() => execFileSync("patch", ["-p1", "-d", dir, "--dry-run", "--reverse", "--forward", "--silent", "-i", join(overlapDir, "010-first.patch")], { stdio: "ignore" }));
  const again = run(dir);
  assert.match(again.out, /applied none; already applied 010-first 020-second/);
  assert.equal(again.warnings, "", "no false 'Did not apply' alert");
  assert.equal(read(dir, "dist/s.js"), "a\nB2\nc\nd\ne\n");
});

test("overlapping patches: with only the first applied, the second is applied on top", () => {
  const dir = pkg("1.1.0", { "dist/s.js": "a\nB1\nc\nd\ne\n" });
  const { out, warnings } = run(dir);
  assert.match(out, /applied 020-second; already applied 010-first/);
  assert.equal(warnings, "");
  assert.equal(read(dir, "dist/s.js"), "a\nB2\nc\nd\ne\n");
});

test("a hand-edited file reports what no longer fits, and nothing is counted applied by mistake", () => {
  const dir = pkg("1.1.0", { "dist/s.js": "a\nB9\nc\nd\ne\n" });
  const { out, warnings } = run(dir);
  assert.match(out, /applied none; already applied none/);
  assert.match(warnings, /Did not apply: 010-first 020-second/);
  assert.equal(read(dir, "dist/s.js"), "a\nB9\nc\nd\ne\n");
});

test("with a terminal attached, an unapplied patch is never taken for applied (-R is paired with -N)", () => {
  // GNU patch without -N answers "Unreversed patch detected! Ignore -R?" with yes when it has a tty, so a fresh package
  // would read as fully patched. script(1) gives the run a pseudo-terminal.
  const dir = pkg("1.1.0", { "dist/s.js": base11 });
  fs.rmSync(join(tmp, "warnings"), { force: true });
  const cmd = `PATH=${tmp}/stubs:$PATH ${join(tmp, "stack/bin/openrig-apply-patches")} ${dir}`;
  const out = execFileSync("script", ["-qec", cmd, "/dev/null"], { encoding: "utf8" });
  assert.match(out, /applied 010-first 020-second; already applied none/);
  assert.equal(read(dir, "dist/s.js"), "a\nB2\nc\nd\ne\n");
});

test("every shipped patch is a -p1 diff against the package's dist trees", () => {
  const root = join(repo, "patches/openrig");
  const patches = fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }).filter(v => v.isDirectory()).flatMap(v => fs.readdirSync(join(root, v.name)).map(p => join(root, v.name, p))) : [];
  for (const p of patches) {
    assert.match(p, /\/patches\/openrig\/\d+\.\d+\.\d+[^/]*\/[^/]+\.patch$/);
    const targets = [...fs.readFileSync(p, "utf8").matchAll(/^\+\+\+ (\S+)/gm)].map(m => m[1]);
    assert.ok(targets.length > 0, `${p} has no file hunks`);
    for (const t of targets) assert.match(t, /^b\/(dist|daemon\/dist|tui\/dist)\//, `${p}: ${t}`);
  }
});

process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
