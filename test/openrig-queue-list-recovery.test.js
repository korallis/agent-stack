// Patch 148 (0.6.3): findQueueRecovery scanned every queue row's tags as JSON (~6 ms on a 15k-row queue) and a queue list
// ran it once per returned row: 1.3 s for 213 active rows. Inside withRecoveryScope (one synchronous list call) the
// answer for every tag is built once from the rows that carry a `recovery-for:` tag, with the query's own match and
// order. This drives the pristine-plus-patch queue-recovery.js on a real SQLite table full of awkward rows and checks
// that, for every id, the scoped answer equals the unscoped one (the original query).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const patch = fs.readFileSync(join(repo, "patches/openrig/0.6.3/148-queue-list-recovery-once.patch"), "utf8");
const root = fs.mkdtempSync(join(os.tmpdir(), "queue-recovery-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const domain = join(root, "daemon/dist/domain");
fs.mkdirSync(domain, { recursive: true });
fs.copyFileSync(join(repo, "test/fixtures/openrig-0.6.3-queue-recovery/daemon/dist/domain/queue-recovery.js"), join(domain, "queue-recovery.js"));
// its one import: the last meaningful transition, from a small table the test fills
fs.writeFileSync(join(domain, "queue-waiting.js"), `export function lastMeaningfulTransition(db, id) {
  return db.prepare("SELECT id, at FROM transitions WHERE qitem_id = ? ORDER BY id DESC LIMIT 1").get(id) ?? null;
}\n`);
const recoveryPart = patch.slice(0, patch.indexOf("--- a/daemon/dist/domain/queue-repository.js"));
execFileSync("patch", ["-p1", "--quiet"], { cwd: root, input: recoveryPart });
const rec = await import(pathToFileURL(join(domain, "queue-recovery.js")).href);

function queue() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE queue_items (qitem_id TEXT PRIMARY KEY, state TEXT, ts_updated TEXT, tags TEXT, last_nudge_attempt TEXT, last_nudge_result TEXT)");
  db.exec("CREATE TABLE transitions (id INTEGER PRIMARY KEY, qitem_id TEXT, at TEXT)");
  const add = (id, state, ts, tags, nudge = null) => db.prepare("INSERT INTO queue_items VALUES (?, ?, ?, ?, ?, ?)").run(id, state, ts, tags, nudge?.at ?? null, nudge?.result ?? null);
  const states = ["pending", "in-progress", "blocked", "done", "handed-off", "canceled"];
  for (let i = 0; i < 30; i++) add(`q${i}`, states[i % 6], `2026-10-02T10:${String(i).padStart(2, "0")}:00.000Z`, JSON.stringify([`project:p`]));
  let n = 0; const r = (target, state, ts, tags) => add(`r${n++}`, state, ts, tags.replaceAll("@", `recovery-for:${target}`));
  // several recoveries for one target: open beats closed, then newest ts_updated, then highest id (r2 over r1)
  r("q0", "done", "2026-10-02T12:00:00.000Z", '["@"]'); r("q0", "pending", "2026-10-02T11:00:00.000Z", '["@","x"]'); r("q0", "blocked", "2026-10-02T11:00:00.000Z", '["@"]');
  r("q1", "done", "2026-10-02T12:00:00.000Z", '["@"]'); r("q1", "canceled", "2026-10-02T12:00:00.000Z", '["@"]');   // tie on ts: qitem_id DESC
  r("q2", "done", null, '["@"]'); r("q2", "done", "2026-10-02T09:00:00.000Z", '["@"]');                                // NULL sorts last
  r("q3", "in-progress", "2026-10-02T11:00:00.000Z", '{"k":"@"}');                                                   // object values count
  r("q4", "pending", "2026-10-02T11:00:00.000Z", '"@"');                                                             // a scalar counts
  r("q5", "pending", "2026-10-02T11:00:00.000Z", '[["@"]]');                                                         // nested: no match
  r("q6", "pending", "2026-10-02T11:00:00.000Z", '["@" ');                                                           // invalid JSON: ignored
  r("q7", "pending", "2026-10-02T11:00:00.000Z", '["@x"]');                                                          // a longer tag: no match
  add("r-upper", "pending", "2026-10-02T11:00:00.000Z", '["RECOVERY-FOR:q8"]');                                       // case differs: no match
  r("q9", "done", "2026-10-02T11:00:00.000Z", '["@","@"]');                                                          // listed twice
  r("q10", "done", "2026-10-02T09:00:00.000Z", '["@"]');                                                             // closed, older than a change
  db.prepare("INSERT INTO transitions (qitem_id, at) VALUES (?, ?)").run("q10", "2026-10-02T10:00:00.000Z");
  add("q40", "pending", "2026-10-02T10:00:00.000Z", "[]", { at: "2026-10-02T13:00:00.000Z", result: "failed: timeout" });
  r("q40", "done", "2026-10-02T12:00:00.000Z", '["@"]');                                                             // failed attempt after it
  r("q12", "done", "2026-10-02T09:00:00.000Z", '["@"]'); r("q12", "done", null, '["@"]');                                // NULL second: still last
  return db;
}

test("inside a scope every id gets exactly the original query's answer, across ties, NULLs, shapes and invalid JSON", () => {
  const db = queue();
  const ids = db.prepare("SELECT qitem_id FROM queue_items").all().map((r) => r.qitem_id).concat(["missing"]);
  const plain = ids.map((id) => JSON.stringify(rec.findQueueRecovery(db, id)));
  const scoped = rec.withRecoveryScope(db, () => ids.map((id) => JSON.stringify(rec.findQueueRecovery(db, id))));
  assert.deepEqual(scoped, plain);
  const pick = Object.fromEntries(ids.map((id, i) => [id, JSON.parse(plain[i])?.qitemId ?? null]));
  assert.deepEqual([pick.q0, pick.q1, pick.q2, pick.q3, pick.q4, pick.q5, pick.q6, pick.q7, pick.q8, pick.q9, pick.q10, pick.q40, pick.q12],
    ["r2", "r4", "r6", "r7", "r8", null, null, null, null, "r12", null, null, "r15"], "the fixture really exercises each rule");
});

test("a scope answers all ids from one scan; outside a scope, and for another database, the original query runs", () => {
  const db = queue(), other = queue();
  other.prepare("INSERT INTO queue_items VALUES ('r-other', 'pending', '2026-10-02T23:00:00.000Z', '[\"recovery-for:q0\"]', NULL, NULL)").run();
  let prepares = 0; const real = db.prepare.bind(db); db.prepare = (sql) => { if (/FROM queue_items/.test(sql) && /recovery|json_each/.test(sql)) prepares++; return real(sql); };
  const ids = ["q0", "q1", "q2", "q3", "q4", "q20", "q21"];
  rec.withRecoveryScope(db, () => { for (const id of ids) rec.findQueueRecovery(db, id); assert.deepEqual(rec.findQueueRecovery(other, "q0"), { qitemId: "r-other", state: "pending" }, "another database is never answered from this scope"); });
  assert.equal(prepares, 1, "one scan for the whole scope");
  prepares = 0; for (const id of ids) rec.findQueueRecovery(db, id);
  assert.equal(prepares, ids.length, "no scope: one query per id, as before");
  assert.equal(rec.withRecoveryScope(db, () => rec.withRecoveryScope(db, () => 7)), 7, "nested scopes share the outer one");
});

test("the repository wraps both list paths, and nothing else, in the scope", () => {
  const repoPart = patch.slice(patch.indexOf("--- a/daemon/dist/domain/queue-repository.js"));
  const added = repoPart.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
  assert.ok(added.includes('+import { withRecoveryScope } from "./queue-recovery.js";'));
  assert.ok(added.some((l) => l.includes("const items = withRecoveryScope(this.db, () => rows.map((r) => {")), "list()");
  assert.ok(added.some((l) => l.includes("return withRecoveryScope(this.db, () => rows.map((r) => this.rowToItem(r)));")), "listAttention()");
  assert.equal(added.filter((l) => l.includes("withRecoveryScope(")).length, 2);
});
