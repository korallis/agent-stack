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
const { seatFromNode, derive, eventLine, isHuman, classify } = await src("model.ts");
const { Cache, parseHeavy, parseAccounts, parseGates, MIN_INTERVAL } = await src("data.ts");
const { History } = await src("history.ts");
const { render, parseArgs } = await src("main.ts");
const await_grid = await src("views/matrix.ts");
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
  // phase 4: stuck is derived (classify); the raw signal alone is "unknown, not stuck"
  const fc = derive(classify(fixture.raw));
  assert.deepEqual([fc.stuck.map((s) => s.session), fc.unknown.map((s) => s.session)], [["impl-codex-5@gamma"], ["tests-codex@beta"]]);
  const n = (st) => fixture.raw.queue.filter((r) => r.state === st).length;
  assert.deepEqual([f.queue.blocked, f.queue.pending, f.queue.inProgress], [n("blocked"), n("pending"), n("in-progress")]);
  assert.ok(f.queue.blocked > 30, "the fixture has a real backlog");
  assert.equal(f.queue.onRow + f.queue.onPr + f.queue.onOwner + f.queue.onOther, f.queue.blocked);
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
  // the proxy's JSON (as agent-proxy-status --json prints it): strings; Anthropic fractions, Codex percents
  const a = parseAccounts(JSON.stringify([{ label: "codex-a", provider: "codex", status: "active", cooldowns: [{}], short_window_used: "100", weekly_used: "0" },
    { label: "claude-a", provider: "claude", status: "active", cooldowns: [], short_window_used: "0.29", weekly_used: "0.79" },
    { label: "claude-b", provider: "claude", status: "active", cooldowns: [], short_window_used: "1.01", weekly_used: "0.85" },
    { label: "kimi-a", provider: "kimi-ai", status: "active", short_window_used: null, weekly_used: null }]));
  assert.deepEqual(a.map((x) => [x.label, x.short, x.weekly, x.cooling]), [["codex-a", 100, 0, true], ["claude-a", 29, 79, false], ["claude-b", 101, 85, false], ["kimi-a", null, null, false]]);
  assert.deepEqual(parseAccounts("not json"), []);
  const g = parseGates([JSON.stringify({ ts: "2026-10-01T10:00:00Z", decision: "review.merge_gate", band: "act", result: { decision: "merge" }, caller: "integ@x" }),
    JSON.stringify({ ts: "2026-10-01T10:01:00Z", decision: "review.merge_gate", band: "uncertain", result: { decision: "hold" }, caller: "diagnosis:qa" }),
    JSON.stringify({ ts: "2026-10-01T10:01:30Z", decision: "review.merge_gate", band: "act", result: { decision: "merge" }, caller: "operator@kernel diagnosis pr#61 helper-old (not a merge gate)" }),
    JSON.stringify({ ts: "2026-10-01T10:02:00Z", decision: "seat.stuck", result: {} }), "{torn"]);
  assert.deepEqual(g, [{ ts: "2026-10-01T10:00:00Z", decision: "merge", band: "act" }]);
});

