// rig-console: a read-only, full-screen fleet console for OpenRig + agent-stack (WO78: Mission Control, the Seat Matrix,
// the River and a slice's journey).
//
//   rig-console [--view home|matrix|river] [--slice <project>/<slice>] [--interval SECONDS] [--url URL] [--color 24|256|16|0] [--theme pad39a] [--history FILE]
//   rig-console --once [--size WxH] [--fixture FILE] [--view ...]     one frame to stdout, then exit
//
// Data: the daemon's HTTP API (rigs, nodes, queue, owner attention, healthz) and its live event stream, plus local
// read-only sources: the Jev decision log, `agent-proxy-status --json`, `agent-heavy status`, /proc. One cache, one
// timer (default 5 s, never under 2 s, backing off when the daemon is slow). It changes nothing and never runs tmux.
// --fixture draws a saved snapshot instead (the neutral demo: console/fixtures/demo.json).
// History for the 24 h graphs: $AGENT_STACK_STATE/rig-console/history.json (default ~/.local/state/agent-stack).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ALT_OFF, ALT_ON, detectDepth, dump, frame, Screen, type Depth } from "./term.ts";
import { PAD39A } from "./theme.ts";
import { derive, type Raw } from "./model.ts";
import { Cache } from "./data.ts";
import { History, sampleOf, type Sample } from "./history.ts";
import { home } from "./views/home.ts";
import { grid, matrix } from "./views/matrix.ts";
import { findChip, journeyView, lanes, river } from "./views/river.ts";
import { fit, panel } from "./draw.ts";
import type { Ctx } from "./views/chrome.ts";

const MIN_W = 100, MIN_H = 30;
interface Args { view: number; interval: number; url: string; depth: Depth | null; once: boolean; size: [number, number] | null; fixture: string | null; history: string | null; slice: string | null }
function usage(msg?: string): never {
  if (msg) process.stderr.write(`rig-console: ${msg}\n`);
  const text = fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n");
  (msg ? process.stderr : process.stdout).write(text + "\n");
  process.exit(msg ? 2 : 0);
}
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv): Args {
  const a: Args = { view: 0, interval: 5, url: env.OPENRIG_URL || `http://127.0.0.1:${env.OPENRIG_PORT || 7433}`, depth: null, once: false, size: null, fixture: null, history: null, slice: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = () => (i + 1 < argv.length ? argv[++i] : usage(`${k} needs a value`));
    if (k === "--view") { const x = v(); a.view = x === "home" ? 0 : x === "matrix" ? 1 : x === "river" ? 2 : usage(`--view is home, matrix or river, not ${JSON.stringify(x)}`); }
    else if (k === "--slice") { const x = v(); if (!/^[^/\s]+\/[^/\s]+$/.test(x)) usage("--slice is <project>/<slice>"); a.slice = x; a.view = 2; }
    else if (k === "--interval") { const x = Number(v()); if (!(x >= 2 && x <= 600)) usage("--interval is 2 to 600 seconds"); a.interval = x; }
    else if (k === "--url") a.url = v().replace(/\/+$/, "");
    else if (k === "--color") { const x = v(); if (!["24", "256", "16", "0"].includes(x)) usage("--color is 24, 256, 16 or 0"); a.depth = Number(x) as Depth; }
    else if (k === "--theme") { const x = v(); if (x !== "pad39a") usage("--theme: pad39a (more themes come in phase 3)"); }
    else if (k === "--once") a.once = true;
    else if (k === "--size") { const m = v().match(/^(\d+)x(\d+)$/); if (!m) usage("--size is WxH, e.g. 176x50"); a.size = [Number(m[1]), Number(m[2])]; }
    else if (k === "--fixture") a.fixture = v();
    else if (k === "--history") a.history = v();
    else if (k === "-h" || k === "--help") usage();
    else usage(`unknown argument ${JSON.stringify(k)}`);
  }
  return a;
}

