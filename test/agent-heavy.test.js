// agent-heavy: long-lived servers are refused (they held both build slots indefinitely, 2026-09-29), and every job has
// a max runtime so a hung or endless one can't keep a slot. Stub-only: systemd-run is faked (it records its args and
// enforces RuntimeMaxSec with `timeout`); the slot locks live in a throwaway XDG_RUNTIME_DIR.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "heavy-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const bin = join(root, "bin"), calls = join(root, "calls");
fs.mkdirSync(bin);
// Like systemd: at RuntimeMaxSec the scope is stopped (SIGTERM), its Result becomes "timeout" (as `systemctl show` then
// reports), and systemd-run returns whatever the job itself returned, which can be 0 if it traps TERM.
fs.writeFileSync(join(bin, "systemd-run"), `#!/usr/bin/env bash
printf '%s\\n' "systemd-run $*" >> "${calls}"
max=""; unit=""; while [ "$1" != "--" ]; do case $1 in RuntimeMaxSec=*) max=\${1#RuntimeMaxSec=};; --unit=*) unit=\${1#--unit=};; esac; shift; done; shift
t0=$(date +%s); timeout --preserve-status "$max" "$@"; rc=$?
[ $(( $(date +%s) - t0 )) -ge "$max" ] && echo timeout > "${root}/result-$unit.scope"
exit $rc
`, { mode: 0o755 });
fs.writeFileSync(join(bin, "systemctl"), `#!/usr/bin/env bash
printf '%s\\n' "systemctl $*" >> "${calls}"
case "$*" in
  "--user show -p Result --value "*) f="${root}/result-\${@: -1}"; [ -f "$f" ] && cat "$f" || echo success ;;
  "--user reset-failed "*) rm -f "${root}/result-\${@: -1}" ;;
esac
`, { mode: 0o755 });