// A stub daemon: records every request; one rig; queue rows; an activity stream and an event stream.
function stubDaemon({ delayMs = 0, events = [], transitions = [], eventDelayMs = 0 } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, lastEventId: req.headers["last-event-id"] ?? null });
    const json = (b) => setTimeout(() => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(b)); }, delayMs);
    if (req.url === "/healthz") return json({ status: "ok", pid: process.pid, semver: "0.6.3", selfHostId: "host-stub", eventLoop: { utilization: 0.1 } });
    if (req.url === "/api/rigs/summary") return json([{ id: "R1", name: "alpha", lifecycleState: "running" }, { id: "R0", name: "old", archivedAt: "x" }]);
    if (req.url.startsWith("/api/rigs/R1/nodes")) return json([{ canonicalSessionName: "impl-codex-1@alpha", logicalId: "impl.codex-1", podNamespace: "impl", rigName: "alpha", runtime: "codex", lifecycleState: "running", nodeKind: "agent", activityState: { display: "working" } }]);
    if (req.url.startsWith("/api/queue/list?")) return json(req.url.includes("attention=1") ? [] : [{ qitemId: "q1", state: "blocked", blockedOn: "qitem-x", destinationSession: "impl-codex-1@alpha", tags: [], tsCreated: "2026-10-01T10:00:00Z", tsUpdated: "2026-10-01T10:00:00Z" }]);
    if (req.url.startsWith("/api/queue/recent-transitions")) return json(transitions);
    if (req.url === "/api/queue/sse") { res.writeHead(200, { "content-type": "text/event-stream" }); res.flushHeaders(); setTimeout(() => { for (const e of events) res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`); }, eventDelayMs); return; }
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
    assert.deepEqual(d.seen.map((x) => x.url), ["/healthz", "/api/rigs/summary", "/api/rigs/R1/nodes", "/api/queue/list?compact=1&state=pending,in-progress,blocked&limit=5000",
      "/api/queue/list?compact=1&attention=1&limit=200", "/api/queue/recent-transitions?scope=instance&limit=40"]);
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
  const urls = () => { const u = d.seen.map((x) => x.url.split("?")[0] + (x.url.includes("attention=1") ? "?attention" : "")).filter((u) => u !== "/api/queue/recent-transitions"); d.seen.length = 0; return u; };
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

test("ticker (QA PR86): queue transitions (bounded read) and live creations from /api/queue/sse, on a quiet fleet too; no general event stream, no replay", async () => {
  const transitions = [{ transitionId: 7, ts: "2026-10-01T10:00:02Z", actorSession: "impl-1@alpha", change: "handed off to qa-1@alpha", summary: "F-1 ready", rig: "alpha" },
    { transitionId: 8, ts: "2026-10-01T10:00:03Z", actorSession: "qa-1@alpha", change: "claimed", summary: null, rig: "alpha" }];
  const d = await stubDaemon({ transitions, events: [{ type: "queue.created", seq: 302, qitemId: "q9", sourceSession: "qa-1@alpha", destinationSession: "impl-1@alpha", priority: "urgent", createdAt: "2026-10-01 10:00:04" }], eventDelayMs: 500 });
  const c = new Cache({ url: d.url, interval: 60_000, events: true, run: async () => null });
  try {
    c.start();
    const t0 = Date.now();
    while (c.raw.events.length < 3 && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 25));
    assert.deepEqual(c.raw.events.map((e) => [e.kind, e.text]), [["QUEUED", "qa-1 → impl-1 (urgent)"], ["CLAIMED", "qa-1 claimed"], ["HANDOFF", "impl-1 handed off to qa-1 · F-1 ready"]]);
    assert.ok(!d.seen.some((x) => /^\/api\/(events|activity\/events)/.test(x.url)), "no general stream, no activity bootstrap, nothing replayed");
    assert.ok(d.seen.some((x) => x.url === "/api/queue/sse"));
    const t1 = Date.now();
    while (d.seen.filter((x) => x.url.startsWith("/api/queue/list?compact=1&state")).length < 2 && Date.now() - t1 < 4000) await new Promise((r) => setTimeout(r, 50));
    assert.ok(d.seen.filter((x) => x.url.startsWith("/api/queue/list?compact=1&state")).length >= 2, `the queue event pulled the next queue read forward (not 60 s later): ${d.seen.map((x) => x.url.split("?")[0]).join(" ")}`);
    assert.equal(c.raw.events.filter((e) => e.kind === "CLAIMED").length, 1, "a transition read twice is shown once");
  } finally { c.stop(); d.close(); }
});

test("gate today (QA PR86): every decision of the UTC day, found by a binary search, whatever the log's size; partial only past the cap, and said", async () => {
  const { dayStart, GATE_DAY_MAX } = await src("data.ts");
  const dir = fs.mkdtempSync(join(scratch, "jev-")), file = join(dir, "jev-decisions.jsonl");
  const line = (ts, o = {}) => JSON.stringify({ ts, decision: "review.merge_gate", band: "act", result: { decision: "merge" }, caller: "integ@x", pad: "x".repeat(300), ...o }) + "\n";
  let text = "";
  for (let i = 0; i < 6000; i++) text += line(`2026-09-30T${String(Math.floor(i / 250)).padStart(2, "0")}:00:00Z`);   // yesterday, ~2 MB
  text += line("2026-10-01T00:00:01Z");                                                                                // today's first
  for (let i = 0; i < 9000; i++) text += line("2026-10-01T01:00:00Z", { decision: "seat.stuck" });                     // unrelated, ~3 MB
  text += line("2026-10-01T09:00:00Z", { result: { decision: "hold" } }) + line("2026-10-01T09:00:01Z", { caller: "diagnosis:qa" });
  fs.writeFileSync(file, text);
  assert.ok(text.length > 4 << 20, "past the old 4 MB tail");
  const fd = fs.openSync(file, "r");
  assert.equal(dayStart(fd, text.length, "2026-10-01T00:00:00"), text.indexOf('{"ts":"2026-10-01'));
  assert.equal(dayStart(fd, text.length, "2026-10-02T00:00:00"), text.length);
  assert.equal(dayStart(fd, text.length, "2026-09-01T00:00:00"), 0);
  fs.closeSync(fd);
  const d = await stubDaemon(), now = Date.parse("2026-10-01T12:00:00Z");
  const c = new Cache({ url: d.url, interval: 5000, events: false, run: async () => null, now: () => now, jevLog: file });
  try {
    await c.tick();
    assert.deepEqual(c.raw.gates.map((g) => g.decision), ["merge", "hold"], "today's merge from before the old 4 MB tail is counted");
    assert.equal(c.raw.sources.gates, "ok");
    fs.appendFileSync(file, line("2026-10-01T11:00:00Z"));
    c.lastLocal.gates = 0; await c.tick();
    assert.equal(c.raw.gates.length, 3, "then read on from where it left off");
    // QA PR86: a failed read says unavailable; the next good read restores the state
    fs.renameSync(file, file + ".away"); c.lastLocal.gates = 0; await c.tick(); assert.equal(c.raw.sources.gates, "unavailable");
    fs.renameSync(file + ".away", file); fs.appendFileSync(file, line("2026-10-01T11:30:00Z"));
    c.lastLocal.gates = 0; await c.tick();
    assert.deepEqual([c.raw.gates.length, c.raw.sources.gates], [4, "ok"], "recovered");
  } finally { c.stop(); d.close(); }
  // QA PR86: over the cap, the count is a lower bound, and every view says so
  const p = new Cache({ url: d.url, interval: 5000, events: false, run: async () => null, now: () => now, jevLog: file, gateDayMax: 1 << 20 });
  const d2 = await stubDaemon(); p.opt.url = d2.url;
  try {
    await p.tick();
    assert.equal(p.raw.sources.gates, "partial");
    assert.deepEqual(p.raw.gates.map((g) => g.decision), ["hold", "merge", "merge"], "only the day's last 1 MB was read");
    const raw = { ...fixture.raw, gates: p.raw.gates.map((g) => ({ ...g, ts: "2026-10-01T09:00:00Z" })), sources: { ...fixture.raw.sources, gates: "partial" } };
    const home = render(raw, hist(), 176, 50, st()).lines().join("\n"), matrixView = render(raw, hist(), 176, 50, st({ view: 1 })).lines().join("\n");
    assert.match(home, /GATE TODAY ≥/); assert.match(home, /PARTIAL: at least/); assert.match(home, /GATE today ≥3 \(partial\)/); assert.match(home, /gates partial/);
    assert.match(matrixView, /GATE TODAY ≥3 \(partial\)/);
    assert.match(render(raw, hist(), 120, 40, st()).lines().join("\n"), /GATE≥/, "the narrow title keeps the mark");
  } finally { p.stop(); d2.close(); }
  assert.ok(GATE_DAY_MAX >= 32 << 20);
});

test("history: one sample a minute, 24 h kept, shared safely through the file; series by bucket", () => {
  const file = join(scratch, "h", "history.json");
  const h = new History(file), s = (t, working) => ({ t, working, idle: 0, stuck: 0, pending: 0, inProgress: 0, blocked: 0, gateToday: 0 });
  assert.equal(h.add(s(0, 1)), true); assert.equal(h.add(s(30_000, 2)), false, "too soon");
  assert.equal(h.add(s(60_000, 3)), true);
  const other = new History(file); assert.equal(other.samples.length, 2);
  other.add(s(120_000, 4)); h.add(s(180_000, 5));
  assert.deepEqual(new History(file).samples.map((x) => x.working), [1, 3, 4, 5], "two writers merged by minute");
  // QA PR86: a writer holding the lock makes the other skip its write, not overwrite; its sample goes out next time
  const lockFile = `${file}.lock`; fs.writeFileSync(lockFile, "");
  const t0 = Date.now(); assert.equal(other.add(s(240_000, 6)), true); assert.ok(Date.now() - t0 < 2000, "never waits long");
  assert.deepEqual(new History(file).samples.map((x) => x.working), [1, 3, 4, 5], "nothing written while another writer holds the lock");
  fs.rmSync(lockFile); h.add(s(300_000, 7)); other.add(s(360_000, 8));
  assert.deepEqual(new History(file).samples.map((x) => x.working), [1, 3, 4, 5, 6, 7, 8], "the held-back sample is merged on the next write");
  fs.writeFileSync(lockFile, ""); fs.utimesSync(lockFile, new Date(0), new Date(0));
  other.add(s(420_000, 9)); assert.ok(!fs.existsSync(lockFile) && new History(file).samples.at(-1).working === 9, "a stale lock (a crashed writer) is taken over");
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

test("QA PR86: at the minimum 100×30 the matrix scrolls rows and seat columns to the selection; the summary never covers a seat", () => {
  const f = derive(fixture.raw);
  const { grid } = await_grid;
  const g = grid({ s: null, t: null, raw: fixture.raw, f, frame: 0, view: 1, rigFocus: 0, seatFocus: [0, 0], note: null });
  const cols = g.rows[0].cells.length;
  for (let ri = 0; ri < g.rows.length; ri++) {
    for (const col of [0, Math.floor(cols / 2), cols - 1]) {
      const lines = render(fixture.raw, hist(), 100, 30, st({ view: 1, seatFocus: [ri, col] })).lines();
      const text = lines.join("\n"), seat = g.rows[ri].cells[col];
      assert.ok(lines.some((l) => l.includes(`▶ ${g.rows[ri].rig}`)), `rig ${g.rows[ri].rig} is on screen when selected`);
      if (seat) assert.ok(text.includes(`SELECTED ${seat.session}`), `${g.rows[ri].rig} col ${col}: ${seat.session}`);
      else assert.ok(text.includes("SELECTED  — (an empty slot"), `${g.rows[ri].rig} col ${col}: empty`);
      // every drawn rig row ends with its own W / I / ? summary, intact, inside the border
      for (const l of lines.filter((l) => /^ │ (▶ |  )\S/.test(l) && /\d+ \/ +\d+ \/ \d+/.test(l))) assert.match(l, / +\d+ \/ +\d+ \/ \d+ │ $/, l);
      assert.ok(lines.every((l) => [...l].length === 100));
      const firstShown = lines.some((l) => new RegExp(`^ │ (▶ |  )${g.rows[0].rig} `).test(l));
      assert.equal(lines.some((l) => /▲ \d+ more/.test(l)), !firstShown, "rows above out of view ⇔ a ▲ marker");
    }
  }
  const last = render(fixture.raw, hist(), 100, 30, st({ view: 1, seatFocus: [0, cols - 1] })).lines().join("\n");
  assert.match(last, /◀/, "columns to the left are out of view and marked");
  const first = render(fixture.raw, hist(), 100, 30, st({ view: 1, seatFocus: [0, 0] })).lines().join("\n");
  assert.match(first.split("\n").find((l) => /^ │ +\d\d \d\d/.test(l)), /▶ +rows/, "columns to the right are marked"); assert.match(first, /▼ \d+ more/, "rows below are marked");
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

test("Home at short heights: the work-in-flight strip never runs into the ticker, the key hints or the status line", () => {
  for (const h of [30, 31, 32, 33, 34, 35, 36, 40, 50]) for (const w of [100, 176]) {
    const rows = render(fixture.raw, hist(), w, h, st()).lines(), [keys, status] = rows.slice(-2);
    assert.doesNotMatch(keys + status, /[─│╭╮╰╯▶]|WORK IN FLIGHT|QUEUE \d| act \d| pend /, `${w}x${h}: the last two rows are the footer's own`);
    assert.match(keys, /^ {2}⏎ {2}rig seats {3}←→ {2}select rig {3}1-5 {2}views {3}r {2}refresh/, `${w}x${h}: clean key hints`);
    assert.doesNotMatch(rows.at(-3), /WORK IN FLIGHT|QUEUE \d/, `${w}x${h}: the ticker row is the ticker's`);
  }
  assert.match(render(fixture.raw, hist(), 176, 50, st()).lines().join("\n"), /WORK IN FLIGHT/, "shown where it fits");
});

