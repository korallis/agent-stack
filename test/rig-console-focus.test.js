// WO78 phase 3: Calm Focus (view 4), the seat drill-in with its live tail, Pool & System (view 5), the ':' command bar,
// panes (Tab) and 'e' expand, themes. Neutral fixture and a stub daemon; never a live daemon, never tmux.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (f) => import(join(repo, "console/src", f));
const { THEMES } = await src("theme.ts");
const { decision, timeline } = await src("views/focus.ts");
const { derive } = await src("model.ts");
const { Cache } = await src("data.ts");
const { History } = await src("history.ts");
const { render, parseArgs, handleKey, runCommand, initialReads } = await src("main.ts");
const { Screen } = await src("term.ts");
const fixture = JSON.parse(fs.readFileSync(join(repo, "console/fixtures/demo.json"), "utf8"));
const hist = () => { const h = new History(null); h.samples = fixture.history; return h; };
const st = (o = {}) => ({ view: 0, rigFocus: 0, seatFocus: [0, 0], help: false, frame: 0, note: null, riverFocus: [0, 0], journey: null, pane: 0, expand: false, select: 0, cmd: null, seat: null, theme: "pad39a", ...o });
const text = (s) => s.lines().join("\n");
const SEAT = "impl-codex-4@gamma";

test("themes: four palettes with every meaning; each one paints the screen", () => {
  assert.deepEqual(Object.keys(THEMES), ["pad39a", "catppuccin", "tokyo-night", "nord"]);
  const keys = Object.keys(THEMES.pad39a);
  for (const [k, t] of Object.entries(THEMES)) {
    assert.deepEqual(Object.keys(t), keys, k);
    const s = render(fixture.raw, hist(), 176, 50, st({ theme: k }));
    assert.deepEqual(s.cells[0].bg, t.panel, `${k}: header`); assert.match(text(s), new RegExp(`theme ${t.name}`));
  }
});

test("decisions: question, detail and lettered options from the row's summary", () => {
  const q = (summary) => ({ summary, tags: [], source: "a@x", destination: "human@kernel", created: "2026-10-01T10:00:00Z", priority: "urgent", id: "q" });
  assert.deepEqual(decision(q("F-056 restore from snapshot: gate HOLD 58%. A merge  B add test  C defer")),
    { title: "F-056 restore from snapshot:", detail: "gate HOLD 58%.", options: [["A", "merge"], ["B", "add test"], ["C", "defer"]] });
  assert.deepEqual(decision(q("Keep the merge gate held? A) keep hold B) request witness")).options, [["A", "keep hold"], ["B", "request witness"]]);
  assert.deepEqual(decision(q("Plain update with no options")).options, []);
});

test("timeline: outcomes newest first, plus what is true now (context pressure, stuck); items carry their seat", () => {
  const c = { t: THEMES.pad39a, raw: fixture.raw, f: derive(fixture.raw) };
  const items = timeline(c);
  assert.ok(items.some((i) => i.label === "Context" && i.seat === "arch-claude@beta"));
  assert.ok(items.some((i) => i.label === "Stuck" && i.seat === "impl-codex-5@gamma"));
  assert.ok(items.every((x, i) => i === 0 || items[i - 1].at >= x.at), "newest first");
});

test("command bar: views, seat, rig, slice, theme, unknowns; typing, backspace, Tab completion, esc", () => {
  const s = st(), raw = fixture.raw;
  for (const ch of ":foc") handleKey(s, ch, raw);
  assert.equal(s.cmd, "foc");
  handleKey(s, "\t", raw); assert.equal(s.cmd, "focus", "Tab completes a unique command");
  handleKey(s, "\r", raw); assert.deepEqual([s.view, s.cmd], [3, null]);
  assert.equal(runCommand(s, "seat impl-codex-4@gamma", raw), null); assert.equal(s.seat, SEAT);
  assert.match(runCommand(s, "seat codex", raw), /match "codex"/, "ambiguous");
  assert.match(runCommand(s, "seat nobody", raw), /no seat/);
  assert.equal(runCommand(s, "rig beta", raw), null); assert.deepEqual([s.view, s.seat, s.seatFocus[0]], [1, null, raw.rigs.findIndex((r) => r.name === "beta")]);
  assert.equal(runCommand(s, "slice F-055", raw), null); assert.deepEqual([s.view, s.journey], [2, "gamma/f-055-backup-and-restore-drill"]);
  assert.equal(runCommand(s, "theme nord", raw), "theme Nord"); assert.equal(s.theme, "nord");
  assert.match(runCommand(s, "theme neon", raw), /theme: pad39a, catppuccin, tokyo-night, nord/);
  assert.match(runCommand(s, "frobnicate", raw), /unknown command/);
  assert.equal(runCommand(s, "q", raw), "quit");
  handleKey(s, ":", raw); handleKey(s, "x", raw); handleKey(s, "\x7f", raw); assert.equal(s.cmd, ""); handleKey(s, "\x1b", raw); assert.equal(s.cmd, null, "esc cancels");
  const bar = render(raw, hist(), 176, 50, st({ cmd: "se" }));
  assert.match(text(bar), / : se█\s+seat <name>/, "the bar and its hints replace the key footer");
});

