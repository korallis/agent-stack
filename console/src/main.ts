// rig-console: a read-only, full-screen fleet console for OpenRig + agent-stack (WO78: Mission Control, the Seat Matrix,
// the River and a slice's journey, Calm Focus and a seat's drill-in, Pool & System; ':' commands, themes).
//
//   rig-console [--view home|matrix|river|focus|pool] [--slice <project>/<slice>] [--seat <session>] [--stuck-minutes N] [--interval SECONDS] [--url URL] [--color 24|256|16|0] [--theme pad39a] [--history FILE]
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
import { PAD39A, THEMES } from "./theme.ts";
import { classify, derive, STUCK_MINUTES, type Raw } from "./model.ts";
import { Cache } from "./data.ts";
import { History, sampleOf, type Sample } from "./history.ts";
import { home } from "./views/home.ts";
import { grid, matrix } from "./views/matrix.ts";
import { findChip, journeyView, lanes, river } from "./views/river.ts";
import { FOCUS_PANES, SEAT_PANES, focus, seatView, timeline } from "./views/focus.ts";
import { POOL_PANES, poolView } from "./views/pool.ts";
import { slices } from "./model.ts";
import { fit, panel } from "./draw.ts";
import type { Ctx } from "./views/chrome.ts";

const MIN_W = 100, MIN_H = 30;
export const VIEW_NAMES = ["home", "matrix", "river", "focus", "pool"];
const validMinutes = (x: string | undefined): number | null => { const n = Number(x); return x !== undefined && x !== "" && Number.isInteger(n) && n >= 5 && n <= 240 ? n : null; };
interface Args { view: number; interval: number; url: string; depth: Depth | null; once: boolean; size: [number, number] | null; fixture: string | null; history: string | null; slice: string | null; seat: string | null; theme: string; stuckMinutes: number }
function usage(msg?: string): never {
  if (msg) process.stderr.write(`rig-console: ${msg}\n`);
  const text = fs.readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n");
  (msg ? process.stderr : process.stdout).write(text + "\n");
  process.exit(msg ? 2 : 0);
}
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv): Args {
  const a: Args = { view: 0, interval: 5, url: env.OPENRIG_URL || `http://127.0.0.1:${env.OPENRIG_PORT || 7433}`, depth: null, once: false, size: null, fixture: null, history: null, slice: null, seat: null, theme: env.RIG_CONSOLE_THEME && THEMES[env.RIG_CONSOLE_THEME] ? env.RIG_CONSOLE_THEME : "pad39a",
    stuckMinutes: validMinutes(env.RIG_CONSOLE_STUCK_MINUTES) ?? STUCK_MINUTES };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = () => (i + 1 < argv.length ? argv[++i] : usage(`${k} needs a value`));
    if (k === "--view") { const x = v(), i = VIEW_NAMES.indexOf(x); if (i < 0) usage(`--view is ${VIEW_NAMES.join(", ")}, not ${JSON.stringify(x)}`); a.view = i; }
    else if (k === "--seat") { const x = v(); if (!/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(x)) usage("--seat is <seat>@<rig>"); a.seat = x; }
    else if (k === "--slice") { const x = v(); if (!/^[^/\s]+\/[^/\s]+$/.test(x)) usage("--slice is <project>/<slice>"); a.slice = x; a.view = 2; }
    else if (k === "--interval") { const x = Number(v()); if (!(x >= 2 && x <= 600)) usage("--interval is 2 to 600 seconds"); a.interval = x; }
    else if (k === "--url") a.url = v().replace(/\/+$/, "");
    else if (k === "--color") { const x = v(); if (!["24", "256", "16", "0"].includes(x)) usage("--color is 24, 256, 16 or 0"); a.depth = Number(x) as Depth; }
    else if (k === "--theme") { const x = v(); if (!THEMES[x]) usage(`--theme is ${Object.keys(THEMES).join(", ")}`); a.theme = x; }
    else if (k === "--stuck-minutes") { const m = validMinutes(v()); if (m === null) usage("--stuck-minutes is 5 to 240"); a.stuckMinutes = m; }
    else if (k === "--once") a.once = true;
    else if (k === "--size") { const m = v().match(/^(\d+)x(\d+)$/); if (!m) usage("--size is WxH, e.g. 176x50"); a.size = [Number(m[1]), Number(m[2])]; }
    else if (k === "--fixture") a.fixture = v();
    else if (k === "--history") a.history = v();
    else if (k === "-h" || k === "--help") usage();
    else usage(`unknown argument ${JSON.stringify(k)}`);
  }
  return a;
}