// WO85: Codex reports only a weekly window now. Its 5 h column is "—" (no limit), and a week used up while the account
// runs on credits is "on credits" in the info colour: never red, never "over", never counted out.
test("WO85: Codex accounts: no 5 h reading, the week, and 'on credits' is never drawn as exhausted", async () => {
  const { PAD39A: t } = await src("theme.ts");
  const a = parseAccounts(JSON.stringify([
    { label: "codex-a", provider: "codex", status: "active", cooldowns: [], short_window_used: null, weekly_used: "100", on_credits: true },
    { label: "codex-b", provider: "codex", status: "active", cooldowns: [], short_window_used: null, weekly_used: "42", on_credits: false },
    { label: "codex-c", provider: "codex", status: "active", cooldowns: [], short_window_used: null, weekly_used: "100" }]));
  assert.deepEqual(a.map((x) => [x.label, x.short, x.weekly, x.onCredits]), [["codex-a", null, 100, true], ["codex-b", null, 42, false], ["codex-c", null, 100, false]]);
  const raw = { ...fixture.raw, accounts: a }, same = (c, rgb) => c.fg && c.fg.join() === rgb.join();
  for (const [view, size] of [[4, [176, 50]], [0, [176, 50]], [1, [176, 50]]]) {
    const scr = render(raw, hist(), ...size, st({ view, pane: 3 })), lines = scr.lines();
    const y = lines.findIndex((l) => /codex-a\s/.test(l));
    assert.ok(y >= 0, `view ${view + 1}: codex-a listed`);
    const row = scr.cells.slice(y * scr.w, (y + 1) * scr.w), xs = [...lines[y].matchAll(/100%/g)].map((m) => m.index);
    assert.ok(xs.length, `view ${view + 1}: the week reads 100%`);
    for (const x of xs) assert.ok(!same(row[x], t.stuck), `view ${view + 1}: 100% on credits is not red`);
    const x0 = lines[y].indexOf("codex-a"), x1 = lines[y].indexOf("│", x0);   // this account's row, within its panel
    assert.ok(!row.slice(x0, x1 < 0 ? undefined : x1).some((c) => same(c, t.stuck)), `view ${view + 1}: nothing red on the on-credits row`);
    assert.match(lines[y], /codex-a\s+(cx\s+(5h\s+)?)?[·\s]*—/, `view ${view + 1}: no 5 h reading`);
    assert.doesNotMatch(lines.join("\n"), /codex-a[^\n]*over/, `view ${view + 1}: never "over"`);
  }
  const pool = render(raw, hist(), 176, 50, st({ view: 4 })).lines().join("\n");
  assert.match(pool, /codex-a[^\n]*100%\s+● on credits/);
  assert.match(pool, /codex-c[^\n]*100%\s+● active/, "no credits reading: just the number, as reported");
  // and a real overrun is still red
  const over = { ...fixture.raw, accounts: parseAccounts(JSON.stringify([{ label: "claude-b", provider: "claude", status: "active", cooldowns: [], short_window_used: "1.01", weekly_used: "0.85" }])) };
  assert.match(render(over, hist(), 176, 50, st({ view: 4 })).lines().join("\n"), /claude-b[^\n]*101%[^\n]*○ over/);
});

