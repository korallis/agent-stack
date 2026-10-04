// WO100: local GitHub Actions runners (bin/agent-ci-runner, system/ci-runner-hook, agent-ci-runner@.service). Every
// external tool is a stub: gh answers from a scenario file and records calls (with the HOME it saw), systemctl records,
// and the runner tarball is a fake whose config.sh records its argv and echoes the token it was given (so a leak shows).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const tool = join(repo, "bin/agent-ci-runner"), hook = join(repo, "system/ci-runner-hook");
const root = fs.mkdtempSync(join(os.tmpdir(), "ci-runners-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const TOKEN = "TOKEN-SECRET-4f9a";

// stubs
// gh lives apart from PATH (as a mise shim does): the tool must find it through AGENT_CI_TOOL_PATH. The other stubs are
// on PATH, so the real systemctl is never reached.
const stubs = join(root, "stubs"), sysStubs = join(root, "sys-stubs"); fs.mkdirSync(stubs); fs.mkdirSync(sysStubs);
fs.writeFileSync(join(stubs, "gh"), `#!/usr/bin/env python3
import json, os, sys
os.getcwd()  # like mise's shim: a deleted working directory fails here
sc = os.environ["GH_SCENARIO"]; s = json.load(open(sc)); a = sys.argv[1:]
open(os.environ["CALLS"], "a").write(json.dumps({"tool": "gh", "argv": a, "home": os.environ.get("HOME")}) + "\\n")
j = " ".join(a)
def save(): json.dump(s, open(sc, "w"))
if "registration-token" in j or "remove-token" in j: print(s.get("token", "")); sys.exit(0)
if j.startswith("api -X DELETE"): sys.exit(0)
if "/actions/variables/CI_LOCAL" in j:
    v = s.get("vars", {}).get(a[1].split("/")[2])
    sys.exit(1) if v is None else print(v); sys.exit(0)
if a[:2] == ["variable", "set"]: s.setdefault("vars", {})[a[a.index("--repo") + 1].split("/")[1]] = a[a.index("--body") + 1]; save(); sys.exit(0)
if a[:2] == ["variable", "delete"]: s.get("vars", {}).pop(a[a.index("--repo") + 1].split("/")[1], None); save(); sys.exit(0)
if j.endswith("/actions/runners --paginate --jq .runners[] | {id, name, status, busy}"):
    for r in s.get("runners", []): print(json.dumps(r))
    sys.exit(0)
if a[0] == "api" and a[1].startswith("repos/") and a[1].count("/") == 2: print(a[1][6:]); sys.exit(0)
sys.exit(3)
`, { mode: 0o755 });
fs.writeFileSync(join(sysStubs, "systemctl"), `#!/usr/bin/env python3
import json, os, sys
s = json.load(open(os.environ["GH_SCENARIO"])); a = sys.argv[1:]
open(os.environ["CALLS"], "a").write(json.dumps({"tool": "systemctl", "argv": a}) + "\\n")
v = s.get("active", "active"); v = v.get(a[-1], "inactive") if isinstance(v, dict) else v   # one state, or per unit
if "show" in a and "Slice" in a: print(s.get("slice", "agent-heavy-ci.slice")); sys.exit(0)
if "show" in a and "ExecMainStatus" in a: print(s.get("mainStatus", {}).get(a[a.index("show") + 1], "0")); sys.exit(0)
if "is-active" in a: print(v); sys.exit(0 if v == "active" else 3)
`, { mode: 0o755 });
// systemd-run: the network guard's probe. "refused" (the guard holds; the default), "open", "fail", or "real": run the
// probe itself on this host, outside any guard, so it really reaches the canary
fs.writeFileSync(join(sysStubs, "systemd-run"), `#!/usr/bin/env python3
import json, os, subprocess, sys
s = json.load(open(os.environ["GH_SCENARIO"])); a = sys.argv[1:]
open(os.environ["CALLS"], "a").write(json.dumps({"tool": "systemd-run", "argv": a}) + "\\n")
m = s.get("netguard", "refused")
if m == "real": sys.exit(subprocess.run(a[a.index("/usr/bin/python3"):]).returncode)
if m == "fail": print("Failed to start transient service unit", file=sys.stderr); sys.exit(1)
print(m)
`, { mode: 0o755 });
fs.writeFileSync(join(sysStubs, "sudo"), `#!/bin/sh
printf '{"tool": "sudo", "argv": "%s"}\\n' "$*" >> "$CALLS"
`, { mode: 0o755 });
for (const t of ["logger", "notify-send"]) fs.writeFileSync(join(sysStubs, t), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

// a fake runner release
const rel = join(root, "release"); fs.mkdirSync(rel);
fs.writeFileSync(join(rel, "config.sh"), `#!/usr/bin/env bash
printf '%s\\n' "$@" > config-argv.txt
[ -n "\${ACTIONS_RUNNER_INPUT_TOKEN:-}" ] && echo "token-in-env" > config-env.txt
echo "configured with \${ACTIONS_RUNNER_INPUT_TOKEN:-none}"
`, { mode: 0o755 });
fs.writeFileSync(join(rel, "run.sh"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
const tarball = join(root, "runner.tar.gz");
execFileSync("tar", ["czf", tarball, "-C", rel, "config.sh", "run.sh"]);
const sha = createHash("sha256").update(fs.readFileSync(tarball)).digest("hex");

const fakeGh = join(root, "fake-gh"); fs.writeFileSync(fakeGh, "#!/bin/sh\necho gh version 0-test\n", { mode: 0o755 });
let n = 0;
function world(initial = {}) {
  const w = join(root, `w${n++}`); fs.mkdirSync(w);
  const sc = join(w, "scenario.json"); fs.writeFileSync(sc, JSON.stringify({ token: TOKEN, ...initial }));
  // as in the unit: a minimal PATH; gh is found through AGENT_CI_TOOL_PATH (default ~/.local/bin and the mise shims)
  const env = { PATH: `${sysStubs}:/usr/bin:/bin`, AGENT_CI_TOOL_PATH: stubs, GH_SCENARIO: sc, CALLS: join(w, "calls"), AGENT_CI_ROOT: join(w, "runners"),
    AGENT_CI_STATE: join(w, "state"), AGENT_CI_CONFIG: join(w, "config/ci-runners.env"), AGENT_CI_CACHE: join(w, "cache"),
    AGENT_CI_TARBALL: tarball, AGENT_CI_SHA256: sha, AGENT_CI_GH: fakeGh, AGENT_CI_HOST: "testhost", AGENT_CI_POLL_S: "0.05", AGENT_CI_ONLINE_WAIT_S: "1" };
  const run = (...args) => { fs.writeFileSync(env.CALLS, ""); const r = spawnSync("python3", [tool, ...args], { encoding: "utf8", env });
    return { ...r, calls: fs.readFileSync(env.CALLS, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) }; };
  const scenario = () => JSON.parse(fs.readFileSync(sc, "utf8"));
  const set = (patch) => fs.writeFileSync(sc, JSON.stringify({ ...scenario(), ...patch }));
  return { w, env, run, scenario, set };
}
const online = (name = "testhost-demo", status = "online") => ({ runners: [{ id: 7, name, status, busy: false }] });

test("the unit sandboxes the job (no home, keys or seats), bounds it inside agent-heavy.slice and gates every job", () => {
  const u = fs.readFileSync(join(repo, "system/systemd/agent-ci-runner@.service"), "utf8");
  assert.doesNotMatch(u, /^StartLimitBurst=/m, "no burst limit on the runner unit");
  for (const line of ["Slice=agent-heavy-ci.slice", "PrivateUsers=yes", "ProtectHome=tmpfs", "PrivateTmp=yes", "NoNewPrivileges=yes",
    "MemoryMax=8G", "MemorySwapMax=0", "CPUQuota=800%", "CPUWeight=20", "IOWeight=20", "Restart=always",
    // no start limit: per-job restarts of a busy ephemeral runner (20 jobs in 10 min) hit 20/600 s and stopped it for good
    "StartLimitIntervalSec=0",
    // hosted images' timezone and locale: date-sensitive browser tests failed on the host's local time
    "Environment=TZ=UTC", "Environment=LANG=C.UTF-8", "Environment=LC_ALL=C.UTF-8",
    "EnvironmentFile=-%h/.local/share/agent-stack/ci-runners/%i/ci.env",
    "Requires=agent-ci-runner-register@%i.service", "After=network-online.target agent-ci-runner-register@%i.service",
    "ExecStart=%h/.local/share/agent-stack/ci-runners/%i/runner/run.sh",
    "BindPaths=%h/.local/share/agent-stack/ci-runners/%i/home:%h %h/.local/share/agent-stack/ci-runners/%i %h/.local/state/agent-stack/ci-runners",
    "BindReadOnlyPaths=%h/.local/share/agent-stack/ci-runners/_shared -%h/.config/agent-stack/ci-runners.env",
    // the runner's worker uses the passwd home: the runner's own home is mounted over that path (Playwright writes ~/.cache)
    "Environment=HOME=%h",
    "Environment=ACTIONS_RUNNER_HOOK_JOB_STARTED=%h/.local/share/agent-stack/ci-runners/_shared/job-started.sh",
    "Environment=ACTIONS_RUNNER_HOOK_JOB_COMPLETED=%h/.local/share/agent-stack/ci-runners/_shared/job-completed.sh"])
    assert.ok(u.split("\n").includes(line), line);
  assert.doesNotMatch(u, /BindPaths=.*(\.codex|\.claude|\.cli-proxy|\.config\/gh|Projects)/);
  assert.match(u, /\n\[Install\]\nWantedBy=default\.target\n/, "enable needs an [Install] section, or install fails on the live host");
  // no privileged step inside the sandboxed unit: with the home bound over the real home path, systemd can't set up an
  // ExecStartPre=+ (226/NAMESPACE on the live host); registration is its own unsandboxed unit, run before every start
  assert.doesNotMatch(u, /^ExecStart(Pre|Post)?=[+!]/m);
  const reg = fs.readFileSync(join(repo, "system/systemd/agent-ci-runner-register@.service"), "utf8");
  assert.match(reg, /^Type=oneshot$/m); assert.match(reg, /^ExecStart=%h\/\.local\/bin\/agent-ci-runner register %i$/m);
  assert.doesNotMatch(reg, /ProtectHome|PrivateUsers|BindPaths/, "registration runs outside the sandbox (it needs gh)");
  // inside the unit plain nproc reports the CPUQuota (8 of 32 here), which would read a normal host load as overloaded
  assert.match(fs.readFileSync(hook, "utf8"), /cpus=\$\{AGENT_CI_NPROC:-\$\(nproc --all\)\}/);
  const inst = fs.readFileSync(join(repo, "install.sh"), "utf8");
  assert.match(inst, /for f in [^;]*\bagent-ci-runner\b/); assert.match(inst, /for t in [^;]*\bagent-ci-runner-watch\b/);
});

test("register: failures (failed registrations, abnormal runner exits) back off growing, then the runner is given up; exit 0 never counts", () => {
  const { env, run, set, scenario } = world(online());
  const reg = () => { const t0 = Date.now(); const r = spawnSync("python3", [tool, "register", "demo"], { encoding: "utf8", env: { ...env, AGENT_CI_REGISTER_BACKOFF_S: "0.2" } }); return { ...r, ms: Date.now() - t0 }; };
  const rec = join(env.AGENT_CI_STATE, "register-failures-demo.json"), gave = join(env.AGENT_CI_STATE, "demo.gave-up");
  // failed registrations (no runner yet): 3 don't wait, the 4th waits first
  for (let i = 0; i < 3; i++) { const r = reg(); assert.equal(r.status, 1); assert.doesNotMatch(r.stderr, /waiting/, `attempt ${i + 1}`); }
  const slow = reg(); assert.equal(slow.status, 1); assert.match(slow.stderr, /3 failed registrations or abnormal exits of demo in 30 min: waiting 0\.2s first/); assert.ok(slow.ms >= 180);
  assert.equal(run("install", "demo").status, 0);
  const ok = reg(); assert.equal(ok.status, 0, ok.stderr); assert.ok(!fs.existsSync(rec), "a success clears the record");
  // a clean run (exit 0: a job done) never counts: normal ephemeral restarts never wait
  set({ mainStatus: { "agent-ci-runner@demo.service": "0" } });
  for (let i = 0; i < 4; i++) assert.doesNotMatch(reg().stderr, /waiting/);
  // QA (#169): a runner that registers fine but exits non-zero restarts every 5 s with no start limit. Each abnormal
  // exit counts (a successful registration doesn't clear it): 2 free, then 0.2, 0.4, 0.8 s, then given up
  set({ mainStatus: { "agent-ci-runner@demo.service": "1" } });
  for (let i = 0; i < 2; i++) assert.doesNotMatch(reg().stderr, /waiting/, `crash ${i + 1}`);
  for (const [n, w] of [[3, "0.2"], [4, "0.4"], [5, "0.8"]]) {
    const r = reg(); assert.equal(r.status, 0); assert.match(r.stderr, new RegExp(`${n} failed registrations or abnormal exits of demo in 30 min: waiting ${w.replace(".", "\\.")}s first`));
    assert.ok(r.ms >= Number(w) * 900, `${n}: waited ${r.ms} ms`);
  }
  assert.equal(scenario().vars.demo, "1");
  const up = reg();
  assert.equal(up.status, 1, "given up: register refuses, so the runner stays stopped");
  assert.match(up.stdout, /runner demo failed 6 times in 30 min .*given up, not restarted; CI_LOCAL cleared, jobs run hosted\. Fix it, then: agent-ci-runner start demo/);
  assert.ok(fs.existsSync(gave)); assert.equal(scenario().vars.demo, undefined, "jobs fall back to hosted at once");
  // watch leaves a given-up runner stopped; start (deliberate) clears it and retries
  set({ active: { "agent-ci-runner@demo.service": "inactive" } });
  assert.ok(!run("watch").calls.some((c) => c.tool === "systemctl" && c.argv.includes("start")), "watch doesn't restart it");
  set({ active: { "agent-ci-runner@demo.service": "inactive" }, runners: online().runners });
  const st = run("start", "demo"); assert.ok(!fs.existsSync(gave) && !fs.existsSync(rec), "start clears the give-up and the streak");
  assert.ok(st.calls.some((c) => c.tool === "systemctl" && c.argv.join(" ") === "--user start agent-ci-runner@demo.service"));
});

test("install re-registers an IDLE runner whose label changed (a lane moved); a busy one changes after its job", () => {
  const r = (n, busy = false) => ({ id: 10 + n, name: n === 1 ? "testhost-demo" : `testhost-demo-${n}`, status: "online", busy });
  const { env, run, set } = world({ runners: [r(1), r(2), r(3)] });
  assert.equal(run("install", "demo", "--count", "2", "--main-lane").status, 0);   // demo_r2 is the lane
  set({ active: "active" });
  const restarts = (out) => out.calls.filter((c) => c.tool === "systemctl" && c.argv.includes("restart")).map((c) => c.argv.join(" "));
  // the lane moves to a new third runner: demo_r2 (idle: no slot, not busy) is re-registered at once as a PR runner
  const moved = run("install", "demo", "--count", "3", "--main-lane");
  assert.equal(moved.status, 0, moved.stderr);
  assert.deepEqual(restarts(moved), ["--user restart agent-ci-runner@demo_r2.service"]);
  assert.match(moved.stdout, /demo_r2 was idle; re-registered now as korallis-local/);
  // nothing changed: nothing restarted
  assert.deepEqual(restarts(run("install", "demo", "--count", "3", "--main-lane")), []);
  // busy on GitHub, or holding a job slot here: left to change after its job
  set({ runners: [r(1), r(2), r(3, true)] });
  const busy = run("install", "demo", "--count", "3", "--no-main-lane");
  assert.deepEqual(restarts(busy), [], "demo_r3 busy on GitHub"); assert.match(busy.stdout, /demo_r3 now takes korallis-local; it is busy .*after its job/);
  set({ runners: [r(1), r(2), r(3)] }); assert.equal(run("install", "demo", "--count", "3", "--main-lane").status, 0);
  fs.mkdirSync(join(env.AGENT_CI_STATE, "slots"), { recursive: true }); fs.writeFileSync(join(env.AGENT_CI_STATE, "slots/demo_r3"), "1");
  assert.deepEqual(restarts(run("install", "demo", "--count", "3", "--no-main-lane")), [], "demo_r3 holds a job slot");
});

test("watch retries a runner whose registration failed (Restart= doesn't: a failed Requires= is not an exit); never a busy, starting or paused one", () => {
  const { env, run, set } = world(online());
  assert.equal(run("install", "demo").status, 0);
  const started = (state) => { set({ active: { "agent-ci-runner@demo.service": state } }); return run("watch").calls.filter((c) => c.tool === "systemctl" && !c.argv.includes("is-active")).map((c) => c.argv.join(" ")); };
  for (const state of ["failed", "inactive"])
    assert.deepEqual(started(state), ["--user reset-failed agent-ci-runner@demo.service agent-ci-runner-register@demo.service", "--user start agent-ci-runner@demo.service"], state);
  for (const state of ["active", "activating"]) assert.deepEqual(started(state), [], `${state}: left alone`);
  fs.writeFileSync(join(env.AGENT_CI_STATE, "demo.paused"), "1");
  assert.deepEqual(started("failed"), [], "a paused repo (stop) is never started");
});

test("jobs get gh (hosted Ubuntu has it; here it lives under the home the sandbox hides): _shared/bin, first on the unit's PATH", () => {
  const u = fs.readFileSync(join(repo, "system/systemd/agent-ci-runner@.service"), "utf8");
  assert.match(u, /^Environment=PATH=%h\/\.local\/share\/agent-stack\/ci-runners\/_shared\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin$/m);
  assert.match(u, /^BindReadOnlyPaths=%h\/\.local\/share\/agent-stack\/ci-runners\/_shared /m, "bound into the sandbox");
  const { w, env, run } = world(online());
  assert.equal(run("install", "demo").status, 0);
  const shared = join(env.AGENT_CI_ROOT, "_shared/bin/gh");
  assert.equal(fs.readFileSync(shared, "utf8"), fs.readFileSync(fakeGh, "utf8")); assert.equal(fs.statSync(shared).mode & 0o777, 0o755);
  // a newer gh reaches the next job through register; an unchanged one isn't copied again
  const newer = join(w, "gh-2"); fs.writeFileSync(newer, "#!/bin/sh\necho gh version 2-test\n"); fs.utimesSync(newer, new Date(), new Date(Date.now() + 5000));
  const reg = (gh) => spawnSync("python3", [tool, "register", "demo"], { encoding: "utf8", env: { ...env, AGENT_CI_GH: gh } });
  assert.equal(reg(newer).status, 0); assert.match(fs.readFileSync(shared, "utf8"), /2-test/);
  const ino = fs.statSync(shared).ino; assert.equal(reg(newer).status, 0); assert.equal(fs.statSync(shared).ino, ino, "unchanged: not re-copied");
  // no gh found: register still succeeds and says so
  const none = reg(join(w, "missing")); assert.equal(none.status, 0, none.stderr); assert.match(none.stderr, /no gh binary found/);
});

test("watch: a job held 10+ min by the host moves its repo to hosted runners; back after 10 calm min; a manual pause is never touched", () => {
  const { env, run, set, scenario } = world(online());
  assert.equal(run("install", "demo").status, 0);
  set({ active: "active" });
  const host = (load, memG = 16) => { fs.writeFileSync(join(env.AGENT_CI_STATE, "loadavg"), `${load} 1 1 1/1 1\n`); fs.writeFileSync(join(env.AGENT_CI_STATE, "meminfo"), `MemAvailable: ${memG * 1048576} kB\n`); };
  Object.assign(env, { AGENT_CI_LOADAVG: join(env.AGENT_CI_STATE, "loadavg"), AGENT_CI_MEMINFO: join(env.AGENT_CI_STATE, "meminfo"), AGENT_CI_NPROC: "32" });
  const now = Math.floor(Date.now() / 1000), lp = join(env.AGENT_CI_STATE, "demo.load-paused");
  fs.mkdirSync(join(env.AGENT_CI_STATE, "waiting"), { recursive: true });
  const held = (s) => fs.writeFileSync(join(env.AGENT_CI_STATE, "waiting", "demo"), `${now - s} host\n`);
  host(40); held(300); run("watch"); assert.equal(scenario().vars.demo, "1", "held 5 min: still local");
  held(700); const w = run("watch"); assert.equal(scenario().vars.demo, undefined, "held 11+ min: hosted"); assert.ok(fs.existsSync(lp));
  assert.match(w.stdout, /a job held 11 min by the host's load or memory; CI_LOCAL cleared/);
  // stays hosted while the host is busy, or calm for under 10 min
  fs.rmSync(join(env.AGENT_CI_STATE, "waiting", "demo")); run("watch"); assert.equal(scenario().vars.demo, undefined);
  host(10); run("watch"); assert.equal(scenario().vars.demo, undefined, "calm just now");
  host(10, 3); fs.writeFileSync(join(env.AGENT_CI_STATE, "host-calm.json"), JSON.stringify({ since: now - 700 })); run("watch");
  assert.equal(scenario().vars.demo, undefined, "load fine but memory short: not calm, whatever the old calm said");
  // calm 10+ min: resumed (the healthy runner sets CI_LOCAL again)
  host(10); fs.writeFileSync(join(env.AGENT_CI_STATE, "host-calm.json"), JSON.stringify({ since: now - 700 }));
  const back = run("watch"); assert.equal(scenario().vars.demo, "1"); assert.ok(!fs.existsSync(lp)); assert.match(back.stdout, /calm 10 min; local runners resumed/);
  // a manual pause (stop) is never resumed by the host rule
  fs.writeFileSync(join(env.AGENT_CI_STATE, "demo.paused"), "1"); set({ vars: {} });
  fs.writeFileSync(join(env.AGENT_CI_STATE, "host-calm.json"), JSON.stringify({ since: now - 700 })); run("watch");
  assert.equal(scenario().vars.demo, undefined);
});

test("watch: one run at a time (a second exits quietly); under systemd each line is logged once, not twice", () => {
  const { w, env, run } = world(online());
  assert.equal(run("install", "demo").status, 0);
  // a run already holding the lock: this one does nothing and exits 0
  fs.mkdirSync(env.AGENT_CI_STATE, { recursive: true }); fs.writeFileSync(env.CALLS, "");
  const holder = spawnSync("bash", ["-c", `exec 9>"${join(env.AGENT_CI_STATE, "watch.lock")}"; flock 9; python3 "${tool}" watch; echo rc=$?`], { encoding: "utf8", env: { ...env } });
  assert.match(holder.stdout, /rc=0/); assert.equal(fs.readFileSync(env.CALLS, "utf8").trim(), "", "no gh or systemctl call while another run holds the lock");
  // say(): logger only when stdout isn't the journal already (systemd sets JOURNAL_STREAM)
  const rec = join(w, "logbin"); fs.mkdirSync(rec); fs.writeFileSync(join(rec, "logger"), `#!/bin/sh\necho "logger $*" >> "${join(w, "logger.log")}"\n`, { mode: 0o755 });
  const sayVia = (extra) => { fs.rmSync(join(w, "logger.log"), { force: true });
    spawnSync("python3", [tool, "stop", "demo"], { encoding: "utf8", env: { ...env, PATH: `${rec}:${env.PATH}`, ...extra } });
    return fs.existsSync(join(w, "logger.log")) ? fs.readFileSync(join(w, "logger.log"), "utf8") : ""; };
  assert.match(sayVia({}), /^logger -t agent-ci-runner .*paused/m, "from a shell: to syslog too");
  assert.equal(sayVia({ JOURNAL_STREAM: "8:12345" }), "", "under systemd: stdout only (the journal already has it)");
});

test("register: a fresh ephemeral registration with a clean work dir; the token reaches config.sh only by env and is never printed", () => {
  const { w, env, run } = world();
  const d = join(env.AGENT_CI_ROOT, "demo/runner"); fs.mkdirSync(join(d, "_work/old"), { recursive: true });
  for (const f of ["config.sh", "run.sh"]) fs.copyFileSync(join(rel, f), join(d, f));
  fs.chmodSync(join(d, "config.sh"), 0o755); fs.writeFileSync(join(d, ".runner"), "{}");
  fs.mkdirSync(join(env.AGENT_CI_STATE, "slots"), { recursive: true }); fs.writeFileSync(join(env.AGENT_CI_STATE, "slots/demo"), "1");
  // as the unit does: WorkingDirectory is the runner dir, which register replaces
  fs.writeFileSync(env.CALLS, "");
  const r0 = spawnSync("python3", [tool, "register", "demo"], { encoding: "utf8", env, cwd: d });
  assert.equal(r0.status, 0, r0.stderr);
  const r = { ...r0, calls: fs.readFileSync(env.CALLS, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) };
  const argv = fs.readFileSync(join(d, "config-argv.txt"), "utf8").trim().split("\n");
  assert.deepEqual(argv, ["--unattended", "--ephemeral", "--replace", "--disableupdate", "--url", "https://github.com/korallis/demo",
    "--name", "testhost-demo", "--labels", "korallis-local", "--work", "_work"]);
  assert.equal(fs.readFileSync(join(d, "config-env.txt"), "utf8").trim(), "token-in-env");
  assert.ok(!(r.stdout + r.stderr).includes(TOKEN), "the token is redacted from config.sh's output"); assert.match(r.stdout, /configured with \*\*\*/);
  assert.ok(!fs.existsSync(join(d, "_work")) && !fs.existsSync(join(d, ".runner")) && !fs.existsSync(join(env.AGENT_CI_STATE, "slots/demo")));
  assert.equal(r.calls.find((c) => c.tool === "gh").home, os.userInfo().homedir, "gh uses the real home's login, not the runner's HOME");
  assert.ok(fs.existsSync(join(w, "runners/demo/home")) && fs.existsSync(join(w, "runners/demo/toolcache")));
});

test("register: nothing a job wrote reaches the next one: the runner is re-extracted, home and tool cache wiped (unless kept)", () => {
  const { env, run } = world();
  const r0 = join(env.AGENT_CI_ROOT, "demo");
  const plant = () => {
    for (const [f, c] of [["runner/run.sh", "#!/bin/sh\necho tampered\n"], ["runner/bin/evil", "x"], ["home/.npmrc", "registry=https://evil.test/"], ["toolcache/node/bin/node", "fake"]]) {
      fs.mkdirSync(dirname(join(r0, f)), { recursive: true }); fs.writeFileSync(join(r0, f), c);
    }
  };
  plant();
  assert.equal(run("register", "demo").status, 0);
  assert.equal(fs.readFileSync(join(r0, "runner/run.sh"), "utf8"), fs.readFileSync(join(rel, "run.sh"), "utf8"), "the runner is the verified release again");
  for (const f of ["runner/bin/evil", "home/.npmrc", "toolcache/node/bin/node"]) assert.ok(!fs.existsSync(join(r0, f)), f);
  assert.deepEqual(fs.readdirSync(join(r0, "home")), []); assert.deepEqual(fs.readdirSync(join(r0, "toolcache")), []);
  fs.mkdirSync(dirname(env.AGENT_CI_CONFIG), { recursive: true }); fs.writeFileSync(env.AGENT_CI_CONFIG, "AGENT_CI_KEEP_CACHE=1\n");
  plant();
  assert.equal(run("register", "demo").status, 0);
  assert.ok(fs.existsSync(join(r0, "home/.npmrc")) && fs.existsSync(join(r0, "toolcache/node/bin/node")), "AGENT_CI_KEEP_CACHE=1 keeps home and tool cache");
  assert.ok(!fs.existsSync(join(r0, "runner/bin/evil")), "the runner itself is always fresh");
  const bad = spawnSync("python3", [tool, "register", "demo"], { encoding: "utf8", env: { ...env, AGENT_CI_SHA256: "0".repeat(64) } });
  assert.equal(bad.status, 1, "a tampered or swapped release is refused at every registration"); assert.match(bad.stderr, /refusing/);
});

test("install: a checksum mismatch installs nothing; otherwise hooks and config, the unit, then CI_LOCAL=1 only once GitHub lists it online", () => {
  const bad = world(online());
  const b = spawnSync("python3", [tool, "install", "demo"], { encoding: "utf8", env: { ...bad.env, AGENT_CI_SHA256: "0".repeat(64) } });
  assert.equal(b.status, 1); assert.match(b.stderr, /checksum .* is not the pinned 0{64}; refusing/);
  assert.ok(!fs.existsSync(join(bad.env.AGENT_CI_ROOT, "demo")));
  const { env, run, scenario } = world({ ...online(), active: "inactive" });
  const r = run("install", "demo");
  assert.equal(r.status, 0, r.stderr);
  const sys = r.calls.filter((c) => c.tool === "systemctl").map((c) => c.argv.join(" "));
  assert.deepEqual(sys, ["--user daemon-reload", "--user enable agent-ci-runner@demo.service", "--user is-active agent-ci-runner@demo.service",
    "--user start agent-ci-runner@demo.service"]);
  assert.equal(scenario().vars.demo, "1");
  const last = r.calls.filter((c) => c.tool === "gh").at(-1).argv.join(" ");
  assert.equal(last, "variable set CI_LOCAL --body 1 --repo korallis/demo", "CI_LOCAL is set last, after the runner is online");
  const shared = join(env.AGENT_CI_ROOT, "_shared");
  assert.equal(fs.readFileSync(join(shared, "job-started.sh"), "utf8"), '#!/usr/bin/env bash\nexec "$(dirname "$0")/ci-runner-hook" start\n');
  assert.equal(fs.readFileSync(join(shared, "ci-runner-hook"), "utf8"), fs.readFileSync(hook, "utf8"));
  assert.equal(fs.statSync(env.AGENT_CI_CONFIG).mode & 0o777, 0o600); assert.match(fs.readFileSync(env.AGENT_CI_CONFIG, "utf8"), /^AGENT_CI_MAX_JOBS=2$/m);
  assert.equal(fs.readFileSync(join(env.AGENT_CI_ROOT, "demo/runner/.agent-ci-version"), "utf8").trim(), "2.337.0");
  const off = world({ runners: [] });
  const o = off.run("install", "demo");
  assert.equal(o.status, 1); assert.match(o.stderr, /did not all come online; CI_LOCAL left unset/); assert.equal(off.scenario().vars, undefined);
});

test("stop clears CI_LOCAL before stopping; watch leaves a paused runner alone, clears CI_LOCAL after 10 minutes down and restores it", () => {
  const { env, run, scenario, set } = world({ ...online(), vars: { demo: "1" } });
  fs.mkdirSync(join(env.AGENT_CI_ROOT, "demo/runner"), { recursive: true });
  const s = run("stop", "demo");
  const order = s.calls.map((c) => `${c.tool} ${c.argv.join(" ")}`);
  assert.ok(order.indexOf("gh variable delete CI_LOCAL --repo korallis/demo") < order.indexOf("systemctl --user stop agent-ci-runner@demo.service"), order.join("\n"));
  assert.equal(scenario().vars.demo, undefined);
  assert.equal(run("watch").calls.filter((c) => c.argv.includes("variable")).length, 0, "paused: untouched");
  fs.rmSync(join(env.AGENT_CI_STATE, "demo.paused"));
  set({ vars: { demo: "1" }, runners: [], active: "active" });
  run("watch"); assert.equal(scenario().vars.demo, "1", "first sight of a missing runner (e.g. between ephemeral jobs) changes nothing");
  const st = join(env.AGENT_CI_STATE, "watch.json"); fs.writeFileSync(st, JSON.stringify({ demo: Math.floor(Date.now() / 1000) - 601 }));
  run("watch"); assert.equal(scenario().vars.demo, undefined, "down 10 minutes: CI_LOCAL cleared");
  set(online()); run("watch"); assert.equal(scenario().vars.demo, "1", "back online: restored");
  assert.deepEqual(JSON.parse(fs.readFileSync(st, "utf8")), {});
});

test("remove clears CI_LOCAL first, disables the unit, deletes this host's runner on GitHub and its directory", () => {
  const { env, run, scenario } = world({ runners: [{ id: 7, name: "testhost-demo", status: "offline", busy: false }, { id: 8, name: "otherhost-demo", status: "online", busy: false }], vars: { demo: "1" } });
  fs.mkdirSync(join(env.AGENT_CI_ROOT, "demo/runner"), { recursive: true });
  const r = run("remove", "demo");
  assert.equal(r.status, 0, r.stderr);
  const order = r.calls.map((c) => `${c.tool} ${c.argv.join(" ")}`);
  assert.equal(order[0].startsWith("gh api repos/korallis/demo/actions/variables/CI_LOCAL"), true);
  assert.ok(order.includes("systemctl --user disable --now agent-ci-runner@demo.service"));
  assert.ok(order.includes("gh api -X DELETE repos/korallis/demo/actions/runners/7")); assert.ok(!order.some((c) => c.endsWith("/runners/8")));
  assert.equal(scenario().vars.demo, undefined); assert.ok(!fs.existsSync(join(env.AGENT_CI_ROOT, "demo")));
  assert.match(run("install", "../x").stderr, /not a repo name/);
});

test("main lane: install --main-lane gives the last runner only korallis-local-main; kept on re-install, dropped on scale-down", () => {
  const two = { runners: [{ id: 7, name: "testhost-demo", status: "online", busy: false }, { id: 9, name: "testhost-demo-2", status: "online", busy: false }] };
  const { env, run, set, scenario } = world(two);
  const labels = (i) => { const a = fs.readFileSync(join(env.AGENT_CI_ROOT, i, "runner/config-argv.txt"), "utf8").trim().split("\n"); return a[a.indexOf("--labels") + 1]; };
  assert.match(run("install", "demo", "--main-lane").stderr, /--main-lane needs --count 2/, "one runner can't be a lane");
  assert.match(run("install", "demo", "--count", "2", "--main-lane", "--dry-run").stdout, /demo_r2 takes only korallis-local-main/);
  assert.equal(run("install", "demo", "--count", "2", "--main-lane").status, 0);
  for (const i of ["demo", "demo_r2"]) assert.equal(run("register", i).status, 0);
  assert.equal(labels("demo_r2"), "korallis-local-main", "the lane runner never takes korallis-local (PR) jobs");
  assert.equal(labels("demo"), "korallis-local");
  assert.match(run("status").stdout, /demo_r2 .* main lane/);
  set(two); assert.equal(run("install", "demo").status, 0, "a plain re-install keeps the lane");
  assert.equal(run("register", "demo_r2").status, 0); assert.equal(labels("demo_r2"), "korallis-local-main");
  set(two); assert.equal(run("install", "demo", "--count", "2", "--no-main-lane").status, 0);
  assert.equal(run("register", "demo_r2").status, 0); assert.equal(labels("demo_r2"), "korallis-local");
  set(two); assert.equal(run("install", "demo", "--count", "2", "--main-lane").status, 0);
  set(two); assert.equal(run("install", "demo", "--count", "1").status, 0, "scale down");
  assert.deepEqual(JSON.parse(fs.readFileSync(join(env.AGENT_CI_STATE, "lanes.json"), "utf8")), {}, "the dropped lane runner's lane is gone");
  assert.equal(run("register", "demo").status, 0); assert.equal(labels("demo"), "korallis-local");
  // watch: with a lane, the repo is healthy only while both kinds of runner are up (main's jobs need the lane runner)
  set(two); assert.equal(run("install", "demo", "--count", "2", "--main-lane").status, 0);
  const down = () => { fs.writeFileSync(join(env.AGENT_CI_STATE, "watch.json"), JSON.stringify({ demo: 1 })); run("watch"); return scenario().vars.demo; };
  set({ runners: [two.runners[0]], vars: { demo: "1" } }); assert.equal(down(), undefined, "lane runner down: hosted");
  set({ runners: [two.runners[1]], vars: { demo: "1" } }); assert.equal(down(), undefined, "PR runner down: hosted");
  set({ ...two, vars: { demo: "1" } }); assert.equal(down(), "1");
});

test("hook updates reach ci-runners/_shared through register and install.sh --apply, by rename (never partly written)", () => {
  const { w, env, run } = world(online());
  const shared = join(env.AGENT_CI_ROOT, "_shared/ci-runner-hook");
  const hookV = (v) => { const f = join(w, `hook-${v}`); fs.writeFileSync(f, `#!/usr/bin/env bash\n# v${v}\n${"x".repeat(200000)}\n`); return f; };
  // install.sh's line, run as install.sh --apply runs it
  const line = fs.readFileSync(join(repo, "install.sh"), "utf8").split("\n").find((l) => l.includes("agent-ci-runner\" refresh-hooks"));
  assert.ok(line && line.startsWith("if [ $CHECK = 0 ]"), "install.sh --apply refreshes the hook");
  const viaInstallSh = (src) => spawnSync("bash", ["-c", `CHECK=0; S=${JSON.stringify(repo)}; todo() { echo "TODO $*"; }\n${line}`],
    { encoding: "utf8", env: { ...env, AGENT_CI_HOOK_SRC: src } });
  // no runners installed: nothing written
  const none = viaInstallSh(hookV(0)); assert.equal(none.status, 0, none.stderr); assert.match(none.stdout, /nothing to refresh/);
  assert.ok(!fs.existsSync(shared));
  assert.equal(run("install", "demo").status, 0);
  // register (before every job) delivers an updated hook
  const r = spawnSync("python3", [tool, "register", "demo"], { encoding: "utf8", env: { ...env, AGENT_CI_HOOK_SRC: hookV(1) } });
  assert.equal(r.status, 0, r.stderr); assert.equal(fs.readFileSync(shared, "utf8"), fs.readFileSync(hookV(1), "utf8"));
  // a job's bash that opened v1 keeps reading all of v1 while install.sh puts v2 in place by rename
  const fd = fs.openSync(shared, "r"); const ino = fs.statSync(shared).ino;
  const two = viaInstallSh(hookV(2)); assert.equal(two.status, 0, two.stderr); assert.match(two.stdout, /hook refreshed/);
  assert.equal(fs.readFileSync(fd, "utf8"), fs.readFileSync(hookV(1), "utf8"), "the open file is never rewritten in place"); fs.closeSync(fd);
  assert.notEqual(fs.statSync(shared).ino, ino); assert.equal(fs.readFileSync(shared, "utf8"), fs.readFileSync(hookV(2), "utf8"));
  assert.equal(fs.statSync(shared).mode & 0o777, 0o755);
  assert.deepEqual(fs.readdirSync(join(env.AGENT_CI_ROOT, "_shared")).sort(), ["bin", "ci-runner-hook", "job-completed.sh", "job-started.sh"], "no temp file left");
  // unchanged: not rewritten
  const ino2 = fs.statSync(shared).ino; assert.match(viaInstallSh(hookV(2)).stdout, /already current/); assert.equal(fs.statSync(shared).ino, ino2);
});

// the job gate
const event = (name, payload) => { const f = join(root, `event-${name}.json`); fs.writeFileSync(f, typeof payload === "string" ? payload : JSON.stringify(payload)); return f; };
const pushEvent = event("push", { ref: "refs/heads/main", repository: { full_name: "korallis/demo" } });
function gate(state, repo, mode, extra = {}) {
  const env = { PATH: "/usr/bin:/bin", AGENT_CI_REPO: repo, AGENT_CI_STATE: state, AGENT_CI_POLL_S: "0.05", AGENT_CI_NPROC: "4",
    GITHUB_REPOSITORY: "korallis/demo", GITHUB_EVENT_PATH: pushEvent,
    AGENT_CI_LOADAVG: join(state, "loadavg"), AGENT_CI_MEMINFO: join(state, "meminfo"), ...extra };
  return spawn("bash", [hook, mode], { env });
}
const done = (p) => new Promise((r) => { let out = ""; p.stdout.on("data", (b) => (out += b)); p.on("close", (code) => r({ code, out })); });
function gateState(load = "1.00", memKb = 16 * 1048576) {
  const s = fs.mkdtempSync(join(root, "gate-"));
  fs.writeFileSync(join(s, "loadavg"), `${load} 1.00 1.00 1/100 123\n`); fs.writeFileSync(join(s, "meminfo"), `MemTotal: 1 kB\nMemAvailable: ${memKb} kB\n`);
  return s;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("gate: fork code is refused before any step (fork PR, fork workflow_run, unreadable event); same-repo runs pass", async () => {
  const pr = (head) => ({ pull_request: { head: { repo: head && { full_name: head } } }, repository: { full_name: "korallis/demo" } });
  const refused = [
    ["a fork pull_request", { GITHUB_EVENT_PATH: event("fork-pr", pr("someone/demo")) }, /code from someone\/demo, not korallis\/demo/],
    ["a deleted fork's pull_request", { GITHUB_EVENT_PATH: event("gone-pr", pr(null)) }, /code from a deleted fork/],
    ["a workflow_run from a fork", { GITHUB_EVENT_PATH: event("fork-wr", { workflow_run: { head_repository: { full_name: "someone/demo" } } }) }, /code from someone\/demo/],
    ["no event file", { GITHUB_EVENT_PATH: join(root, "missing.json") }, /no readable event/],
    ["an event that is not JSON", { GITHUB_EVENT_PATH: event("junk", "not json") }, /no readable event/],
    ["no repository", { GITHUB_REPOSITORY: "" }, /no readable event for an unknown repository/],
  ];
  for (const [what, env, why] of refused) {
    const s = gateState(); const r = await done(gate(s, "a", "start", env));
    assert.equal(r.code, 1, what); assert.match(r.out, /REFUSED, fork code never runs on a local runner/, what); assert.match(r.out, why, what);
    assert.ok(!fs.existsSync(join(s, "slots", "a")), `${what}: no job slot taken`);
  }
  for (const [what, env] of [["a same-repo pull_request", { GITHUB_EVENT_PATH: event("own-pr", pr("korallis/demo")) }], ["a push", {}]]) {
    const r = await done(gate(gateState(), "a", "start", env)); assert.equal(r.code, 0, what); assert.match(r.out, /job slot taken/, what);
  }
});

test("gate: at most AGENT_CI_MAX_JOBS jobs at once across repos; a slot frees on job end", async () => {
  const s = gateState();
  for (const r of ["a", "b"]) assert.equal((await done(gate(s, r, "start"))).code, 0);
  const third = gate(s, "c", "start"); let finished = false; done(third).then(() => (finished = true));
  await sleep(400); assert.equal(finished, false, "a third job waits while 2 slots are taken");
  assert.equal((await done(gate(s, "a", "end"))).code, 0);
  const r = await done(third); assert.equal(r.code, 0); assert.match(r.out, /c: job slot taken \(2\/2 busy/);
  assert.deepEqual(fs.readdirSync(join(s, "slots")).filter((f) => !f.startsWith(".")).sort(), ["b", "c"]);
  fs.writeFileSync(join(s, "config"), "AGENT_CI_MAX_JOBS=3\nAGENT_CI_MAX_JOBS=3; touch pwned\n");
  assert.equal((await done(gate(s, "d", "start", { AGENT_CI_CONFIG: join(s, "config") }))).code, 0, "the cap is configurable");
  assert.ok(!fs.existsSync("pwned") && !fs.existsSync(join(s, "pwned")), "config lines are parsed as NAME=number only, never run");
});

test("gate: load1 above AGENT_CI_MAX_LOAD (24) waits even on a host with CPUs to spare; the ceiling is configurable", async () => {
  const s = gateState("25.00"); const big = { AGENT_CI_NPROC: "64" };
  const p = gate(s, "a", "start", { ...big, AGENT_CI_GATE_WAIT_S: "30" }); let ok = false; const pd = done(p).then((x) => ((ok = true), x));
  await sleep(400); assert.equal(ok, false, "25 > 24 on 64 CPUs: waits");
  fs.writeFileSync(join(s, "loadavg"), "23.90 1.00 1.00 1/100 123\n"); assert.equal((await pd).code, 0);
  fs.writeFileSync(join(s, "config"), "AGENT_CI_MAX_LOAD=30\n");
  const s2 = gateState("25.00"); fs.copyFileSync(join(s, "config"), join(s2, "config"));
  const r = await done(gate(s2, "b", "start", { ...big, AGENT_CI_GATE_WAIT_S: "30", AGENT_CI_CONFIG: join(s2, "config") }));
  assert.equal(r.code, 0); assert.match(r.out, /waited 0s/);
});

test("gate: a job held by the host (load or memory) leaves a waiting marker, gone when it starts; the slot cap leaves none", async () => {
  const hot = gateState("9.50");
  const p = gate(hot, "a", "start", { AGENT_CI_GATE_WAIT_S: "1" }); const pd = done(p);
  await sleep(300);
  const mark = join(hot, "waiting", "a");
  assert.ok(fs.existsSync(mark), "held by load: marker"); assert.match(fs.readFileSync(mark, "utf8"), /^\d+ host\n$/);
  assert.equal((await pd).code, 0); assert.ok(!fs.existsSync(mark), "gone once the job starts");
  const full = gateState(); fs.mkdirSync(join(full, "slots"), { recursive: true }); for (const r of ["x", "y"]) fs.writeFileSync(join(full, "slots", r), String(Math.floor(Date.now() / 1000)));
  const c = gate(full, "c", "start", { AGENT_CI_GATE_WAIT_S: "0" }); const cd = done(c);
  await sleep(300); assert.ok(!fs.existsSync(join(full, "waiting", "c")), "held only by the slot cap: no marker");
  c.kill(); await cd;
});

test("gate: end frees its slot under the lock, so it never races a start's stale sweep", async () => {
  const s = gateState(); assert.equal((await done(gate(s, "a", "start"))).code, 0);
  const held = done(spawn("flock", [join(s, "slots", ".lock"), "sleep", "0.6"])); await sleep(150); const t0 = Date.now();
  assert.equal((await done(gate(s, "a", "end"))).code, 0); assert.ok(Date.now() - t0 >= 300, "waited for the lock holder");
  assert.ok(!fs.existsSync(join(s, "slots", "a"))); await held;
});

test("gate: a hot or memory-starved host waits, up to the gate wait; the slot cap still holds after it; stale slots clear", async () => {
  const hot = gateState("9.50");
  const p = gate(hot, "a", "start", { AGENT_CI_GATE_WAIT_S: "1" }); const t0 = Date.now();
  const r = await done(p); assert.equal(r.code, 0); assert.ok(Date.now() - t0 >= 900, "waited for the load gate"); assert.match(r.out, /waited [1-9]\d*s/);
  const starved = gateState("0.5", 2 * 1048576);
  const q = gate(starved, "a", "start", { AGENT_CI_GATE_WAIT_S: "30" }); let ok = false; done(q).then(() => (ok = true));
  await sleep(400); assert.equal(ok, false, "2 GB free < 6 GB: waits");
  fs.writeFileSync(join(starved, "meminfo"), `MemAvailable: ${16 * 1048576} kB\n`); assert.equal((await done(q)).code, 0);
  const full = gateState("9.5");
  for (const r2 of ["a", "b"]) { fs.mkdirSync(join(full, "slots"), { recursive: true }); fs.writeFileSync(join(full, "slots", r2), "1"); }
  const c = gate(full, "c", "start", { AGENT_CI_GATE_WAIT_S: "0" }); let cd = false; done(c).then(() => (cd = true));
  await sleep(400); assert.equal(cd, false, "past the load gate the cap still holds");
  const old = (Date.now() / 1000) - 7 * 3600; fs.utimesSync(join(full, "slots/a"), old, old);
  assert.equal((await done(c)).code, 0, "a 7 h old slot is stale and cleared");
});

test("several runners per repo: <repo>_r<N> instances with their own names, units and slots; scaled up and back down", () => {
  const two = { runners: [{ id: 7, name: "testhost-demo", status: "online", busy: false }, { id: 9, name: "testhost-demo-2", status: "online", busy: false }] };
  // runner 1 is already active (it may be mid-job): install enables it but never starts it again (that would re-run its
  // register unit and wipe it under the job); the new runner 2 is started
  const { env, run, scenario, set } = world({ ...two, active: { "agent-ci-runner@demo.service": "active" } });
  const r = run("install", "demo", "--count", "2");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls.filter((c) => c.tool === "systemctl").map((c) => c.argv.join(" ")),
    ["--user daemon-reload", "--user enable agent-ci-runner@demo.service", "--user is-active agent-ci-runner@demo.service",
      "--user enable agent-ci-runner@demo_r2.service", "--user is-active agent-ci-runner@demo_r2.service", "--user start agent-ci-runner@demo_r2.service"]);
  set({ active: "active" });   // both running from here on
  assert.ok(fs.existsSync(join(env.AGENT_CI_ROOT, "demo/runner/config.sh")) && fs.existsSync(join(env.AGENT_CI_ROOT, "demo_r2/runner/config.sh")));
  assert.equal(scenario().vars.demo, "1"); assert.match(r.stdout, /2 local runner\(s\) online \(testhost-demo, testhost-demo-2\)/);
  // runner 2 registers under its own name, for the same repo, with its own slot and home
  fs.mkdirSync(join(env.AGENT_CI_STATE, "slots"), { recursive: true }); fs.writeFileSync(join(env.AGENT_CI_STATE, "slots/demo_r2"), "1"); fs.writeFileSync(join(env.AGENT_CI_STATE, "slots/demo"), "1");
  assert.equal(run("register", "demo_r2").status, 0);
  const argv = fs.readFileSync(join(env.AGENT_CI_ROOT, "demo_r2/runner/config-argv.txt"), "utf8").trim().split("\n");
  assert.equal(argv[argv.indexOf("--name") + 1], "testhost-demo-2"); assert.equal(argv[argv.indexOf("--url") + 1], "https://github.com/korallis/demo");
  assert.ok(!fs.existsSync(join(env.AGENT_CI_STATE, "slots/demo_r2")) && fs.existsSync(join(env.AGENT_CI_STATE, "slots/demo")), "only its own slot");
  // each runner gets its own E2E_PORT, stable across registrations (two browser shards collided on one port)
  assert.equal(run("register", "demo").status, 0);
  const port = (i) => fs.readFileSync(join(env.AGENT_CI_ROOT, i, "ci.env"), "utf8");
  assert.equal(port("demo_r2"), "E2E_PORT=31000\n", "registered first"); assert.equal(port("demo"), "E2E_PORT=31001\n");
  assert.equal(run("register", "demo_r2").status, 0); assert.equal(port("demo_r2"), "E2E_PORT=31000\n", "stable");
  // below the ephemeral range: an old allocation in it (471xx) moves at the next registration; a range overlapping it is refused
  const pj = join(env.AGENT_CI_STATE, "ports.json"), cur = JSON.parse(fs.readFileSync(pj, "utf8"));
  fs.writeFileSync(pj, JSON.stringify({ ...cur, demo: 47103 }));
  assert.equal(run("register", "demo").status, 0); assert.match(port("demo"), /^E2E_PORT=310\d\d\n$/, "migrated out of the ephemeral range");
  const ranges = join(env.AGENT_CI_STATE, "ephemeral"); fs.writeFileSync(ranges, "30000\t60999\n");
  const bad = spawnSync("python3", [tool, "register", "demo"], { encoding: "utf8", env: { ...env, AGENT_CI_EPHEMERAL_RANGE: ranges } });
  assert.equal(bad.status, 1); assert.match(bad.stderr, /E2E_PORT range 31000\.\.31099 overlaps the kernel's ephemeral ports 30000\.\.60999/);
  // the repo is healthy while either runner is up
  set({ runners: [two.runners[1]] }); fs.writeFileSync(join(env.AGENT_CI_STATE, "watch.json"), JSON.stringify({ demo: 0 }));
  run("watch"); assert.equal(scenario().vars.demo, "1");
  // stop covers every runner of the repo, and frees their job slots (a stopped job never reaches its completed hook)
  fs.writeFileSync(join(env.AGENT_CI_STATE, "slots/demo_r2"), "1");
  const st = run("stop", "demo");
  assert.ok(!fs.existsSync(join(env.AGENT_CI_STATE, "slots/demo_r2")));
  assert.deepEqual(st.calls.filter((c) => c.tool === "systemctl").map((c) => c.argv.join(" ")), ["--user stop agent-ci-runner@demo.service", "--user stop agent-ci-runner@demo_r2.service"]);
  // start skips an active runner (it may be mid-job; starting it would re-run its register unit) and starts the rest
  set({ ...two, active: { "agent-ci-runner@demo.service": "active" } });
  const sr = run("start", "demo"); assert.equal(sr.status, 0, sr.stderr);
  const started = sr.calls.filter((c) => c.tool === "systemctl" && c.argv.includes("start")).map((c) => c.argv.join(" "));
  assert.deepEqual(started, ["--user start agent-ci-runner@demo_r2.service"]); assert.equal(scenario().vars.demo, "1");
  // an installed runner may be mid-job: install (e.g. scaling up) never re-extracts it; register does, before each start
  fs.writeFileSync(join(env.AGENT_CI_ROOT, "demo/runner/job-in-progress"), "x");
  set(two); assert.equal(run("install", "demo", "--count", "2").status, 0);
  assert.ok(fs.existsSync(join(env.AGENT_CI_ROOT, "demo/runner/job-in-progress")), "the running runner's files are left alone");
  // back down to one: runner 2 is disabled, deleted on GitHub, and its directory removed
  set(two);
  const down = run("install", "demo", "--count", "1");
  assert.equal(down.status, 0, down.stderr);
  const order = down.calls.map((c) => `${c.tool} ${c.argv.join(" ")}`);
  assert.ok(order.includes("systemctl --user disable --now agent-ci-runner@demo_r2.service")); assert.ok(order.includes("gh api -X DELETE repos/korallis/demo/actions/runners/9"));
  assert.ok(!order.some((c) => c.endsWith("/runners/7")), "runner 1 stays");
  assert.ok(!fs.existsSync(join(env.AGENT_CI_ROOT, "demo_r2")));
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(join(env.AGENT_CI_STATE, "ports.json"), "utf8"))), ["demo"], "the dropped runner's port is freed");
  // a repo name that looks like an instance is refused
  assert.match(run("install", "demo_r2").stderr, /name a repo, not a runner instance/);
  assert.match(run("install", "demo", "--count", "9").stderr, /--count must be 1 to 8/);
});

test("network guard: register probes from inside the CI slice before every registration and fails closed", () => {
  const { w, env, run, scenario } = world({ vars: { demo: "1" } });
  const d = join(env.AGENT_CI_ROOT, "demo/runner"); fs.mkdirSync(d, { recursive: true });
  const ok = run("register", "demo");
  assert.equal(ok.status, 0, ok.stderr);
  const probe = ok.calls.find((c) => c.tool === "systemd-run");
  assert.deepEqual(probe.argv.slice(0, 8), ["--user", "--quiet", "--wait", "--pipe", "--collect", "--slice=agent-heavy-ci.slice", "-p", "PrivateUsers=yes"]);
  assert.ok(ok.calls.indexOf(probe) < ok.calls.findIndex((c) => c.tool === "gh" && c.argv.join(" ").includes("registration-token")), "probe before the token");
  assert.equal(scenario().vars.demo, "1");
  // a runner still in the old slice (its unit loaded before install.sh --apply) is outside the guard: refused too
  const { env: e0, run: r0, scenario: s0 } = world({ vars: { demo: "1" }, slice: "agent-heavy.slice" });
  fs.mkdirSync(join(e0.AGENT_CI_ROOT, "demo/runner"), { recursive: true });
  const old = r0("register", "demo");
  assert.equal(old.status, 1); assert.match(old.stderr, /agent-ci-runner@demo\.service runs in agent-heavy\.slice, not agent-heavy-ci\.slice: run install\.sh --apply/);
  assert.equal(s0().vars?.demo, undefined); assert.ok(!old.calls.some((c) => c.tool === "systemd-run"), "no probe needed");
  for (const [mode, why] of [["open", /reached a service on the host's loopback/], ["fail", /the probe failed .*Failed to start transient/],
    ["real", /reached a service on the host's loopback/]]) {
    const { env: e2, run: r2, scenario: sc2 } = world({ vars: { demo: "1" }, netguard: mode });
    fs.mkdirSync(join(e2.AGENT_CI_ROOT, "demo/runner"), { recursive: true });
    const r = r2("register", "demo");
    assert.equal(r.status, 1, mode);
    assert.match(r.stderr, why, mode);
    assert.match(r.stderr, /network guard not holding .*CI_LOCAL cleared, jobs run hosted/, mode);
    assert.equal(sc2().vars?.demo, undefined, `${mode}: CI_LOCAL cleared`);
    assert.ok(!r.calls.some((c) => c.tool === "gh" && c.argv.join(" ").includes("registration-token")), `${mode}: never registered`);
  }
  void w;
});

test("network guard: netguard-check reports, the probe's own loopback server must work, and netguard-install is root-owned and explicit", () => {
  const { run } = world({ netguard: "real" });
  const c = run("netguard-check");
  assert.equal(c.status, 1); assert.match(c.stdout, /network guard NOT holding: a job in the CI slice reached a service/);
  const { run: ok } = world();
  assert.equal(ok("netguard-check").status, 0);
  const dry = run("netguard-install", "--dry-run");
  assert.equal(dry.status, 0, dry.stderr);
  const lines = dry.stdout.trim().split("\n").filter((l) => l.startsWith("would run:"));
  // the anchor's unit is written by netguard-install itself: it runs before install.sh --apply places the units
  assert.match(dry.stdout, /^would write: \S+\/\.config\/systemd\/user\/agent-ci-netguard-anchor\.service; systemctl --user daemon-reload$/m);
  assert.match(lines[0], /^would run: sudo install -o root -g root -m 0755 \S+\/system\/ci-netguard \/usr\/local\/libexec\/agent-ci-netguard$/);
  for (const re of [/sudo install -o root -g root -m 0644 \S+agent-ci-netguard\.service \/etc\/systemd\/system\/agent-ci-netguard\.service$/,
    /sudo systemctl enable agent-ci-netguard\.timer$/, /^would run: systemctl --user enable --now agent-ci-netguard-anchor\.service$/,
    /sudo systemctl start agent-ci-netguard\.service agent-ci-netguard\.timer$/]) assert.ok(lines.some((l) => re.test(l)), String(re));
  assert.ok(lines.findIndex((l) => /anchor/.test(l)) < lines.findIndex((l) => /systemctl start agent-ci-netguard/.test(l)), "the slice exists before the table loads");
  const unit = fs.readFileSync(join(repo, "system/netguard/agent-ci-netguard.service"), "utf8");
  assert.match(unit, /^ExecStart=\/usr\/local\/libexec\/agent-ci-netguard apply @UID@$/m, "root runs its own copy, never the checkout");
  assert.match(fs.readFileSync(join(repo, "system/netguard/agent-ci-netguard.timer"), "utf8"), /^OnUnitActiveSec=30s$/m);
  const anchor = fs.readFileSync(join(repo, "system/systemd/agent-ci-netguard-anchor.service"), "utf8");
  assert.match(anchor, /^Slice=agent-heavy-ci\.slice$/m); assert.match(anchor, /^ExecStart=\/usr\/bin\/sleep infinity$/m);
});

test("network guard: the nft table (system/ci-netguard --print) touches only the CI slice and refuses the host and private ranges", () => {
  const g = join(repo, "system/ci-netguard");
  const r = spawnSync("bash", [g, "apply", "1000", "--print"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const t = r.stdout, cg = '"user.slice/user-1000.slice/user@1000.service/agent.slice/agent-heavy.slice/agent-heavy-ci.slice"';
  assert.match(t, /^table inet agent_ci\ndelete table inet agent_ci\ntable inet agent_ci \{/, "an atomic replace");
  assert.ok(t.includes(`socket cgroupv2 level 6 ${cg} ct state new ct mark set ct mark or 0x20000000`), "only the CI slice is marked");
  assert.match(t, /ct mark and 0x20000000 == 0x20000000 ip daddr \{ 10\.0\.0\.0\/8, 100\.64\.0\.0\/10, 169\.254\.0\.0\/16, 172\.16\.0\.0\/12, 192\.168\.0\.0\/16 \} reject/);
  assert.match(t, /ct mark and 0x20000000 == 0x20000000 ip6 daddr \{ fc00::\/7, fe80::\/10 \} reject/);
  const inChain = t.slice(t.indexOf("chain in"));
  const rules = inChain.split("\n").filter((l) => /^\s+iif lo/.test(l));
  assert.ok(rules.at(-2).includes("meta l4proto tcp reject with tcp reset") && rules.at(-1).includes("reject with icmpx"), "local delivery refused last");
  assert.ok(rules.some((l) => l.includes(`socket cgroupv2 level 6 ${cg} accept`)), "a job's own listeners stay reachable");
  assert.ok(rules.every((l) => l.includes("ct mark and 0x20000000 == 0x20000000")), "nothing outside the CI slice is touched");
  assert.equal(spawnSync("bash", [g, "apply", "x"], { encoding: "utf8" }).status, 2);
  assert.equal(spawnSync("bash", [g, "bogus"], { encoding: "utf8" }).status, 2);
});

test("netguard-install writes the anchor's user unit itself, before enabling it, then runs the root steps and the probe", () => {
  const { w, env } = world();
  const units = join(w, "user-units");
  fs.writeFileSync(env.CALLS, "");
  const r = spawnSync("python3", [tool, "netguard-install"], { encoding: "utf8", env: { ...env, AGENT_CI_USER_UNITS: units } });
  assert.equal(r.status, 0, r.stderr);
  const placed = join(units, "agent-ci-netguard-anchor.service");
  assert.equal(fs.readFileSync(placed, "utf8"), fs.readFileSync(join(repo, "system/systemd/agent-ci-netguard-anchor.service"), "utf8"));
  assert.equal(fs.statSync(placed).mode & 0o777, 0o644);
  const calls = fs.readFileSync(env.CALLS, "utf8").trim().split("\n").map(JSON.parse).map((c) => `${c.tool} ${Array.isArray(c.argv) ? c.argv.join(" ") : c.argv}`);
  const at = (re) => calls.findIndex((c) => re.test(c));
  assert.ok(at(/^systemctl --user daemon-reload$/) >= 0 && at(/^systemctl --user daemon-reload$/) < at(/^systemctl --user enable --now agent-ci-netguard-anchor\.service$/), calls.join("\n"));
  assert.ok(at(/^sudo install -o root -g root -m 0755 \S+\/system\/ci-netguard \/usr\/local\/libexec\/agent-ci-netguard$/) >= 0);
  assert.ok(at(/^systemctl --user enable --now agent-ci-netguard-anchor/) < at(/^sudo systemctl start agent-ci-netguard\.service/));
  assert.ok(at(/^systemd-run /) > at(/^sudo systemctl start/), "the probe runs last");
  assert.match(r.stdout, /network guard holds/);
});
