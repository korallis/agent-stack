// bin/agent-human-inbox-tidy against a fake `rig`: closes only posted informational rows addressed to *@external.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "inbox-tidy-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const bin = join(root, "bin"), calls = join(root, "calls"), list = join(root, "list.json");
fs.mkdirSync(bin);
// fake rig: `queue list` prints $list (+ a trailing notice, like the real CLI can), `queue update` records; FAIL_* fail
fs.writeFileSync(join(bin, "rig"), `#!/usr/bin/env bash
if [ "$2" = list ]; then [ -n "$FAIL_LIST" ] && { echo "daemon unreachable" >&2; exit 1; }; cat ${list}; echo "notice: something"; exit 0; fi
printf '%s\\n' "rig $*" >> ${calls}
[ "$2" = update ] && [ "$3" = "$FAIL_ID" ] && { echo "nope" >&2; exit 1; }; exit 0
`, { mode: 0o755 });
fs.writeFileSync(join(bin, "logger"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
const row = (id, dest, intent, outcome) => ({ qitemId: id, destinationSession: dest, humanIntent: intent, deliveryOutcome: outcome, state: "pending", summary: id });
fs.writeFileSync(list, JSON.stringify([
  row("fyi", "owner@external", null, "posted"),
  row("quiet", "owner@external", "update", "posted"),
  row("decide", "owner@external", "decision", "posted"),
  row("unsent", "owner@external", null, null),
  row("failed", "owner@external", null, "failed"),
  row("never", "owner@external", null, "never-posted"),
  row("agent", "impl@shop", null, "posted"),
]));
function run(args = [], env = {}) {
  fs.rmSync(calls, { force: true });
  const r = spawnSync("python3", [join(repo, "bin/agent-human-inbox-tidy"), ...args], { encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}`, ...env } });
  return { ...r, calls: fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n") : [] };
}

test("closes only posted rows marked humanIntent=update; unset intent (a legacy decision), decisions, unsent/failed and agent rows are untouched", () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls, [
    "rig queue update quiet --state done --closure-reason no-follow-on --note informational; auto-closed after posting (agent-human-inbox-tidy)",
  ]);
  assert.match(r.stdout, /closed 1; left 5/);
});

test("--dry-run writes nothing", () => {
  const r = run(["--dry-run"]);
  assert.deepEqual(r.calls, []);
  assert.match(r.stdout, /would close quiet[\s\S]*would close 1; left 5/);
  assert.doesNotMatch(r.stdout, /would close fyi/);
});

test("an unreadable queue exits 1 without writing; one failed close is logged and the rest continue", () => {
  const down = run([], { FAIL_LIST: "1" });
  assert.equal(down.status, 1);
  assert.deepEqual(down.calls, []);
  fs.writeFileSync(list, JSON.stringify([row("a", "owner@external", "update", "posted"), row("b", "owner@external", "update", "posted")]));
  const partial = run([], { FAIL_ID: "a" });
  assert.equal(partial.status, 0);
  assert.match(partial.stdout, /could not close a[\s\S]*closed b/);
});

test("the timer runs every 5 minutes as its own queue identity", () => {
  const svc = fs.readFileSync(join(repo, "system/systemd/agent-human-inbox-tidy.service"), "utf8");
  assert.match(svc, /^Environment=OPENRIG_SESSION_NAME=agent-human-inbox-tidy@agent-stack$/m);
  assert.match(fs.readFileSync(join(repo, "system/systemd/agent-human-inbox-tidy.timer"), "utf8"), /^OnUnitActiveSec=5min$/m);
});
