// Patch 144 (0.6.3): transcript rotation captured each session's pane with its own fork of the daemon, on its own
// timer. A CPU profile of the live daemon (~90 seats) spent a third of its time in spawn. The patch aligns the ticks to
// wall-clock boundaries and shares one batched read (patch 142's capturePanesContent) among the sessions due together.
// The patch is applied to the pristine published file and driven against a fake adapter.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(join(os.tmpdir(), "batched-transcripts-"));
fs.cpSync(join(repo, "test/fixtures/openrig-0.6.3-transcripts/daemon"), join(root, "daemon"), { recursive: true });
execFileSync("patch", ["-p1", "--quiet", "-i", join(repo, "patches/openrig/0.6.3/144-batched-transcript-capture.patch")], { cwd: root });
const rot = await import(pathToFileURL(join(root, "daemon/dist/domain/transcript-rotation.js")).href);
test.after(() => { rot.clearAllTranscriptRotationsForTest(); fs.rmSync(root, { recursive: true, force: true }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A fake adapter: `batched` false drops capturePanesContent (an unpatched adapter); `omit` sessions are left out of
// the batch (as patch 142 leaves a session whose capture failed); `batchFails` makes the batch return null.
function adapter({ batched = true, omit = new Set(), batchFails = false } = {}) {
  const calls = { batch: [], single: [] };
  const a = {
    calls,
    async capturePaneContent(name, lines) { calls.single.push(name); return `pane ${name} (${lines})\n`; },
  };
  if (batched) a.capturePanesContent = async (names, lines) => {
    calls.batch.push([...names]);
    if (batchFails) return null;
    return new Map(names.filter((n) => !omit.has(n)).map((n) => [n, { text: `pane ${n} (${lines})\n`, capturedAt: new Date() }]));
  };
  return a;
}
const dir = (name) => { const d = join(root, name); fs.mkdirSync(d, { recursive: true }); return d; };
const read = (d, n) => fs.readFileSync(join(d, `${n}.log`), "utf8");

test("sessions due together share ONE batched read and no per-session fork; each transcript gets its own pane", async () => {
  rot.clearAllTranscriptRotationsForTest();
  const a = adapter(), d = dir("together"), names = Array.from({ length: 30 }, (_, i) => `seat-${i}@demo`);
  for (const n of names) rot.startTranscriptRotation(a, n, join(d, `${n}.log`), { lines: 400, pollIntervalMs: 60000 });
  await sleep(200);
  assert.equal(a.calls.batch.length, 1, "the 30 first ticks coalesce into one batched read");
  assert.equal(a.calls.batch[0].length, 30);
  assert.deepEqual(a.calls.single, []);
  for (const n of names) assert.equal(read(d, n), `pane ${n} (400)\n`);
  assert.ok(names.every((n) => typeof rot.getLastCaptureAt(n) === "number"), "liveness recorded for every session");
});

test("sessions started at different times tick on the same wall-clock boundary and are read together", async () => {
  rot.clearAllTranscriptRotationsForTest();
  const a = adapter(), d = dir("staggered"), ms = 1000;
  await sleep(ms - (Date.now() % ms) + 50); // just after a boundary, so the starts below precede the next one
  for (const n of ["x@demo", "y@demo", "z@demo"]) { rot.startTranscriptRotation(a, n, join(d, `${n}.log`), { lines: 20, pollIntervalMs: ms }); await sleep(250); }
  // three separate first ticks (250 ms apart), then the shared boundary tick
  await sleep(ms - (Date.now() % ms) + 200);
  assert.deepEqual(a.calls.batch.map((b) => b.length), [1, 1, 1, 3], JSON.stringify(a.calls.batch));
  assert.deepEqual(a.calls.single, []);
});

test("fallbacks: an adapter without batching, a session the batch left out, and a failed batch read per session", async () => {
  rot.clearAllTranscriptRotationsForTest();
  const plain = adapter({ batched: false }), d1 = dir("plain");
  for (const n of ["p1@demo", "p2@demo"]) rot.startTranscriptRotation(plain, n, join(d1, `${n}.log`), { lines: 20, pollIntervalMs: 60000 });
  const partial = adapter({ omit: new Set(["q2@demo"]) }), d2 = dir("partial");
  for (const n of ["q1@demo", "q2@demo"]) rot.startTranscriptRotation(partial, n, join(d2, `${n}.log`), { lines: 20, pollIntervalMs: 60000 });
  const failed = adapter({ batchFails: true }), d3 = dir("failed");
  for (const n of ["r1@demo", "r2@demo"]) rot.startTranscriptRotation(failed, n, join(d3, `${n}.log`), { lines: 20, pollIntervalMs: 60000 });
  await sleep(200);
  assert.deepEqual(plain.calls.single.sort(), ["p1@demo", "p2@demo"]);
  assert.deepEqual(partial.calls.single, ["q2@demo"], "only the omitted session is read on its own");
  assert.deepEqual(failed.calls.batch.length, 1); assert.deepEqual(failed.calls.single.sort(), ["r1@demo", "r2@demo"]);
  for (const [d, n] of [[d1, "p1@demo"], [d2, "q1@demo"], [d2, "q2@demo"], [d3, "r2@demo"]]) assert.equal(read(d, n), `pane ${n} (20)\n`);
});

test("a session stopped while its batched read is pending writes nothing and records no liveness", async () => {
  rot.clearAllTranscriptRotationsForTest();
  const a = adapter(), d = dir("stopped");
  rot.startTranscriptRotation(a, "keep@demo", join(d, "keep@demo.log"), { lines: 20, pollIntervalMs: 60000 });
  rot.startTranscriptRotation(a, "stop@demo", join(d, "stop@demo.log"), { lines: 20, pollIntervalMs: 60000 });
  rot.stopTranscriptRotation("stop@demo"); // within the coalescing window
  await sleep(200);
  assert.equal(read(d, "keep@demo"), "pane keep@demo (20)\n");
  assert.ok(!fs.existsSync(join(d, "stop@demo.log")));
  assert.equal(rot.getLastCaptureAt("stop@demo"), undefined);
  assert.equal(rot.getActiveRotationCount(), 1);
});
