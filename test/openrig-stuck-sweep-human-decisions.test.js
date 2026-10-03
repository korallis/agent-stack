// Patch 149 (0.6.3): the stuck sweep raised an "unclaimed-obligation" finding to the operator for every owner decision
// row (destination a human, human_intent decision) once it was 60 min old. Those rows stay pending and unclaimed for
// the human by design, so every such finding was noise. The patch skips a human destination's row unless it is an
// update (no intent is OpenRig's legacy decision). The pristine sweep plus 133 (which 149 follows) and the same plus
// 149 run on one real SQLite queue table, their imports stubbed.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(join(os.tmpdir(), "stuck-sweep-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const STUBS = {
  "queue-recovery.js": "export const findQueueRecovery = () => null;\nexport const recoveryId = (db, id) => `qitem-recovery-${id}`;\nexport const recoveryTag = (id) => `recovery-for:${id}`;\n",
  "queue-wait-backoff.js": "export const queueWaitNotice = () => null;\n",
  "queue-waiting.js": "export const lastMeaningfulTransition = () => null;\nexport const pendingSince = () => null;\n",
  "queue-pickup.js": "export const resolvePickupThresholdMinutes = () => 30;\nexport const stalledPickupFinding = () => null;\n",
  "queue-owner.js": "export const defaultResolveOrchestrator = () => null;\nexport const resolveSessionNodeId = () => null;\n",
  "session-name.js": "export const isHumanSeatSessionRef = (s) => /@external$/.test(s || \"\");\n",   // humans are *@external
  "queue-repository.js": "export const deriveCrossHostSuccessorId = () => null;\n",
  "user-settings/settings-store.js": "export class SettingsStore { resolveOne() { return { value: undefined }; } }\n",
  "hosts/hosts-registry-reader.js": "export const loadHostRegistry = () => ({ hosts: [] });\n",
};
async function load(with149) {
  const dir = join(root, with149 ? "patched" : "pristine"), dom = join(dir, "daemon/dist/domain");
  fs.mkdirSync(dom, { recursive: true });
  fs.copyFileSync(join(repo, "test/fixtures/openrig-0.6.3-stuck-sweep/daemon/dist/domain/queue-stuck-sweep.js"), join(dom, "queue-stuck-sweep.js"));
  for (const [f, text] of Object.entries(STUBS)) { fs.mkdirSync(dirname(join(dom, f)), { recursive: true }); fs.writeFileSync(join(dom, f), text); }
  for (const p of ["133-unclaimed-human-routes-to-source", ...(with149 ? ["149-sweep-skips-human-decisions"] : [])])
    execFileSync("patch", ["-p1", "--quiet", "-i", join(repo, `patches/openrig/0.6.3/${p}.patch`)], { cwd: dir });
  return import(pathToFileURL(join(dom, "queue-stuck-sweep.js")).href);
}

function world() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE queue_items (qitem_id TEXT PRIMARY KEY, state TEXT, claimed_at TEXT, destination_session TEXT, source_session TEXT,
      ts_created TEXT, ts_updated TEXT, last_nudge_result TEXT, closure_target TEXT, tags TEXT, human_intent TEXT);
    CREATE TABLE queue_transitions (transition_id INTEGER PRIMARY KEY, qitem_id TEXT, ts TEXT, state TEXT, actor_session TEXT, transition_note TEXT);
    CREATE TABLE watchdog_jobs (job_id TEXT, spec_yaml TEXT, state TEXT, policy TEXT);
    CREATE TABLE queue_transition_wakes (transition_id INTEGER, qitem_id TEXT, wake_ref TEXT, phase TEXT);
    CREATE TABLE sessions (id INTEGER PRIMARY KEY, session_name TEXT, status TEXT, node_id TEXT);
    CREATE TABLE nodes (id TEXT, rig_id TEXT); CREATE TABLE rigs (id TEXT);`);
  const old = new Date(Date.now() - 3 * 3600_000).toISOString();   // 3 h: past the 60 min threshold
  const rows = new Map();
  const add = (id, dest, intent = null) => {
    db.prepare("INSERT INTO queue_items VALUES (?, 'pending', NULL, ?, 'lead@proj', ?, ?, NULL, NULL, '[]', ?)").run(id, dest, old, old, intent);
    rows.set(id, { qitemId: id, state: "pending", destinationSession: dest, sourceSession: "lead@proj", tsCreated: old, tags: [], humanIntent: intent });
  };
  add("qitem-decision", "owner@external", "decision");
  add("qitem-legacy", "owner@external", null);         // no intent: OpenRig's legacy decision
  add("qitem-update", "owner@external", "update");
  add("qitem-agent", "impl@proj");
  const created = [];
  const queueRepo = {
    findOverdue: () => [], findUndelivered: () => [], getById: (id) => rows.get(id) ?? null,
    create: async (input) => { created.push(input); return { qitemId: input.qitemId }; }, update: async () => ({}),
  };
  return { db, queueRepo, created };
}

test("owner decision rows (human destination, decision or no intent) get no unclaimed-obligation finding; updates and agent rows still do", async () => {
  for (const with149 of [false, true]) {
    const mod = await load(with149);
    const { db, queueRepo, created } = world();
    const r = await mod.runStuckSweep({ db, queueRepo, status: mod.createStuckSweepStatus(), unclaimedAgeMinutes: 60, isRegisteredHost: () => false, log: () => {} });
    const raised = r.findings.filter((f) => f.kind === "unclaimed-obligation").map((f) => f.qitemId).sort();
    if (!with149) {
      assert.deepEqual(raised, ["qitem-agent", "qitem-decision", "qitem-legacy", "qitem-update"], "without 149 every unclaimed row is raised");
      continue;
    }
    assert.deepEqual(raised, ["qitem-agent", "qitem-update"], "a human's decision rows wait by design");
    // 133's routing is unchanged for what is still raised: a human's row goes to the operator (no live seat here), never to the human
    assert.equal(created.find((c) => c.summary.includes("qitem-update")).destinationSession, "operator-agent@kernel");
    assert.equal(created.find((c) => c.summary.includes("qitem-agent")).destinationSession, "impl@proj");
  }
});
