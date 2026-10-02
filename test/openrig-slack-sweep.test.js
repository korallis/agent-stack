// Patch 147 (0.6.3): the Slack outbound sweep (every 30 s) asked QueueRepository.list for every active row with its full
// face (waiting view, recovery ladder) and then kept only rows with an unposted owner notification: 0.8-1.4 s event-loop
// stalls per sweep in a CPU profile of the stalled daemon. The patch reads active ids, runs the notification and
// receipt checks first, and loads a full row only for one it will project. The pristine and patched queue-access.js
// run side by side on the same fake repository (backed by a real SQLite table for the id query).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(join(os.tmpdir(), "slack-sweep-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
async function load(patched) {
  const dir = join(root, patched ? "patched" : "pristine"), slack = join(dir, "daemon/dist/domain/gateway/slack");
  fs.mkdirSync(slack, { recursive: true });
  fs.copyFileSync(join(repo, "test/fixtures/openrig-0.6.3-slack/daemon/dist/domain/gateway/slack/queue-access.js"), join(slack, "queue-access.js"));
  // its two imports, stubbed: humans are `*@external`; levels order NOTICE < ALERT
  fs.writeFileSync(join(dirname(slack), "human-registry.js"), `export const loadHumanRegistry = () => ({ ok: true, entities: [] });
export const resolveRegisteredHumanAddress = (s) => (s && s.endsWith("@external") ? s : null);\n`);
  fs.writeFileSync(join(dirname(dirname(slack)), "queue-transition-log.js"), `const order = ["NOTICE", "ALERT"];
export const ownerNotificationLevelAtLeast = (a, b) => order.indexOf(a) >= order.indexOf(b);\n`);
  if (patched) execFileSync("patch", ["-p1", "--quiet", "-i", join(repo, "patches/openrig/0.6.3/147-slack-sweep-active-ids-first.patch")], { cwd: dir });
  return import(pathToFileURL(join(slack, "queue-access.js")).href);
}

// A queue: 40 active rows (a few with owner notifications, one already posted, one to a non-human) and closed ones.
function fakeRepo() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE queue_items (qitem_id TEXT PRIMARY KEY, state TEXT, ts_created TEXT)");
  const items = new Map(), notes = new Map(), receipts = new Set(), counts = { list: 0, full: 0 };
  const add = (i, state, extra = {}) => {
    const id = `q${String(i).padStart(3, "0")}`, ts = new Date(Date.UTC(2026, 9, 2, 0, 0, i)).toISOString();
    db.prepare("INSERT INTO queue_items VALUES (?, ?, ?)").run(id, state, ts);
    items.set(id, { qitemId: id, state, tsCreated: ts, destinationSession: "lead@demo", sourceSession: "impl@demo", summary: `row ${i}`, body: `body ${i}`, tags: null, tier: null, evidenceRef: null, humanIntent: null, humanDetail: null, ...extra });
    return id;
  };
  for (let i = 0; i < 40; i++) add(i, ["pending", "in-progress", "blocked"][i % 3]);
  for (let i = 40; i < 60; i++) add(i, i % 2 ? "done" : "handed-off", { destinationSession: "owner@external" });
  const notify = (id, t, level = "ALERT", kind = "owner") => notes.set(id, { transitionId: t, ownerNotificationLevel: level, ownerNotificationKind: kind });
  items.get("q003").destinationSession = "owner@external"; notify("q003", 11);
  items.get("q007").destinationSession = "owner@external"; notify("q007", 12, "NOTICE");
  items.get("q010").destinationSession = "owner@external"; notify("q010", 13); receipts.add("q010:13"); // already posted
  notify("q012", 14);                                                                                  // not to a human
  items.get("q014").blockedOn = "owner@external"; notify("q014", 15);                                 // blocked on the owner
  notify("q021", 16, "ALERT", "human-decision-resolved"); notes.get("q021").actorSession = "owner@external";        // resolved by the owner
  notify("q045", 17);                                                                                  // closed: never
  const full = (id) => { counts.full++; return { ...items.get(id), deliveryOutcome: null }; };
  return {
    counts,
    db,
    getById: (id) => (items.has(id) ? full(id) : null),
    list: (opts) => { counts.list++; assert.deepEqual(opts, { activeOnly: true, limit: 1000000 });
      return [...items.values()].filter((q) => ["pending", "in-progress", "blocked"].includes(q.state)).sort((a, b) => b.tsCreated.localeCompare(a.tsCreated)).map((q) => full(q.qitemId)); },
    transitionLog: { latestOwnerNotificationForQitem: (id) => notes.get(id) ?? null, hasOwnerNotificationReceipt: (id, key) => receipts.has(key) },
  };
}

test("the patched sweep returns exactly the pristine alerts, in the same order", async () => {
  const [pristine, patched] = [await load(false), await load(true)];
  const a = fakeRepo(), b = fakeRepo();
  const want = await pristine.makeQueuePorts(a).listHumanAlerts({ minimumLevel: "NOTICE" });
  const got = await patched.makeQueuePorts(b).listHumanAlerts({ minimumLevel: "NOTICE" });
  assert.deepEqual(got, want);
  assert.deepEqual(got.map((x) => x.qitemId), ["q021", "q014", "q007", "q003"]);
  assert.equal(got.find((x) => x.qitemId === "q021").sourceSession, "lead@demo", "a resolved decision goes back to the human who resolved it");
  assert.deepEqual((await patched.makeQueuePorts(fakeRepo()).listHumanAlerts({ minimumLevel: "ALERT" })).map((x) => x.qitemId), ["q021", "q014", "q003"]);
});

test("the full row face is built only for rows it will project; the pristine sweep built it for every active row", async () => {
  const [pristine, patched] = [await load(false), await load(true)];
  const a = fakeRepo(), b = fakeRepo();
  await pristine.makeQueuePorts(a).listHumanAlerts({});
  await patched.makeQueuePorts(b).listHumanAlerts({});
  assert.deepEqual(a.counts, { list: 1, full: 40 });
  assert.deepEqual(b.counts, { list: 0, full: 5 }, "q003, q007, q012 (not a human: projected null), q014, q021");
});
