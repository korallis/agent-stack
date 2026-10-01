// WO78 phase 1: rig-console, the read-only fleet console (Mission Control + Seat Matrix). Renderer, model, data cache
// (against a stub daemon), history, the neutral fixture and the CLI. Never a live daemon, never real tmux.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (f) => import(join(repo, "console/src", f));
const { Screen, frame, dump, detectDepth, to256, to16 } = await src("term.ts");
const { bigNumber, braille, fit, sparkline } = await src("draw.ts");
const { seatFromNode, derive, eventLine, isHuman } = await src("model.ts");
const { Cache, parseHeavy, parseAccounts, parseGates, MIN_INTERVAL } = await src("data.ts");
const { History } = await src("history.ts");
const { render, parseArgs } = await src("main.ts");
const fixture = JSON.parse(fs.readFileSync(join(repo, "console/fixtures/demo.json"), "utf8"));
const scratch = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "rigconsole-"));
process.on("exit", () => fs.rmSync(scratch, { recursive: true, force: true }));
const plain = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
const hist = (samples = fixture.history) => { const h = new History(null); h.samples = samples; return h; };
const st = (o = {}) => ({ view: 0, rigFocus: 0, seatFocus: [0, 0], help: false, frame: 0, note: null, ...o });
const cli = (args, env = {}) => spawnSync(process.execPath, [join(repo, "console/src/main.ts"), ...args], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: scratch, ...env }, timeout: 30_000 });