test("keys: 1-5 views, Tab panes, e expands, j/k select, ⏎ opens a seat from the matrix and the timeline, esc steps back", () => {
  const raw = fixture.raw, s = st();
  handleKey(s, "4", raw); assert.equal(s.view, 3);
  handleKey(s, "\t", raw); assert.equal(s.pane, 1, "decisions → timeline");
  handleKey(s, "e", raw); assert.equal(s.expand, true);
  assert.match(text(render(raw, hist(), 176, 50, s)), /LIVE TIMELINE[\s\S]*e  collapse/);
  handleKey(s, "\x1b", raw); assert.equal(s.expand, false, "esc collapses first");
  const items = timeline({ t: THEMES.pad39a, raw, f: derive(raw) }), k = items.findIndex((i) => i.seat === "arch-claude@beta");
  for (let i = 0; i < k; i++) handleKey(s, "j", raw);
  handleKey(s, "\r", raw); assert.equal(s.seat, "arch-claude@beta", "⏎ on a timeline item opens its seat");
  handleKey(s, "\x1b", raw); assert.equal(s.seat, null);
  handleKey(s, "2", raw); s.seatFocus = [raw.rigs.findIndex((r) => r.name === "gamma"), 0];
  handleKey(s, "\r", raw); assert.match(s.seat, /@gamma$/, "⏎ on a matrix cell opens the seat");
  handleKey(s, "5", raw); assert.deepEqual([s.view, s.seat], [4, null]);
  handleKey(s, "\t", raw); handleKey(s, "\t", raw); handleKey(s, "e", raw);
  assert.match(text(render(raw, hist(), 176, 50, s)), /GATE DECISIONS · 24 h/);
  handleKey(s, "\x1b", raw); handleKey(s, "\x1b", raw); assert.equal(s.view, 0);
});

test("views at 176, 120 and 100 columns: Focus, the seat drill-in (live tail), Pool & System", () => {
  for (const [w, h] of [[176, 50], [120, 40], [100, 30]]) {
    const f = render(fixture.raw, hist(), w, h, st({ view: 3 })), p = render(fixture.raw, hist(), w, h, st({ view: 4 })), z = render(fixture.raw, hist(), w, h, st({ seat: SEAT }));
    for (const s of [f, p, z]) assert.ok(s.lines().every((l) => [...l].length === w), `${w}`);
    assert.match(text(f), /what needs me\?[\s\S]*answered in Slack/); assert.match(text(f), /FLEET PULSE/); assert.match(text(f), /LIVE TIMELINE/);
    assert.match(text(p), /WORKING SEATS/); assert.match(text(p), /SUBSCRIPTION POOL/); assert.match(text(p), /─ SYSTEM ─/);
    assert.match(text(z), /impl-codex-4@gamma/); assert.match(text(z), /LIVE TERMINAL/); assert.match(text(z), /CURRENT WORK/);
  }
  const z = text(render(fixture.raw, hist(), 176, 50, st({ seat: SEAT })));
  assert.match(z, /3 passed \(3\)/, "the tail"); assert.doesNotMatch(z, /SESSION BOUNDARY/, "restore markers are dropped");
  assert.match(z, /81% used[\s\S]*Above the 80% handover threshold/); assert.match(z, /RECENT HISTORY[\s\S]*claimed · F-055 fix round/);
  assert.match(text(render(fixture.raw, hist(), 176, 50, st({ seat: SEAT, pane: 1, expand: true }))), /LIVE TERMINAL[\s\S]*Checking types/, "the tail expanded");
  const empty = { ...fixture.raw, attention: [] };
  assert.match(text(render(empty, hist(), 176, 50, st({ view: 3 }))), /Nothing needs you/);
});