export interface ViewState {
  view: number; rigFocus: number; seatFocus: [number, number]; help: boolean; frame: number; note: string | null; riverFocus?: [number, number]; journey?: string | null;
  pane?: number; expand?: boolean; select?: number; cmd?: string | null; seat?: string | null; theme?: string; stuckMinutes?: number;
}
export function render(raw: Raw, hist: History, w: number, h: number, st: ViewState): Screen {
  const t = THEMES[st.theme ?? "pad39a"] ?? PAD39A, s = new Screen(w, h, t.bg);
  raw = classified(raw, st);   // phase 4: derived stuck verdicts, with reasons
  if (w < MIN_W || h < MIN_H) {
    s.put(2, 1, `rig-console needs at least ${MIN_W}×${MIN_H}; this terminal is ${w}×${h}.`, { fg: t.blocked });
    s.put(2, 2, "Widen the window (best at 176×50). q quits.", { fg: t.dim });
    return s;
  }
  const c: Ctx = { s, t, raw, f: derive(raw), frame: st.frame, view: st.view, rigFocus: st.rigFocus, seatFocus: st.seatFocus, note: st.note,
    riverFocus: st.riverFocus ?? [0, 0], journey: st.journey ?? null, pane: st.pane ?? 0, expand: !!st.expand, select: st.select ?? 0, cmd: st.cmd ?? null,
    clampSelect: (n: number) => { st.select = n; } };
  if (st.seat) seatView(c, st.seat);
  else if (st.view === 1) matrix(c, hist);
  else if (st.view === 2) { if (st.journey) journeyView(c, st.journey); else river(c); }
  else if (st.view === 3) focus(c);
  else if (st.view === 4) poolView(c, hist);
  else home(c, hist);
  if (st.help) {
    const lines = [
      "1  Mission Control: hero counts, rigs, work in flight, decisions, pool, events",
      "2  Seat Matrix: every seat, CTX shading, 24 h telemetry, account pool",
      "3  River: slices flowing through the stages per rig; ⏎ on a chip opens its journey ([ ] next slice)",
      "4  Focus: what needs the owner (answered in Slack), fleet pulse, live timeline, progress",
      "5  Pool & System: 24 h graphs, the account pool, system health",
      "⏎ on a seat (matrix) or a timeline item (focus) opens the seat: work, context, history, live tail",
      "Tab  next pane   e  expand / collapse it   j k  select or scroll in it",
      ":    command: home matrix river focus pool · seat <name> · rig <name> · slice <id> · stuck <min> · theme <name> · q",
      "stuck = activity unknown or stalled for N min (default 15) AND no movement on the seat's open rows for N min",
      "←→ / h l   select a rig (home) or a seat (matrix);  ↑↓ / k j  rows in the matrix",
      "⏎          from a rig card: that rig in the Seat Matrix",
      "esc        back (seat, journey, expanded pane, then Mission Control)   r  refresh now (≥ 2 s)",
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

export function loadFixture(file: string): { raw: Raw; history: Sample[] } {
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  return { raw: d.raw as Raw, history: Array.isArray(d.history) ? d.history : [] };
}

/** What the first screen shows decides the first reads (QA PR90: a River or journey opened from the command line read
 *  nothing until a key was pressed); a seat opened with --seat reads its tail at once too. */
export function initialReads(cache: Cache, st: ViewState) {
  cache.setView(wantsDone(st), st.seat ? null : st.journey ?? null);
  cache.setSeat(st.seat ?? null);
}
/** The views that show done slices (the River's DONE column, Focus's progress) read the done list (QA PR92). */
export const wantsDone = (st: ViewState) => !st.seat && (st.view === 2 || st.view === 3);

/** The stuck verdicts at the view's threshold: frames, commands and history samples all classify the same way. */
const classified = (raw: Raw, st: ViewState): Raw => classify({ ...raw, stuckMinutes: st.stuckMinutes ?? raw.stuckMinutes });
export const sampleFor = (raw: Raw, st: ViewState): Sample => sampleOf(derive(classified(raw, st)), raw.at);
const ctxOf = (st: ViewState, raw0: Raw): Ctx => { const raw = classified(raw0, st); return { s: new Screen(1, 1), t: PAD39A, raw, f: derive(raw), frame: 0, view: st.view, rigFocus: st.rigFocus, seatFocus: st.seatFocus,
  note: null, riverFocus: st.riverFocus, journey: st.journey, pane: st.pane, select: st.select } as Ctx; };
const panesOf = (st: ViewState) => (st.seat ? SEAT_PANES : st.view === 3 ? FOCUS_PANES : st.view === 4 ? POOL_PANES : []);

/** One ':' command. Returns a note for the status line (an error or what it did), or "quit". */
export function runCommand(st: ViewState, line: string, raw: Raw): string | null {
  const [word, ...rest] = line.trim().split(/\s+/), arg = rest.join(" ");
  const go = (v: number) => { st.view = v; st.seat = null; st.journey = null; st.pane = 0; st.select = 0; st.expand = false; };
  const views: Record<string, number> = { home: 0, mc: 0, matrix: 1, seats: 1, river: 2, focus: 3, pool: 4, system: 4 };
  if (word === "" ) return null;
  if (word in views) { go(views[word]); return null; }
  if (word === "q" || word === "quit") return "quit";
  if (word === "help") { st.help = true; return null; }
  if (word === "stuck") { const m = validMinutes(arg); if (m === null) return "stuck: minutes from 5 to 240"; st.stuckMinutes = m; return `stuck after ${m} quiet minutes with no queue movement`; }
  if (word === "theme") { if (!THEMES[arg]) return `theme: ${Object.keys(THEMES).join(", ")}`; st.theme = arg; return `theme ${THEMES[arg].name}`; }
  const seats = raw.rigs.flatMap((r) => r.seats).filter((x) => x.kind === "agent");
  if (word === "seat") {
    const hit = seats.find((x) => x.session === arg) ?? seats.filter((x) => x.session.startsWith(arg) || x.session.includes(arg));
    const one = Array.isArray(hit) ? (hit.length === 1 ? hit[0] : null) : hit;
    if (!one) return Array.isArray(hit) && hit.length > 1 ? `seat: ${hit.length} match "${arg}" (${hit.slice(0, 3).map((x) => x.session).join(", ")}…)` : `seat: no seat "${arg}"`;
    st.seat = one.session; st.pane = 0; st.select = 0; st.expand = false; return null;
  }
  if (word === "rig") {
    const i = raw.rigs.findIndex((r) => r.name === arg);
    if (i < 0) return `rig: no rig "${arg}"`;
    go(1); st.seatFocus = [i, 0]; st.rigFocus = i; return null;
  }
  if (word === "slice") {
    const all = slices(raw), hit = all.filter((x) => x.key === arg || x.id.toLowerCase() === arg.toLowerCase() || x.key.endsWith(`/${arg}`));
    if (hit.length !== 1) return hit.length ? `slice: ${hit.length} slices are ${arg} (${hit.map((x) => x.rig).join(", ")}); use <project>/<slice>` : `slice: no open slice "${arg}"`;
    go(2); st.journey = hit[0].key; st.riverFocus = findChip(ctxOf(st, raw), hit[0].key) ?? [0, 0]; return null;
  }
  return `unknown command "${word}" (? for help)`;
}

/** One key against the view state. Returns "quit", "refresh", a note to flash, or null. */
export function handleKey(st: ViewState, key: string, raw: Raw): string | null {
  if (st.cmd !== null && st.cmd !== undefined) {   // typing a ':' command
    if (key === "\x1b" || key === "\x03") st.cmd = null;
    else if (key === "\r") { const line = st.cmd; st.cmd = null; return runCommand(st, line, raw); }
    else if (key === "\x7f" || key === "\b") st.cmd = st.cmd.slice(0, -1);
    else if (key === "\t") { const w = st.cmd.split(" ")[0], m = ["home", "matrix", "river", "focus", "pool", "seat ", "rig ", "slice ", "stuck ", "theme ", "help"].filter((k) => k.startsWith(w)); if (m.length === 1 && !st.cmd.includes(" ")) st.cmd = m[0]; }
    else if (/^[ -~]$/.test(key)) st.cmd += key;
    return null;
  }
  if (key === "q" || key === "\x03") return "quit";
  if (key === ":") { st.cmd = ""; return null; }
  if (key === "?") { st.help = !st.help; return null; }
  if (key === "\x1b") {
    if (st.help) st.help = false; else if (st.expand) st.expand = false; else if (st.seat) { st.seat = null; st.pane = 0; st.select = 0; }
    else if (st.journey) st.journey = null; else st.view = 0;
    return null;
  }
  if (/^[1-5]$/.test(key)) { st.view = Number(key) - 1; st.journey = null; st.seat = null; st.pane = 0; st.select = 0; st.expand = false; return null; }
  if (key === "r") return "refresh";
  const panes = panesOf(st);
  if (key === "\t" && panes.length) { st.pane = ((st.pane ?? 0) + 1) % panes.length; st.select = 0; return null; }
  if (key === "e" && panes.length) { st.expand = !st.expand; return null; }
  const cur = raw;
  if (st.seat) {   // seat drill-in: j/k scroll the tail (when it is the pane)
    if (key === "k" || key === "\x1b[A") st.select = (st.select ?? 0) + 1;
    else if (key === "j" || key === "\x1b[B") st.select = Math.max(0, (st.select ?? 0) - 1);
    return null;
  }
  if (st.view === 3) {
    const pane = FOCUS_PANES[(st.pane ?? 0) % FOCUS_PANES.length], c = ctxOf(st, cur), f = c.f;
    const n = pane === "decisions" ? f.owner.length : pane === "timeline" ? timeline(c).length : cur.rigs.length;
    if (key === "j" || key === "\x1b[B") st.select = Math.min(Math.max(0, n - 1), (st.select ?? 0) + 1);
    else if (key === "k" || key === "\x1b[A") st.select = Math.max(0, (st.select ?? 0) - 1);
    else if (key === "\r") {
      if (pane === "timeline") { const it = timeline(c)[st.select ?? 0]; if (it?.seat && cur.rigs.some((r) => r.seats.some((x) => x.session === it.seat))) { st.seat = it.seat; st.pane = 0; st.select = 0; st.expand = false; } else return "no seat for this item"; }
      else if (pane === "decisions") { const q = f.owner[st.select ?? 0]; if (q && cur.rigs.some((r) => r.seats.some((x) => x.session === q.source))) { st.seat = q.source; st.pane = 0; st.select = 0; st.expand = false; } else return "the decision's sender isn't a seat here"; }
      else { const rig = cur.rigs.filter((r) => r.seats.some((z) => z.kind === "agent"))[st.select ?? 0]; if (rig) runCommand(st, `rig ${rig.name}`, cur); }
    }
    return null;
  }
  if (st.view === 2) {
    const ctx = ctxOf(st, cur);
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
    return null;
  }
  const rigs = cur.rigs.length;
  if (st.view === 0) {
    if (key === "\x1b[C" || key === "l") st.rigFocus = (st.rigFocus + 1) % Math.max(1, rigs);
    else if (key === "\x1b[D" || key === "h") st.rigFocus = (st.rigFocus - 1 + Math.max(1, rigs)) % Math.max(1, rigs);
    else if (key === "\r") { st.view = 1; st.seatFocus = [st.rigFocus, 0]; }
    return null;
  }
  if (st.view === 1) {
    const g = grid(ctxOf(st, cur)), cols = g.rows[0]?.cells.length ?? 1;
    if (key === "\x1b[C" || key === "l") st.seatFocus[1] = Math.min(cols - 1, st.seatFocus[1] + 1);
    else if (key === "\x1b[D" || key === "h") st.seatFocus[1] = Math.max(0, st.seatFocus[1] - 1);
    else if (key === "\x1b[B" || key === "j") st.seatFocus[0] = Math.min(Math.max(0, rigs - 1), st.seatFocus[0] + 1);
    else if (key === "\x1b[A" || key === "k") st.seatFocus[0] = Math.max(0, st.seatFocus[0] - 1);
    else if (key === "\r") { const seat = g.rows[st.seatFocus[0]]?.cells[st.seatFocus[1]]; if (seat) { st.seat = seat.session; st.pane = 0; st.select = 0; st.expand = false; } else return "an empty slot: no seat here"; }
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), process.env);
  const depth: Depth = args.depth ?? detectDepth(process.env);
  const stateDir = process.env.AGENT_STACK_STATE || path.join(os.homedir(), ".local/state/agent-stack");
  const st: ViewState = { view: args.view, rigFocus: 0, seatFocus: [0, 0], help: false, frame: 0, note: null, riverFocus: [0, 0], journey: args.slice,
    pane: 0, expand: false, select: 0, cmd: null, seat: args.seat, theme: args.theme, stuckMinutes: args.stuckMinutes };
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
      initialReads(cache, st);
      await cache.tick();
      if (st.journey) { cache.setView(true, st.journey); await cache.tick(); }   // its rows are known after the first read
      cache.stop(); raw = cache.raw; hist.add(sampleFor(raw, st)); }
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
    cache.onChange(() => { hist.add(sampleFor(cache!.raw, st)); schedule(); });
    initialReads(cache, st);
    cache.start();
  }
  setInterval(() => { st.frame++; schedule(); }, 1000);
  const flash = (m: string) => { st.note = m; schedule(); setTimeout(() => { st.note = null; schedule(); }, 1500); };
  // one read can carry several keys (a paste, a fast typist, tmux send-keys): split into escape sequences and characters
  const keys = (chunk: string) => chunk.match(/\x1b\[[0-9;]*[A-Za-z~]|\x1bO[A-Za-z]|\x1b(?!\[)|[\s\S]/g) ?? [];
  const onKey = (key: string) => {
    const act = handleKey(st, key, cache ? cache.raw : raw);
    if (act === "quit") return quit();
    if (act === "refresh") { if (cache) { cache.soon(); flash("refreshing"); } else flash("fixture: nothing to refresh"); }
    else if (act) flash(act);
  };
  process.stdin.on("data", (chunk: string) => {
    for (const k of keys(chunk)) onKey(k);
    cache?.setView(wantsDone(st), st.seat ? null : st.journey ?? null); cache?.setSeat(st.seat ?? null);
    schedule();
  });
  draw();
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/rig-console") || process.argv[1]?.endsWith("main.ts")) {
  main().catch((e) => { process.stdout.write(ALT_OFF); console.error(`rig-console: ${e instanceof Error ? e.message : e}`); process.exit(1); });
}