test("renderer: a second frame writes only the changed cells; a resize redraws everything", () => {
  const a = new Screen(20, 3), b = new Screen(20, 3);
  a.put(0, 0, "hello world"); b.put(0, 0, "hello there");
  const full = frame(a, null, 24);
  assert.match(full, /\x1b\[2J/); assert.ok(plain(full).includes("hello world"));
  const diff = frame(b, a, 24);
  assert.doesNotMatch(diff, /\x1b\[2J/);
  assert.equal(plain(diff), "there", "only the changed run");
  assert.ok(diff.includes("\x1b[1;7H"), "jumps straight to the first changed cell");
  assert.equal(frame(b, b, 24), "\x1b[0m", "nothing changed, nothing written but a reset");
  assert.match(frame(new Screen(21, 3), b, 24), /\x1b\[2J/, "a new size is a full redraw");
  const s = new Screen(5, 1); assert.equal(s.put(3, 0, "abcdef"), 9); assert.equal(s.lines()[0], "   ab", "clipped at the edge");
});

test("colour: truecolor, 256 and 16 fallbacks, and NO_COLOR draws glyphs only", () => {
  const s = new Screen(4, 1); s.put(0, 0, "ab", { fg: [56, 214, 196], bg: [12, 17, 32] });
  assert.match(dump(s, 24), /38;2;56;214;196/); assert.match(dump(s, 256), /38;5;\d+/); assert.match(dump(s, 16), /\x1b\[0;9\dm|;9\d|;3\d/);
  assert.doesNotMatch(dump(s, 0), /38;|48;/);
  assert.equal(detectDepth({ NO_COLOR: "1", COLORTERM: "truecolor" }), 0);
  assert.equal(detectDepth({ COLORTERM: "truecolor", TERM: "xterm" }), 24);
  assert.equal(detectDepth({ TERM: "tmux-256color" }), 256);
  assert.equal(detectDepth({ TERM: "xterm" }), 16);
  assert.equal(to256([255, 0, 0]), 196); assert.equal(to16([0, 0, 0]), 0);
});

test("draw: block digits, braille graphs, sparklines and fit stay one cell per glyph", () => {
  const s = new Screen(30, 6);
  assert.equal(bigNumber(s, 0, 0, "36", {}), 9);
  assert.deepEqual(s.lines().slice(0, 5).map((l) => l.slice(0, 9)), ["▀▀▀█ █▀▀▀", "   █ █   ", " ▀▀█ █▀▀█", "   █ █  █", "▄▄▄█ █▄▄█"]);
  const g = new Screen(4, 2);
  braille(g, { working: [0, 0, 0], blocked: [0, 0, 0], stuck: [0, 0, 0] }, 0, 0, 4, 2, [0, 2, 4, 6, 8, 8, 8, 8], { max: 8 });
  assert.ok(g.lines().join("").split("").every((ch) => ch.charCodeAt(0) >= 0x2800 && ch.charCodeAt(0) <= 0x28ff), g.lines().join("|"));
  assert.equal(g.lines()[0][3], "⣿", "full columns at the top right");
  assert.equal(sparkline([0, 4, 8], 3), "▁▅█");
  assert.equal(fit("abcdef", 4), "abc…"); assert.equal(fit("ab", 4), "ab  ");
});

test("model: daemon nodes map to working / idle / stuck / unknown / detached; owner seats as OpenRig defines them", () => {
  const n = (o) => ({ canonicalSessionName: "impl-codex-1@alpha", logicalId: "impl.codex-1", podNamespace: "impl", rigName: "alpha", runtime: "codex", model: "gpt-6.1-sol",
    lifecycleState: "running", nodeKind: "agent", contextUsage: { availability: "known", usedPercentage: 61.6 }, ...o });
  assert.equal(seatFromNode(n({ activityState: { display: "working" } })).activity, "working");
  assert.equal(seatFromNode(n({ activityState: { display: "idle" } })).activity, "idle");
  assert.deepEqual([seatFromNode(n({ activityState: { display: "idle", needsInput: { count: 1 } } })).activity, seatFromNode(n({ activityState: { display: "idle", needsInput: { count: 1 } } })).why], ["stuck", "needs input"]);
  assert.equal(seatFromNode(n({ activityState: { display: "stalled" } })).activity, "stuck");
  assert.equal(seatFromNode(n({ activityState: null, agentActivity: { state: "unknown" } })).activity, "unknown");
  assert.equal(seatFromNode(n({ lifecycleState: "detached" })).activity, "detached");
  assert.equal(seatFromNode(n({ lifecycleState: "recoverable" })).activity, "detached");
  const s = seatFromNode(n({ activityState: { display: "working" }, model: "kimi-k3[1m]", runtime: "claude-code" }));
  assert.deepEqual([s.pod, s.name, s.ctx, s.runtime, s.model], ["impl", "codex-1", 62, "km", "kimi-k3"]);
  assert.equal(seatFromNode(n({ contextUsage: { availability: "unknown" } })).ctx, null);
  assert.ok(isHuman("human@kernel") && isHuman("human-ops@host") && !isHuman("humane@alpha") && !isHuman("impl@kernel"));
});

test("model: derived counts match the fixture; blocked rows by what they wait on; only today's gate decisions count", () => {
  const f = derive(fixture.raw);
  const agents = fixture.raw.rigs.flatMap((r) => r.seats);
  assert.equal(f.count.working, agents.filter((s) => s.activity === "working").length);
  assert.equal(f.stuck.length, 2, "a stalled seat and an unknown one");
  assert.equal(f.queue.blocked, 41); assert.equal(f.queue.pending, 18); assert.equal(f.queue.inProgress, 41);
  assert.equal(f.queue.onRow + f.queue.onPr + f.queue.onOwner + f.queue.onOther, 41);
  assert.equal(f.owner.length, 3); assert.ok(f.owner[0].created <= f.owner[1].created, "oldest first");
  const raw = { ...fixture.raw, gates: [...fixture.raw.gates, { ts: "2026-09-30T23:59:00Z", decision: "merge", band: "act" }] };
  assert.equal(derive(raw).gate.total, 36, "yesterday's decision is not today's");
  assert.equal(f.rigs.find((r) => r.rig.name === "omega").health, "down");
  assert.equal(f.rigs.find((r) => r.rig.name === "beta").health, "degraded");
});

test("model: only meaningful daemon events reach the ticker", () => {
  assert.equal(eventLine({ type: "view.changed" }), null);
  assert.equal(eventLine({ type: "seat.activity_changed" }), null);
  assert.equal(eventLine({ type: "queue.updated", toState: "in-progress" }), null);
  const e = eventLine({ type: "queue.created", sourceSession: "qa-codex-2@beta", destinationSession: "impl-codex-4@beta", priority: "urgent", createdAt: "2026-10-01 14:42:28" });
  assert.deepEqual([e.kind, e.rig, e.text, e.at], ["QUEUED", "beta", "qa-codex-2 → impl-codex-4 (urgent)", "2026-10-01T14:42:28Z"]);
  assert.equal(eventLine({ type: "queue.updated", toState: "done", actorSession: "integ-codex@beta", summary: "merged" }).kind, "DONE");
});

test("sources: agent-heavy status (with or without the queue), the account pool, the gate log without diagnosis calls", () => {
  assert.deepEqual(parseHeavy("build 1/2  held  seat=x\nbuild 2/2  free\nbuild queue 1  seat=y\nbuild queue 2  seat=z\nbrowser 1/2  free\nbrowser 2/2  free\nbrowser queue  empty\n"),
    [{ cls: "build", held: 1, total: 2, waiting: 2 }, { cls: "browser", held: 0, total: 2, waiting: 0 }]);
  assert.deepEqual(parseHeavy("build 1/2  free\nbuild 2/2  free\n"), [{ cls: "build", held: 0, total: 2, waiting: 0 }]);
  assert.deepEqual(parseHeavy(null), []);
  const a = parseAccounts(JSON.stringify([{ label: "codex-a", provider: "codex", status: "active", cooldowns: [{}], short_window_used: 100, weekly_used: null }]));
  assert.deepEqual(a, [{ label: "codex-a", provider: "codex", status: "active", short: 100, weekly: null, cooling: true }]);
  assert.deepEqual(parseAccounts("not json"), []);
  const g = parseGates([JSON.stringify({ ts: "2026-10-01T10:00:00Z", decision: "review.merge_gate", band: "act", result: { decision: "merge" }, caller: "integ@x" }),
    JSON.stringify({ ts: "2026-10-01T10:01:00Z", decision: "review.merge_gate", band: "uncertain", result: { decision: "hold" }, caller: "diagnosis:qa" }),
    JSON.stringify({ ts: "2026-10-01T10:02:00Z", decision: "seat.stuck", result: {} }), "{torn"]);
  assert.deepEqual(g, [{ ts: "2026-10-01T10:00:00Z", decision: "merge", band: "act" }]);
});

// A stub daemon: records every request; one rig; queue rows; an activity stream and an event stream.
function stubDaemon({ delayMs = 0, events = [] } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, lastEventId: req.headers["last-event-id"] ?? null });
    const json = (b) => setTimeout(() => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(b)); }, delayMs);
    if (req.url === "/healthz") return json({ status: "ok", pid: process.pid, semver: "0.6.3", selfHostId: "host-stub", eventLoop: { utilization: 0.1 } });
    if (req.url === "/api/rigs/summary") return json([{ id: "R1", name: "alpha", lifecycleState: "running" }, { id: "R0", name: "old", archivedAt: "x" }]);
    if (req.url.startsWith("/api/rigs/R1/nodes")) return json([{ canonicalSessionName: "impl-codex-1@alpha", logicalId: "impl.codex-1", podNamespace: "impl", rigName: "alpha", runtime: "codex", lifecycleState: "running", nodeKind: "agent", activityState: { display: "working" } }]);
    if (req.url.startsWith("/api/queue/list")) return json(req.url.includes("attention=1") ? [] : [{ qitemId: "q1", state: "blocked", blockedOn: "qitem-x", destinationSession: "impl-codex-1@alpha", tags: [], tsCreated: "2026-10-01T10:00:00Z", tsUpdated: "2026-10-01T10:00:00Z" }]);
    if (req.url === "/api/activity/events") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(`event: seat.activity_changed\ndata: ${JSON.stringify({ type: "seat.activity_changed", seq: 500 })}\n\n`); return; }
    if (req.url === "/api/events") { res.writeHead(200, { "content-type": "text/event-stream" }); for (const e of events) res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`); return; }
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${server.address().port}`, seen, close: () => { server.closeAllConnections(); server.close(); } })));
}

