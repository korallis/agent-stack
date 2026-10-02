// Daemon lifecycle belongs to the operator (2026-10-02): a seat followed OpenRig's "Daemon not running … run 'rig daemon
// start'" advice during the operator's daemon cycle and started a second daemon in its own terminal's scope. Three
// layers: the ~/.local/bin/rig launcher (written by install.sh) asks rig-lifecycle-guard before any command naming `up`
// or `daemon`; patch 146 changes OpenRig's advice for seats; the template CULTURE carries the rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(join(os.tmpdir(), "rig-guard-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

// The launcher exactly as install.sh writes it, into a scratch $L/$B, with a recording fake OpenRig CLI.
const L = join(root, "L"), B = join(root, "B"), calls = join(root, "calls");
for (const d of [join(L, "bin"), join(L, "openrig/bin"), B]) fs.mkdirSync(d, { recursive: true });
fs.copyFileSync(join(repo, "system/rig-lifecycle-guard"), join(L, "bin/rig-lifecycle-guard")); fs.chmodSync(join(L, "bin/rig-lifecycle-guard"), 0o755);
fs.writeFileSync(join(L, "openrig/bin/rig"), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${calls}"\n`, { mode: 0o755 });
const printf = fs.readFileSync(join(repo, "install.sh"), "utf8").split("\n").find((l) => l.startsWith("  printf '#!/usr/bin/env bash")).trim();
const w = spawnSync("bash", ["-c", printf], { env: { PATH: "/usr/bin:/bin", L, B, node22: "/usr/bin" }, encoding: "utf8" });
assert.equal(w.status, 0, w.stderr);
const rig = (args, env = {}) => {
  fs.writeFileSync(calls, "");
  const r = spawnSync(join(B, "rig"), args, { encoding: "utf8", env: { PATH: "/usr/bin:/bin", ...env } });
  return { code: r.status, err: r.stderr, ran: fs.readFileSync(calls, "utf8").trim() };
};
const seat = { OPENRIG_SESSION_NAME: "coord-deputy@demo" };

test("a seat is refused rig up and rig daemon start|stop|restart; nothing reaches OpenRig", () => {
  for (const args of [["up", "demo"], ["up", "kernel", "--existing"], ["daemon", "start"], ["daemon", "stop"], ["daemon", "restart"], ["--json", "daemon", "start"], ["daemon", "--force", "restart"]]) {
    const r = rig(args, seat);
    assert.equal(r.code, 3, args.join(" ")); assert.equal(r.ran, "", args.join(" "));
    assert.match(r.err, /refused: 'rig (up|daemon (start|stop|restart))' is the operator's job \(daemon lifecycle belongs to operator-agent@kernel\)/);
    assert.match(r.err, /wait 30 s and retry your command; if it stays down for 2 minutes,\n\s+tell operator-agent@kernel/);
  }
});

test("everything else passes through for a seat, including daemon status/logs and text that merely says up or daemon", () => {
  for (const args of [["daemon", "status"], ["daemon", "logs"], ["ps"], ["send", "lead@demo", "daemon start failed, is it up?"], ["queue", "show", "up"]]) {
    const r = rig(args, seat);
    assert.equal(r.code, 0, `${args.join(" ")}: ${r.err}`); assert.equal(r.ran, args.join(" "));
  }
});

test("the operator seat, a configured operator, and callers without a seat identity (systemd, a human) may run lifecycle commands", () => {
  for (const env of [{ OPENRIG_SESSION_NAME: "operator-agent@kernel" }, { OPENRIG_SESSION_NAME: "ops@x", AGENT_OPERATOR_SEAT: "ops@x" }, {}]) {
    for (const args of [["daemon", "start"], ["up", "kernel", "--existing"]]) {
      const r = rig(args, env); assert.equal(r.code, 0, JSON.stringify(env)); assert.equal(r.ran, args.join(" "));
    }
  }
  assert.equal(rig(["daemon", "start"], { OPENRIG_SESSION_NAME: "operator-agent@kernel", AGENT_OPERATOR_SEAT: "ops@x" }).code, 3, "a configured operator replaces the default");
});

test("a launcher whose guard is missing still runs (never blocks the CLI)", () => {
  fs.renameSync(join(L, "bin/rig-lifecycle-guard"), join(L, "bin/guard.off"));
  try { const r = rig(["daemon", "start"], seat); assert.equal(r.code, 0); assert.equal(r.ran, "daemon start"); }
  finally { fs.renameSync(join(L, "bin/guard.off"), join(L, "bin/rig-lifecycle-guard")); }
});

test("patch 146: OpenRig's daemon-down advice tells a seat to wait, and the operator and non-seats keep the start advice", async () => {
  const patch = fs.readFileSync(join(repo, "patches/openrig/0.6.3/146-seat-daemon-advice.patch"), "utf8");
  assert.match(patch, /^--- a\/dist\/daemon-lifecycle\.js$/m);
  // the first hunk's new side holds the helper and daemonNotRunningError whole; the second only rewraps an action
  const hunk = patch.split(/^@@.*@@$/m)[1].split("\n").filter((l) => !l.startsWith("-")).map((l) => l.slice(1)).join("\n");
  const src = hunk.slice(hunk.indexOf("function seatLifecycleAdvice"), hunk.indexOf("/**", hunk.indexOf("export function daemonNotRunningError")));
  fs.writeFileSync(join(root, "advice.mjs"), src);
  const { daemonNotRunningError } = await import(pathToFileURL(join(root, "advice.mjs")).href);
  const advice = (env) => { const saved = { ...process.env }; Object.assign(process.env, env); for (const k of ["OPENRIG_SESSION_NAME", "AGENT_OPERATOR_SEAT"]) if (!(k in env)) delete process.env[k];
    try { return daemonNotRunningError().action; } finally { process.env = saved; } };
  assert.match(advice({ OPENRIG_SESSION_NAME: "impl@demo" }), /^Don't start it yourself: daemon lifecycle belongs to the operator\. Wait 30 s and retry; if it stays down for 2 minutes, tell the operator\.$/);
  assert.equal(advice({ OPENRIG_SESSION_NAME: "operator-agent@kernel" }), "Run 'rig up' (it auto-starts the daemon), or 'rig daemon start'.");
  assert.equal(advice({}), "Run 'rig up' (it auto-starts the daemon), or 'rig daemon start'.");
  assert.match(patch, /^\+\s+action: seatLifecycleAdvice\("Re-check with 'rig daemon status'\. If it is confirmed stopped, run 'rig up' or 'rig daemon start'\."\),$/m, "the did-not-respond advice is wrapped too");
});

test("the template CULTURE carries the operator's lifecycle rule", () => {
  const culture = fs.readFileSync(join(repo, "rig/template/CULTURE.md"), "utf8");
  const sec = culture.split(/^## /m).find((s) => s.startsWith("Operator and lead rules"));
  assert.match(sec, /^- 2026-10-02: Daemon lifecycle belongs to operator-agent@kernel only\. Never run `rig daemon start\|stop\|restart` or `rig up` yourself, even when an error message suggests it.*wait 30 s and retry; if it stays down for 2 minutes, tell operator-agent@kernel.*\(operator, 19:41Z\)$/m);
});