function stub() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    const json = (b, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(b)); };
    if (req.url === "/healthz") return json({ status: "ok", pid: process.pid });
    if (req.url === "/api/rigs/summary") return json([{ id: "R1", name: "alpha" }]);
    const node = (name, ingest) => ({ canonicalSessionName: `${name}@alpha`, logicalId: `impl.${name}`, podNamespace: "impl", rigName: "alpha", lifecycleState: "running", nodeKind: "agent",
      activityState: { display: "working" }, contextUsage: { availability: "known", usedPercentage: 40, totalInputTokens: 80000, contextWindowSize: 200000 }, transcriptIngest: ingest });
    const fresh = new Date().toISOString(), old = new Date(Date.now() - 5 * 60_000).toISOString();
    if (req.url.startsWith("/api/rigs/R1/nodes")) return json([node("impl-1", { state: "live", reason: "capture_fresh", lastCapturedAt: fresh }),
      node("degraded-1", { state: "degraded", reason: "capture_missing", lastCapturedAt: null }), node("stale-1", { state: "live", reason: "capture_fresh", lastCapturedAt: old }), node("none-1", undefined)]);
    if (req.url.startsWith("/api/queue/")) return json([]);
    if (req.url.startsWith("/api/transcripts/impl-1%40alpha/tail")) return json({ session: "impl-1@alpha", lines: 150, content: "$ npm test\n ✓ ok\n", ingestHealth: { state: "live" } });
    if (req.url.startsWith("/api/transcripts/")) return json({ error: "No transcript", ingestHealth: { state: "unavailable" } }, 404);
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${server.address().port}`, seen, close: () => { server.closeAllConnections(); server.close(); } })));
}

test("data: the tail of ONE seat, read only while its drill-in is open (the daemon's transcript store, never tmux); tokens for the gauge", async () => {
  const d = await stub(), c = new Cache({ url: d.url, interval: 5000, events: false, run: async () => null });
  try {
    await c.tick(); assert.ok(!d.seen.some((u) => u.includes("/api/transcripts/")), "no drill-in, no tail");
    assert.deepEqual([c.raw.rigs[0].seats[0].tokens, c.raw.rigs[0].seats[0].window, c.raw.rigs[0].seats[0].ingest.state], [80000, 200000, "live"]);
    c.setSeat("impl-1@alpha"); d.seen.length = 0; await c.tick();
    assert.deepEqual(d.seen.filter((u) => u.includes("/api/transcripts/")), ["/api/transcripts/impl-1%40alpha/tail?lines=150"]);
    assert.equal(c.raw.tail.content, "$ npm test\n ✓ ok\n");
    // QA PR92: the tail route STARTS a capture when ingest isn't live, so it is never asked then: the console says why
    for (const [seat, why] of [["degraded-1@alpha", /capture is degraded \(capture_missing\)/], ["stale-1@alpha", /last transcript capture is \d+ s old/],
      ["none-1@alpha", /reports no transcript capture/], ["ghost@alpha", /not a seat this daemon runs/]]) {
      c.setSeat(seat); d.seen.length = 0; await c.tick();
      assert.ok(!d.seen.some((u) => u.includes("/api/transcripts/")), `${seat}: no tail request`);
      assert.equal(c.raw.tail.content, null); assert.match(c.raw.tail.error, why, seat); assert.match(c.raw.tail.error, /never starts a capture/);
    }
    c.setSeat(null); d.seen.length = 0; await c.tick();
    assert.ok(!d.seen.some((u) => u.includes("/api/transcripts/")) && c.raw.tail === null, "closed: no tail");
    initialReads(c, st({ seat: "impl-1@alpha" })); d.seen.length = 0; await c.tick();
    assert.ok(d.seen.some((u) => u.includes("/api/transcripts/impl-1%40alpha/tail")), "--seat reads its tail from the first tick");
  } finally { c.stop(); d.close(); }
});

test("CLI: --view focus|pool, --seat <seat@rig>, --theme (strict); RIG_CONSOLE_THEME", () => {
  assert.equal(parseArgs(["--view", "focus"], {}).view, 3); assert.equal(parseArgs(["--view", "pool"], {}).view, 4);
  assert.equal(parseArgs(["--seat", SEAT], {}).seat, SEAT); assert.equal(parseArgs(["--theme", "nord"], {}).theme, "nord");
  assert.equal(parseArgs([], { RIG_CONSOLE_THEME: "catppuccin" }).theme, "catppuccin"); assert.equal(parseArgs([], { RIG_CONSOLE_THEME: "neon" }).theme, "pad39a");
  for (const bad of [["--seat", "no-rig"], ["--theme", "neon"], ["--view", "constellation"]]) {
    const r = spawnSync(process.execPath, [join(repo, "console/src/main.ts"), ...bad], { encoding: "utf8" });
    assert.equal(r.status, 2, bad.join(" "));
  }
  const r = spawnSync(process.execPath, [join(repo, "console/src/main.ts"), "--once", "--fixture", join(repo, "console/fixtures/demo.json"), "--size", "176x50", "--color", "0", "--seat", SEAT], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /LIVE TERMINAL/);
});
