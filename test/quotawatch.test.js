// cliproxy-quotawatch reads Codex's windows by their reported length: since 2026-10 primary is the WEEKLY window
// (10080 minutes) and secondary a 0-minute one, so there is no 5-hour limit. Reading by position raised "codex-x at
// 100% of its 5-hour window" and a critical "every codex account ... will stall soon" every 3 hours while the accounts
// worked on credits. An account that has used a window but has credits is noted once a day (low urgency), never as a
// stall; a used-up week with no credits is still critical. The script runs on a synthetic routing log with stub
// notify-send and logger (no proxy, no desktop).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "quotawatch-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const bin = join(root, "bin");
fs.mkdirSync(bin);
for (const t of ["notify-send", "logger"]) fs.writeFileSync(join(bin, t), `#!/bin/sh\nprintf '%s\\n' "${t} $*" >> "$CALLS"\n`, { mode: 0o755 });

let n = 0;
/** Runs quotawatch over these log lines; `state` carries over between runs of one scenario. */
function watch(lines, state = join(root, `state-${++n}`)) {
  const log = join(root, `log-${n}.jsonl`), calls = join(root, `calls-${n}-${Math.random()}`);
  fs.writeFileSync(log, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const r = spawnSync("bash", [join(repo, "system/cliproxy-quotawatch")], { encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, QUOTAWATCH_LOG: log, QUOTAWATCH_STATE: state, CALLS: calls } });
  assert.equal(r.status, 0, r.stderr);
  const notes = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter((l) => l.startsWith("notify-send")) : [];
  return { out: r.stdout, notes, state, urgency: (re) => notes.filter((l) => re.test(l)).map((l) => l.match(/--urgency=(\w+)/)[1]) };
}
const cx = (account, used, credits, extra = {}) => ({ account, quota: { "X-Codex-Primary-Used-Percent": used, "X-Codex-Primary-Window-Minutes": "10080",
  "X-Codex-Secondary-Used-Percent": "0", "X-Codex-Secondary-Window-Minutes": "0", "X-Codex-Plan-Type": "pro",
  ...(credits === undefined ? {} : { "X-Codex-Credits-Has-Credits": credits }), ...extra } });
const cl = (account, h5, d7) => ({ account, quota: { "Anthropic-Ratelimit-Unified-5h-Utilization": h5, "Anthropic-Ratelimit-Unified-7d-Utilization": d7 } });

test("today's Codex shape on credits: no 5-hour alerts, no critical, one low-urgency note a day", () => {
  const lines = ["a", "b", "c", "d"].map((x) => cx(`codex-${x}`, "100", "True"));
  const r = watch(lines);
  assert.doesNotMatch(r.out, /5-hour/, r.out);
  assert.doesNotMatch(r.out, /every codex account|will stall/);
  assert.deepEqual(r.urgency(/on credits/), ["low"]);
  assert.match(r.out, /^Quota: 4 codex accounts on credits: They have used a window and carry on on credits: working, at a cost\./m);
  assert.equal(r.notes.length, 1, r.notes.join("\n"));
  assert.equal(watch(lines, r.state).notes.length, 0, "the note is not repeated within the day");
});

test("a used-up week with no credits is still critical; one account with credits means the provider is not stalling", () => {
  const none = watch([cx("codex-a", "100", "False"), cx("codex-b", "92", "False")]);
  assert.match(none.out, /codex-a at 100% of its weekly allowance: Plan heavy runs around it/);
  assert.doesNotMatch(none.out, /5-hour/);
  assert.deepEqual(none.urgency(/every codex account/), ["critical"]);
  const mixed = watch([cx("codex-a", "100", "False"), cx("codex-b", "100", "True")]);
  assert.doesNotMatch(mixed.out, /every codex account/, "codex-b carries on on credits");
  assert.match(mixed.out, /1 codex account on credits/);
  const unknown = watch([cx("codex-a", "100", undefined)]);
  assert.deepEqual(unknown.urgency(/every codex account/), ["critical"], "no credits reading: no exemption");
  const unlimited = watch([cx("codex-a", "100", "False", { "X-Codex-Credits-Unlimited": "True" })]);
  assert.doesNotMatch(unlimited.out, /every codex/); assert.match(unlimited.out, /1 codex account on credits/);
});

test("windows by length (either order), a real 5-hour window still alerts, and the older shape reads by position", () => {
  const swapped = watch([{ account: "codex-a", quota: { "X-Codex-Primary-Used-Percent": "40", "X-Codex-Primary-Window-Minutes": "10080",
    "X-Codex-Secondary-Used-Percent": "85", "X-Codex-Secondary-Window-Minutes": "300" } }]);
  assert.match(swapped.out, /codex-a at 85% of its 5-hour window/); assert.doesNotMatch(swapped.out, /weekly/);
  const old = watch([{ account: "codex-a", quota: { "X-Codex-Primary-Used-Percent": "90", "X-Codex-Secondary-Used-Percent": "20" } }]);
  assert.match(old.out, /codex-a at 90% of its 5-hour window/, "no lengths: primary is the short window, as before");
  const weekCredits = watch([cx("codex-a", "85", "True")]);
  assert.match(weekCredits.out, /codex-a at 85% of its weekly allowance: It has credits, so when the week runs out it carries on on credits \(a cost, not a stall\)/);
  assert.doesNotMatch(weekCredits.out, /every codex/, "a week with credits behind it is not a stall");
});

test("Claude is read as before: fractions, the 5-hour window, and the provider-wide critical", () => {
  const r = watch([cl("claude-a", "1.01", "0.5"), cl("claude-b", "0.3", "0.85")]);
  assert.match(r.out, /claude-a at 101% of its 5-hour window/); assert.match(r.out, /claude-b at 85% of its weekly allowance/);
  assert.deepEqual(r.urgency(/every claude account/), ["critical"]);
  assert.equal(watch([cl("claude-a", "0.2", "0.3")]).out, "");
});

test("the routing log keeps what quotawatch needs: each Codex window's length and the credits flags", () => {
  const r = spawnSync("python3", ["-c", "import sys; sys.path.insert(0, sys.argv[1]); import usage_collector as u; print('\\n'.join(u.QUOTA_KEYS))", join(repo, "proxy")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  for (const k of ["X-Codex-Primary-Window-Minutes", "X-Codex-Secondary-Window-Minutes", "X-Codex-Credits-Has-Credits", "X-Codex-Credits-Unlimited"])
    assert.ok(r.stdout.split("\n").includes(k), k);
});

test("under systemd each alert reaches the journal once (logger), not twice (logger and stdout)", () => {
  const log = join(root, "log-journal.jsonl"), calls = join(root, "calls-journal");
  fs.writeFileSync(log, JSON.stringify(cl("claude-a", "1.01", "0.5")) + "\n");
  const go = (extra) => spawnSync("bash", [join(repo, "system/cliproxy-quotawatch")], { encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, QUOTAWATCH_LOG: log, QUOTAWATCH_STATE: join(root, `state-j-${Math.random()}`), CALLS: calls, ...extra } });
  const r = go({ JOURNAL_STREAM: "8:12345" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "", "stdout is the journal there: logger has it");
  const c = fs.readFileSync(calls, "utf8").split("\n");
  assert.equal(c.filter((l) => l.startsWith("logger") && l.includes("claude-a at 101% of its 5-hour window")).length, 1);
  assert.equal(c.filter((l) => l.startsWith("notify-send") && l.includes("claude-a at 101%")).length, 1);
  assert.match(go({}).stdout, /claude-a at 101% of its 5-hour window/, "by hand: printed as well");
});
