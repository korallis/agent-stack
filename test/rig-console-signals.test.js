// WO78 phase 4: derived signals. "Stuck" is conservative (the daemon's quiet signal + N quiet minutes + no queue
// movement on the seat's open rows) and always carries its reason and ages; stage times come from the queue rows' own
// last transitions. Fixture and pure functions; no daemon.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (f) => import(join(repo, "console/src", f));
const { stuckVerdict, classify, derive, stageTimes, sliceStageTime, slices, RIVER, STUCK_MINUTES } = await src("model.ts");
const { History } = await src("history.ts");
const { render, parseArgs, runCommand } = await src("main.ts");
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
