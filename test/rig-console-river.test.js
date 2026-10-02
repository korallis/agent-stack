// WO78 phase 2: the River (slices flowing through the stages per rig) and one slice's journey. Model, the River's data
// tier (only while it is open), both views. Stub daemon and the neutral fixture; never a live daemon.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (f) => import(join(repo, "console/src", f));
const { slices, sliceId, doneToday, journey, RIVER } = await src("model.ts");
const { Cache } = await src("data.ts");
const { History } = await src("history.ts");
const { render, parseArgs, initialReads } = await src("main.ts");
const fixture = JSON.parse(fs.readFileSync(join(repo, "console/fixtures/demo.json"), "utf8"));
const hist = () => { const h = new History(null); h.samples = fixture.history; return h; };
const st = (o = {}) => ({ view: 2, rigFocus: 0, seatFocus: [0, 0], help: false, frame: 0, note: null, riverFocus: [0, 0], journey: null, ...o });
const J = "gamma/f-055-backup-and-restore-drill";
const q = (o) => ({ id: "q", state: "pending", priority: "routine", source: "a@x", destination: "impl-codex-1@alpha", blockedOn: null, tags: [], created: "2026-10-01T10:00:00Z", updated: "2026-10-01T10:00:00Z", summary: null, ...o });
const seats = [{ rig: "alpha", pod: "impl", name: "codex-1", session: "impl-codex-1@alpha", kind: "agent" }, { rig: "alpha", pod: "qa", name: "codex-1", session: "qa-codex-1@alpha", kind: "agent" },
  { rig: "alpha", pod: "integ", name: "codex", session: "integ-codex@alpha", kind: "agent" }];
const raw = (queue, extra = {}) => ({ at: Date.parse("2026-10-01T12:00:00Z"), rigs: [{ id: "R", name: "alpha", seats }], queue, attention: [], ...extra });

test("slice ids and labels from tags", () => {
  assert.equal(sliceId("05-f-021-welcome-and-my-details"), "F-021");
  assert.equal(sliceId("f-055-backup-and-restore-drill"), "F-055");
  assert.equal(sliceId("w2-wit-wave-2-end-to-end-proof"), "W2-WIT");
  assert.equal(sliceId("opr.99.0.2.20"), "OPR.99.");
});

test("a slice sits at the most advanced stage one of its open rows waits on; owner > blocked (all) > active > pending", () => {
  const tags = ["project:alpha", "slice:f-001-a", "pr:12"];
  const S = (rows) => slices(raw(rows))[0];
  assert.equal(RIVER[S([q({ id: "1", tags }), q({ id: "2", tags, destination: "qa-codex-1@alpha" })]).stage].label, "QA");
  assert.equal(S([q({ id: "1", tags, state: "in-progress" }), q({ id: "2", tags, state: "blocked" })]).state, "active");
  assert.equal(S([q({ id: "1", tags, state: "blocked" }), q({ id: "2", tags, state: "blocked" })]).state, "blocked");
  assert.equal(S([q({ id: "1", tags, state: "in-progress" }), q({ id: "2", tags, state: "blocked", blockedOn: "human@kernel" })]).state, "owner");
  assert.equal(S([q({ id: "1", tags })]).state, "pending");
  const s = S([q({ id: "1", tags, created: "2026-10-01T09:00:00Z" }), q({ id: "2", tags: [...tags, "pr:13"], created: "2026-10-01T08:00:00Z" })]);
  assert.deepEqual([s.id, s.rig, s.prs, s.since, s.rows.length], ["F-001", "alpha", ["#12", "#13"], "2026-10-01T08:00:00Z", 2]);
  assert.equal(slices(raw([q({ tags: ["project:alpha"] })])).length, 0, "a row without a slice tag is no slice");
  assert.equal(slices(raw([q({ id: "1", tags: ["project:alpha", "slice:x"] }), q({ id: "2", tags: ["project:beta", "slice:x"] })])).length, 2, "the same slice name in two projects is two slices");
});