const heavy = (args, env = {}) => {
  fs.rmSync(calls, { force: true });
  const r = spawnSync(join(repo, "bin/agent-heavy"), args, { encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin`, XDG_RUNTIME_DIR: root, USER: "t", ...env } });
  return { ...r, c: fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "" };
};

test("obvious servers are refused before taking a slot, with a clear message", () => {
  for (const cmd of [
    ["npm", "run", "start:test"], ["npm", "start"], ["npm", "run", "dev"], ["pnpm", "dev"], ["yarn", "serve"],
    ["bun", "run", "preview"], ["pnpm", "run", "dev:web"], ["npx", "next", "start"], ["npx", "-y", "next", "dev"],
    ["pnpm", "exec", "next", "start"], ["next", "dev"], ["./node_modules/.bin/next", "start"], ["vite"],
    ["npx", "vite", "--port", "3000"], ["vite", "preview"], ["npx", "serve", "dist"], ["http-server", "."],
    ["PORT=3001", "npm", "run", "start:test"], ["env", "PORT=3001", "next", "start"],
    // QA round 1: options before the script or binary, and versioned packages
    ["npm", "--prefix", "app", "run", "start:test"], ["npm", "run", "--silent", "dev"], ["pnpm", "--filter", "web", "dev"],
    ["pnpm", "-F", "web", "run", "start"], ["npm", "-w", "packages/web", "start"], ["npx", "next@latest", "start"],
    ["npx", "-p", "vite", "vite"], ["pnpm", "dlx", "serve", "dist"], ["yarn", "workspace", "web", "dev"],
    ["env", "-u", "NODE_ENV", "npm", "start"], ["env", "-i", "PATH=/usr/bin", "npm", "run", "dev"],
  ]) {
    const r = heavy(["build", "--", ...cmd]);
    assert.equal(r.status, 2, cmd.join(" "));
    assert.match(r.stderr, /looks like a long-lived server\. Run servers outside agent-heavy.*re-run with --allow-long/s, cmd.join(" "));
    assert.equal(r.c, "", `${cmd.join(" ")}: no slot taken`);
  }
});

test("finite jobs still run: tests, builds, tsc, eslint, playwright, next build, vite build", () => {
  for (const cmd of [["npm", "test"], ["npm", "run", "build"], ["npm", "run", "test:unit"], ["npx", "tsc", "--noEmit"],
    ["npx", "eslint", "."], ["npx", "playwright", "test"], ["next", "build"], ["npx", "vite", "build"], ["pnpm", "run", "lint"],
    ["npm", "run", "startup-check"], ["vitest", "run"],
    // QA round 1: vite builds and version probes are finite
    ["vite", "--mode", "production", "build"], ["vite", "--version"], ["npx", "vite", "-v"], ["next", "--version"],
    ["npm", "--prefix", "app", "run", "build"], ["pnpm", "--filter", "web", "test"]]) {
    const stubbed = join(bin, cmd[0] === "npx" ? "npx" : cmd[0]);
    if (!fs.existsSync(stubbed)) fs.writeFileSync(stubbed, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const r = heavy(["build", "--", ...cmd]);
    assert.equal(r.status, 0, `${cmd.join(" ")}: ${r.stderr}`);
    assert.match(r.c, /^systemd-run --user --scope/m, cmd.join(" "));
  }
});

test("--allow-long lifts the refusal, but the max runtime still applies", () => {
  const r = heavy(["browser", "--allow-long", "--", "npm", "run", "start:test"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.c, / -p RuntimeMaxSec=1800 /);
});

test("every job gets a max runtime: 45min build, 30min browser, configurable, and --max-runtime per call", () => {
  assert.match(heavy(["build", "--", "true"]).c, / -p RuntimeMaxSec=2700 /);
  assert.match(heavy(["browser", "--", "true"]).c, / -p RuntimeMaxSec=1800 /);
  assert.match(heavy(["build", "--", "true"], { AGENT_HEAVY_BUILD_MAX_RUNTIME: "2h" }).c, / -p RuntimeMaxSec=7200 /);
  assert.match(heavy(["browser", "--max-runtime", "90", "--", "true"]).c, / -p RuntimeMaxSec=90 /);
  assert.match(heavy(["build", "--max-runtime", "10m", "--", "true"]).c, / -p RuntimeMaxSec=600 /);
  const bad = heavy(["build", "--max-runtime", "soon", "--", "true"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /bad max runtime 'soon'/);
  assert.equal(heavy(["build", "--max-runtime", "0", "--", "true"]).status, 2);
});

test("a job that hits the max runtime is stopped, says so, exits 124 and frees its slot", () => {
  const t0 = Date.now();
  const r = heavy(["build", "--max-runtime", "1", "--", "sleep", "30"]);
  assert.ok(Date.now() - t0 < 10000, "stopped at the limit, not after the job");
  assert.equal(r.status, 124);
  assert.match(r.stderr, /stopped: reached the build max runtime \(1\)/);
  assert.match(r.c, /^systemctl --user reset-failed agent-heavy-build-\d+-\d+\.scope$/m, "the failed scope is cleared");
  // the slot is free again: two quick jobs run back to back without waiting
  assert.equal(heavy(["build", "--wait", "1", "--", "true"]).status, 0);
  assert.equal(heavy(["build", "--wait", "1", "--", "true"]).status, 0);
  // an ordinary failure is not reported as a timeout
  const fail = heavy(["build", "--", "false"]);
  assert.equal(fail.status, 1);
  assert.doesNotMatch(fail.stderr, /max runtime/);
});

test("QA round 1: a job that traps SIGTERM and exits 0 when stopped is still reported as stopped (never a success)", () => {
  const r = heavy(["build", "--max-runtime", "1", "--", "bash", "-c", "trap 'exit 0' TERM; sleep 30 & wait"]);
  assert.equal(r.status, 124, r.stderr);
  assert.match(r.stderr, /stopped: reached the build max runtime \(1\)/);
});

test("if systemd can't report the scope's result, the elapsed time decides", () => {
  const sc = fs.readFileSync(join(bin, "systemctl"), "utf8");
  fs.writeFileSync(join(bin, "systemctl"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  try {
    assert.equal(heavy(["build", "--max-runtime", "1", "--", "bash", "-c", "trap 'exit 0' TERM; sleep 30 & wait"]).status, 124);
    assert.equal(heavy(["build", "--max-runtime", "5", "--", "true"]).status, 0);
  } finally { fs.writeFileSync(join(bin, "systemctl"), sc, { mode: 0o755 }); }
});

test("the seat rules say servers stay outside agent-heavy and jobs have a max runtime", () => {
  const rules = fs.readFileSync(join(repo, "rig/template/CULTURE.md"), "utf8").split(/^## /m).find(s => s.startsWith("Operating rules"));
  assert.match(rules, /Never wrap a server/);
  assert.match(rules, /max runtime \(45min build, 30min browser/);
  const agents = fs.readFileSync(join(repo, "starter-kit/AGENTS.md"), "utf8");
  assert.match(agents, /`npm run start:test`, run directly and never inside agent-heavy/);
});

// ---- agent-heavy status (read-only: who holds each slot) ------------------------------------------------------------
const status = (...args) => {
  const env = typeof args.at(-1) === "object" ? args.pop() : {};
  return spawnSync(join(repo, "bin/agent-heavy"), ["status", ...args], { encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin`, XDG_RUNTIME_DIR: root, USER: "t", ...env } });
};
const until = async (pred, ms = 5000) => { const t = Date.now(); while (!pred()) { if (Date.now() - t > ms) return false; await new Promise(r => setTimeout(r, 50)); } return true; };

