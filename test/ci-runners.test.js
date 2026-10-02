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
const stubs = join(root, "stubs"); fs.mkdirSync(stubs);
fs.writeFileSync(join(stubs, "gh"), `#!/usr/bin/env python3
import json, os, sys
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
fs.writeFileSync(join(stubs, "systemctl"), `#!/usr/bin/env python3
import json, os, sys
s = json.load(open(os.environ["GH_SCENARIO"])); a = sys.argv[1:]
open(os.environ["CALLS"], "a").write(json.dumps({"tool": "systemctl", "argv": a}) + "\\n")
if "is-active" in a: print(s.get("active", "active")); sys.exit(0 if s.get("active", "active") == "active" else 3)
`, { mode: 0o755 });
for (const t of ["logger", "notify-send"]) fs.writeFileSync(join(stubs, t), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

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

let n = 0;
function world(initial = {}) {
  const w = join(root, `w${n++}`); fs.mkdirSync(w);
  const sc = join(w, "scenario.json"); fs.writeFileSync(sc, JSON.stringify({ token: TOKEN, ...initial }));
  const env = { PATH: `${stubs}:/usr/bin:/bin`, GH_SCENARIO: sc, CALLS: join(w, "calls"), AGENT_CI_ROOT: join(w, "runners"),
    AGENT_CI_STATE: join(w, "state"), AGENT_CI_CONFIG: join(w, "config/ci-runners.env"), AGENT_CI_CACHE: join(w, "cache"),
    AGENT_CI_TARBALL: tarball, AGENT_CI_SHA256: sha, AGENT_CI_HOST: "testhost", AGENT_CI_POLL_S: "0.05", AGENT_CI_ONLINE_WAIT_S: "1" };
  const run = (...args) => { fs.writeFileSync(env.CALLS, ""); const r = spawnSync("python3", [tool, ...args], { encoding: "utf8", env });
    return { ...r, calls: fs.readFileSync(env.CALLS, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse) }; };
  const scenario = () => JSON.parse(fs.readFileSync(sc, "utf8"));
  const set = (patch) => fs.writeFileSync(sc, JSON.stringify({ ...scenario(), ...patch }));
  return { w, env, run, scenario, set };
}
const online = (name = "testhost-demo", status = "online") => ({ runners: [{ id: 7, name, status, busy: false }] });

test("the unit sandboxes the job (no home, keys or seats), bounds it inside agent-heavy.slice and gates every job", () => {
  const u = fs.readFileSync(join(repo, "system/systemd/agent-ci-runner@.service"), "utf8");
  for (const line of ["Slice=agent-heavy.slice", "PrivateUsers=yes", "ProtectHome=tmpfs", "PrivateTmp=yes", "NoNewPrivileges=yes",
    "MemoryMax=8G", "MemorySwapMax=0", "CPUQuota=800%", "CPUWeight=20", "IOWeight=20", "Restart=always",
    "ExecStartPre=+%h/.local/bin/agent-ci-runner register %i", "ExecStart=%h/.local/share/agent-stack/ci-runners/%i/runner/run.sh",
    "BindPaths=%h/.local/share/agent-stack/ci-runners/%i %h/.local/state/agent-stack/ci-runners",
    "BindReadOnlyPaths=%h/.local/share/agent-stack/ci-runners/_shared -%h/.config/agent-stack/ci-runners.env",
    "Environment=HOME=%h/.local/share/agent-stack/ci-runners/%i/home",
    "Environment=ACTIONS_RUNNER_HOOK_JOB_STARTED=%h/.local/share/agent-stack/ci-runners/_shared/job-started.sh",
    "Environment=ACTIONS_RUNNER_HOOK_JOB_COMPLETED=%h/.local/share/agent-stack/ci-runners/_shared/job-completed.sh"])
    assert.ok(u.split("\n").includes(line), line);
  assert.doesNotMatch(u, /BindPaths=.*(\.codex|\.claude|\.cli-proxy|\.config\/gh|Projects)/);
  // inside the unit plain nproc reports the CPUQuota (8 of 32 here), which would read a normal host load as overloaded
  assert.match(fs.readFileSync(hook, "utf8"), /cpus=\$\{AGENT_CI_NPROC:-\$\(nproc --all\)\}/);
  const inst = fs.readFileSync(join(repo, "install.sh"), "utf8");
  assert.match(inst, /for f in [^;]*\bagent-ci-runner\b/); assert.match(inst, /for t in [^;]*\bagent-ci-runner-watch\b/);
});

test("register: a fresh ephemeral registration with a clean work dir; the token reaches config.sh only by env and is never printed", () => {
  const { w, env, run } = world();
  const d = join(env.AGENT_CI_ROOT, "demo/runner"); fs.mkdirSync(join(d, "_work/old"), { recursive: true });
  for (const f of ["config.sh", "run.sh"]) fs.copyFileSync(join(rel, f), join(d, f));
  fs.chmodSync(join(d, "config.sh"), 0o755); fs.writeFileSync(join(d, ".runner"), "{}");
  fs.mkdirSync(join(env.AGENT_CI_STATE, "slots"), { recursive: true }); fs.writeFileSync(join(env.AGENT_CI_STATE, "slots/demo"), "1");
  const r = run("register", "demo");
  assert.equal(r.status, 0, r.stderr);
  const argv = fs.readFileSync(join(d, "config-argv.txt"), "utf8").trim().split("\n");
  assert.deepEqual(argv, ["--unattended", "--ephemeral", "--replace", "--disableupdate", "--url", "https://github.com/korallis/demo",
    "--name", "testhost-demo", "--labels", "korallis-local", "--work", "_work"]);
  assert.equal(fs.readFileSync(join(d, "config-env.txt"), "utf8").trim(), "token-in-env");
  assert.ok(!(r.stdout + r.stderr).includes(TOKEN), "the token is redacted from config.sh's output"); assert.match(r.stdout, /configured with \*\*\*/);
  assert.ok(!fs.existsSync(join(d, "_work")) && !fs.existsSync(join(d, ".runner")) && !fs.existsSync(join(env.AGENT_CI_STATE, "slots/demo")));
  assert.equal(r.calls.find((c) => c.tool === "gh").home, os.userInfo().homedir, "gh uses the real home's login, not the runner's HOME");
  assert.ok(fs.existsSync(join(w, "runners/demo/home")) && fs.existsSync(join(w, "runners/demo/toolcache")));
});

test("install: a checksum mismatch installs nothing; otherwise hooks and config, the unit, then CI_LOCAL=1 only once GitHub lists it online", () => {
  const bad = world(online());
  const b = spawnSync("python3", [tool, "install", "demo"], { encoding: "utf8", env: { ...bad.env, AGENT_CI_SHA256: "0".repeat(64) } });
  assert.equal(b.status, 1); assert.match(b.stderr, /checksum .* is not the pinned 0{64}; refusing/);
  assert.ok(!fs.existsSync(join(bad.env.AGENT_CI_ROOT, "demo")));
  const { env, run, scenario } = world(online());
  const r = run("install", "demo");
  assert.equal(r.status, 0, r.stderr);
  const sys = r.calls.filter((c) => c.tool === "systemctl").map((c) => c.argv.join(" "));
  assert.deepEqual(sys, ["--user daemon-reload", "--user enable --now agent-ci-runner@demo.service"]);
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
  assert.equal(o.status, 1); assert.match(o.stderr, /did not come online; CI_LOCAL left unset/); assert.equal(off.scenario().vars, undefined);
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

// the job gate
function gate(state, repo, mode, extra = {}) {
  const env = { PATH: "/usr/bin:/bin", AGENT_CI_REPO: repo, AGENT_CI_STATE: state, AGENT_CI_POLL_S: "0.05", AGENT_CI_NPROC: "4",
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