test("done today: a slice whose rows finished today and has no open row; journey: worked vs waited from transitions", () => {
  const tags = ["project:alpha", "slice:f-002-b"];
  const r = raw([q({ id: "open", tags: ["project:alpha", "slice:f-003-c"] })], { done: [q({ id: "d1", state: "done", tags, updated: "2026-10-01T11:00:00Z" }),
    q({ id: "d2", state: "done", tags: ["project:alpha", "slice:f-003-c"], updated: "2026-10-01T11:00:00Z" }), q({ id: "d3", state: "done", tags: ["project:alpha", "slice:f-004-d"], updated: "2026-09-30T11:00:00Z" })] });
  assert.deepEqual(doneToday(r), { alpha: ["F-002"] });
  const tr = [{ id: 1, ts: "2026-10-01T10:00:00Z", state: "pending" }, { id: 2, ts: "2026-10-01T10:30:00Z", state: "in-progress" }, { id: 3, ts: "2026-10-01T11:30:00Z", state: "blocked" }];
  const jr = journey(raw([q({ id: "x", tags, state: "blocked", destination: "integ-codex@alpha" })], { transitions: { x: tr } }), "alpha/f-002-b");
  assert.equal(jr.steps.length, 1);
  assert.deepEqual([jr.steps[0].worked, jr.steps[0].waited], [3_600_000, 30 * 60_000 + 30 * 60_000], "worked 1 h; waited 30 min pending + 30 min blocked until now");
  assert.equal(jr.perStage[RIVER.findIndex((s) => s.label === "MERGE")].worked, 3_600_000);
  assert.equal(journey(raw([q({ id: "y", tags })]), "alpha/f-002-b").steps[0].known, false, "no transitions read yet: unknown, not zero");
});