test("status: every slot free when nothing runs; a bad class is a usage error", () => {
  const r = status();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "build 1/2  free\nbuild 2/2  free\nbrowser 1/2  free\nbrowser 2/2  free\n");
  assert.equal(status("browser").stdout, "browser 1/2  free\nbrowser 2/2  free\n");
  assert.equal(status("gpu").status, 2);
});

test("status: a running job shows its seat, cwd, command, age and remaining runtime; the slot frees when it ends", async () => {
  const cwd = fs.mkdtempSync(join(root, "seat-cwd-"));
  const job = spawn(join(repo, "bin/agent-heavy"), ["build", "--max-runtime", "10m", "--", "sleep", "3"], { cwd,
    env: { PATH: `${bin}:/usr/bin:/bin`, XDG_RUNTIME_DIR: root, USER: "t", OPENRIG_SESSION_NAME: "impl-1@proj" }, stdio: "ignore" });
  const done = new Promise(r => job.on("exit", r));
  assert.ok(await until(() => /held/.test(status("build").stdout)), "the slot shows as held");
  const line = status("build").stdout.split("\n").find(l => l.includes("held"));
  assert.match(line, /^build 1\/2  held  seat=impl-1@proj  age=0m0[0-9]s  remaining=(10m00s|9m5[0-9]s)  cwd=\S+seat-cwd-\S+  cmd=sleep 3$/);
  assert.match(status("build").stdout, /^build 2\/2  free$/m);
  await done;
  assert.equal(status("build").stdout, "build 1/2  free\nbuild 2/2  free\n", "free again after the job");
  assert.equal(fs.existsSync(join(root, "agent-heavy/build.1.holder")), false, "the holder file is removed");
});

