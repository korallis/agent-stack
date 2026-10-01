// One cache, refreshed on a timer, for every source the console shows. Read-only, and gentle with the daemon:
//   - the daemon tier, one request at a time: healthz and each rig's nodes every `interval` (>= 2 s, default 5 s); the
//     rig list every 60 s and the active queue + owner attention every 30 s, sooner when a node or queue event says
//     they changed. A slow or failed read doubles the interval (up to 60 s), a fast one halves it back. Nodes are read
//     without ?full / ?refresh, which never capture a tmux pane;
//   - the River (phase 2) only while it is open: done rows every 5 min (a 400-row read costs the daemon ~0.14 s); a slice's row transitions only for the journey
//     on screen (its newest 20 rows, each re-read only when the row changed);
//   - local sources (gate log, account pool, heavy slots, host) on their own slower clocks;
//   - the ticker: the queue's recent transitions (a bounded read, with the queue tier) and queue creations from the
//     live-only /api/queue/sse, whose events also pull the next queue read forward (never sooner than 2 s after the
//     last). No cursor and no replay: it works on a quiet fleet as on a busy one (QA PR86).
// It never runs tmux: no per-seat polling, and phase 1 has no terminal tail at all.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { eventLine, journey, qrowFromItem, seatFromNode, transitionLine, type Account, type Event, type Gate, type Heavy, type Raw, type Rig } from "./model.ts";

export interface Options {
  url: string; interval: number; procDir?: string; jevLog?: string | null; timeoutMs?: number;
  run?: (cmd: string, args: string[], timeoutMs: number) => Promise<string | null>; now?: () => number; events?: boolean;
  gateDayMax?: number;   // tests only
}
export const MIN_INTERVAL = 2000, MAX_INTERVAL = 60_000, RIGS_EVERY = 60_000, QUEUE_EVERY = 30_000, DONE_EVERY = 300_000, JOURNEY_ROWS = 20;
/** The most of the gate log read for one UTC day; past it the count is shown as partial (a lower bound). */
export const GATE_DAY_MAX = 64 << 20;

const runDefault = (cmd: string, args: string[], timeoutMs: number) => new Promise<string | null>((resolve) => {
  execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 << 20 }, (err, stdout) => resolve(err ? null : stdout));
});

export function parseHeavy(text: string | null): Heavy[] {
  if (!text) return [];
  const by = new Map<string, Heavy>();
  for (const l of text.split("\n")) {
    let m = l.match(/^(\w+) (\d+)\/(\d+)\s+(\w+)/);
    if (m) { const h = by.get(m[1]) ?? { cls: m[1], held: 0, total: Number(m[3]), waiting: 0 }; if (m[4] === "held") h.held++; by.set(m[1], h); continue; }
    m = l.match(/^(\w+) queue (\d+)\s/);
    if (m && by.has(m[1])) by.get(m[1])!.waiting = Math.max(by.get(m[1])!.waiting, Number(m[2]));
  }
  return [...by.values()];
}
/** A quota reading as a percent. The proxy passes the upstream header through as a string: Anthropic's
 *  unified-utilization headers are fractions (0.29, and 1.01 when over), Codex's used-percent headers are percents
 *  ("100"), so the unit follows the provider, never the magnitude. */
export function quotaPct(v: unknown, provider: string): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.round(provider === "claude" ? n * 100 : n);
}
export function parseAccounts(text: string | null): Account[] {
  if (!text) return [];
  try {
    const a = JSON.parse(text);
    return (Array.isArray(a) ? a : []).map((x: any) => ({ label: String(x.label), provider: String(x.provider ?? ""), status: String(x.status ?? "?"),
      short: quotaPct(x.short_window_used, String(x.provider ?? "")), weekly: quotaPct(x.weekly_used, String(x.provider ?? "")),
      cooling: x.status !== "active" || (Array.isArray(x.cooldowns) && x.cooldowns.length > 0) }));
  } catch { return []; }
}
/** Today's merge-gate decisions from the Jev decision log. Diagnosis calls are excluded, whether the caller is
 *  "diagnosis:<label>" or a seat with a diagnosis note ("<seat> diagnosis <what>"). */
export function parseGates(lines: string[]): Gate[] {
  const out: Gate[] = [];
  for (const l of lines) {
    if (!l.includes('"review.merge_gate"')) continue;
    try {
      const d = JSON.parse(l);
      if (d.decision !== "review.merge_gate" || /(^|\s)diagnosis(:|\s|$)/.test(String(d.caller ?? ""))) continue;
      out.push({ ts: String(d.ts), decision: String(d.result?.decision ?? "hold"), band: String(d.band ?? "?") });
    } catch { /* a torn line */ }
  }
  return out;
}