export interface ViewState { view: number; rigFocus: number; seatFocus: [number, number]; help: boolean; frame: number; note: string | null; riverFocus?: [number, number]; journey?: string | null }
export function render(raw: Raw, hist: History, w: number, h: number, st: ViewState): Screen {
  const t = PAD39A, s = new Screen(w, h, t.bg);
  if (w < MIN_W || h < MIN_H) {
    s.put(2, 1, `rig-console needs at least ${MIN_W}×${MIN_H}; this terminal is ${w}×${h}.`, { fg: t.blocked });
    s.put(2, 2, "Widen the window (best at 176×50). q quits.", { fg: t.dim });
    return s;
  }
  const c: Ctx = { s, t, raw, f: derive(raw), frame: st.frame, view: st.view, rigFocus: st.rigFocus, seatFocus: st.seatFocus, note: st.note,
    riverFocus: st.riverFocus ?? [0, 0], journey: st.journey ?? null };
  if (st.view === 1) matrix(c, hist); else if (st.view === 2) { if (st.journey) journeyView(c, st.journey); else river(c); } else home(c, hist);
  if (st.help) {
    const lines = [
      "1  Mission Control: hero counts, rigs, work in flight, decisions, pool, events",
      "2  Seat Matrix: every seat, CTX shading, 24 h telemetry, account pool",
      "3  River: slices flowing through the stages per rig; ⏎ on a chip opens its journey",
      "   journey: [ ] previous / next slice, esc back to the river",
      "←→ / h l   select a rig (home) or a seat (matrix);  ↑↓ / k j  rows in the matrix",
      "⏎          from a rig card: that rig in the Seat Matrix",
      "esc        back to Mission Control      r  refresh now (never sooner than 2 s)",
      "?          this help                    q  quit",
      "",
      "Read-only: the console changes nothing. Data refreshes every few seconds from the daemon",
      "API and its live event stream; it never polls tmux.",
    ];
    const bw = 92, bh = lines.length + 4, bx = Math.floor((w - bw) / 2), by = Math.floor((h - bh) / 2);
    s.fill(bx, by, bw, bh, " ", { bg: t.panel });
    panel(s, t, bx, by, bw, bh, "HELP", { color: t.title });
    lines.forEach((l, i) => s.put(bx + 3, by + 2 + i, fit(l, bw - 6), { fg: t.text, bg: t.panel }));
  }
  return s;
}

function loadFixture(file: string): { raw: Raw; history: Sample[] } {
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  return { raw: d.raw as Raw, history: Array.isArray(d.history) ? d.history : [] };
}

/** What the first screen shows decides the first reads (QA PR90: a River or journey opened from the command line read
 *  nothing until a key was pressed). */
export function initialReads(cache: Cache, st: ViewState) {
  cache.setView(st.view === 2, st.journey ?? null);
}

