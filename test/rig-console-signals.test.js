// WO78 phase 4: derived signals. "Stuck" is conservative (the daemon's quiet signal + N quiet minutes + no queue
// movement on the seat's open rows) and always carries its reason and ages; stage times come from the queue rows' own
// last transitions. Fixture and pure functions; no daemon.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import * as http from "node:http";
import * as os from "node:os";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (f) => import(join(repo, "console/src", f));
const { stuckVerdict, classify, derive, stageTimes, sliceStageTime, slices, RIVER, STUCK_MINUTES } = await src("model.ts");
const { History } = await src("history.ts");
const { render, parseArgs, runCommand, sampleFor } = await src("main.ts");
const fixture = JSON.parse(fs.readFileSync(join(repo, "console/fixtures/demo.json"), "utf8"));
const hist = () => { const h = new History(null); h.samples = fixture.history; return h; };
const st = (o = {}) => ({ view: 0, rigFocus: 0, seatFocus: [0, 0], help: false, frame: 0, note: null, riverFocus: [0, 0], journey: null, pane: 0, expand: false, select: 0, cmd: null, seat: null, theme: "pad39a", ...o });
const NOW = Date.parse("2026-10-01T12:00:00Z"), ago = (m) => new Date(NOW - m * 60_000).toISOString();
const seat = (o = {}) => ({ rig: "alpha", pod: "impl", name: "codex-1", session: "impl-codex-1@alpha", runtime: "cx", model: null, ctx: 40, activity: "unknown", why: "activity unknown",
  assigned: 1, pending: 0, inProgress: 1, blocked: 0, lastActivityAt: ago(30), kind: "agent", ...o });
const row = (o = {}) => ({ id: "q1", state: "in-progress", priority: "routine", source: "a@alpha", destination: "impl-codex-1@alpha", blockedOn: null, tags: [], created: ago(120), updated: ago(40), summary: null, ...o });
const raw = (queue, extra = {}) => ({ at: NOW, rigs: [], queue, attention: [], history: [], ...extra });

test("stuck needs all three: the quiet signal, N quiet minutes, and no movement on the seat's open rows; every verdict says why", () => {
  assert.equal(STUCK_MINUTES, 15);
  const v = stuckVerdict(raw([row()]), seat());
  assert.equal(v.stuck, true); assert.equal(v.activity, "stuck");
  assert.equal(v.why, "activity unknown for 30m · no queue movement on 1 open row for 40m");
  const cases = [
    [seat({ activity: "working", why: null }), [row()], { stuck: false, activity: "working", why: null }, "a working seat is untouched"],
    [seat({ lastActivityAt: ago(10) }), [row()], /^activity unknown for 10m \(stuck after 15m\)$/, "not quiet long enough"],
    [seat(), [], /^activity unknown for 30m · holds no open work$/, "nothing to be stuck on"],
    [seat(), [row({ state: "blocked" })], /holds no open work/, "only blocked rows: waiting on others, not stuck"],
    [seat(), [row({ updated: ago(4) })], /^activity unknown for 30m · its queue moved 4m ago$/, "its row moved"],
    [seat({ lastActivityAt: null }), [row()], /last activity not reported/, "no age, no verdict"],
  ];
  for (const [s, q, want, label] of cases) {
    const r = stuckVerdict(raw(q), s);
    if (want instanceof RegExp) { assert.equal(r.stuck, false, label); assert.equal(r.activity, "unknown", label); assert.match(r.why, want, label); }
    else assert.deepEqual(r, want, label);
  }
  // the seat's own recent transition counts as movement too
  assert.match(stuckVerdict(raw([row()], { history: [{ id: 1, ts: ago(2), actor: "impl-codex-1@alpha", change: "claimed", summary: null, rig: "alpha", qitemId: "q9" }] }), seat()).why, /its queue moved 2m ago/);
  // stalled and needs-input are the daemon's other quiet signals, and keep their words
  assert.match(stuckVerdict(raw([row()]), seat({ activity: "stuck", why: "needs input" })).why, /^needs input for 30m · no queue movement/);
  assert.match(stuckVerdict(raw([row(), row({ id: "q2", state: "pending", updated: ago(50) })]), seat({ activity: "stuck", why: "stalled" })).why, /^stalled for 30m · no queue movement on 2 open rows for 40m$/);
  // N is configurable
  assert.equal(stuckVerdict(raw([row()], { stuckMinutes: 45 }), seat()).stuck, false);
  assert.equal(stuckVerdict(raw([row()]), seat(), 5).stuck, true);
});