export class Cache {
  opt: Required<Omit<Options, "run" | "now">> & Pick<Options, "run" | "now">;
  raw: Raw;
  interval: number;
  lastDaemonAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private again = false;
  private stopped = false;
  private jevOffset = 0;
  private gates: Gate[] = [];
  private lastLocal: Record<string, number> = {};
  private cpu: { ticks: number; at: number; pid: number } | null = null;
  private ticker = new Map<string, Event & { key: string }>();
  private gateDay = "";
  private gatePartial = false;
  private abort: AbortController | null = null;
  private listeners: (() => void)[] = [];
  private summary: any[] | null = null;
  private summaryAt = -Infinity;
  private queueAt = -Infinity;
  private dirty = { rigs: false, queue: false };
  private river = false;
  private journeyKey: string | null = null;
  private doneAt = -Infinity;
  private trSeen = new Map<string, string>();   // qitem id -> its updated time when its transitions were read
  requests = 0;
  constructor(o: Options) {
    this.opt = { procDir: "/proc", jevLog: null, timeoutMs: 4000, events: true, gateDayMax: GATE_DAY_MAX, ...o, interval: Math.max(MIN_INTERVAL, o.interval) } as Cache["opt"];
    this.interval = this.opt.interval;
    this.raw = {
      at: this.now(), host: { id: os.hostname(), cores: os.cpus().length, load: [0, 0, 0], memUsedGB: 0, memTotalGB: 0 },
      daemon: { ok: false, latencyMs: null, version: null, cpuPct: null, loopUtil: null, error: "connecting" },
      rigs: [], queue: [], attention: [], gates: [], accounts: [], heavy: [], events: [], refreshMs: this.interval, sources: {},
    };
  }
  private now() { return this.opt.now ? this.opt.now() : Date.now(); }
  onChange(f: () => void) { this.listeners.push(f); }
  private changed() { for (const f of this.listeners) f(); }