test("status: a slot held by an older agent-heavy (no holder file) is described from /proc; a stale holder file is ignored", async () => {
  const dir = join(root, "agent-heavy"); fs.mkdirSync(dir, { recursive: true });
  // a stale holder file from a run that died without cleaning up must not describe the new holder
  fs.writeFileSync(join(dir, "browser.2.holder"), "pid=1\nseat=ghost\ncwd=/\nstart=0\nmax=60\ncmd=old\n");
  const old = spawn("bash", ["-c", 'exec 9>"$L"; flock 9; sleep 30; true', "/opt/old/agent-heavy", "browser", "--", "npx", "playwright", "test"],
    { env: { PATH: "/usr/bin:/bin", L: join(dir, "browser.2.lock"), OPENRIG_SESSION_NAME: "qa@proj" }, stdio: "ignore" });
  try {
    assert.ok(await until(() => /held/.test(status("browser").stdout)));
    const line = status("browser").stdout.split("\n").find(l => l.includes("held"));
    assert.match(line, new RegExp(`^browser 2/2  held  seat=qa@proj  age=0m0[0-9]s  remaining=unknown \\(no holder record\\)  cwd=\\S+  cmd=npx playwright test  pid=${old.pid}$`));
    assert.doesNotMatch(line, /ghost/);
  } finally { old.kill(); fs.rmSync(join(dir, "browser.2.holder"), { force: true }); }
});

// QA round 1 (PR #12): ownership is the lock itself, not an open fd; any path to the runtime dir works; what can't be
// observed is unknown, never free.
test("status: a process that merely opens the lock file is not its holder; the process whose fd carries the flock is", async () => {
  const dir = join(root, "agent-heavy"), lock = join(dir, "build.2.lock"); fs.mkdirSync(dir, { recursive: true });
  const observer = spawn("bash", ["-c", 'exec 8<>"$L"; sleep 30; true'], { env: { PATH: "/usr/bin:/bin", L: lock, OPENRIG_SESSION_NAME: "observer@x" }, stdio: "ignore" });
  await until(() => fs.existsSync(lock));
  const owner = spawn("bash", ["-c", 'exec 9>"$L"; flock 9; sleep 30; true'], { env: { PATH: "/usr/bin:/bin", L: lock, OPENRIG_SESSION_NAME: "owner@x" }, stdio: "ignore", detached: true });
  try {
    assert.ok(await until(() => /build 2\/2  held/.test(status("build").stdout)));
    const line = status("build").stdout.split("\n").find(l => l.startsWith("build 2/2"));
    assert.match(line, new RegExp(`seat=owner@x .* pid=${owner.pid}$`));
    // a symlinked runtime dir (another path to the same lock) describes the same holder
    const alias = join(root, "alias-run"); if (!fs.existsSync(alias)) fs.symlinkSync(root, alias);
    assert.match(status("build", { XDG_RUNTIME_DIR: alias }).stdout, new RegExp(`build 2/2  held  seat=owner@x .* pid=${owner.pid}\n`));
  } finally { process.kill(-owner.pid); observer.kill(); }   // the whole group: its sleep child inherited the locked fd
  assert.ok(await until(() => /build 2\/2  free/.test(status("build").stdout)), "free once the owner is gone, observer or not");
});

test("status: an unreadable lock table is unknown, and a lock held with no visible holder is 'owner unknown', never free", () => {
  const dir = join(root, "agent-heavy"), lock = join(dir, "browser.1.lock"); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(lock, "");
  const fake = fs.mkdtempSync(join(root, "proc-"));
  assert.match(status("browser", { AGENT_HEAVY_PROC: fake }).stdout, /^browser 1\/2  unknown \(cannot read \S+\/locks\)$/m);
  const st = spawnSync("stat", ["-L", "-c", "%Hd %Ld %i", lock], { encoding: "utf8" }).stdout.trim().split(" ").map(Number);
  const id = `${st[0].toString(16).padStart(2, "0")}:${st[1].toString(16).padStart(2, "0")}:${st[2]}`;
  fs.writeFileSync(join(fake, "locks"), `1: FLOCK  ADVISORY  WRITE 999999 ${id} 0 EOF\n`);
  assert.match(status("browser", { AGENT_HEAVY_PROC: fake }).stdout, /^browser 1\/2  held  owner unknown \(lock \S+ is held but no holder is visible\)$/m);
  fs.writeFileSync(join(fake, "locks"), "");
  assert.match(status("browser", { AGENT_HEAVY_PROC: fake }).stdout, /^browser 1\/2  free$/m, "a readable table without the lock: free");
});
