// Patch 145 (0.6.3): the usage-samples store read "the seat's latest row" with ORDER BY id, which SQLite could only
// answer by sorting every row the seat ever wrote (a TEMP B-TREE): ~35k rows for a busy seat, and a 2 s event-loop
// stall per context-monitor tick across ~90 seats. The patch orders by the index (captured_at, then id). Applied to the
// pristine published store and run against a real SQLite database with the table's own migration.
// install.sh sets usage_samples retention to 7 days in config.json (the daemon prunes in bounded batches).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import { join, dirname } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(join(os.tmpdir(), "usage-samples-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const load = async (patched) => {
  const dir = join(root, patched ? "patched" : "pristine");
  fs.cpSync(join(repo, "test/fixtures/openrig-0.6.3-usage-samples/daemon"), join(dir, "daemon"), { recursive: true });
  if (patched) execFileSync("patch", ["-p1", "--quiet", "-i", join(repo, "patches/openrig/0.6.3/145-usage-samples-latest-by-index.patch")], { cwd: dir });
  const { UsageSamplesStore } = await import(pathToFileURL(join(dir, "daemon/dist/domain/usage-samples-store.js")).href);
  const { usageSamplesSchema } = await import(pathToFileURL(join(dir, "daemon/dist/db/migrations/062_usage_samples.js")).href);
  const db = new DatabaseSync(":memory:"); db.exec(usageSamplesSchema.sql);
  // record every statement the store prepares, to ask SQLite how it plans them
  const prepared = []; const real = db.prepare.bind(db); db.prepare = (sql) => { prepared.push(sql); return real(sql); };
  return { store: new UsageSamplesStore(db), db, prepared, real };
};
const ctx = (seat, i) => ({ seatSession: seat, nodeId: "n", source: "test", sampledAt: `s${i}`, totalInputTokens: i, totalOutputTokens: i, usedPercentage: i });
const win = (seat, w, i) => ({ seatSession: seat, nodeId: "n", source: "test", window: w, asOf: `a${i}`, usedPercent: i, resetsAt: `r${i}` });
const at = (i) => new Date(Date.UTC(2026, 9, 1) + i * 1000).toISOString();

test("the latest-row reads use the seat index with no sort; the pristine store sorted every row of the seat", async () => {
  for (const patched of [false, true]) {
    const { store, prepared, real } = await load(patched);
    store.appendContextSample(ctx("a@r", 1), at(1)); store.appendProviderWindowSample(win("a@r", "weekly", 1), at(1));
    const reads = prepared.filter((s) => /^\s*SELECT/.test(s));
    assert.equal(reads.length, 2);
    for (const sql of reads) {
      const plan = real(`EXPLAIN QUERY PLAN ${sql}`).all(...["a@r", "weekly"].slice(0, sql.split("?").length - 1)).map((r) => r.detail).join(" | ");
      assert.match(plan, /USING INDEX idx_usage_samples_seat_time/);
      if (patched) assert.doesNotMatch(plan, /TEMP B-TREE/, plan); else assert.match(plan, /TEMP B-TREE/, "the pristine plan sorts");
    }
  }
});

test("append-only, advance-only behaviour is unchanged: identical samples are skipped, the newest row is the one compared", async () => {
  const { store, db } = await load(true);
  assert.equal(store.appendContextSample(ctx("a@r", 1), at(1)), true);
  assert.equal(store.appendContextSample(ctx("a@r", 1), at(2)), false, "identical to the latest: not written");
  assert.equal(store.appendContextSample(ctx("a@r", 2), at(3)), true);
  assert.equal(store.appendContextSample(ctx("a@r", 1), at(4)), true, "differs from the LATEST row (2), so written");
  assert.equal(store.appendContextSample(ctx("b@r", 1), at(5)), true, "another seat has its own series");
  // a same-millisecond pair: the higher id is the latest
  assert.equal(store.appendContextSample(ctx("c@r", 1), at(6)), true); assert.equal(store.appendContextSample(ctx("c@r", 2), at(6)), true);
  assert.equal(store.appendContextSample(ctx("c@r", 2), at(6)), false, "compared with the newer of the tie");
  assert.equal(store.appendProviderWindowSample(win("a@r", "weekly", 1), at(7)), true);
  assert.equal(store.appendProviderWindowSample(win("a@r", "five_hour", 1), at(8)), true, "a window has its own series");
  assert.equal(store.appendProviderWindowSample(win("a@r", "weekly", 1), at(9)), false);
  assert.equal(db.prepare("SELECT count(*) AS n FROM usage_samples").get().n, 8);
});

test("install.sh sets usage_samples retention to 7 days in config.json, keeps an existing value, and --check writes nothing", () => {
  const src = fs.readFileSync(join(repo, "install.sh"), "utf8");
  const block = src.slice(src.indexOf("# usage_samples retention"), src.indexOf("# OpenRig's own seat skills"));
  const run = (cfgText, check) => {
    const d = fs.mkdtempSync(join(root, "cfg-")), cfg = join(d, "config.json");
    if (cfgText !== null) { fs.writeFileSync(cfg, cfgText); fs.chmodSync(cfg, 0o600); }
    const r = spawnSync("bash", ["-c", `ok() { echo "OK $*"; }; todo() { echo "TODO $*"; }; cfg=${cfg}; CHECK=${check ? 1 : 0}\n${block}`], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } });
    assert.equal(r.status, 0, r.stderr);
    return { out: r.stdout.trim(), cfg: fs.existsSync(cfg) ? fs.readFileSync(cfg, "utf8") : null, mode: fs.existsSync(cfg) ? fs.statSync(cfg).mode & 0o777 : null, left: fs.readdirSync(d) };
  };
  const set = run('{"queue":{"pickupStallThresholdMinutes":480}}', false);
  assert.equal(set.out, "OK retention.usage_samples_days = 7 (set)");
  assert.deepEqual(JSON.parse(set.cfg), { queue: { pickupStallThresholdMinutes: 480 }, retention: { usageSamplesDays: 7 } });
  assert.equal(set.mode, 0o600); assert.deepEqual(set.left, ["config.json"], "no temp file left");
  assert.equal(run('{"retention":{"usageSamplesDays":3}}', false).out, "OK retention.usage_samples_days = 3 (kept)");
  const check = run("{}", true);
  assert.match(check.out, /^TODO retention\.usage_samples_days should be 7/); assert.equal(check.cfg, "{}");
  assert.equal(run(null, false).out, "TODO retention.usage_samples_days = 7", "no config.json: reported, nothing created");
});
