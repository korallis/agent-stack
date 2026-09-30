// Whole-service harness for patch 139: the daemon's REAL SeatActivityService (1 Hz sweep) and SeatIdentityReconciler
// (15 s sweep), from the given @openrig/cli tree, against a COPY of the live openrig.sqlite and the REAL tmux server (read-
// only tmux queries), in a process holding ~380 MB like the daemon. Measures event-loop utilization and delay.
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { exec as cpExec } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
const [tree, dbFile, seconds] = [process.argv[2], process.argv[3], Number(process.argv[4] ?? 60)];
const require = createRequire(tree + "/package.json");
const Database = require("better-sqlite3");
const { TmuxAdapter } = await import(tree + "/daemon/dist/adapters/tmux.js");
const { SeatActivityService } = await import(tree + "/daemon/dist/domain/seat-activity-service.js");
const { SeatIdentityReconciler } = await import(tree + "/daemon/dist/domain/seat-identity-reconciler.js");
const hold = []; for (let i = 0; i < 380; i++) { const b = Buffer.alloc(1 << 20); b.fill(i & 255); hold.push(b); }
const run = promisify(cpExec); let spawns = 0;
const tmux = new TmuxAdapter(async (cmd) => { spawns++; return (await run(cmd, { maxBuffer: 8 << 20 })).stdout; });
const db = new Database(dbFile);
const act = new SeatActivityService({ tmux, defaultWindowSeconds: 3 });
const id = new SeatIdentityReconciler({ db, tmux });
const seats = db.prepare("SELECT COUNT(*) n FROM sessions WHERE status='running'").get().n;
await act.pollAllRunningTmuxSeats(db); await id.reconcileAll();   // warm-up
spawns = 0;
const h = monitorEventLoopDelay({ resolution: 10 }); h.enable();
const e0 = performance.eventLoopUtilization();
act.start(db, 1000); id.start(15000);
await new Promise((r) => setTimeout(r, seconds * 1000));
act.stop(); id.stop(); h.disable();
const e = performance.eventLoopUtilization(e0);
console.log(JSON.stringify({ tree: tree.split("/").slice(-1)[0], seats, seconds, rssMB: (process.memoryUsage().rss / 2 ** 20) | 0,
  eventLoopUtilizationPct: +(e.utilization * 100).toFixed(1), tmuxSpawnsPerSec: +(spawns / seconds).toFixed(1),
  delayP50ms: +(h.percentile(50) / 1e6).toFixed(1), delayP99ms: +(h.percentile(99) / 1e6).toFixed(1), delayMaxMs: +(h.max / 1e6).toFixed(1) }));
db.close(); process.exit(0);
