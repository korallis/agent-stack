// agent-refresh-guidance.timer (every 5 min) runs agent-refresh-guidance-all: every running project rig's seat
// instructions are refreshed after a CULTURE/role/startup edit, and native seats owed a re-read are told once idle.
// Near-free when nothing changed; a stopped rig is never touched. rig and agent-refresh-guidance are stubs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const tool = join(repo, "bin/agent-refresh-guidance-all");
const root = fs.mkdtempSync(join(os.tmpdir(), "refresh-all-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function world({ ps = "running", psFails = false, refreshFails = false } = {}) {
  const w = fs.mkdtempSync(join(root, "w-")), P = join(w, "Projects"), S = join(w, "state"), A = join(w, "agent-stack"), bin = join(w, "bin"), calls = join(w, "calls");
  for (const [name, rig] of [["Alpha", "alpha"], ["Beta", "beta"]]) {
    fs.mkdirSync(join(P, `${name}-work/rig/startup`), { recursive: true });
    fs.writeFileSync(join(P, `${name}-work/rig/CULTURE.md`), `# ${name}\n`); fs.writeFileSync(join(P, `${name}-work/rig/team.yaml`), `name: "${rig}"\npods: []\n`);
    fs.mkdirSync(join(P, `${name}.worktrees/impl-grok-1/.grok/rules`), { recursive: true });
  }
  fs.mkdirSync(join(A, "rig/template/agents/implementer/guidance"), { recursive: true }); fs.writeFileSync(join(A, "rig/template/agents/implementer/guidance/role.md"), "role\n");
  fs.mkdirSync(join(A, "bin"), { recursive: true }); fs.writeFileSync(join(A, "bin/agent-native-seat"), "launcher\n");
  fs.mkdirSync(bin); fs.mkdirSync(S);
  fs.writeFileSync(join(bin, "rig"), `#!/bin/sh\n${psFails ? "exit 1" : `cat <<'X'\n6 rigs\nRIG   NODES RUNNING ACTIVE WORK ATTN STATUS LIFECYCLE UPTIME SNAPSHOT\nalpha 3 3 1 1 0 ${ps} run 1d 1s ago\nbeta 3 0 0 0 0 stopped stop - 1s ago\nX`}\n`, { mode: 0o755 });
  fs.writeFileSync(join(bin, "logger"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const refresh = join(bin, "agent-refresh-guidance");
  fs.writeFileSync(refresh, `#!/bin/sh\necho "$@" >> "${calls}"\n${refreshFails ? 'echo "boom" >&2; exit 3' : `echo '{"total": 3, "changed": [{"seat": "impl-claude", "file": "CLAUDE.local.md", "reasons": ["x"]}], "native_notified": ["impl-grok-1@alpha"], "native_pending": ["review-grok@alpha"]}'`}\n`, { mode: 0o755 });
  const env = { PATH: `${bin}:/usr/bin:/bin`, AGENT_PROJECTS_DIR: P, AGENT_STACK_STATE: S, AGENT_STACK_DIR: A, AGENT_REFRESH_GUIDANCE: refresh };
  const run = () => { fs.writeFileSync(calls, ""); const r = spawnSync("python3", [tool], { encoding: "utf8", env }); return { ...r, calls: fs.readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) }; };
  return { w, P, S, A, run };
}

test("a running rig is refreshed (one log line per action); a stopped rig never; an unchanged rig with nothing owed is skipped", () => {
  const { P, S, run } = world();
  const r1 = run();
  assert.equal(r1.status, 0, r1.stderr);
  assert.deepEqual(r1.calls, [`${P}/Alpha-work --apply --json`], "alpha only: beta is stopped");
  assert.deepEqual(r1.stdout.trim().split("\n"), ["alpha: refreshed 1 instruction file(s): impl-claude", "alpha: told impl-grok-1@alpha to re-read its instructions",
    "alpha: review-grok@alpha still owed a re-read (busy; told when idle)"]);
  assert.ok(JSON.parse(fs.readFileSync(join(S, "refresh-guidance-hashes.json"), "utf8")).alpha);
  const r2 = run(); assert.deepEqual(r2.calls, [], "unchanged, nothing owed: no call"); assert.equal(r2.stdout, "");
});

test("an owed native seat, or an edit to CULTURE, startup, a role or the launcher, runs it again", () => {
  const { P, S, A, run } = world();
  run();
  fs.writeFileSync(join(S, "native-refresh-pending.json"), JSON.stringify({ "impl-grok-1@alpha": { path: join(P, "Alpha.worktrees/impl-grok-1/.grok/rules/openrig-seat.md") } }));
  assert.equal(run().calls.length, 1, "owed: run even though nothing changed");
  fs.writeFileSync(join(S, "native-refresh-pending.json"), JSON.stringify({ "impl-grok-1@beta": { path: join(P, "Beta.worktrees/impl-grok-1/.grok/rules/openrig-seat.md") } }));
  assert.equal(run().calls.length, 0, "a seat of another (stopped) rig owed: alpha still skipped");
  for (const f of [join(P, "Alpha-work/rig/CULTURE.md"), join(P, "Alpha-work/rig/startup/context.md"), join(A, "rig/template/agents/implementer/guidance/role.md"), join(A, "bin/agent-native-seat")]) {
    fs.writeFileSync(f, `edited ${Math.random()}\n`);
    assert.equal(run().calls.length, 1, f); assert.equal(run().calls.length, 0, `${f}: then quiet again`);
  }
});

test("rig ps unreadable: nothing runs; a failed refresh is retried next time and fails the unit", () => {
  const down = world({ psFails: true }).run();
  assert.equal(down.status, 0); assert.deepEqual(down.calls, []); assert.match(down.stdout, /rig ps unreadable \(daemon down\?\): nothing refreshed/);
  const bad = world({ refreshFails: true });
  const r = bad.run(); assert.equal(r.status, 1); assert.match(r.stdout, /alpha: agent-refresh-guidance failed \(exit 3\): boom/);
  assert.equal(bad.run().calls.length, 1, "no hash recorded after a failure: retried");
  assert.equal(world({ ps: "partial" }).run().calls.length, 1, "a partial (degraded) rig is still running");
});

test("installed: the timer runs every 5 minutes, install links the tool and enables the timer", () => {
  const t = fs.readFileSync(join(repo, "system/systemd/agent-refresh-guidance.timer"), "utf8");
  assert.match(t, /OnUnitActiveSec=5min/);
  assert.match(fs.readFileSync(join(repo, "system/systemd/agent-refresh-guidance.service"), "utf8"), /ExecStart=%h\/\.local\/bin\/agent-refresh-guidance-all/);
  const inst = fs.readFileSync(join(repo, "install.sh"), "utf8");
  assert.match(inst, /for f in [^;]*\bagent-refresh-guidance-all\b/); assert.match(inst, /for t in [^;]*\bagent-refresh-guidance\b[^;]*playwright-browsers;/);
});
