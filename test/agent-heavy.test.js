// agent-heavy: long-lived servers are refused (they held both build slots indefinitely, 2026-09-29), and every job has
// a max runtime so a hung or endless one can't keep a slot. Stub-only: systemd-run is faked (it records its args and
// enforces RuntimeMaxSec with `timeout`); the slot locks live in a throwaway XDG_RUNTIME_DIR.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
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
# WO58: an "oom-next" file makes this run look OOM-killed: systemd counts it (OOMKills) and the job dies with 137
if [ -f "${root}/oom-next" ]; then rm -f "${root}/oom-next"; echo 1 > "${root}/oom-$unit.scope"; exit 137; fi
t0=$(date +%s); timeout --preserve-status "$max" "$@"; rc=$?
[ $(( $(date +%s) - t0 )) -ge "$max" ] && echo timeout > "${root}/result-$unit.scope"
exit $rc
`, { mode: 0o755 });
fs.writeFileSync(join(bin, "systemctl"), `#!/usr/bin/env bash
printf '%s\\n' "systemctl $*" >> "${calls}"
case "$*" in
  "--user show -p Result --value "*) f="${root}/result-\${@: -1}"; [ -f "$f" ] && cat "$f" || echo success ;;
  "--user show -p OOMKills --value "*) f="${root}/oom-\${@: -1}"; [ -f "$f" ] && cat "$f" || echo 0 ;;
  "--user show-environment") [ -f "${root}/no-bus" ] && exit 1; echo PATH=/usr/bin ;;
  "--user reset-failed "*) rm -f "${root}/result-\${@: -1}" "${root}/oom-\${@: -1}" ;;
esac
`, { mode: 0o755 });

// bwrap is stubbed (it records its arguments and runs the job): the filesystem sandbox has its own tests
fs.writeFileSync(join(bin, "bwrap"), `#!/usr/bin/env bash
[ -n "\${BWRAP_CALLS:-}" ] && printf '%s\\n' "$*" >> "$BWRAP_CALLS"
while [ $# -gt 0 ] && [ "$1" != "--" ]; do shift; done; [ $# -gt 0 ] && shift
[ $# -gt 0 ] && exec "$@"; exit 0
`, { mode: 0o755 });
// logger is faked too: a stop at the cap is logged for journalctl, and nothing reaches the real journal from tests
fs.writeFileSync(join(bin, "logger"), `#!/usr/bin/env bash\nprintf '%s\\n' "logger $*" >> "${calls}"\n`, { mode: 0o755 });

const heavy = (args, env = {}) => {
  fs.rmSync(calls, { force: true });
  const r = spawnSync(join(repo, "bin/agent-heavy"), args, { encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin`, XDG_RUNTIME_DIR: root, USER: "t", AGENT_HEAVY_BWRAP: join(bin, "bwrap"), ...env } });
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
  const rules = fs.readFileSync(join(repo, "rig/template/guidance/host-operations.md"), "utf8");
  assert.match(rules, /Never wrap a server/);
  assert.match(rules, /max runtime \(45min build, 30min browser/);
  const agents = fs.readFileSync(join(repo, "starter-kit/AGENTS.md"), "utf8");
  assert.match(agents, /`npm run start:test`, run directly and never inside agent-heavy/);
});

// ---- agent-heavy status (read-only: who holds each slot) ------------------------------------------------------------
const status = (...args) => {
  const env = typeof args.at(-1) === "object" ? args.pop() : {};
  return spawnSync(join(repo, "bin/agent-heavy"), ["status", ...args], { encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin`, XDG_RUNTIME_DIR: root, USER: "t", AGENT_HEAVY_BWRAP: join(bin, "bwrap"), ...env } });
};
const until = async (pred, ms = 5000) => { const t = Date.now(); while (!pred()) { if (Date.now() - t > ms) return false; await new Promise(r => setTimeout(r, 50)); } return true; };

test("status: every slot free when nothing runs; a bad class is a usage error", () => {
  const r = status();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "build 1/2  free\nbuild 2/2  free\nbuild queue  empty\nbrowser 1/2  free\nbrowser 2/2  free\nbrowser queue  empty\n");
  assert.equal(status("browser").stdout, "browser 1/2  free\nbrowser 2/2  free\nbrowser queue  empty\n");
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
  assert.equal(status("build").stdout, "build 1/2  free\nbuild 2/2  free\nbuild queue  empty\n", "free again after the job");
  assert.equal(fs.existsSync(join(root, "agent-heavy/build.1.holder")), false, "the holder file is removed");
});