test("cache: one read of every daemon source, never the per-seat capture options; archived rigs skipped; local sources by name", async () => {
  const d = await stubDaemon(), ran = [];
  const c = new Cache({ url: d.url, interval: 1000, events: false, run: async (cmd, args) => { ran.push([cmd, ...args].join(" ")); return null; } });
  try {
    await c.tick();
    assert.equal(c.interval, MIN_INTERVAL, "never under 2 s, whatever was asked");
    assert.deepEqual(d.seen.map((x) => x.url), ["/healthz", "/api/rigs/summary", "/api/rigs/R1/nodes", "/api/queue/list?compact=1&state=pending,in-progress,blocked&limit=5000", "/api/queue/list?compact=1&attention=1&limit=200"]);
    assert.ok(d.seen.every((x) => !/full=true|refresh=true/.test(x.url)), "no tmux capture asked of the daemon");
    assert.deepEqual(ran, ["agent-proxy-status --json", "agent-heavy status"], "local sources, by name: never tmux");
    assert.equal(c.raw.rigs.length, 1); assert.equal(c.raw.rigs[0].seats[0].activity, "working"); assert.equal(c.raw.queue[0].blockedOn, "qitem-x");
    assert.equal(c.raw.daemon.ok, true); assert.equal(c.raw.host.id, "host-stub");
  } finally { c.stop(); d.close(); }
});

