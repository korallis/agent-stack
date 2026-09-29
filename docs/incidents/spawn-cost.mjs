// Main-thread cost of ASYNC child_process.execFile vs heap size: uv_spawn forks, then blocks in read() on a
// CLOEXEC pipe until the child execs. Measure the synchronous time the execFile() call itself takes.
import { execFile } from "node:child_process";
const mb = Number(process.argv[2] ?? 0), n = 200;
const hold = []; for (let i = 0; i < mb; i++) { const b = Buffer.alloc(1 << 20); b.fill(i & 255); hold.push(b); }
let tot = 0, max = 0; const done = [];
for (let i = 0; i < n; i++) {
  const t = performance.now();
  done.push(new Promise((r) => execFile("tmux", ["-V"], () => r())));
  const d = performance.now() - t; tot += d; max = Math.max(max, d);
}
await Promise.all(done);
console.log(`heap+${mb}MB rss=${(process.memoryUsage().rss / 2**20) | 0}MB: sync time inside execFile() mean=${(tot / n).toFixed(2)}ms max=${max.toFixed(1)}ms (n=${n})`);