  start() { void this.tick(); if (this.opt.events) void this.events(); }
  stop() { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.abort?.abort(); }
  /** Pulls the next refresh forward (an event, or 'r'), never sooner than MIN_INTERVAL after the last daemon read. */
  soon() {
    if (this.stopped) return;
    if (this.busy) { this.again = true; return; }   // a change arrived during a read: one more read right after it
    const wait = Math.max(0, this.lastDaemonAt + MIN_INTERVAL - this.now());
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), wait);
  }

  private async get(p: string): Promise<any> {
    this.requests++;
    const res = await fetch(this.opt.url + p, { signal: AbortSignal.timeout(this.opt.timeoutMs) });
    if (!res.ok) throw new Error(`${p}: HTTP ${res.status}`);
    return res.json();
  }

  async tick(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    const t0 = this.now();
    try {
      await this.readDaemon();
      const took = this.now() - t0;
      this.interval = took > 1500 ? Math.min(MAX_INTERVAL, this.interval * 2) : Math.max(this.opt.interval, Math.round(this.interval / 2));
    } catch (e) {
      this.raw.daemon = { ...this.raw.daemon, ok: false, error: e instanceof Error ? e.message.slice(0, 120) : "unreachable" };
      this.interval = Math.min(MAX_INTERVAL, this.interval * 2);
    }
    this.lastDaemonAt = this.now();
    await this.readLocal().catch(() => {});
    this.raw.at = this.now(); this.raw.refreshMs = this.interval;
    this.busy = false;
    this.changed();
    if (!this.stopped) {
      if (this.timer) clearTimeout(this.timer);
      const wait = this.again ? MIN_INTERVAL : this.interval; this.again = false;
      this.timer = setTimeout(() => void this.tick(), wait);
    }
  }

  private async readDaemon() {
    const t0 = this.now();
    const hz = await this.get("/healthz");
    const latency = this.now() - t0;
    this.raw.host.id = hz.selfHostId ?? this.raw.host.id;
    if (!this.summary || this.dirty.rigs || this.now() - this.summaryAt >= RIGS_EVERY) {
      this.dirty.rigs = false; this.summary = await this.get("/api/rigs/summary"); this.summaryAt = this.now();
    }
    const rigs: Rig[] = [];
    for (const r of this.summary!.filter((x) => !x.archivedAt)) {
      const nodes: any[] = await this.get(`/api/rigs/${encodeURIComponent(r.id)}/nodes`);
      rigs.push({ id: r.id, name: r.name, lifecycle: r.lifecycleState ?? "unknown", seats: nodes.map(seatFromNode) });
    }
    if (this.dirty.queue || this.now() - this.queueAt >= QUEUE_EVERY) {
      this.dirty.queue = false;
      const queue: any[] = await this.get("/api/queue/list?compact=1&state=pending,in-progress,blocked&limit=5000");
      const attention: any[] = await this.get("/api/queue/list?compact=1&attention=1&limit=200");
      this.raw.queue = queue.map(qrowFromItem); this.raw.attention = attention.map(qrowFromItem); this.queueAt = this.now();
      const tr: any[] = await this.get("/api/queue/recent-transitions?scope=instance&limit=40");
      for (const x of Array.isArray(tr) ? tr : []) { const l = transitionLine(x); if (l) this.addTicker(`t${x.transitionId}`, l); }
    }
    this.raw.rigs = rigs;
    if (this.river && this.now() - this.doneAt >= DONE_EVERY) {
      const done: any[] = await this.get("/api/queue/list?compact=1&state=done&limit=400");
      this.raw.done = done.map(qrowFromItem); this.doneAt = this.now();
    }
    if (this.journeyKey) await this.readJourney(this.journeyKey);
    this.raw.daemon = { ok: hz.status === "ok", latencyMs: latency, version: hz.semver ?? null, cpuPct: this.daemonCpu(Number(hz.pid)),
      loopUtil: typeof hz.eventLoop?.utilization === "number" ? hz.eventLoop.utilization : null, error: null };
    this.raw.sources.daemon = "ok";
  }
  /** The daemon's CPU % since the last read, from /proc/<pid>/stat (utime + stime), across all cores as 100% = one. */
  private daemonCpu(pid: number): number | null {
    try {
      const f = fs.readFileSync(path.join(this.opt.procDir, String(pid), "stat"), "utf8").replace(/^.*\) /, "").split(" ");
      const ticks = Number(f[11]) + Number(f[12]), at = this.now();
      const prev = this.cpu; this.cpu = { ticks, at, pid };
      if (!prev || prev.pid !== pid || at <= prev.at) return this.raw.daemon.cpuPct;
      return Math.round(((ticks - prev.ticks) / 100) / ((at - prev.at) / 1000) * 1000) / 10;
    } catch { return null; }
  }
  private due(name: string, every: number) {
    const now = this.now();
    if (now - (this.lastLocal[name] ?? 0) < every) return false;
    this.lastLocal[name] = now; return true;
  }
  private async readLocal() {
    const run = this.opt.run ?? runDefault;
    try {
      const l = fs.readFileSync(path.join(this.opt.procDir, "loadavg"), "utf8").split(" ").slice(0, 3).map(Number);
      const mi = fs.readFileSync(path.join(this.opt.procDir, "meminfo"), "utf8");
      const kb = (k: string) => Number(mi.match(new RegExp(`^${k}:\\s+(\\d+)`, "m"))?.[1] ?? 0);
      this.raw.host.load = l; this.raw.host.memTotalGB = kb("MemTotal") / 1048576; this.raw.host.memUsedGB = (kb("MemTotal") - kb("MemAvailable")) / 1048576;
    } catch { /* not Linux */ }
    if (this.due("accounts", 30_000)) { const a = parseAccounts(await run("agent-proxy-status", ["--json"], 5000)); this.raw.accounts = a; this.raw.sources.accounts = a.length ? "ok" : "unavailable"; }
    if (this.due("heavy", 10_000)) { const h = parseHeavy(await run("agent-heavy", ["status"], 5000)); this.raw.heavy = h; this.raw.sources.heavy = h.length ? "ok" : "unavailable"; }
    if (this.opt.jevLog && this.due("gates", 10_000)) this.readGates(this.opt.jevLog);
    const today = new Date(this.now()).toISOString().slice(0, 10);
    this.raw.gates = this.gates = this.gates.filter((g) => g.ts.startsWith(today));
  }
  /** Reads the decision log for the current UTC day: the first time (and at each new day) from the day's first line,
   *  found by a binary search over the append-only, time-ordered log; then from where it left off. When the day alone
   *  is over GATE_DAY_MAX, only its last GATE_DAY_MAX are read and the count is marked partial, never shown as whole. */
  private readGates(file: string) {
    try {
      const st = fs.statSync(file), day = new Date(this.now()).toISOString().slice(0, 10);
      const fd = fs.openSync(file, "r");
      try {
        if (day !== this.gateDay || st.size < this.jevOffset) {
          this.gateDay = day; this.gates = []; this.gatePartial = false;
          let from = dayStart(fd, st.size, `${day}T00:00:00`);
          if (st.size - from > this.opt.gateDayMax) { from = st.size - this.opt.gateDayMax; this.gatePartial = true; }
          this.jevOffset = from;
        }
        const len = st.size - this.jevOffset;
        // every successful read states the source afresh: a read after a failure recovers it (QA PR86)
        this.raw.sources.gates = this.gatePartial ? "partial" : "ok";
        if (len <= 0) return;
        const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, this.jevOffset);
        let text = buf.toString("utf8");
        const cut = text.lastIndexOf("\n") + 1;
        text = text.slice(0, cut);
        let lines = text.split("\n");
        // a start inside a line (the partial case) drops that line
        if (this.jevOffset > 0 && !isLineStart(fd, this.jevOffset)) lines = lines.slice(1);
        this.gates.push(...parseGates(lines).filter((g) => g.ts.startsWith(day)));
        this.jevOffset += Buffer.byteLength(text);
      } finally { fs.closeSync(fd); }
    } catch { this.raw.sources.gates = "unavailable"; }
  }
  /** What the screen shows decides what the River tier reads: the done list while the River is open, transitions for
   *  the one journey open. Opening either pulls the next read forward. */
  setView(river: boolean, journeyKey: string | null) {
    const pull = (river && !this.river) || (journeyKey !== null && journeyKey !== this.journeyKey);
    this.river = river; this.journeyKey = journeyKey;
    if (pull) this.soon();
  }
  private async readJourney(key: string) {
    const rows = journey(this.raw, key).steps.map((s) => s.row).sort((a, b) => b.updated.localeCompare(a.updated)).slice(0, JOURNEY_ROWS);
    const tr = (this.raw.transitions ??= {});
    for (const r of rows) {
      if (this.trSeen.get(r.id) === r.updated && tr[r.id]) continue;
      const list: any[] = await this.get(`/api/queue/${encodeURIComponent(r.id)}/transitions`);
      tr[r.id] = (Array.isArray(list) ? list : []).map((x) => ({ id: x.transitionId, ts: x.ts, state: x.state, note: x.transitionNote ?? "", actor: x.actorSession ?? "" }));
      this.trSeen.set(r.id, r.updated);
    }
  }
  private addTicker(key: string, e: Event) {
    if (this.ticker.has(key)) return;
    this.ticker.set(key, { ...e, key });
    const all = [...this.ticker.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 60);
    this.ticker = new Map(all.map((x) => [x.key, x]));
    this.raw.events = all.map(({ key: _k, ...rest }) => rest);
  }

  // ── live events ──────────────────────────────────────────────────────────────────────────────────────────────────
  /** The live-only queue stream: a creation goes on the ticker as it happens (creations aren't transitions); every
   *  queue event marks the queue changed and pulls the next read forward. Reconnects with backoff. */
  private async events() {
    let backoff = 2000;
    while (!this.stopped) {
      try {
        await this.stream("/api/queue/sse", {}, (e) => {
          backoff = 2000;
          if (e.type === "queue.created") { const l = eventLine(e); if (l) { this.addTicker(`c${e.qitemId ?? e.seq}`, l); this.changed(); } }
          this.dirty.queue = true; this.soon();
        });
      } catch { /* daemon away: retry */ }
      if (this.stopped) break;
      await new Promise((r) => setTimeout(r, backoff)); backoff = Math.min(60_000, backoff * 2);
    }
  }
  private async stream(p: string, headers: Record<string, string>, onEvent: (e: any) => void, ac = new AbortController()) {
    this.abort = ac;
    this.requests++;
    const res = await fetch(this.opt.url + p, { headers: { Accept: "text/event-stream", ...headers }, signal: ac.signal });
    if (!res.ok || !res.body) throw new Error(`${p}: HTTP ${res.status}`);
    const dec = new TextDecoder(); let buf = "";
    for await (const chunk of res.body as any) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
        if (data) { try { onEvent(JSON.parse(data)); } catch { /* not JSON */ } }
      }
      if (this.stopped) { ac.abort(); break; }
    }
  }
}