test("cache: tiers: seats every tick; the rig list every 60 s and the queue every 30 s unless an event says they changed", async () => {
  let now = 0;
  const d = await stubDaemon();
  const c = new Cache({ url: d.url, interval: 5000, events: false, run: async () => null, now: () => now });
  const urls = () => { const u = d.seen.map((x) => x.url.split("?")[0] + (x.url.includes("attention=1") ? "?attention" : "")); d.seen.length = 0; return u; };
  try {
    await c.tick(); assert.equal(urls().length, 5, "everything on the first read");
    now = 5000; await c.tick(); assert.deepEqual(urls(), ["/healthz", "/api/rigs/R1/nodes"]);
    now = 30_000; await c.tick(); assert.deepEqual(urls(), ["/healthz", "/api/rigs/R1/nodes", "/api/queue/list", "/api/queue/list?attention"]);
    now = 35_000; c.dirty.queue = true; await c.tick(); assert.deepEqual(urls(), ["/healthz", "/api/rigs/R1/nodes", "/api/queue/list", "/api/queue/list?attention"], "a queue event");
    now = 40_000; c.dirty.rigs = true; await c.tick(); assert.deepEqual(urls(), ["/healthz", "/api/rigs/summary", "/api/rigs/R1/nodes"], "a node event");
    now = 60_000; await c.tick(); assert.deepEqual(urls(), ["/healthz", "/api/rigs/R1/nodes"], "20 s after the event-driven read: nothing else");
    now = 100_000; await c.tick(); assert.equal(urls().length, 5, "60 s after the last rig-list read, 65 s after the last queue read");
  } finally { c.stop(); d.close(); }
});

test("cache: a slow or failing daemon doubles the interval (to 60 s at most); a fast read brings it back", async () => {
  let now = 0;
  const d = await stubDaemon();
  const c = new Cache({ url: d.url, interval: 5000, events: false, run: async () => null, now: () => now });
  try {
    const slow = c.readDaemon.bind(c);
    c.readDaemon = async () => { now += 2000; return slow(); };            // every read "takes" 2 s
    await c.tick(); assert.equal(c.interval, 10_000);
    await c.tick(); assert.equal(c.interval, 20_000);
    c.readDaemon = slow;                                                    // fast again
    await c.tick(); assert.equal(c.interval, 10_000);
    await c.tick(); assert.equal(c.interval, 5000);
    await c.tick(); assert.equal(c.interval, 5000, "never below the chosen interval");
    c.readDaemon = async () => { throw new Error("connect ECONNREFUSED"); };
    for (let i = 0; i < 6; i++) await c.tick();
    assert.equal(c.interval, 60_000); assert.equal(c.raw.daemon.ok, false); assert.match(c.raw.daemon.error, /ECONNREFUSED/);
    assert.equal(c.raw.rigs.length, 1, "the last good data stays on screen");
  } finally { c.stop(); d.close(); }
});

