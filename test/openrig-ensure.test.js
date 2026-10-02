// bin/openrig-ensure (install.sh's OpenRig step, WO23): never downgrades. Installs when missing or when the pin is
// newer; keeps a newer install and moves the pin; --check WARNs on a mismatch and FAILs on missing patches. A throwaway
// agent-stack copy and HOME, with openrig-upgrade and openrig-apply-patches stubbed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "orensure-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const write = (p, t, mode) => { fs.mkdirSync(dirname(p), { recursive: true }); fs.writeFileSync(p, t, mode ? { mode } : undefined); };
const stack = join(root, "stack"), log = join(root, "calls"), pkg = join(root, "pkg");
write(join(stack, "bin/openrig-ensure"), fs.readFileSync(join(repo, "bin/openrig-ensure"), "utf8"), 0o755);
write(join(stack, "bin/semver-cmp"), fs.readFileSync(join(repo, "bin/semver-cmp"), "utf8"), 0o755);
write(join(stack, "bin/openrig-upgrade"), `#!/bin/sh\necho "upgrade $*" >> ${log}\n`, 0o755);
write(join(stack, "bin/openrig-apply-patches"), `#!/bin/sh\necho "patches $*" >> ${log}\nif [ "$1" != --check ]; then\n  [ -f ${root}/patches-missing ] && { echo "OpenRig 0.6.1 patches: applied 135-x; already applied 132-y"; exit 0; }\n  echo "OpenRig 0.6.1 patches: applied none; already applied 132-y 135-x"; exit 0\nfi\n[ -f ${root}/patches-missing ] && { echo "OpenRig 0.6.1 patches: 8/9 applied; NOT applied: 135-x (run openrig-apply-patches)"; exit 1; }\necho "OpenRig 0.6.1 patches: all 9 applied"\n`, 0o755);
write(join(stack, "config/versions.defaults.env"), "OPENRIG_VERSION=0.6.1\n");

function ensure({ installed = null, localPin = null, check = false, missing = false } = {}) {
  fs.rmSync(log, { force: true }); fs.rmSync(pkg, { recursive: true, force: true }); fs.rmSync(join(root, "patches-missing"), { force: true });
  if (installed) write(join(pkg, "package.json"), JSON.stringify({ version: installed }));
  if (localPin === null) fs.rmSync(join(stack, "config/versions.env"), { force: true }); else write(join(stack, "config/versions.env"), localPin);
  if (missing) write(join(root, "patches-missing"), "");
  const r = spawnSync(join(stack, "bin/openrig-ensure"), check ? ["--check"] : [], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: root, OPENRIG_PKG: pkg } });
  const pinFile = join(stack, "config/versions.env");
  return { ...r, calls: fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "", local: fs.existsSync(pinFile) ? fs.readFileSync(pinFile, "utf8") : null };
}

test("the incident: installed 0.6.1, a stale local pin 0.5.17 -> kept, NOT downgraded, pin moved to 0.6.1", () => {
  const r = ensure({ installed: "0.6.1", localPin: "OPENRIG_VERSION=0.5.17\nNODE_FOR_OPENRIG=22\n" });
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.calls, /upgrade/);
  assert.match(r.stdout, /OpenRig 0\.6\.1 is newer than the pin 0\.5\.17: kept, not downgraded; pin updated/);
  assert.equal(r.local, "OPENRIG_VERSION=0.6.1\nNODE_FOR_OPENRIG=22\n", "only the pin line changes");
});

test("missing OpenRig, or a newer pin: openrig-upgrade <pin>; equal: nothing", () => {
  assert.match(ensure().calls, /^upgrade 0\.6\.1$/m);
  assert.match(ensure({ installed: "0.6.0" }).calls, /^upgrade 0\.6\.1$/m);
  assert.match(ensure({ installed: "0.6.1", localPin: "OPENRIG_VERSION=0.6.10\n" }).calls, /^upgrade 0\.6\.10$/m, "semver, not string order");
  const same = ensure({ installed: "0.6.1" });
  assert.doesNotMatch(same.calls, /upgrade/);
  assert.equal(same.local, null, "no local file created when nothing changes");
});

test("a newer install with no local override: the pin is created in config/versions.env; the tracked defaults are untouched", () => {
  const r = ensure({ installed: "0.7.0" });
  assert.equal(r.local, "OPENRIG_VERSION=0.7.0\n");
  assert.equal(fs.readFileSync(join(stack, "config/versions.defaults.env"), "utf8"), "OPENRIG_VERSION=0.6.1\n");
});

