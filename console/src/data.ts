// One cache, refreshed on a timer, for every source the console shows. Read-only, and gentle with the daemon:
//   - the daemon tier, one request at a time: healthz and each rig's nodes every `interval` (>= 2 s, default 5 s); the
//     rig list every 60 s and the active queue + owner attention every 30 s, sooner when a node or queue event says
//     they changed. A slow or failed read doubles the interval (up to 60 s), a fast one halves it back. Nodes are read
//     without ?full / ?refresh, which never capture a tmux pane;
//   - local sources (gate log, account pool, heavy slots, host) on their own slower clocks;
//   - live events from /api/events, joined near the tail (never a replay of the whole history), for the ticker and to
//     pull the next refresh forward (never sooner than 2 s after the last).
// It never runs tmux: no per-seat polling, and phase 1 has no terminal tail at all.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { eventLine, qrowFromItem, seatFromNode, type Account, type Event, type Gate, type Heavy, type Raw, type Rig } from "./model.ts";

export interface Options {
  url: string; interval: number; procDir?: string; jevLog?: string | null; timeoutMs?: number;
  run?: (cmd: string, args: string[], timeoutMs: number) => Promise<string | null>; now?: () => number; events?: boolean;
}
export const MIN_INTERVAL = 2000, MAX_INTERVAL = 60_000, RIGS_EVERY = 60_000, QUEUE_EVERY = 30_000;

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
export function parseAccounts(text: string | null): Account[] {
  if (!text) return [];
  try {
    const a = JSON.parse(text);
    return (Array.isArray(a) ? a : []).map((x: any) => ({ label: String(x.label), provider: String(x.provider ?? ""), status: String(x.status ?? "?"),
      short: typeof x.short_window_used === "number" ? x.short_window_used : null, weekly: typeof x.weekly_used === "number" ? x.weekly_used : null,
      cooling: x.status !== "active" || (Array.isArray(x.cooldowns) && x.cooldowns.length > 0) }));
  } catch { return []; }
}
/** Today's merge-gate decisions from the Jev decision log (diagnosis calls excluded). */
export function parseGates(lines: string[]): Gate[] {
  const out: Gate[] = [];
  for (const l of lines) {
    if (!l.includes('"review.merge_gate"')) continue;
    try {
      const d = JSON.parse(l);
      if (d.decision !== "review.merge_gate" || String(d.caller ?? "").startsWith("diagnosis:")) continue;
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
  private stopped = false;
  private jevOffset = 0;
  private gates: Gate[] = [];
  private lastLocal: Record<string, number> = {};
  private cpu: { ticks: number; at: number; pid: number } | null = null;
  private seq: number | null = null;
  private abort: AbortController | null = null;
  private listeners: (() => void)[] = [];
  private summary: any[] | null = null;
  private summaryAt = -Infinity;
  private queueAt = -Infinity;
  private dirty = { rigs: false, queue: false };
  requests = 0;
  constructor(o: Options) {
    this.opt = { procDir: "/proc", jevLog: null, timeoutMs: 4000, events: true, ...o, interval: Math.max(MIN_INTERVAL, o.interval) } as Cache["opt"];
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
    if (this.stopped || this.busy) return;
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
    if (!this.stopped) { if (this.timer) clearTimeout(this.timer); this.timer = setTimeout(() => void this.tick(), this.interval); }
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
    }
    this.raw.rigs = rigs;
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
  /** Reads the decision log from where it left off (the last 4 MB the first time, or after a rotation). */
  private readGates(file: string) {
    try {
      const st = fs.statSync(file);
      if (st.size < this.jevOffset) this.jevOffset = 0;
      const from = this.jevOffset || Math.max(0, st.size - (4 << 20));
      const fd = fs.openSync(file, "r");
      try {
        const buf = Buffer.alloc(st.size - from); fs.readSync(fd, buf, 0, buf.length, from);
        const text = buf.toString("utf8"), cut = text.lastIndexOf("\n") + 1;
        const lines = text.slice(0, cut).split("\n");
        if (!this.jevOffset && from > 0) lines.shift();   // the first, partial line of the tail
        this.gates.push(...parseGates(lines));
        this.jevOffset = from + Buffer.byteLength(text.slice(0, cut));
      } finally { fs.closeSync(fd); }
      this.raw.sources.gates = "ok";
    } catch { this.raw.sources.gates = "unavailable"; }
  }

  // ── live events ──────────────────────────────────────────────────────────────────────────────────────────────────
  /** /api/events replays everything after Last-Event-ID and then skips live events at or below it, so it needs a real
   *  recent seq: the first event of the live-only activity stream gives one. Joins 200 events back for the ticker. */
  private async events() {
    let backoff = 2000;
    while (!this.stopped) {
      try {
        if (this.seq === null) this.seq = await this.liveSeq();
        if (this.seq !== null) {
          await this.stream("/api/events", { "Last-Event-ID": String(this.seq === 0 ? 0 : Math.max(1, this.seq - 200)) }, (e) => {
            if (typeof e.seq === "number") this.seq = e.seq + 200;   // reconnect near where we were
            const line = eventLine(e);
            if (line) { this.raw.events = [line, ...this.raw.events].slice(0, 60); this.changed(); }
            if (/^queue\./.test(String(e.type))) { this.dirty.queue = true; this.soon(); }
            if (/^node\./.test(String(e.type))) { this.dirty.rigs = true; this.soon(); }
          });
        }
        backoff = 2000;
      } catch { /* daemon away: retry */ }
      if (this.stopped) break;
      await new Promise((r) => setTimeout(r, backoff)); backoff = Math.min(60_000, backoff * 2);
    }
  }
  private async liveSeq(): Promise<number | null> {
    let seq: number | null = null;
    const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 20_000);
    try { await this.stream("/api/activity/events", {}, (e) => { if (typeof e.seq === "number") { seq = e.seq; ac.abort(); } }, ac); }
    catch { /* aborted on the first event, or no event within 20 s */ }
    finally { clearTimeout(t); }
    return seq;
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