test("WO85: the Pool shows how many accounts run on credits, prominently (a cost signal); nothing when none do", async () => {
  const { PAD39A: t } = await src("theme.ts");
  const acc = (label, onCredits) => ({ label, provider: "codex", status: "active", cooldowns: [], short_window_used: null, weekly_used: onCredits ? "100" : "40", on_credits: onCredits });
  const raw = { ...fixture.raw, accounts: parseAccounts(JSON.stringify([acc("codex-a", true), acc("codex-b", true), acc("codex-c", false)])) };
  const scr = render(raw, hist(), 176, 50, st({ view: 4 })), lines = scr.lines();
  const ty = lines.findIndex((l) => l.includes("SUBSCRIPTION POOL"));
  assert.match(lines[ty], /SUBSCRIPTION POOL[^\n]*● 2 on credits/, "the count in the panel title");
  const x = lines[ty].indexOf("● 2 on credits"), cell = scr.cells[ty * scr.w + x];
  assert.ok(cell.bold && cell.fg.join() === t.info.join(), "bold, in the info colour");
  assert.match(lines.join("\n"), /● 2 of 3 accounts on credits \(a cost signal\): codex-a, codex-b/);
  assert.match(render(raw, hist(), 176, 50, st()).lines().join("\n"), /ACCOUNT POOL[^\n]*● 2 on credits/, "Home's account pool too");
  const none = { ...fixture.raw, accounts: parseAccounts(JSON.stringify([acc("codex-c", false)])) };
  assert.doesNotMatch(render(none, hist(), 176, 50, st({ view: 4 })).lines().join("\n") + render(none, hist(), 176, 50, st()).lines().join("\n"), /on credits/);
});