test("classify is pure and every view shows the reason with the verdict, never a bare label", () => {
  const before = JSON.stringify(fixture.raw);
  const c = classify(fixture.raw);
  assert.equal(JSON.stringify(fixture.raw), before, "input unchanged");
  const f = derive(c);
  const open = fixture.raw.queue.filter((r) => r.destination === "impl-codex-5@gamma" && ["in-progress", "pending"].includes(r.state));
  const moved = Math.round((fixture.raw.at - Math.max(...open.map((r) => Date.parse(r.updated)))) / 60_000);
  const why = `stalled for 42m · no queue movement on ${open.length} open row${open.length > 1 ? "s" : ""} for ${moved}m`;
  assert.ok(moved >= 15, "the fixture's stuck seat really hasn't moved for N minutes");
  assert.deepEqual(f.stuck.map((s) => [s.session, s.why]), [["impl-codex-5@gamma", why]]);
  assert.deepEqual(f.unknown.map((s) => [s.session, s.why]), [["tests-codex@beta", "activity unknown for 18m · its queue moved 3m ago"]]);
  const home = render(fixture.raw, hist(), 176, 50, st()).lines().join("\n");
  const tile = home.split("\n").slice(3, 8).map((l) => l.slice(66, 87)).join(" ").replace(/[│\s]+/g, " ");   // the STUCK tile's text column
  assert.match(tile, /impl-codex-5@gamma stalled for 42m · no queue movement on \d+ open rows? for \d+m/, `the whole reason in the tile: ${tile}`);
  const matrix = render(fixture.raw, hist(), 176, 50, st({ view: 1 })).lines().join("\n");
  assert.ok(matrix.includes(`EXCEPTIONS impl-codex-5@gamma stuck: ${why}`));
  assert.match(matrix, /1 quiet, not stuck/);
  const focus = render(fixture.raw, hist(), 176, 50, st({ view: 3 })).lines().join("\n");
  assert.match(focus, /Stuck[\s\S]*impl-codex-5@gamma · stalled for 42m · no queue movement/);
  assert.match(focus, /Quiet[\s\S]*tests-codex@beta · activity unknown for 18m · its queue moved 3m ago · not stuck/);
  const seatv = render(fixture.raw, hist(), 176, 50, st({ seat: "impl-codex-5@gamma" })).lines().join("\n");
  assert.match(seatv, /◆ stuck \(stalled for 42m · no queue movement/);
  assert.doesNotMatch(home + matrix + focus, /stuck or unknown|STUCK\/UNKNOWN/, "the old bare wording is gone");
  // the threshold through the view state: at 60 min nothing is stuck yet
  assert.equal(derive(classify({ ...fixture.raw, stuckMinutes: 60 })).stuck.length, 0);
  assert.doesNotMatch(render(fixture.raw, hist(), 176, 50, st({ view: 1, stuckMinutes: 60 })).lines().join("\n"), /impl-codex-5@gamma stuck:/);
});

test("stage times: each stage's open rows by time in their current state (median) and the share waiting; a slice's time at its stage", () => {
  const seats = [{ rig: "alpha", pod: "impl", name: "codex-1", session: "impl-codex-1@alpha", kind: "agent" }, { rig: "alpha", pod: "qa", name: "codex-1", session: "qa-codex-1@alpha", kind: "agent" }];
  const r = { at: NOW, rigs: [{ id: "R", name: "alpha", seats }], attention: [], queue: [
    row({ id: "b1", updated: ago(60) }), row({ id: "b2", state: "pending", updated: ago(30) }), row({ id: "b3", state: "blocked", updated: ago(90) }),
    row({ id: "q1", destination: "qa-codex-1@alpha", updated: ago(10), tags: ["project:alpha", "slice:f-001-x"] })] };
  const t = stageTimes(r), BUILD = RIVER.findIndex((s) => s.label === "BUILD"), QA = RIVER.findIndex((s) => s.label === "QA");
  assert.deepEqual([t[BUILD].rows, t[BUILD].median / 60_000, t[BUILD].worked / 60_000, t[BUILD].waited / 60_000], [3, 60, 60, 120]);
  assert.deepEqual([t[QA].rows, t[QA].median / 60_000], [1, 10]);
  // an even count: the mean of the middle pair (QA PR94: 10m and 30m is 20m, not 30m)
  const two = { ...r, queue: [row({ id: "e1", updated: ago(10) }), row({ id: "e2", state: "pending", updated: ago(30) })] };
  assert.deepEqual([stageTimes(two)[BUILD].median / 60_000, Math.round(100 * stageTimes(two)[BUILD].waited / (stageTimes(two)[BUILD].worked + stageTimes(two)[BUILD].waited))], [20, 75]);
  assert.equal(t[RIVER.findIndex((s) => s.label === "SPEC")].median, null, "an empty stage has no time");
  const sl = slices(r).find((x) => x.id === "F-001");
  assert.deepEqual(Object.values(sliceStageTime(r, sl)).map((v) => v / 60_000), [10, 10, 0]);
  const river = render(fixture.raw, hist(), 176, 50, st({ view: 2, riverFocus: [3, 0] })).lines().join("\n");
  assert.match(river, /⧗\S+ \d+%w/, "per stage: median and waiting share");
  assert.match(river, /SELECTED F-\d+[^\n]* at [A-Z]+ for \S+ \(in progress \S+ \/ waiting \S+\)/, "the selected slice's time at its stage");
  // never more than the time at the stage, however many rows sit there
  for (const sl of slices(fixture.raw)) { const x = sliceStageTime(fixture.raw, sl); assert.ok(x.worked <= x.since && x.waited <= x.since, sl.key); }
});

test("CLI and ':' command: --stuck-minutes (5-240), RIG_CONSOLE_STUCK_MINUTES, :stuck <m>", () => {
  assert.equal(parseArgs([], {}).stuckMinutes, 15);
  assert.equal(parseArgs(["--stuck-minutes", "30"], {}).stuckMinutes, 30);
  assert.equal(parseArgs([], { RIG_CONSOLE_STUCK_MINUTES: "20" }).stuckMinutes, 20);
  assert.equal(parseArgs([], { RIG_CONSOLE_STUCK_MINUTES: "2" }).stuckMinutes, 15, "out of range: the default");
  for (const bad of ["4", "241", "ten", "1.5"]) {
    const r = spawnSync(process.execPath, [join(repo, "console/src/main.ts"), "--stuck-minutes", bad], { encoding: "utf8" });
    assert.equal(r.status, 2, bad); assert.match(r.stderr, /--stuck-minutes is 5 to 240/);
  }
  const s = st();
  assert.match(runCommand(s, "stuck 30", fixture.raw), /stuck after 30 quiet minutes/); assert.equal(s.stuckMinutes, 30);
  assert.match(runCommand(s, "stuck 1", fixture.raw), /minutes from 5 to 240/); assert.equal(s.stuckMinutes, 30);
});

// QA PR94: the 24 h history and every count on Home use the same verdicts as the views, at the same threshold.
const oneSeat = (activity, lastMin, rowMin, o = {}) => {
  const s = seat({ activity: activity === "stalled" ? "stuck" : "unknown", why: activity === "stalled" ? "stalled" : "activity unknown", lastActivityAt: ago(lastMin) });
  return { ...fixture.raw, ...raw([row({ updated: ago(rowMin) })], { rigs: [{ id: "R", name: "alpha", seats: [s] }], ...o }) };
};
test("history samples and Home's rig cards count stuck the conservative way; quiet seats stay quiet", () => {
  const young = oneSeat("stalled", 10, 40), old = oneSeat("unknown", 30, 40);
  assert.equal(sampleFor(young, st()).stuck, 0, "stalled for 10m: not stuck yet");
  assert.equal(sampleFor(old, st()).stuck, 1, "unknown for 30m, its row unmoved for 40m: stuck");
  assert.equal(sampleFor(old, st({ stuckMinutes: 60 })).stuck, 0, "the selected threshold");
  assert.equal(sampleFor(oneSeat("unknown", 30, 3), st()).stuck, 0, "its queue moved");
  const card = (r) => render(r, hist(), 176, 50, st()).lines().join("\n");
  const y = card(young);
  assert.match(y, /none stuck/); assert.match(y, /1 quiet, not stuck/);
  assert.doesNotMatch(y, /\d+ stuck(?!\S)/, "the rig card never calls a quiet seat stuck");
  assert.match(y, /0 wrk {2}0 idle {2}1 quiet/);
  assert.match(card(old), /0 wrk {2}0 idle {2}1 stuck/);
  const matrix = (r) => render(r, hist(), 176, 50, st({ view: 1 })).lines().join("\n");
  assert.match(matrix(young), / 0\/ 0\/ 0◆ 1\?/); assert.match(matrix(old), / 0\/ 0\/ 1◆/);
  const river = render(young, hist(), 176, 50, st({ view: 2 })).lines().join("\n");
  assert.match(river, /▸0 ·0 \?1/); assert.doesNotMatch(river, /▸0 ·0 ◆/);
  assert.match(render(old, hist(), 176, 50, st({ view: 2 })).lines().join("\n"), /▸0 ·0 ◆1(?! \?)/, "a stuck seat is ◆ on its lane, not ?");
});

test("CLI: the live sample written to history uses the conservative verdict and the --stuck-minutes threshold", async () => {
  const scratch = fs.mkdtempSync(join(os.tmpdir(), "rig-console-p4-"));
  const daemon = (lastMin, rowMin) => new Promise((ok) => {
    const at = (m) => new Date(Date.now() - m * 60_000).toISOString();
    const server = http.createServer((req, res) => {
      const json = (b) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
      if (req.url === "/healthz") return json({ status: "ok" });
      if (req.url === "/api/rigs/summary") return json([{ id: "R1", name: "alpha", lifecycleState: "running" }]);
      if (req.url.startsWith("/api/rigs/R1/nodes")) return json([{ canonicalSessionName: "impl-codex-1@alpha", logicalId: "impl.codex-1", podNamespace: "impl", rigName: "alpha", runtime: "codex", nodeKind: "agent",
        lifecycleState: "running", activityState: { display: "stalled" }, lastActivityAt: at(lastMin) }]);
      if (req.url.startsWith("/api/queue/list?")) return json(req.url.includes("attention=1") ? [] : [{ qitemId: "q1", state: "in-progress", destinationSession: "impl-codex-1@alpha", tags: [], tsCreated: at(120), tsUpdated: at(rowMin) }]);
      if (req.url.startsWith("/api/queue/recent-transitions")) return json([]);
      res.writeHead(404); res.end();
    });
    server.listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections(); server.close(); } }));
  });
  const once = (url, file, extra = []) => new Promise((ok) => {
    const p = spawn(process.execPath, [join(repo, "console/src/main.ts"), "--once", "--size", "176x50", "--color", "0", "--url", url, "--history", file, ...extra],
      { env: { PATH: "/usr/bin:/bin", HOME: scratch, AGENT_STACK_STATE: join(scratch, "state") } });
    p.stdout.resume(); p.on("exit", (code) => ok(code));
  });
  const stuckIn = (file) => JSON.parse(fs.readFileSync(file, "utf8")).samples.at(-1).stuck;
  try {
    for (const [label, lastMin, rowMin, extra, want] of [["stalled 10m", 10, 40, [], 0], ["stalled 30m, row 40m", 30, 40, [], 1], ["threshold 60", 30, 40, ["--stuck-minutes", "60"], 0], ["row moved", 30, 3, [], 0]]) {
      const d = await daemon(lastMin, rowMin), file = join(scratch, `${label.replace(/\W+/g, "-")}.json`);
      try { assert.equal(await once(d.url, file, extra), 0, label); assert.equal(stuckIn(file), want, label); } finally { d.close(); }
    }
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

// QA PR94 P2: the reason and its ages wherever the verdict shows: the footer (every view), the Focus pulse and, briefer, a narrow Home tile.
test("the stuck reason in the footer, the Focus pulse and narrow Home; the verdicts lead the Focus timeline", () => {
  const f = derive(classify(fixture.raw)), [x] = f.stuck, frame = (o, size = [176, 50]) => render(fixture.raw, hist(), ...size, st(o)).lines();
  for (const v of [0, 1, 2, 3, 4]) assert.ok(frame({ view: v }).at(-1).includes(`${x.session} stuck: ${x.why}`), `footer, view ${v + 1}`);
  const narrow = frame({}, [100, 30]);
  assert.match(narrow.at(-1), /▲ 3 owner decisions waiting · impl-codex-5@gamma stuck: stalled 42m · \d+ rows? unmoved \d+m/, "narrow: the owner first, then the stuck reason, shortened");
  const tile = narrow.slice(3, 8).map((l) => l.slice(34, 49)).join(" ");
  assert.match(tile, /stalled 42m/); assert.match(tile, /unmoved \d+m/);
  for (const size of [[176, 50], [100, 30]]) {
    const focus = frame({ view: 3 }, size).join("\n");
    assert.ok(focus.includes(`▲ ${x.session} stuck: ${x.why}`), `the pulse carries the reason at ${size}`);
  }
  const timeline = frame({ view: 3 }, [100, 30]).join("\n");
  assert.match(timeline, /Stuck[\s\S]*impl-codex-5@gamma · stalled/, "the stuck item is on screen at 100x30, above newer events");
});
