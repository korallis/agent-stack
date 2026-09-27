process.env.AGENT_STACK_STATE = (await import("node:fs")).mkdtempSync("/tmp/claude-1000/agst-");
import { test } from "node:test";
import assert from "node:assert/strict";
const { permittedActions, ruleClass, BUDGET } = await import("../orchestration/recover.js");
const { odb } = await import("../orchestration/lib.js");

const seats = [
  { seat: "impl-a@r", role: "implementer", family: "codex", running: true, assigned: 1, pending: 0, idle: false },
  { seat: "impl-b@r", role: "implementer", family: "claude", running: true, assigned: 0, pending: 0, idle: true },
  { seat: "lead@r", role: "lead", family: "claude", running: true, assigned: 0, pending: 0, idle: true },
];
const ctx = (item, who = "impl-a@r") => ({ item, seat: "impl-a@r", owner: "impl-a@r", caller: who, rigSeats: seats });

test("uncertain classification permits only escalation", () => {
  assert.deepEqual(permittedActions("network", "uncertain", ctx("q1")).actions, ["escalate"]);
});
test("retry budget and cooldown are enforced by code", () => {
  const db = odb();
  db.prepare("INSERT INTO recovery (ts,item,seat,class,action,applied,decided_by) VALUES (?,?,?,?,?,?,?)").run(Date.now() - 10 * 60_000, "q2", "impl-a@r", "network", "retry", 1, "jev");
  db.prepare("INSERT INTO recovery (ts,item,seat,class,action,applied,decided_by) VALUES (?,?,?,?,?,?,?)").run(Date.now() - 9 * 60_000, "q2", "impl-a@r", "network", "retry", 1, "jev");
  const p = permittedActions("network", "act", ctx("q2"));
  assert.ok(!p.actions.includes("retry")); assert.match(p.reasons.retry, /budget exhausted/);
});
test("a recent applied action suppresses duplicate recovery", () => {
  odb().prepare("INSERT INTO recovery (ts,item,seat,class,action,applied,decided_by) VALUES (?,?,?,?,?,?,?)").run(Date.now(), "q3", "impl-a@r", "stalled", "retry", 1, "jev");
  const p = permittedActions("stalled", "act", ctx("q3"));
  assert.deepEqual(p.actions, ["escalate"]); assert.ok(p.reasons.duplicate);
});
test("reassign requires ownership (owner, lead or integration) and a free same-role seat", () => {
  assert.ok(permittedActions("stalled", "act", ctx("q4", "impl-a@r")).actions.includes("reassign"));
  assert.ok(permittedActions("stalled", "act", ctx("q5", "lead@r")).actions.includes("reassign"));
  const p = permittedActions("stalled", "act", ctx("q6", "impl-b@r"));
  assert.ok(!p.actions.includes("reassign")); assert.match(p.reasons.reassign, /does not own/);
});
test("permission_denied never auto-acts", () => {
  assert.deepEqual(permittedActions("permission_denied", "act", ctx("q7")).actions, ["escalate"]);
});
test("deterministic rules classify unambiguous signatures; ambiguous ones go to Jev", () => {
  assert.equal(ruleClass("HTTP 401 Unauthorized"), "auth_expired");
  assert.equal(ruleClass("unknown provider for model gpt-6-astra"), "quota_exhausted");
  assert.equal(ruleClass("something odd happened"), null);
  assert.equal(ruleClass("401 Unauthorized ... CONFLICT (content): Merge conflict"), null); // two rules → Jev
});