test("--check: ok when equal and patched; WARN on installed != pin; FAIL (exit 1) on missing patches; changes nothing", () => {
  const ok = ensure({ installed: "0.6.1", check: true });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /^ok  OpenRig 0\.6\.1 \(= pin\)$/m);
  assert.match(ok.stdout, /^ok  OpenRig 0\.6\.1 patches: all 9 applied$/m);
  const warn = ensure({ installed: "0.6.1", localPin: "OPENRIG_VERSION=0.5.17\n", check: true });
  assert.equal(warn.status, 0);
  assert.match(warn.stdout, /^--  WARN: OpenRig 0\.6\.1 installed, pin is 0\.5\.17/m);
  assert.equal(warn.local, "OPENRIG_VERSION=0.5.17\n", "--check never moves the pin");
  const fail = ensure({ installed: "0.6.1", check: true, missing: true });
  assert.equal(fail.status, 1);
  assert.match(fail.stdout, /^--  FAIL: OpenRig 0\.6\.1 patches: 8\/9 applied; NOT applied: 135-x/m);
  assert.doesNotMatch(fail.calls, /upgrade/);
});

test("install.sh uses openrig-ensure and never compares versions for inequality itself", () => {
  const s = fs.readFileSync(join(repo, "install.sh"), "utf8");
  assert.match(s, /"\$S\/bin\/openrig-ensure" \| sed/);
  assert.match(s, /"\$S\/bin\/openrig-ensure" --check/);
  assert.doesNotMatch(s, /!= "\$OPENRIG_VERSION" \]; then "\$S\/bin\/openrig-upgrade"/);
  assert.match(s, /source "\$S\/config\/versions\.defaults\.env"; \[ -f "\$S\/config\/versions\.env" \] && source "\$S\/config\/versions\.env"/);
});

test("the tracked defaults exist and are not ignored by git", () => {
  assert.match(fs.readFileSync(join(repo, "config/versions.defaults.env"), "utf8"), /^OPENRIG_VERSION=\d+\.\d+\.\d+$/m);
  assert.equal(spawnSync("git", ["-C", repo, "check-ignore", "-q", "config/versions.defaults.env"]).status, 1);
  assert.equal(spawnSync("git", ["-C", repo, "check-ignore", "-q", "config/versions.env"]).status, 0, "the local override stays untracked");
});

test("QA: a stale PRERELEASE pin (0.6.1-rc.1) never downgrades 0.6.1; a v-prefixed pin is normalised; a non-version pin changes nothing", () => {
  const rc = ensure({ installed: "0.6.1", localPin: "OPENRIG_VERSION=0.6.1-rc.1\n" });
  assert.doesNotMatch(rc.calls, /upgrade/);
  assert.equal(rc.local, "OPENRIG_VERSION=0.6.1\n");
  const v = ensure({ installed: "0.6.1", localPin: "OPENRIG_VERSION=v0.6.1\n" });
  assert.doesNotMatch(v.calls, /upgrade/);
  const bad = ensure({ installed: "0.6.1", localPin: "OPENRIG_VERSION=latest\n" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /not a version/);
  assert.doesNotMatch(bad.calls, /upgrade/);
});

// WO94: a patch added for the version already installed was reported "NOT applied" by install.sh and never applied.
test("equal or newer install: the installed version's patches are applied (only the missing ones), with a cycle note when any was new", () => {
  const fresh = ensure({ installed: "0.6.1", missing: true });
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.match(fresh.calls, new RegExp(`^patches ${pkg}$`, "m"), "applied to the installed package");
  assert.match(fresh.stdout, /patches: applied 135-x;/);
  assert.match(fresh.stdout, /note: the newly applied OpenRig patches load at the daemon's next start: cycle it at a quiet moment \(openrig-daemon-cycle\)/);
  const same = ensure({ installed: "0.6.1" });
  assert.match(same.stdout, /patches: applied none;/); assert.doesNotMatch(same.stdout, /next start/, "nothing new: no note");
  assert.match(ensure({ installed: "0.7.0", missing: true }).calls, /^patches /m, "a kept newer install too");
  assert.doesNotMatch(ensure({ installed: "0.6.0" }).calls, /^patches /m, "an upgrade applies them itself (openrig-upgrade)");
});
