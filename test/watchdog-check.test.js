// WO71: agent-project-check knows a merge sweep and a daily summary by their spec message, not their interval.
// `rig queue block --wake-after 15m|24h` registers a periodic-reminder with the same 900 s / 86400 s ("Wake timer fired
// for parked qitem ..."); those parked-row wakes were reported as duplicate sweeps and summaries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "wdcheck-"));
process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
const W = join(home, "Projects/P-work"), bin = join(home, "bin");
const write = (p, text, mode) => { fs.mkdirSync(dirname(p), { recursive: true }); fs.writeFileSync(p, text, mode ? { mode } : undefined); };
write(join(W, "project.yaml"), "kind: project\n");
write(join(W, "rig/core.yaml"), "name: demo\npods:\n  - id: integ\n    members: []\n");
// The fake rig serves `watchdog list --json` and `watchdog show <id> --json` from $JOBS; everything else fails fast.
write(join(bin, "rig"), `#!/bin/bash
case "$1 $2" in
  "watchdog list") cat "$JOBS/list.json" ;;
  "watchdog show") [ -f "$JOBS/$3.json" ] && cat "$JOBS/$3.json" || { echo "daemon timeout" >&2; exit 1; } ;;
  *) exit 1 ;;
esac
`, 0o755);
for (const t of ["gh", "systemctl", "curl"]) write(join(bin, t), "#!/bin/sh\nexit 1\n", 0o755);

const MERGE = 'target:\n  session: "integ-claude@demo"\nmessage: >-\n  Merge sweep: go through every open PR per your role. If nothing changed, reply "no change".\n';
const DAILY = '# Wake the lead once a day.\ntarget:\n  session: "coord-lead-claude@demo"\nmessage: >-\n  Daily summary: write docs/summary/<today>.md per your role.\n';
const PARKED = (q) => `target:\n  session: x@demo\nmessage: "Wake timer fired for parked qitem ${q}. Resume the recorded continuation and update the row."\n`;
let n = 0;
function check(jobs, unreadable = []) {
  const dir = join(home, `jobs-${++n}`); fs.mkdirSync(dir);
  fs.writeFileSync(join(dir, "list.json"), JSON.stringify(jobs.map(([id, interval, target]) =>
    ({ jobId: id, policy: "periodic-reminder", state: "active", intervalSeconds: interval, targetSession: target }))));
  for (const [id, interval, target, spec] of jobs) if (!unreadable.includes(id))
    fs.writeFileSync(join(dir, `${id}.json`), JSON.stringify({ jobId: id, policy: "periodic-reminder", specYaml: spec, targetSession: target, intervalSeconds: interval }));
  const r = spawnSync("python3", [join(repo, "bin/agent-project-check"), W, "--json"], { encoding: "utf8", timeout: 60000,
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, JOBS: dir, OPENRIG_URL: "http://127.0.0.1:9" } });
  const out = JSON.parse(r.stdout);
  const get = (name) => out.find((x) => x.check === name) ?? assert.fail(`${name} missing: ${r.stdout.slice(0, 300)}${r.stderr.slice(0, 300)}`);
  return { merge: get("one merge-sweep watchdog on the merge owner"), daily: get("one daily-summary watchdog on the lead") };
}

test("parked-row wakes at 900 s and 86400 s are not counted: one sweep and one summary are OK (the reported case)", () => {
  const r = check([
    ["m1", 900, "integ-claude@demo", MERGE], ["p1", 900, "integ-claude@demo", PARKED("q-1")],
    ["d1", 86400, "coord-lead-claude@demo", DAILY], ["p2", 86400, "coord-lead-claude@demo", PARKED("q-2")],
    ["p3", 86400, "impl-a@demo", PARKED("q-3")], ["x1", 900, "integ-claude@other", MERGE],
  ]);
  assert.deepEqual([r.merge.level, r.merge.detail], ["OK", ""]);
  assert.deepEqual([r.daily.level, r.daily.detail], ["OK", ""]);
});

test("a sweep is found by its message whatever its interval; two real sweeps FAIL and name their seats", () => {
  const r = check([["m1", 600, "integ-claude@demo", MERGE], ["m2", 1800, "integ-codex@demo", MERGE], ["d1", 43200, "coord-lead-claude@demo", DAILY]]);
  assert.equal(r.merge.level, "FAIL"); assert.equal(r.merge.detail, "2 active (integ-claude@demo, integ-codex@demo)");
  assert.equal(r.daily.level, "OK");
});

test("no sweep or summary WARNs; one on the wrong seat WARNs and names it", () => {
  const none = check([["p1", 900, "integ-claude@demo", PARKED("q-1")]]);
  assert.deepEqual([none.merge.level, none.merge.detail], ["WARN", "none active"]);
  assert.equal(none.daily.level, "WARN");
  const wrong = check([["m1", 900, "impl-a@demo", MERGE], ["d1", 86400, "coord-lead-claude@demo", DAILY]]);
  assert.deepEqual([wrong.merge.level, wrong.merge.detail], ["WARN", "1 active (impl-a@demo)"]);
});

// QA PR77: OpenRig delivers `message ?? context.message`, so a spec may carry the message under context.
const CTX = (seat, text) => `target:\n  session: "${seat}"\ncontext:\n  message: "${text}"\n`;
test("a context.message spec counts like a top-level message; two such sweeps FAIL; an empty top-level message wins", () => {
  const one = check([["m1", 900, "integ-codex@demo", CTX("integ-codex@demo", "Merge sweep: inspect PRs")],
    ["d1", 86400, "coord-lead-claude@demo", CTX("coord-lead-claude@demo", "Daily summary: write it")]]);
  assert.deepEqual([one.merge.level, one.merge.detail], ["OK", ""]);
  assert.deepEqual([one.daily.level, one.daily.detail], ["OK", ""]);
  const two = check([["m1", 900, "integ-codex@demo", CTX("integ-codex@demo", "Merge sweep: inspect PRs")],
    ["m2", 900, "integ-claude@demo", CTX("integ-claude@demo", "Merge sweep: again")]]);
  assert.deepEqual([two.merge.level, two.merge.detail], ["FAIL", "2 active (integ-claude@demo, integ-codex@demo)"]);
  const twoDaily = check([["d1", 86400, "coord-lead-claude@demo", CTX("coord-lead-claude@demo", "Daily summary: one")],
    ["d2", 43200, "coord-lead-codex@demo", DAILY]]);
  assert.deepEqual([twoDaily.daily.level, twoDaily.daily.detail], ["FAIL", "2 active (coord-lead-claude@demo, coord-lead-codex@demo)"]);
  const emptyWins = check([["m1", 900, "integ-codex@demo", 'target:\n  session: "integ-codex@demo"\nmessage: ""\ncontext:\n  message: "Merge sweep: hidden"\n']]);
  assert.deepEqual([emptyWins.merge.level, emptyWins.merge.detail], ["WARN", "none active"], "an empty top-level message is what is delivered");
});

test("a watchdog whose spec can't be read is not counted and is said, never taken for a sweep", () => {
  const r = check([["m1", 900, "integ-claude@demo", MERGE], ["u1", 900, "integ-claude@demo", MERGE], ["d1", 86400, "coord-lead-claude@demo", DAILY]], ["u1"]);
  assert.equal(r.merge.level, "WARN");
  assert.equal(r.merge.detail, "1 watchdog(s) whose spec could not be read were not counted");
  assert.equal(r.daily.level, "WARN");
});