// QA PR96: the console shows the status tool's own over_limit verdict (what dispatch and recovery read), never its own.
test("WO85: account panels follow over_limit: on credits at 101% is not over; used up with no credits is over", async () => {
  const { PAD39A: t } = await src("theme.ts");
  const acc = (label, weekly, onCredits, over) => ({ label, provider: "codex", status: "active", cooldowns: [], short_window_used: null, weekly_used: weekly, on_credits: onCredits, ...(over === undefined ? {} : { over_limit: over }) });
  const a = parseAccounts(JSON.stringify([acc("credit101", "101", true, false), acc("nocred100", "100", false, true), acc("older101", "101", false), acc("oldcred101", "101", true)]));
  assert.deepEqual(a.map((x) => [x.label, x.onCredits, x.over]), [["credit101", true, false], ["nocred100", false, true], ["older101", false, true], ["oldcred101", true, false]],
    "over_limit when the tool gives it; an older tool: above 100% and not on credits");
  const raw = { ...fixture.raw, accounts: a }, same = (c, rgb) => c.fg && c.fg.join() === rgb.join();
  for (const view of [4, 0]) {
    const scr = render(raw, hist(), 176, 50, st({ view })), lines = scr.lines(), y = (l) => lines.findIndex((x) => x.includes(l));
    assert.match(lines[y("credit101")], /101%\s+● on credits/, `view ${view + 1}: on credits above 100%`);
    const x0 = lines[y("credit101")].indexOf("credit101"), x1 = lines[y("credit101")].indexOf("│", x0);
    assert.ok(!scr.cells.slice(y("credit101") * scr.w + x0, y("credit101") * scr.w + x1).some((c) => same(c, t.stuck)), `view ${view + 1}: nothing red`);
    assert.match(lines[y("nocred100")], /100%\s+○ over/, `view ${view + 1}: used up, no credits: over, not active`);
  }
  const m = render(raw, hist(), 176, 50, st({ view: 1 })), ml = m.lines(), my = ml.findIndex((l) => l.includes("nocred100"));
  const dot = ml[my].lastIndexOf("○");
  assert.ok(dot > 0 && same(m.cells[my * m.w + dot], t.stuck), "matrix: a hollow red dot for the over account");
});

