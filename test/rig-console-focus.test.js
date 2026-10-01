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

test("data: the tail of ONE seat, read only while its drill-in is open, from the daemon's transcript FILE: never a route that can start a capture (QA PR92)", async () => {
  const d = await stub(), tdir = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "rc-transcripts-"));
  fs.mkdirSync(join(tdir, "alpha"));
  fs.writeFileSync(join(tdir, "alpha", "impl-1@alpha.log"), "--- SESSION BOUNDARY: x ---\n\x1b[1m$ npm test\x1b[0m\r\n \x1b[32m✓ ok\x1b[0m\n");
  const c = new Cache({ url: d.url, interval: 5000, events: false, run: async () => null, transcripts: tdir });
  try {
    await c.tick(); assert.equal(c.raw.tail ?? null, null, "no drill-in, no tail");
    assert.deepEqual([c.raw.rigs[0].seats[0].tokens, c.raw.rigs[0].seats[0].window, c.raw.rigs[0].seats[0].ingest.state], [80000, 200000, "live"]);
    c.setSeat("impl-1@alpha"); await c.tick();
    assert.match(c.raw.tail.content, /\$ npm test\n+ ✓ ok/, "the file's tail, ANSI stripped as the daemon does (\\r becomes a line break)");
    assert.ok(!/\x1b/.test(c.raw.tail.content));
    for (const [seat, why] of [["degraded-1@alpha", /no transcript file for this seat \(the daemon's capture is degraded: capture_missing\)/],
      ["ghost@alpha", /not a seat this daemon runs/]]) {
      c.setSeat(seat); await c.tick();
      assert.equal(c.raw.tail.content, null, seat); assert.match(c.raw.tail.error, why, seat);
      if (seat !== "ghost@alpha") assert.match(c.raw.tail.error, /never starts a capture/);
    }
    assert.ok(!d.seen.some((u) => u.includes("/api/transcripts/")), "the transcript route is never called, whatever the ingest state");
    c.setSeat(null); await c.tick(); assert.equal(c.raw.tail, null, "closed: no tail");
    initialReads(c, st({ seat: "impl-1@alpha" })); await c.tick();
    assert.match(c.raw.tail.content, /npm test/, "--seat reads its tail from the first tick");
  } finally { c.stop(); d.close(); fs.rmSync(tdir, { recursive: true, force: true }); }
});

test("QA PR92: Focus reads the done list itself; expanded decisions and the progress list keep the selection drawn; the tail stops at its first page; the seat header never overlaps", async () => {
  const { wantsDone } = await src("main.ts");
  assert.deepEqual([0, 1, 2, 3, 4].map((v) => wantsDone(st({ view: v }))), [false, false, true, true, false]);
  assert.equal(wantsDone(st({ view: 3, seat: SEAT })), false, "a seat drill-in reads its tail, not the done list");
  // many decisions, expanded: the ninth is drawn and marked when selected
  const many = { ...fixture.raw, attention: Array.from({ length: 12 }, (_, i) => ({ ...fixture.raw.attention[0], id: `qitem-dec-${String(i).padStart(4, "0")}`, created: `2026-10-01T1${i % 10}:00:00Z`,
    summary: `Decision number ${i + 1}: pick one. A yes B no` })) };
  const f = derive(many), ninth = f.owner[8];
  const ex = text(render(many, hist(), 100, 30, st({ view: 3, pane: 0, expand: true, select: 8 })));
  assert.match(ex, new RegExp(`▶ 09  ${ninth.summary.split(":")[0]}:`), "the ninth card is drawn and selected"); assert.match(ex, /▲ \d+ more/);
  // progress: many rigs, the last one selected
  const rigs = Array.from({ length: 14 }, (_, i) => ({ id: `R${i}`, name: `rig${String(i).padStart(2, "0")}`, lifecycle: "running", seats: fixture.raw.rigs[1].seats.map((x) => ({ ...x, rig: `rig${String(i).padStart(2, "0")}`, session: x.session.replace("@alpha", `@rig${String(i).padStart(2, "0")}`) })) }));
  const pr = text(render({ ...fixture.raw, rigs }, hist(), 100, 30, st({ view: 3, pane: 2, select: 13 })));
  assert.match(pr, /▶ rig13/, "the selected rig is drawn");
  // the tail's scroll stops at the first page, and the state remembers the clamp
  const s1 = st({ seat: SEAT, pane: 1, select: 200 });
  const t1 = text(render(fixture.raw, hist(), 120, 40, s1));
  assert.match(t1, /Running the locked restore tests/, "the first lines are shown, not a blank pane");
  assert.ok(s1.select < 200 && s1.select >= 0, `clamped to ${s1.select}`);
  // 100 columns: the model and the tail status both readable
  const hdr = render(fixture.raw, hist(), 100, 30, st({ seat: SEAT })).lines().slice(2, 4).join("\n");
  assert.match(hdr, /gpt-6\.1-sol · Codex/); assert.match(hdr, /transcript tail · as of/);
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
