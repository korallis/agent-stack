// WO81: agent-heavy waiters queue first come, first served (a freed slot went to whichever waiter polled first, so an
// urgent QA run waited ~20 min while newer jobs won), with an optional priority lane that only orders the queue.
// Real processes and real flock in an isolated AGENT_HEAVY_DIR; no systemd user session (the stub systemctl says so),
// so jobs run under timeout(1) with the slot and the max runtime.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const heavyBin = join(repo, "bin/agent-heavy");
const root = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "heavyq-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const bin = join(root, "bin");
fs.mkdirSync(bin);
fs.writeFileSync(join(bin, "systemctl"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
fs.writeFileSync(join(bin, "logger"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

let n = 0;
function lab() {
  const d = join(root, `lab${++n}`); fs.mkdirSync(d);
  const env = { PATH: `${bin}:/usr/bin:/bin`, USER: "t", AGENT_HEAVY_DIR: join(d, "heavy"), AGENT_HEAVY_BUILD_SLOTS: "1",
    AGENT_HEAVY_BROWSER_SLOTS: "1", AGENT_HEAVY_POLL: "0.1" };
  const order = join(d, "order");
  const kids = [], names = new Set(["A"]);
  // a job that records its name, then (if asked) holds its slot until released
  const job = (name, hold = false) => ["bash", "-c", `echo ${name} >> ${order}; ${hold ? `while [ ! -f ${d}/release-${name} ]; do sleep 0.05; done` : ""}`];
  const run = (name, { hold = false, args = [], env: extra = {}, seat = name } = {}) => {
    const p = spawn(heavyBin, ["build", ...args, "--", ...job(name, hold)], { env: { ...env, OPENRIG_SESSION_NAME: `${seat}@lab`, ...extra } });
    let err = ""; p.stderr.on("data", (b) => (err += b));
    const done = new Promise((r) => p.on("exit", (code) => r({ code, err })));
    kids.push(p); names.add(name);
    return { p, done };
  };
  const tickets = () => (fs.existsSync(join(env.AGENT_HEAVY_DIR, "queue.build")) ? fs.readdirSync(join(env.AGENT_HEAVY_DIR, "queue.build")).filter((f) => f.endsWith(".ticket")).sort() : []);
  const ran = () => (fs.existsSync(order) ? fs.readFileSync(order, "utf8").split("\n").filter(Boolean) : []);
  const release = (name) => fs.writeFileSync(join(d, `release-${name}`), "");
  const status = () => spawnSync(heavyBin, ["status", "build"], { env, encoding: "utf8" });
  // On a failure, release every held job (timeout(1) runs it in its own process group, so killing agent-heavy alone
  // would leave it holding the test's stderr pipe and the runner) and then kill the waiters.
  const stop = () => { names.forEach((x) => fs.writeFileSync(join(d, `release-${x}`), "")); kids.forEach((k) => { try { k.kill("SIGKILL"); } catch {} }); };
  return { d, env, run, tickets, ran, release, status, stop };
}
const until = async (cond, what, ms = 10000) => {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 25)); }
};

test("FIFO: with one slot, waiters run in arrival order, never a newer one first", async () => {
  const L = lab();
  try {
    const a = L.run("A", { hold: true });
    await until(() => L.ran().includes("A"), "A running");
    const ws = [];
    for (const [i, name] of ["B", "C", "D", "E"].entries()) {
      ws.push(L.run(name).done);
      await until(() => L.tickets().length === i + 1, `${name}'s ticket`);
    }
    // all four poll the free-slot check every 0.1s while A holds the slot; none takes it
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(L.ran(), ["A"]);
    L.release("A");
    const rs = await Promise.all([a.done, ...ws]);
    assert.deepEqual(rs.map((r) => r.code), [0, 0, 0, 0, 0]);
    assert.deepEqual(L.ran(), ["A", "B", "C", "D", "E"]);
    assert.match(rs[1].err, /waiting for a build slot: position 1 of 1 \(routine\); see agent-heavy status/);
    assert.match(rs[4].err, /position 4 of 4/);
    assert.deepEqual(L.tickets(), [], "every ticket is gone");
  } finally { L.stop(); }
});

test("priority: critical, then urgent, then routine; first come first served within a lane; never preempts the running job", async () => {
  const L = lab();
  try {
    const a = L.run("A", { hold: true });
    await until(() => L.ran().includes("A"), "A running");
    const ws = [];
    for (const [i, [name, opt]] of [["R1", {}], ["U1", { args: ["--priority", "urgent"] }], ["R2", {}], ["C1", { env: { AGENT_HEAVY_PRIORITY: "critical" } }],
      ["U2", { args: ["--priority", "urgent"] }]].entries()) {
      ws.push(L.run(name, opt).done);
      await until(() => L.tickets().length === i + 1, `${name}'s ticket`);
    }
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(L.ran(), ["A"], "a critical waiter does not stop the running job");
    const s = L.status();
    assert.equal(s.status, 0);
    const q = s.stdout.split("\n").filter((l) => / queue /.test(l));
    assert.deepEqual(q.map((l) => l.match(/seat=(\S+)/)[1]), ["C1@lab", "U1@lab", "U2@lab", "R1@lab", "R2@lab"]);
    assert.match(q[0], /^build queue 1  seat=C1@lab  priority=critical  waiting=0m0\ds  pid=\d+  cwd=\S+  cmd=bash -c echo C1/);
    assert.match(q[3], /^build queue 4  seat=R1@lab  priority=routine /);
    L.release("A");
    await Promise.all([a.done, ...ws]);
    assert.deepEqual(L.ran(), ["A", "C1", "U1", "U2", "R1", "R2"]);
  } finally { L.stop(); }
});

test("a dead waiter's ticket (pid gone, or pid reused by another process) is skipped and removed; status only reads", async () => {
  const L = lab();
  try {
    const a = L.run("A", { hold: true });
    await until(() => L.ran().includes("A"), "A running");
    const q = join(L.env.AGENT_HEAVY_DIR, "queue.build");
    const dead = spawnSync("bash", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim();   // exited: its pid is free
    const old = String(Date.now() * 1e6 - 60e9).padStart(20, "0");                          // a minute before anyone
    fs.writeFileSync(join(q, `0-${old}-${dead}.ticket`), `pid=${dead}\npstart=1\nseat=gone@lab\npriority=critical\narrived=1\ncwd=/\ncmd=x\n`);
    // a live pid with another start time: the waiter that wrote it is gone and the pid now names another process
    fs.writeFileSync(join(q, `0-${old}-${process.pid}.ticket`), `pid=${process.pid}\npstart=1\nseat=reused@lab\npriority=critical\narrived=1\ncwd=/\ncmd=x\n`);
    const s = L.status();
    assert.doesNotMatch(s.stdout, /gone@lab|reused@lab/, "dead tickets are not listed");
    assert.equal(L.tickets().length, 2, "status removes nothing");
    const b = L.run("B");
    await until(() => L.tickets().length === 1, "dead tickets cleaned by the waiter");
    L.release("A");
    assert.equal((await b.done).code, 0); await a.done;
    assert.deepEqual(L.ran(), ["A", "B"]);
  } finally { L.stop(); }
});

test("a waiter killed while queued doesn't block the next one", async () => {
  const L = lab();
  try {
    const a = L.run("A", { hold: true });
    await until(() => L.ran().includes("A"), "A running");
    const b = L.run("B"); await until(() => L.tickets().length === 1, "B queued");
    const c = L.run("C"); await until(() => L.tickets().length === 2, "C queued");
    b.p.kill("SIGKILL"); await b.done;
    L.release("A");
    assert.equal((await c.done).code, 0); await a.done;
    assert.deepEqual(L.ran(), ["A", "C"]);
    assert.deepEqual(L.tickets(), []);
  } finally { L.stop(); }
});

test("--wait still gives up with exit 75 and leaves no ticket; a bad priority is a usage error before queueing", async () => {
  const L = lab();
  try {
    const a = L.run("A", { hold: true });
    await until(() => L.ran().includes("A"), "A running");
    const r = spawnSync(heavyBin, ["build", "--wait", "1", "--", "true"], { env: L.env, encoding: "utf8" });
    assert.equal(r.status, 75); assert.match(r.stderr, /no build slot free within 1s/);
    assert.deepEqual(L.tickets(), []);
    for (const bad of [["--priority", "high"], ["--priority", ""]]) {
      const x = spawnSync(heavyBin, ["build", ...bad, "--", "true"], { env: L.env, encoding: "utf8" });
      assert.equal(x.status, 2); assert.match(x.stderr, /bad priority/);
    }
    const y = spawnSync(heavyBin, ["build", "--", "true"], { env: { ...L.env, AGENT_HEAVY_PRIORITY: "asap" }, encoding: "utf8" });
    assert.equal(y.status, 2);
    L.release("A"); await a.done;
  } finally { L.stop(); }
});

test("a nested same-class call still runs inline while others queue: no ticket, no deadlock", async () => {
  const L = lab();
  try {
    const order = join(L.d, "order");
    const outer = spawn(heavyBin, ["build", "--", "bash", "-c",
      `echo A >> ${order}; while [ ! -f ${L.d}/release-A ]; do sleep 0.05; done; ${heavyBin} build -- bash -c 'echo nested >> ${order}'`],
      { env: { ...L.env, OPENRIG_SESSION_NAME: "A@lab" } });
    const outerDone = new Promise((r) => outer.on("exit", r));
    await until(() => L.ran().includes("A"), "A running");
    const b = L.run("B"); await until(() => L.tickets().length === 1, "B queued");
    L.release("A");
    assert.equal(await outerDone, 0);
    assert.equal((await b.done).code, 0);
    assert.deepEqual(L.ran(), ["A", "nested", "B"]);
  } finally { L.stop(); }
});

test("status: an empty queue says so; the docs name the order and the priority lane", () => {
  const L = lab();
  assert.match(L.status().stdout, /^build queue  empty$/m);
  const src = fs.readFileSync(heavyBin, "utf8");
  assert.match(src, /--priority urgent\|critical \(or AGENT_HEAVY_PRIORITY\) sorts ahead of routine/);
  assert.match(src, /never stops or preempts a running job/);
});

test("QA PR85: the resolved priority (flag over env) is the lane of nested calls, also through an inline same-class call", async () => {
  for (const [label, parentArgs, parentEnv, nestedFirst] of [
    ["flag urgent", ["--priority", "urgent"], {}, true],
    ["flag routine over env critical", ["--priority", "routine"], { AGENT_HEAVY_PRIORITY: "critical" }, false],
    ["env urgent", [], { AGENT_HEAVY_PRIORITY: "urgent" }, true]]) {
    const L = lab();
    const order = join(L.d, "order"), kids = [];
    const go = (args, env = {}) => { const p = spawn(heavyBin, args, { env: { ...L.env, ...env } }); kids.push(p); let err = ""; p.stderr.on("data", (b) => (err += b)); return new Promise((r) => p.on("exit", (code) => r({ code, err }))); };
    const bq = () => (fs.existsSync(join(L.env.AGENT_HEAVY_DIR, "queue.browser")) ? fs.readdirSync(join(L.env.AGENT_HEAVY_DIR, "queue.browser")).filter((f) => f.endsWith(".ticket")) : []);
    try {
      // the one browser slot is held; an older routine browser waiter queues first
      const holder = go(["browser", "--", "bash", "-c", `echo H >> ${order}; while [ ! -f ${L.d}/release-H ]; do sleep 0.05; done`]);
      await until(() => L.ran().includes("H"), `${label}: holder running`);
      const older = go(["browser", "--", "bash", "-c", `echo older >> ${order}`], { AGENT_HEAVY_PRIORITY: "routine" });
      await until(() => bq().length === 1, `${label}: older waiter queued`);
      // the parent build calls a nested build (inline) that calls a browser job
      const parent = go(["build", ...parentArgs, "--", heavyBin, "build", "--", heavyBin, "browser", "--", "bash", "-c", `echo nested >> ${order}`], parentEnv);
      await until(() => bq().length === 2, `${label}: nested browser queued`);
      const lanes = bq().map((f) => fs.readFileSync(join(L.env.AGENT_HEAVY_DIR, "queue.browser", f), "utf8").match(/^priority=(\w+)$/m)[1]).sort();
      assert.deepEqual(lanes, nestedFirst ? ["routine", "urgent"] : ["routine", "routine"], label);
      fs.writeFileSync(join(L.d, "release-H"), "");
      const rs = await Promise.all([holder, older, parent]);
      assert.deepEqual(rs.map((r) => r.code), [0, 0, 0], label);
      assert.match(rs[2].err, /nested build run: already inside build\.1; running inline/, label);
      assert.deepEqual(L.ran(), nestedFirst ? ["H", "nested", "older"] : ["H", "older", "nested"], label);
    } finally { fs.writeFileSync(join(L.d, "release-H"), ""); kids.forEach((k) => { try { k.kill("SIGKILL"); } catch {} }); }
  }
});