test("status: a slot held by an older agent-heavy (no holder file) is described from /proc; a stale holder file is ignored", async () => {
  const dir = join(root, "agent-heavy"); fs.mkdirSync(dir, { recursive: true });
  // a stale holder file from a run that died without cleaning up must not describe the new holder
  fs.writeFileSync(join(dir, "browser.2.holder"), "pid=1\nseat=ghost\ncwd=/\nstart=0\nmax=60\ncmd=old\n");
  const old = spawn("bash", ["-c", 'exec 9>"$L"; flock 9; sleep 30; true', "/opt/old/agent-heavy", "browser", "--", "npx", "playwright", "test"],
    { env: { PATH: "/usr/bin:/bin", L: join(dir, "browser.2.lock"), OPENRIG_SESSION_NAME: "qa@proj" }, stdio: "ignore", detached: true });
  try {
    assert.ok(await until(() => /held/.test(status("browser").stdout)));
    const line = status("browser").stdout.split("\n").find(l => l.includes("held"));
    assert.match(line, new RegExp(`^browser 2/2  held  seat=qa@proj  age=0m0[0-9]s  remaining=unknown \\(no holder record\\)  cwd=\\S+  cmd=npx playwright test  pid=${old.pid}$`));
    assert.doesNotMatch(line, /ghost/);
  } finally { process.kill(-old.pid); fs.rmSync(join(dir, "browser.2.holder"), { force: true }); }   // the group: its sleep holds the lock
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

test("a stop at the runtime cap is logged with seat, class, cwd, command and runtime; nothing else is logged", () => {
  const cwd = fs.mkdtempSync(join(root, "log-cwd-"));
  fs.rmSync(calls, { force: true });
  const r = spawnSync(join(repo, "bin/agent-heavy"), ["build", "--max-runtime", "1", "--", "sleep", "30"], { encoding: "utf8", cwd,
    env: { PATH: `${bin}:/usr/bin:/bin`, XDG_RUNTIME_DIR: root, USER: "t", OPENRIG_SESSION_NAME: "impl-2@proj", CALLS: calls } });
  assert.equal(r.status, 124);
  const c = fs.readFileSync(calls, "utf8");
  assert.match(c, new RegExp(`^logger -t agent-heavy stopped at the build max runtime: seat=impl-2@proj class=build slot=\\d runtime=[1-3]s max=1 cwd=${cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} cmd=sleep 30$`, "m"));
  for (const args of [["build", "--", "true"], ["build", "--", "false"], ["build", "--", "npm", "start"]]) {
    assert.doesNotMatch(heavy(args).c, /^logger/m, args.join(" "));
  }
});

// ---- nesting (WO15): a nested call of a class already held runs inline in that slot ---------------------------------
const nestedPath = `${bin}:${join(repo, "bin")}:/usr/bin:/bin`;   // the job itself calls agent-heavy

test("nested same-class call runs inline: one slot, a note on stderr, the class and slot exported to the job", () => {
  const r = heavy(["browser", "--", "agent-heavy", "browser", "--", "sh", "-c", 'echo "active=$AGENT_HEAVY_ACTIVE slot=$AGENT_HEAVY_SLOT"'], { PATH: nestedPath });
  assert.equal(r.status, 0, r.stderr);
  assert.equal((r.c.match(/^systemd-run /gm) || []).length, 1, "only the outer run took a slot");
  assert.match(r.stderr, /\[agent-heavy\] nested browser run: already inside browser\.1; running inline \(no second slot\)/);
  assert.match(r.stdout, /^active=browser slot=browser\.1$/m);
});

test("two concurrent nested same-class runs both finish: no run holds both slots, no deadlock", async () => {
  const run = () => new Promise((resolve) => {
    const p = spawn(join(repo, "bin/agent-heavy"), ["browser", "--wait", "4", "--", "agent-heavy", "browser", "--wait", "4", "--", "sleep", "1"],
      { env: { PATH: nestedPath, XDG_RUNTIME_DIR: root, USER: "t" }, stdio: ["ignore", "ignore", "pipe"] });
    let err = ""; p.stderr.on("data", (d) => { err += d; });
    p.on("exit", (code) => resolve({ code, err }));
  });
  const t0 = Date.now();
  const [a, b] = await Promise.all([run(), run()]);
  assert.equal(a.code, 0, a.err); assert.equal(b.code, 0, b.err);
  assert.ok(Date.now() - t0 < 4000, "neither waited for a second slot");
  for (const r of [a, b]) assert.match(r.err, /running inline/);
});

test("a nested call of a different class takes its own slot; a same class further down still runs inline", () => {
  const r = heavy(["browser", "--", "agent-heavy", "build", "--", "agent-heavy", "browser", "--", "sh", "-c",
    'echo "active=$AGENT_HEAVY_ACTIVE slot=$AGENT_HEAVY_SLOT"'], { PATH: nestedPath });
  assert.equal(r.status, 0, r.stderr);
  const scopes = r.c.match(/^systemd-run .*--unit=agent-heavy-(\w+)-\d+-\d+/gm) || [];
  assert.deepEqual(scopes.map((l) => l.match(/agent-heavy-(\w+)-/)[1]), ["browser", "build"], "one browser slot, then one build slot");
  assert.match(r.stderr, /nested browser run: already inside browser\.1; running inline/);
  assert.match(r.stdout, /^active=browser build slot=browser\.1 build\.1$/m);
});

test("outside a run the job sees only the markers agent-heavy set for it", () => {
  const r = heavy(["build", "--", "sh", "-c", 'echo "active=$AGENT_HEAVY_ACTIVE slot=$AGENT_HEAVY_SLOT"']);
  assert.match(r.stdout, /^active=build slot=build\.1$/m);
  assert.equal((r.c.match(/^systemd-run /gm) || []).length, 1);
});

// Operator/QA: a marker is trusted only if this process's own ancestors hold the named slot. Anything else fails closed.
test("a marker leaked into a long-lived shell (no slot held) is ignored: the run takes a slot as usual", () => {
  const r = heavy(["build", "--", "sh", "-c", 'echo "active=$AGENT_HEAVY_ACTIVE slot=$AGENT_HEAVY_SLOT"'],
    { AGENT_HEAVY_ACTIVE: "build", AGENT_HEAVY_SLOT: "build.1" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal((r.c.match(/^systemd-run /gm) || []).length, 1, "a real scope with the budget");
  assert.match(r.stderr, /ignoring AGENT_HEAVY_ACTIVE=build: no build slot is held by this process's ancestors; taking a slot/);
  assert.doesNotMatch(r.stderr, /running inline/);
  assert.match(r.stdout, /^active=build slot=build\.1$/m, "the stale entry is replaced, not appended to");
});

test("a foreign marker naming a slot another seat really holds does not let this caller skip the budget", async () => {
  const dir = join(root, "agent-heavy"); fs.mkdirSync(dir, { recursive: true });
  const other = spawn("bash", ["-c", 'exec 9>"$L"; flock 9; sleep 30; true'], { env: { PATH: "/usr/bin:/bin", L: join(dir, "build.1.lock") }, stdio: "ignore", detached: true });
  try {
    assert.ok(await until(() => /build 1\/2  held/.test(status("build").stdout)), "another seat holds build.1");
    const r = heavy(["build", "--wait", "2", "--", "true"], { AGENT_HEAVY_ACTIVE: "build", AGENT_HEAVY_SLOT: "build.1" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /ignoring AGENT_HEAVY_ACTIVE=build/);
    assert.match(r.c, /--unit=agent-heavy-build-2-/, "it took the free slot 2 under the budget");
  } finally { process.kill(-other.pid); }
});

test("an unverifiable marker is dropped only for its class; other classes in the lists are kept", () => {
  const r = heavy(["build", "--", "sh", "-c", 'echo "active=$AGENT_HEAVY_ACTIVE slot=$AGENT_HEAVY_SLOT"'],
    { AGENT_HEAVY_ACTIVE: "browser build", AGENT_HEAVY_SLOT: "browser.2 build.1" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal((r.c.match(/^systemd-run /gm) || []).length, 1);
  assert.match(r.stdout, /^active=browser build slot=browser\.2 build\.1$/m);
});

// ---- WO58: memory ceilings, the all-heavy ceiling, worker hints, and the fallback without systemd -----------------
test("WO58: each run gets its class ceiling, no swap, inside agent-heavy.slice whose all-heavy ceiling is set first", () => {
  let r = heavy(["build", "--", "true"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.c, /^systemctl --user set-property --runtime agent-heavy\.slice MemoryMax=24G MemorySwapMax=0$/m);
  assert.match(r.c, /^systemd-run --user --scope --quiet --slice=agent-heavy\.slice -p CPUQuota=800% -p MemoryMax=14G -p MemorySwapMax=0 -p RuntimeMaxSec=2700 /m);
  const order = r.c.split("\n"); assert.ok(order.findIndex((l) => /set-property/.test(l)) < order.findIndex((l) => /^systemd-run/.test(l)), "the ceiling before the run");
  assert.match(r.stderr, /build slot \d\/2 \(cpu=800% mem=14G swap=0 all-heavy=24G max=45min workers=4\)/);
  r = heavy(["browser", "--", "true"]);
  assert.match(r.c, /^systemd-run .* -p CPUQuota=400% -p MemoryMax=8G -p MemorySwapMax=0 /m);
  r = heavy(["build", "--", "true"], { AGENT_HEAVY_BUILD_MEM: "10G", AGENT_HEAVY_BUILD_SWAP: "1G", AGENT_HEAVY_TOTAL_MEM: "infinity" });
  assert.match(r.c, /MemoryMax=10G -p MemorySwapMax=1G /); assert.match(r.c, /set-property --runtime agent-heavy\.slice MemoryMax=infinity /);
  r = heavy(["build", "--", "true"], { AGENT_HEAVY_SLICE: "throwaway-test.slice" });
  assert.match(r.c, /set-property --runtime throwaway-test\.slice /); assert.match(r.c, /--slice=throwaway-test\.slice /);
});

test("WO58: a run killed for memory says so, exits 137 whatever it returned, is logged, its scope is cleared and the slot freed", () => {
  fs.writeFileSync(join(root, "oom-next"), "");
  const r = heavy(["build", "--", "true"], { OPENRIG_SESSION_NAME: "impl-2@proj" });
  assert.equal(r.status, 137, r.stderr);
  assert.match(r.stderr, /killed: the run went over its memory ceiling \(build: 14G, no swap; all heavy runs together: 24G\)/);
  assert.match(r.stderr, /Rerun it focused: a subset of the tests, or fewer workers \(node --test --test-concurrency=4, vitest --maxWorkers=4,\s+jest --maxWorkers=4, pytest -n 4\)/);
  assert.match(r.stderr, /set AGENT_HEAVY_BUILD_MEM/);
  assert.match(r.c, /^logger -t agent-heavy killed for memory: build ceiling 14G, all heavy runs 24G: seat=impl-2@proj class=build slot=\d runtime=\d+s max=45min cwd=.* cmd=true$/m);
  assert.match(r.c, /^systemctl --user reset-failed agent-heavy-build-\d+-\d+\.scope$/m);
  assert.doesNotMatch(r.stderr, /max runtime/);
  assert.equal(heavy(["build", "--wait", "1", "--", "true"]).status, 0, "the slot is free");
  assert.equal(heavy(["build", "--wait", "1", "--", "true"]).status, 0);
});

test("WO58: every run clears its scope afterwards, so failed scopes don't pile up; an ordinary failure is not a memory kill", () => {
  const r = heavy(["build", "--", "false"]);
  assert.equal(r.status, 1); assert.doesNotMatch(r.stderr, /memory ceiling|max runtime/);
  assert.match(r.c, /^systemctl --user reset-failed agent-heavy-build-\d+-\d+\.scope$/m);
});

test("WO58: worker hints in the job's env (4 unless set or overridden)", () => {
  const show = ["sh", "-c", 'echo "W=$PYTEST_XDIST_AUTO_NUM_WORKERS/$VITEST_MAX_WORKERS/$VITEST_MAX_THREADS/$VITEST_MAX_FORKS"'];
  assert.match(heavy(["build", "--", ...show]).stdout, /^W=4\/4\/4\/4$/m);
  assert.match(heavy(["build", "--", ...show], { AGENT_HEAVY_WORKERS: "2" }).stdout, /^W=2\/2\/2\/2$/m);
  assert.match(heavy(["build", "--", ...show], { VITEST_MAX_WORKERS: "8", PYTEST_XDIST_AUTO_NUM_WORKERS: "1" }).stdout, /^W=1\/8\/4\/4$/m, "a value the caller set is kept");
});

test("WO58: without a systemd user session it warns and still runs the job (slot, exit code and max runtime kept)", () => {
  fs.writeFileSync(join(root, "no-bus"), "");
  try {
    let r = heavy(["build", "--", "sh", "-c", "echo ran; exit 3"]);
    assert.equal(r.status, 3); assert.match(r.stdout, /^ran$/m);
    assert.match(r.stderr, /WARN: no systemd user session \(systemd-run --user unavailable\): running WITHOUT the CPU and memory limits/);
    assert.doesNotMatch(r.c, /^systemd-run|set-property/m);
    r = heavy(["build", "--max-runtime", "1", "--", "sleep", "30"]);
    assert.equal(r.status, 124); assert.match(r.stderr, /stopped: reached the build max runtime \(1\)/);
  } finally { fs.rmSync(join(root, "no-bus"), { force: true }); }
  const sr = fs.readFileSync(join(bin, "systemd-run")); fs.rmSync(join(bin, "systemd-run"));
  try {
    const r = spawnSync(join(repo, "bin/agent-heavy"), ["build", "--", "true"], { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, XDG_RUNTIME_DIR: root, USER: "t" } });
    if (!fs.existsSync("/usr/bin/systemd-run") && !fs.existsSync("/bin/systemd-run")) { assert.equal(r.status, 0); assert.match(r.stderr, /WARN: no systemd user session/); }
  } finally { fs.writeFileSync(join(bin, "systemd-run"), sr, { mode: 0o755 }); }
});

// One REAL check, where a systemd user session exists (never on CI or a live seat's run): a throwaway command allocates
// past a tiny ceiling in a throwaway slice and lock dir; it is killed inside its scope, the slot is released, and no
// unit or slice drop-in is left behind. The live agent-heavy.slice and slot locks are never touched.
const realSystemd = !process.env.CI && spawnSync("systemctl", ["--user", "show-environment"]).status === 0 && spawnSync("sh", ["-c", "command -v systemd-run"]).status === 0;
test("WO58 real: a run past its ceiling is OOM-killed in its own scope, the slot is released, nothing is left behind", { skip: !realSystemd && "no systemd user session" }, () => {
  const locks = fs.mkdtempSync(join(root, "real-")), sl = `agent-heavy-wo58test-${process.pid}.slice`;
  const env = { ...process.env, AGENT_HEAVY_DIR: locks, AGENT_HEAVY_SLICE: sl, AGENT_HEAVY_BUILD_MEM: "64M", AGENT_HEAVY_TOTAL_MEM: "128M" };
  const alloc = ["python3", "-c", "import time; b = bytearray(256 * 1024 * 1024); time.sleep(0.5); print('survived')"];
  try {
    const failedScopes = () => spawnSync("systemctl", ["--user", "list-units", "--all", "--no-legend", "--plain", "--state=failed", "agent-heavy-*.scope"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).length;
    const failedBefore = failedScopes();
    const before = spawnSync("sh", ["-c", "free -m | awk '/^Mem:/ {print $7}'"], { encoding: "utf8" }).stdout.trim();
    let r = spawnSync(join(repo, "bin/agent-heavy"), ["build", "--", ...alloc], { encoding: "utf8", env });
    assert.equal(r.status, 137, r.stderr); assert.doesNotMatch(r.stdout, /survived/);
    assert.match(r.stderr, /killed: the run went over its memory ceiling \(build: 64M/);
    r = spawnSync(join(repo, "bin/agent-heavy"), ["build", "--wait", "1", "--", "python3", "-c", "b = bytearray(16 * 1024 * 1024); print('fits')"], { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /fits/, "the slot was released and a run under the ceiling works");
    assert.ok(failedScopes() <= failedBefore, "the killed run's failed scope was cleared");
    assert.ok(Number(spawnSync("sh", ["-c", "free -m | awk '/^Mem:/ {print $7}'"], { encoding: "utf8" }).stdout.trim()) > Number(before) - 2048, "the host is unaffected");
  } finally {
    spawnSync("systemctl", ["--user", "stop", sl]); spawnSync("systemctl", ["--user", "revert", sl]);
  }
  assert.equal(fs.existsSync(`/run/user/${process.getuid()}/systemd/user.control/${sl}.d`), false, "the throwaway slice's drop-in is gone");
});

// 2026-10-04: a mutation run of a test-harness cleanup called rmSync('/', {recursive: true}) as the owner, outside any
// sandbox, and wiped ~/.config, ~/.local/share and the dotfiles. Every agent-heavy job now runs under bwrap.
test("sandbox: every job runs under bwrap with / read-only, only its repo, ~/.cache, worktrees, /tmp and the lock dir writable, HOME a scratch dir", () => {
  const log = join(root, "bwrap-calls"); fs.rmSync(log, { force: true });
  const r = heavy(["build", "--", "sh", "-c", "echo ran"], { BWRAP_CALLS: log });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /ran/);
  const [probe, run] = fs.readFileSync(log, "utf8").trim().split("\n");
  assert.equal(probe, "--ro-bind / / --dev-bind /dev /dev true", "bwrap is checked before a slot is taken");
  assert.match(run, /^--ro-bind \/ \/ --dev-bind \/dev \/dev --bind \/proc \/proc /, "everything read-only first");
  const home = spawnSync("sh", ["-c", "getent passwd $(id -u) | cut -d: -f6"], { encoding: "utf8" }).stdout.trim();
  for (const p of [repo, `${home}/.cache`, join(root, "agent-heavy"), "/tmp"]) assert.ok(run.includes(` --bind ${p} ${p} `), `writable: ${p}`);
  assert.doesNotMatch(run, new RegExp(` --bind ${home} ${home} `), "never the home directory itself");
  assert.match(run, new RegExp(` --setenv HOME ${home}/\\.cache/agent-heavy/run-agent-heavy-build-\\d+-\\d+/home `));
  for (const v of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) assert.match(run, new RegExp(` --setenv ${v} ${home}/\\.cache/agent-heavy/run-`), v);
  assert.match(run, new RegExp(` --setenv GH_CONFIG_DIR ${home}/\\.config/gh `), "real config by path (read-only)");
  assert.match(run, / --die-with-parent /); assert.match(run, / -- sh -c echo ran$/);
  const scratch = run.match(/--setenv HOME (\S+)\/home /)[1];
  assert.equal(fs.existsSync(scratch), false, "the scratch dir is removed after the run");
});

test("sandbox: refused when bwrap can't run (never unsandboxed), or when the job would get its home directory writable", () => {
  const r = heavy(["build", "--", "true"], { AGENT_HEAVY_BWRAP: join(root, "no-such-bwrap") });
  assert.equal(r.status, 78); assert.match(r.stderr, /refused: the filesystem sandbox \(bwrap\) can't run here, and jobs never run without it/);
  assert.equal(r.c, "", "no slot taken");
  const home = spawnSync("sh", ["-c", "getent passwd $(id -u) | cut -d: -f6"], { encoding: "utf8" }).stdout.trim();
  for (const cwd of ["/", dirname(home)]) {
    const x = spawnSync(join(repo, "bin/agent-heavy"), ["build", "--", "true"], { cwd, encoding: "utf8",
      env: { PATH: `${bin}:/usr/bin:/bin`, XDG_RUNTIME_DIR: root, USER: "t", AGENT_HEAVY_BWRAP: join(bin, "bwrap") } });
    assert.equal(x.status, 2, cwd); assert.match(x.stderr, /refused: the job would get write access to .*, which holds your home directory/, cwd);
  }
});

// One REAL check where bwrap works (never on CI): a job deletes a directory outside its writable set (EROFS, the
// directory survives), can't touch the real ~/.config (EROFS), and still writes in its own repository.
const bwrapPath = spawnSync("sh", ["-c", "command -v bwrap"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } }).stdout.trim();
const realBwrap = !process.env.CI && !!bwrapPath && spawnSync(bwrapPath, ["--ro-bind", "/", "/", "--dev-bind", "/dev", "/dev", "true"]).status === 0;
test("sandbox real: rm -rf outside the writable set fails with EROFS and changes nothing; the repo stays writable", { skip: !realBwrap && "bwrap unavailable" }, () => {
  // the victim sits beside the job's repo in a dir the job may not write (/tmp is dropped from its writable set here:
  // AGENT_HEAVY_TMP_RW=0, a tests-only knob that only narrows it), so this also works when the suite itself runs
  // inside agent-heavy
  const base = fs.mkdtempSync(join(os.tmpdir(), "agent-heavy-ro-")), victim = join(base, "victim"), work = join(base, "repo");
  fs.mkdirSync(join(victim, "deep"), { recursive: true }); fs.writeFileSync(join(victim, "deep/keep"), "x");
  fs.mkdirSync(work); spawnSync("git", ["init", "-q"], { cwd: work });
  try {
    const job = `rm -rf ${victim} 2>&1; touch -c "$AGENT_HEAVY_REAL_HOME/.config" 2>&1; echo ok > written && echo repo-write-ok; echo "home=$HOME"`;
    const r = spawnSync(join(repo, "bin/agent-heavy"), ["build", "--wait", "60", "--", "sh", "-c", job], { cwd: work, encoding: "utf8",
      env: { PATH: `${bin}:/usr/bin:/bin`, XDG_RUNTIME_DIR: root, USER: "t", AGENT_HEAVY_DIR: join(root, "real-locks"), AGENT_HEAVY_TMP_RW: "0",
        AGENT_HEAVY_BWRAP: bwrapPath } });   // the real one (the stub sits first on PATH)
    assert.match(r.stdout, /rm: cannot remove .*victim.*Read-only file system/, r.stdout + r.stderr);
    assert.match(r.stdout, /touch: setting times of '.*\/\.config': Read-only file system/);
    assert.match(r.stdout, /repo-write-ok/); assert.equal(fs.readFileSync(join(work, "written"), "utf8"), "ok\n");
    assert.match(r.stdout, /home=\S+\/\.cache\/agent-heavy\/run-/, "HOME is the run's scratch dir");
    assert.equal(fs.readFileSync(join(victim, "deep/keep"), "utf8"), "x", "nothing outside the writable set changed");
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
