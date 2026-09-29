// bin/openrig-upgrade: a version mismatch stops before any restart; --no-restart installs and pins without restarting.
// Runs the real script in a throwaway agent-stack copy and HOME with fake npm, mise, rig, systemctl and patch hook.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "orupgrade-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const write = (p, text, mode) => { fs.mkdirSync(dirname(p), { recursive: true }); fs.writeFileSync(p, text, mode ? { mode } : undefined); };

const stack = join(root, "stack"), bin = join(root, "fakebin"), log = join(root, "calls.log");
const pkg = join(root, ".local/share/agent-stack/openrig/lib/node_modules/@openrig/cli/package.json");
write(join(stack, "bin/openrig-upgrade"), fs.readFileSync(join(repo, "bin/openrig-upgrade"), "utf8"), 0o755);
fs.mkdirSync(join(stack, "rig/template"), { recursive: true }); // openrig-upgrade links openrig-shared here
write(join(stack, "bin/openrig-daemon-cycle"), `#!/bin/sh\necho "cycle $*" >> ${log}\nexit \${CYCLE_EXIT:-0}\n`, 0o755);
write(join(stack, "bin/openrig-apply-patches"), `#!/bin/sh\necho "patches $*" >> ${log}\n`, 0o755);
write(join(bin, "mise"), `#!/bin/sh\necho ${root}/node\n`, 0o755);
// npm "succeeds" and writes whatever version NPM_INSTALLS says actually landed.
write(join(bin, "npm"), `#!/bin/sh\necho "npm $*" >> ${log}\nmkdir -p ${dirname(pkg)}/daemon/specs/rigs/x/y\necho "permission_policy: builtin:yolo" > ${dirname(pkg)}/daemon/specs/rigs/x/y/rig.yaml\nprintf '{"version":"%s"}' "$NPM_INSTALLS" > ${pkg}\n`, 0o755);
for (const t of ["rig", "systemctl"]) write(join(bin, t), `#!/bin/sh\necho "${t} $*" >> ${log}\n`, 0o755);

function run(args, installs, extra = {}) {
  fs.rmSync(log, { force: true });
  write(join(stack, "config/versions.env"), "NODE_FOR_OPENRIG=22\nOPENRIG_VERSION=0.6.0\n");
  const r = spawnSync(join(stack, "bin/openrig-upgrade"), args, { encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: root, NPM_INSTALLS: installs, ...extra } });
  return { ...r, calls: fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "", pinned: fs.readFileSync(join(stack, "config/versions.env"), "utf8").match(/OPENRIG_VERSION=(.*)/)[1] };
}

test("a package that isn't the requested version stops with exit 1 before any restart or pin", () => {
  const r = run(["0.6.1"], "0.6.0");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /asked for 0\.6\.1 but 0\.6\.0 is installed; stopping before any restart/);
  assert.doesNotMatch(r.calls, /systemctl|cycle/);
  assert.equal(r.pinned, "0.6.0");
});

test("the requested version installs, is pinned, and restarts only the daemon, once (never systemctl)", () => {
  const r = run(["0.6.1"], "0.6.1");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.pinned, "0.6.1");
  assert.equal(r.calls.match(/^cycle --reason openrig-upgrade 0\.6\.1$/gm)?.length, 1);
  assert.doesNotMatch(r.calls, /systemctl/);
});

test("a daemon restart that doesn't complete fails the upgrade (exit 1)", () => {
  const r = run(["0.6.1"], "0.6.1", { CYCLE_EXIT: "1" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the daemon restart did not complete/);
});

test("--no-restart installs, patches and pins but leaves the daemon alone", () => {
  const r = run(["--no-restart", "0.6.1"], "0.6.1");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.calls, /^patches /m);
  assert.doesNotMatch(r.calls, /systemctl|cycle/);
  assert.equal(r.pinned, "0.6.1");
  assert.match(r.stdout, /daemon NOT restarted\. Observe, then: openrig-daemon-cycle/);
});

test("a dist-tag request pins whatever version actually installed", () => {
  const r = run(["--no-restart", "latest"], "0.6.2");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.pinned, "0.6.2");
});

test("a missing or unreadable package identity stops before any restart", () => {
  const r = run(["0.6.1"], "");  // fake npm writes {"version":""}
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no readable @openrig\/cli version/);
  assert.doesNotMatch(r.calls, /systemctl|cycle/);
  assert.equal(r.pinned, "0.6.0");
});

test("the upgrade never suggests tearing seats down", () => {
  assert.doesNotMatch(fs.readFileSync(join(repo, "bin/openrig-upgrade"), "utf8"), /rig down/);
});