// WO88: a cooling account says what its timers mean, from the proxy's cooldowns (retry restrictions, not
// availability): a credential-wide cooldown gates the whole account and wins; model timers only say when the FIRST
// model is back; a disabled account is never promised back (QA PR103). An old build showed "0% but cooling".
test("cooling accounts: the whole-account gate wins, model timers say 'first model back', disabled is never back", async () => {
  const { coolingUntil, coolingShort } = await src("views/chrome.ts");
  const model = (m, at, reason = "quota") => ({ scope: "model", model_key: m, reason, retry_at: at, http_status: 429 });
  const a = parseAccounts(JSON.stringify([
    // the live shape: one quota cooldown per model, all until the weekly reset (a Sunday)
    { label: "claude-c", provider: "claude", status: "active", cooldowns: ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5"].map((m, i) => model(m, `2026-10-04T07:00:${String(20 - i).padStart(2, "0")}.000Z`)) },
    // QA: a credential quota gate plus a short model timer: the gate wins, and it's one model, not two
    { label: "qa-a", provider: "codex", status: "active", cooldowns: [{ scope: "credential", reason: "quota", retry_at: "2026-10-04T07:00:00Z" }, model("gpt-6-sol", "2026-10-01T14:10:00Z", "transient")] },
    // QA: disabled, with a model timer: never "back"
    { label: "qa-d", provider: "codex", status: "active", disabled: true, cooldowns: [model("gpt-6-sol", "2026-10-01T20:00:00Z")] },
    { label: "codex-b", provider: "codex", status: "active", cooldowns: [model("gpt-6-sol", "2026-10-01T20:00:07Z"), { reason: "x", retry_at: "not a time" }] },
    { label: "codex-a", provider: "codex", status: "active", cooldowns: [] }]));
  assert.deepEqual(a.map((x) => [x.label, x.cooling, x.coolScope, x.coolUntil, x.coolReason, x.coolModels, x.blocked]), [
    ["claude-c", true, "models", "2026-10-04T07:00:18.000Z", "quota", 3, false],
    ["qa-a", true, "credential", "2026-10-04T07:00:00Z", "quota", 1, false],
    ["qa-d", true, "models", "2026-10-01T20:00:00Z", "quota", 1, true],
    ["codex-b", true, "models", "2026-10-01T20:00:07Z", "quota", 1, false],
    ["codex-a", false, null, null, null, 0, false]]);
  const at = Date.parse("2026-10-01T14:06:00Z");
  assert.equal(coolingUntil(a[0], at), "3 models cooling, first back Sun 07:00Z (quota, in 2d)");
  assert.equal(coolingUntil(a[1], at), "cooling until Sun 07:00Z (quota, whole account, in 2d)", "the credential gate, not the 14:10Z model timer");
  assert.equal(coolingUntil(a[2], at), null, "disabled: no promise");
  assert.equal(coolingUntil(a[3], at), "1 model cooling, first back 20:00Z (quota, in 5h54m)", "the same UTC day: no weekday");
  assert.equal(coolingUntil(a[4], at), null);
  assert.deepEqual([coolingShort(a[1], at), coolingShort(a[3], at), coolingShort(a[2], at)], ["back Sun 07:00Z", "first model back 20:00Z", null]);
  const raw = { ...fixture.raw, at, accounts: a };
  const pool = render(raw, hist(), 176, 50, st({ view: 4 })).lines().join("\n");
  assert.match(pool, /○ claude-c 3 models cooling, first back Sun 07:00Z \(quota, in 2d\)/);
  assert.match(pool, /○ qa-a cooling until Sun 07:00Z \(quota, whole account, in 2d\)/);
  assert.doesNotMatch(pool, /qa-d [^\n]*back|qa-a [^\n]*14:10Z/);
  const home = render(raw, hist(), 176, 50, st()).lines().join("\n");
  assert.match(home, /ACCOUNT POOL[^\n]*○ codex-b first model back 20:00Z/, "Home names the next one back");
  assert.doesNotMatch(home, /qa-d back|qa-a back 14:10Z/);
  // QA's home case: only the credential-gated account cooling: Home says when the whole account is back
  const gate = { ...raw, accounts: [a[1], a[2]] };
  assert.match(render(gate, hist(), 176, 50, st()).lines().join("\n"), /ACCOUNT POOL[^\n]*○ qa-a back Sun 07:00Z/);
  // the demo fleet carries one, so the README images show it
  assert.match(render(fixture.raw, hist(), 176, 50, st({ view: 4 })).lines().join("\n"), /○ codex-c 1 model cooling, first back Fri 20:06Z \(quota, in 1d\)/);
});