test("events: joins /api/events just behind a live seq from the activity stream (never a full replay); queue events reach the ticker", async () => {
  const d = await stubDaemon({ events: [{ type: "view.changed", seq: 301 }, { type: "queue.created", seq: 302, sourceSession: "qa-1@alpha", destinationSession: "impl-1@alpha", priority: "routine", createdAt: "2026-10-01 10:00:00" }] });
  const c = new Cache({ url: d.url, interval: 60_000, events: true, run: async () => null });
  try {
    c.start();
    const t0 = Date.now();
    while (!c.raw.events.length && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 25));
    const ev = d.seen.filter((x) => x.url === "/api/events");
    assert.ok(ev.length >= 1); assert.equal(ev[0].lastEventId, "300", "200 events behind the live seq 500");
    assert.equal(c.raw.events.length, 1); assert.equal(c.raw.events[0].kind, "QUEUED");
  } finally { c.stop(); d.close(); }
});

test("history: one sample a minute, 24 h kept, shared safely through the file; series by bucket", () => {
  const file = join(scratch, "h", "history.json");
  const h = new History(file), s = (t, working) => ({ t, working, idle: 0, stuck: 0, pending: 0, inProgress: 0, blocked: 0, gateToday: 0 });
  assert.equal(h.add(s(0, 1)), true); assert.equal(h.add(s(30_000, 2)), false, "too soon");
  assert.equal(h.add(s(60_000, 3)), true);
  const other = new History(file); assert.equal(other.samples.length, 2);
  other.add(s(120_000, 4)); h.add(s(180_000, 5));
  assert.deepEqual(new History(file).samples.map((x) => x.working), [1, 3, 4, 5], "two writers merged by minute");
  for (let m = 4; m < 1500; m++) h.add(s(m * 60_000, m));
  assert.ok(h.samples.length <= 1440 && h.samples[0].t >= 1499 * 60_000 - 1440 * 60_000);
  const series = h.series("working", 24, 1500 * 60_000);
  assert.equal(series.length, 24); assert.ok(series[23] > series[0]);
});

test("views: Mission Control and the Seat Matrix from the fixture, at 176×50 and 120×40; too small says so", () => {
  for (const [w, h] of [[176, 50], [120, 40]]) {
    const home = render(fixture.raw, hist(), w, h, st()).lines();
    assert.equal(home.length, h); assert.ok(home.every((l) => [...l].length === w));
    const text = home.join("\n");
    // narrow tiles shorten their titles (OWNER, GATE) and show plain figures instead of block digits
    for (const s of ["MISSION CONTROL", "WORKING", "IDLE", "STUCK", "BLOCKED", w >= 176 ? "OWNER DECISIONS" : "OWNER", w >= 176 ? "GATE TODAY" : "GATE", "WORK IN FLIGHT", "◀◀ LIVE"]) assert.ok(text.includes(s), `${w}: ${s}`);
    assert.equal(text.includes("█▀▀▀"), w >= 176, `${w}: block digits only on wide tiles`);
    for (const rig of ["kernel", "alpha", "beta", "gamma", "pair", "omega"]) assert.ok(text.includes(rig), `${w}: rig card ${rig}`);
    const m = render(fixture.raw, hist(), w, h, st({ view: 1, seatFocus: [3, 10] })).lines().join("\n");
    for (const s of ["SEAT MATRIX", "CTX shade", "EXCEPTIONS", "SELECTED impl-codex-5@gamma", "stalled"]) assert.ok(m.includes(s), `${w}: ${s}`);
  }
  const wide = render(fixture.raw, hist(), 176, 50, st({ view: 1 })).lines().join("\n");
  assert.ok(wide.includes("24H TELEMETRY") && wide.includes("SUBSCRIPTION POOL"), "both side panels at 176");
  const narrow = render(fixture.raw, hist(), 120, 40, st({ view: 1 })).lines().join("\n");
  assert.ok(!narrow.includes("SUBSCRIPTION POOL"), "the side panels give way at 120");
  assert.match(render(fixture.raw, hist(), 90, 30, st()).lines().join("\n"), /needs at least 100×30; this terminal is 90×30/);
  assert.match(render(fixture.raw, hist(), 176, 50, st({ help: true })).lines().join("\n"), /HELP[\s\S]*never polls tmux/);
});