/** The offset of the first line whose "ts" is at or after `dayIso` in a time-ordered JSONL log (binary search over
 *  line starts; reads a few KB per step). */
export function dayStart(fd: number, size: number, dayIso: string): number {
  const lineAt = (pos: number): { start: number; ts: string | null } | null => {
    let start = pos;
    if (pos > 0) {
      const b = Buffer.alloc(65536); const n = fs.readSync(fd, b, 0, b.length, pos - 1);
      const i = b.subarray(0, n).indexOf(10);
      if (i < 0) return null;
      start = pos - 1 + i + 1;
    }
    if (start >= size) return null;
    const b = Buffer.alloc(4096); const n = fs.readSync(fd, b, 0, b.length, start);
    const m = b.subarray(0, n).toString("utf8").match(/"ts"\s*:\s*"([^"]+)"/);
    return { start, ts: m ? m[1] : null };
  };
  let lo = 0, hi = size;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2), l = lineAt(mid);
    if (!l || l.ts === null || l.ts >= dayIso) hi = mid; else lo = mid;
  }
  // lineAt(lo) is before the day (or lo is 0), lineAt(hi) is the first line at or after it
  const l0 = lineAt(0);
  if (lo === 0 && l0 && l0.ts !== null && l0.ts >= dayIso) return 0;
  const first = lineAt(hi);
  return first ? first.start : size;
}
function isLineStart(fd: number, pos: number): boolean {
  const b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, pos - 1); return b[0] === 10;
}