async function main() {
  const args = parseArgs(process.argv.slice(2), process.env);
  const depth: Depth = args.depth ?? detectDepth(process.env);
  const stateDir = process.env.AGENT_STACK_STATE || path.join(os.homedir(), ".local/state/agent-stack");
  const st: ViewState = { view: args.view, rigFocus: 0, seatFocus: [0, 0], help: false, frame: 0, note: null, riverFocus: [0, 0], journey: args.slice };
  let raw: Raw, hist: History, cache: Cache | null = null;
  if (args.fixture) {
    const fx = loadFixture(args.fixture);
    raw = fx.raw; hist = new History(null); hist.samples = fx.history;
  } else {
    hist = new History(args.history ?? path.join(stateDir, "rig-console", "history.json"));
    cache = new Cache({ url: args.url, interval: args.interval * 1000, jevLog: path.join(stateDir, "jev-decisions.jsonl"), events: !args.once });
    raw = cache.raw;
  }
  const size = (): [number, number] => args.size ?? [process.stdout.columns || 176, process.stdout.rows || 50];

  if (args.once) {
    if (cache) {
      cache.setView(st.view === 2, st.journey ?? null);
      await cache.tick();
      if (st.journey) { cache.setView(true, st.journey); await cache.tick(); }   // its rows are known after the first read
      cache.stop(); raw = cache.raw; hist.add(sampleOf(derive(raw), raw.at)); }
    const [w, h] = size();
    process.stdout.write(dump(render(raw, hist, w, h, st), depth));
    return;
  }
  if (!process.stdout.isTTY || !process.stdin.isTTY) usage("needs a terminal (use --once for a single frame)");
  let prev: Screen | null = null, pending = false;
  const draw = () => {
    pending = false;
    const [w, h] = size();
    const next = render(cache ? cache.raw : raw, hist, w, h, st);
    process.stdout.write(frame(next, prev, depth));
    prev = next;
  };
  const schedule = () => { if (!pending) { pending = true; setTimeout(draw, 50); } };
  const quit = () => { cache?.stop(); process.stdout.write(ALT_OFF); process.exit(0); };
  process.stdout.write(ALT_ON);
  process.on("SIGINT", quit); process.on("SIGTERM", quit);
  process.on("uncaughtException", (e) => { process.stdout.write(ALT_OFF); console.error(e); process.exit(1); });
  process.stdout.on("resize", () => { prev = null; schedule(); });
  process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding("utf8");
  if (cache) {
    cache.onChange(() => { const r = cache!.raw; hist.add(sampleOf(derive(r), r.at)); schedule(); });
    initialReads(cache, st);
    cache.start();
  }
  setInterval(() => { st.frame++; schedule(); }, 1000);
  const flash = (m: string) => { st.note = m; schedule(); setTimeout(() => { st.note = null; schedule(); }, 1500); };
  // one read can carry several keys (a paste, a fast typist, tmux send-keys): split into escape sequences and characters
  const keys = (chunk: string) => chunk.match(/\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Za-z]|\x1b(?!\[)|[\s\S]/g) ?? [];
  const onKey = (key: string) => {
    const cur = cache ? cache.raw : raw;
    const rigs = cur.rigs.length;
    if (key === "q" || key === "\x03") return quit();
    if (key === "?") st.help = !st.help;
    else if (key === "\x1b") { if (st.help) st.help = false; else if (st.journey) st.journey = null; else st.view = 0; }
    else if (key === "1") { st.view = 0; st.journey = null; }
    else if (key === "2") { st.view = 1; st.journey = null; }
    else if (key === "3") st.view = 2;
    else if (key === "r") { if (cache) { cache.soon(); flash("refreshing"); } else flash("fixture: nothing to refresh"); }
    else if (st.view === 2) {
      const ctx = { s: new Screen(1, 1), t: PAD39A, raw: cur, f: derive(cur), frame: 0, view: 2, rigFocus: 0, seatFocus: st.seatFocus, note: null, riverFocus: st.riverFocus, journey: st.journey } as Ctx;
      const L = lanes(ctx), flat = L.flatMap((l) => l.slices);
      const [li, ci] = st.riverFocus ?? [0, 0];
      if (st.journey) {
        const at = flat.findIndex((x) => x.key === st.journey);
        if (key === "[" || key === "]") {
          const nx = flat[Math.max(0, Math.min(flat.length - 1, (at < 0 ? 0 : at) + (key === "]" ? 1 : -1)))];
          if (nx) { st.journey = nx.key; st.riverFocus = findChip(ctx, nx.key) ?? st.riverFocus; }
        }
      } else if (key === "\x1b[C" || key === "l") st.riverFocus = [li, Math.min(Math.max(0, (L[li]?.slices.length ?? 1) - 1), ci + 1)];
      else if (key === "\x1b[D" || key === "h") st.riverFocus = [li, Math.max(0, ci - 1)];
      else if (key === "\x1b[B" || key === "j") st.riverFocus = [Math.min(L.length - 1, li + 1), 0];
      else if (key === "\x1b[A" || key === "k") st.riverFocus = [Math.max(0, li - 1), 0];
      else if (key === "\r") { const sl = L[li]?.slices[ci]; if (sl) st.journey = sl.key; }
    }
    else if (st.view === 0) {
      if (key === "\x1b[C" || key === "l" || key === "\t") st.rigFocus = (st.rigFocus + 1) % Math.max(1, rigs);
      else if (key === "\x1b[D" || key === "h") st.rigFocus = (st.rigFocus - 1 + Math.max(1, rigs)) % Math.max(1, rigs);
      else if (key === "\r") { st.view = 1; st.seatFocus = [st.rigFocus, 0]; }
    } else {
      const g = grid({ s: new Screen(1, 1), t: PAD39A, raw: cur, f: derive(cur), frame: 0, view: 1, rigFocus: 0, seatFocus: st.seatFocus, note: null });
      const cols = g.rows[0]?.cells.length ?? 1;
      if (key === "\x1b[C" || key === "l") st.seatFocus[1] = Math.min(cols - 1, st.seatFocus[1] + 1);
      else if (key === "\x1b[D" || key === "h") st.seatFocus[1] = Math.max(0, st.seatFocus[1] - 1);
      else if (key === "\x1b[B" || key === "j") st.seatFocus[0] = Math.min(Math.max(0, rigs - 1), st.seatFocus[0] + 1);
      else if (key === "\x1b[A" || key === "k") st.seatFocus[0] = Math.max(0, st.seatFocus[0] - 1);
      else if (key === "\r") { st.view = 0; st.rigFocus = st.seatFocus[0]; }
    }
  };
  process.stdin.on("data", (chunk: string) => { for (const k of keys(chunk)) onKey(k); cache?.setView(st.view === 2, st.journey ?? null); schedule(); });
  draw();
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/rig-console") || process.argv[1]?.endsWith("main.ts")) {
  main().catch((e) => { process.stdout.write(ALT_OFF); console.error(`rig-console: ${e instanceof Error ? e.message : e}`); process.exit(1); });
}