test("CLI: --once draws one frame from the fixture; strict arguments; the fixture is neutral", () => {
  const r = cli(["--once", "--fixture", join(repo, "console/fixtures/demo.json"), "--size", "176x50", "--color", "0"]);
  assert.equal(r.status, 0, r.stderr);
  const lines = plain(r.stdout).split("\n").filter((l, i, a) => i < a.length - 1);
  assert.equal(lines.length, 50); assert.ok(lines.every((l) => [...l].length === 176));
  assert.match(r.stdout, /MISSION CONTROL/); assert.doesNotMatch(r.stdout, /38;2;/, "monochrome has no colour");
  for (const bad of [["--bogus"], ["--interval", "1"], ["--view", "river"], ["--color", "8"], ["--size", "big"], ["--interval"]]) {
    const x = cli(bad); assert.equal(x.status, 2, bad.join(" ")); assert.match(x.stderr, /rig-console: /);
  }
  assert.deepEqual(parseArgs([], { OPENRIG_PORT: "47431" }).url, "http://127.0.0.1:47431");
  assert.equal(parseArgs(["--url", "http://h:1/"], {}).url, "http://h:1");
  const text = fs.readFileSync(join(repo, "console/fixtures/demo.json"), "utf8");
  assert.doesNotMatch(text, /\/home\/|\/Users\/|github\.com|@[a-z]+\.(com|io|dev)\b/i, "no paths, links or addresses");
});

test("CLI: a live --once frame against a stub daemon runs no tmux (a tmux on PATH would record the call)", async () => {
  const d = await stubDaemon(), bin = join(scratch, "bin"), log = join(scratch, "tmux.log");
  fs.mkdirSync(bin, { recursive: true });
  for (const t of ["tmux", "agent-proxy-status", "agent-heavy"]) fs.writeFileSync(join(bin, t), `#!/bin/sh\necho "${t} $*" >> ${log}\n`, { mode: 0o755 });
  try {
    const r = await new Promise((res) => {
      const p = spawn(process.execPath, [join(repo, "console/src/main.ts"), "--once", "--size", "120x40", "--color", "0", "--url", d.url],
        { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: scratch, AGENT_STACK_STATE: join(scratch, "state") } });
      let out = ""; p.stdout.on("data", (b) => (out += b)); p.on("exit", (code) => res({ code, out }));
    });
    assert.equal(r.code, 0);
    assert.match(plain(r.out), /alpha/);
    const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "";
    assert.doesNotMatch(calls, /^tmux/m, "never tmux");
    assert.match(calls, /^agent-proxy-status --json$/m); assert.match(calls, /^agent-heavy status$/m);
    assert.ok(fs.existsSync(join(scratch, "state/rig-console/history.json")), "the first sample is kept");
  } finally { d.close(); }
});

test("install.sh installs rig-console as a launcher on the pinned Node, like the other Node tools", () => {
  const install = fs.readFileSync(join(repo, "install.sh"), "utf8");
  assert.match(install, /launcher rig-console "\$NODE_FOR_JEV" "\$S\/console\/src\/main\.ts"/);
});
