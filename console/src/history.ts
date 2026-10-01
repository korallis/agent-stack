// The 24-hour history behind the braille graphs: one fleet sample a minute, at most 1440, in a small local file
// (written whole, then renamed). Several consoles may share it: each appends only when the newest sample is a minute old.
import fs from "node:fs";
import path from "node:path";
import type { Fleet } from "./model.ts";

export interface Sample { t: number; working: number; idle: number; stuck: number; pending: number; inProgress: number; blocked: number; gateToday: number }
export const STEP_MS = 60_000, KEEP = 1440;

export function sampleOf(f: Fleet, t: number): Sample {
  return { t, working: f.count.working, idle: f.count.idle, stuck: f.stuck.length, pending: f.queue.pending, inProgress: f.queue.inProgress,
    blocked: f.queue.blocked, gateToday: f.gate.total };
}

export class History {
  readonly file: string | null;
  samples: Sample[] = [];
  constructor(file: string | null) {
    this.file = file;
    if (file) {
      try {
        const d = JSON.parse(fs.readFileSync(file, "utf8"));
        if (Array.isArray(d?.samples)) this.samples = d.samples.filter((s: Sample) => typeof s?.t === "number").slice(-KEEP);
      } catch { /* none yet, or unreadable: start empty */ }
    }
  }
  /** Adds a sample when the newest is at least a minute old; drops what is older than 24 h. Returns true when added. */
  add(s: Sample): boolean {
    const last = this.samples.at(-1);
    if (last && s.t - last.t < STEP_MS - 5_000) return false;
    this.samples.push(s);
    this.samples = this.samples.filter((x) => s.t - x.t <= KEEP * STEP_MS).slice(-KEEP);
    if (this.file) {
      const lock = `${this.file}.lock`;
      let held = false;
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        // One writer at a time (QA PR86): read, merge and rename under an exclusive lock file, so two consoles never
        // overwrite each other's minute. A lock older than 10 s is a crashed writer's; a busy lock skips this write,
        // and the sample, kept in memory, goes out with the next one.
        for (let i = 0; i < 20 && !held; i++) {
          try { fs.closeSync(fs.openSync(lock, "wx")); held = true; }
          catch {
            try { if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) fs.rmSync(lock, { force: true }); } catch { /* gone */ }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
        }
        if (!held) return true;
        // merge with what another console wrote meanwhile
        let disk: Sample[] = [];
        try { disk = JSON.parse(fs.readFileSync(this.file, "utf8")).samples ?? []; } catch { /* none */ }
        const byT = new Map<number, Sample>();
        for (const x of [...disk, ...this.samples]) byT.set(Math.round(x.t / STEP_MS), x);
        this.samples = [...byT.values()].sort((a, b) => a.t - b.t).filter((x) => s.t - x.t <= KEEP * STEP_MS).slice(-KEEP);
        const tmp = `${this.file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ version: 1, samples: this.samples }));
        fs.renameSync(tmp, this.file);
      } catch { /* history is best effort; the console keeps running */ }
      finally { if (held) fs.rmSync(lock, { force: true }); }
    }
    return true;
  }
  /** Per-hour (or per-bucket) series over the last 24 h, `n` buckets, for one field; missing buckets are 0. */
  series(field: keyof Sample, n: number, now: number): number[] {
    const span = KEEP * STEP_MS, bucket = span / n, out = new Array(n).fill(0), seen = new Array(n).fill(0);
    for (const s of this.samples) {
      const i = Math.floor((s.t - (now - span)) / bucket);
      if (i < 0 || i >= n) continue;
      out[i] += s[field] as number; seen[i]++;
    }
    return out.map((v, i) => (seen[i] ? v / seen[i] : 0));
  }
}