function stub() {
  const seen = [];
  const rows = [{ qitemId: "a1", state: "in-progress", destinationSession: "impl-codex-1@alpha", tags: ["project:alpha", "slice:f-001-a"], tsCreated: "2026-10-01T10:00:00Z", tsUpdated: "2026-10-01T10:00:00Z" },
    { qitemId: "b1", state: "pending", destinationSession: "qa-codex-1@alpha", tags: ["project:alpha", "slice:f-009-z"], tsCreated: "2026-10-01T10:00:00Z", tsUpdated: "2026-10-01T10:00:00Z" }];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    const json = (b) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    if (req.url === "/healthz") return json({ status: "ok", pid: process.pid });
    if (req.url === "/api/rigs/summary") return json([{ id: "R1", name: "alpha" }]);
    if (req.url.startsWith("/api/rigs/R1/nodes")) return json([]);
    if (req.url.startsWith("/api/queue/list?") && req.url.includes("state=done")) return json([{ qitemId: "d1", state: "done", destinationSession: "integ-codex@alpha", tags: ["project:alpha", "slice:f-001-a"], tsCreated: "2026-10-01T08:00:00Z", tsUpdated: "2026-10-01T09:00:00Z" }]);
    if (req.url.startsWith("/api/queue/list?")) return json(req.url.includes("attention=1") ? [] : rows);
    if (req.url.startsWith("/api/queue/recent-transitions")) return json([]);
    const m = req.url.match(/^\/api\/queue\/([^/]+)\/transitions$/);
    if (m) return json([{ transitionId: 1, ts: "2026-10-01T10:00:00Z", state: "pending", transitionNote: "created", actorSession: "x@alpha" }]);
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${server.address().port}`, seen, rows, close: () => { server.closeAllConnections(); server.close(); } })));
}

test("data: the River's reads happen only while it is open: done rows every 5 min; transitions only for the open slice's rows, re-read only when changed", async () => {
  let now = 0;
  const d = await stub(), c = new Cache({ url: d.url, interval: 5000, events: false, run: async () => null, now: () => now });
  const take = () => { const u = d.seen.slice(); d.seen.length = 0; return u; };
  try {
    await c.tick(); let u = take();
    assert.ok(!u.some((x) => x.includes("state=done") || /\/transitions$/.test(x)), "home and matrix read neither");
    c.setView(true, null); now = 5000; await c.tick(); u = take();
    assert.equal(u.filter((x) => x.includes("state=done")).length, 1); assert.ok(!u.some((x) => /\/transitions$/.test(x)));
    now = 10_000; await c.tick(); assert.equal(take().filter((x) => x.includes("state=done")).length, 0, "not again within 5 min");
    c.setView(true, "alpha/f-001-a"); now = 15_000; await c.tick(); u = take();
    assert.deepEqual(u.filter((x) => /\/transitions$/.test(x)).sort(), ["/api/queue/a1/transitions", "/api/queue/d1/transitions"], "only that slice's rows (open and done)");
    assert.equal(c.raw.transitions.a1[0].note, "created");
    now = 20_000; await c.tick(); assert.equal(take().filter((x) => /\/transitions$/.test(x)).length, 0, "unchanged rows aren't re-read");
    d.rows[0].tsUpdated = "2026-10-01T11:00:00Z"; c.dirty.queue = true; now = 25_000; await c.tick();
    assert.deepEqual(take().filter((x) => /\/transitions$/.test(x)), ["/api/queue/a1/transitions"], "a changed row is");
    c.setView(false, null); now = 300_000; await c.tick(); u = take();
    assert.ok(!u.some((x) => x.includes("state=done") || /\/transitions$/.test(x)), "closed: neither");
  } finally { c.stop(); d.close(); }
});

test("views: the River at 176, 120 and 100 columns; a selected chip; the journey of the fixture's slice", () => {
  for (const [w, h] of [[176, 50], [120, 40], [100, 30]]) {
    const lines = render(fixture.raw, hist(), w, h, st({ riverFocus: [3, 0] })).lines(), text = lines.join("\n");
    assert.ok(lines.every((l) => [...l].length === w));
    for (const s of ["THE RIVER", "QUEUE", "BUILD", "REVIEW", "MERGE", "DONE today", "chips"]) assert.ok(text.includes(s), `${w}: ${s}`);
    assert.match(text, /▶gamma/, `${w}: the focused lane`);
    assert.match(text, /SELECTED F-\d{3}/, `${w}: the selected chip is named`);
  }
  assert.match(render(fixture.raw, hist(), 176, 50, st()).lines().join("\n"), /pooling at\s+\S+ ×\d+/);
  const j = render(fixture.raw, hist(), 176, 50, st({ journey: J })).lines().join("\n");
  for (const s of ["RIVER › gamma › F-055", "backup and restore drill", "WAITING ON OWNER", "◆ MERGE", "✓ BUILD", "JOURNEY · F-055", "spec locked", "merge held: Jev HOLD 58%", "WAITING ON", "human@kernel", "QUEUE ROWS"])
    assert.ok(j.includes(s), s);
  assert.match(j, /total worked \S+ · waited \S+ \(\d+% waiting\)/);
  for (const [w, h] of [[120, 40], [100, 30]]) assert.ok(render(fixture.raw, hist(), w, h, st({ journey: J })).lines().every((l) => [...l].length === w));
});

test("CLI: --view river and --slice <project>/<slice> (strict)", () => {
  assert.equal(parseArgs(["--view", "river"], {}).view, 2);
  const a = parseArgs(["--slice", J], {}); assert.deepEqual([a.view, a.slice], [2, J]);
  const bad = spawnSync(process.execPath, [join(repo, "console/src/main.ts"), "--legacy", "--slice", "no-project"], { encoding: "utf8" });
  assert.equal(bad.status, 2); assert.match(bad.stderr, /--slice is <project>\/<slice>/);
  const r = spawnSync(process.execPath, [join(repo, "console/src/main.ts"), "--legacy", "--once", "--fixture", join(repo, "console/fixtures/demo.json"), "--size", "176x50", "--color", "0", "--slice", J], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /JOURNEY · F-055/);
});

test("QA PR90: started on the River or a journey, the first read already loads its data (no key needed)", async () => {
  const d = await stub();
  try {
    for (const [st0, want] of [[{ view: 2, journey: null }, /state=done/], [{ view: 2, journey: "alpha/f-001-a" }, /\/api\/queue\/a1\/transitions$/]]) {
      d.seen.length = 0;
      const c = new Cache({ url: d.url, interval: 60_000, events: false, run: async () => null });
      initialReads(c, st0);
      await c.tick(); if (st0.journey) await c.tick();
      c.stop();
      assert.ok(d.seen.some((u) => want.test(u)), `${JSON.stringify(st0)}: ${d.seen.join(" ")}`);
    }
  } finally { d.close(); }
});

test("QA PR90: in a crowded stage the focused chip is always drawn and named, past the display cap", () => {
  const rows = Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, state: "in-progress", priority: "routine", source: "x@alpha", destination: "impl-codex-1@alpha", blockedOn: null,
    tags: ["project:alpha", `slice:f-1${String(i).padStart(2, "0")}-crowd`], created: `2026-10-01T0${i}:00:00Z`, updated: "2026-10-01T10:00:00Z", summary: null }));
  const r = { ...fixture.raw, queue: rows, attention: [] };
  const ids = rows.map((x) => `F-1${x.id.slice(1).padStart(2, "0")}`);
  const alpha = fixture.raw.rigs.findIndex((x) => x.name === "alpha");
  for (let k = 0; k < rows.length; k++) {
    const scr = render(r, hist(), 100, 30, st({ riverFocus: [alpha, k] }));
    const text = scr.lines().join("\n");
    assert.match(text, new RegExp(`SELECTED ${ids[k]}`), `chip ${k}: named`);
    const inv = scr.cells.filter((c2) => c2.inverse).map((c2) => c2.ch).join("");
    assert.ok(inv.includes(ids[k]), `chip ${k}: drawn highlighted (${inv})`);
  }
});

test("QA PR90: the journey at the minimum 100 columns names who it waits on, keeps states whole and bars inside", () => {
  for (const [w, h] of [[100, 30], [120, 40]]) {
    const lines = render(fixture.raw, hist(), w, h, st({ journey: J })).lines(), text = lines.join("\n");
    assert.match(text, /WAITING ON[\s\S]*j0550005 blocked on human@kernel/, `${w}`);
    assert.ok(lines.every((l) => [...l].length === w), `${w}: widths`);
    const rows = lines.filter((l) => /^ │ \d\d-\d\d \d\d:\d\d /.test(l));
    assert.ok(rows.length >= 4, `${w}: rows`);
    for (const l of rows) { assert.match(l, /\b(done|blocked|in-progress|pending)\b/, l); assert.match(l, /│ $/, `${w}: the row ends at the panel border: ${l}`); }
  }
});

test("QA PR90: the history note is never clipped: beside the totals when they fit, else on its own line", () => {
  // 25 rows on one slice, history read for none of them: the note shows whole at 100 and 176 columns
  const rows = Array.from({ length: 25 }, (_, i) => ({ id: `h${i}`, state: "in-progress", priority: "routine", source: "x@alpha", destination: "impl-codex-1@alpha", blockedOn: null,
    tags: ["project:alpha", "slice:f-200-many"], created: `2026-10-01T09:${String(i).padStart(2, "0")}:00Z`, updated: "2026-10-01T10:00:00Z", summary: null }));
  const r = { ...fixture.raw, queue: rows, attention: [], transitions: {} };
  for (const [w, h] of [[100, 30], [176, 50]]) assert.match(render(r, hist(), w, h, st({ journey: "alpha/f-200-many" })).lines().join("\n"), /history: newest 20 rows \(… = not read\)/, `${w}`);
});
