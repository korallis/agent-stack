// WO82: agent-heavy recognises a slot's holders on every filesystem. On Btrfs, stat's device for a file (the
// subvolume's anonymous device) is not the device /proc/locks and fdinfo show for its lock, so the device:inode match
// missed every holder: status said a held slot was free, and a nested same-class call waited for itself. Holders are now
// found by the lock FILE (an fd on its real path that carries the FLOCK). Real processes and flock, on tmpfs and, where
// this machine has one, Btrfs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const heavy = join(repo, "bin/agent-heavy");
const fsType = (d) => { try { return spawnSync("stat", ["-f", "-c", "%T", d], { encoding: "utf8" }).stdout.trim(); } catch { return ""; } };
// one scratch dir per filesystem type found among the usual places
const places = [...new Set([os.tmpdir(), process.env.XDG_RUNTIME_DIR, join(os.homedir(), ".cache")].filter((d) => d && fs.existsSync(d)))];
const byType = new Map();
for (const d of places) { const t = fsType(d); if (t && !byType.has(t)) byType.set(t, d); }
const roots = [];
process.on("exit", () => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true })));
const bin = fs.mkdtempSync(join(os.tmpdir(), "heavyfs-bin-")); roots.push(bin);
fs.writeFileSync(join(bin, "systemctl"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
fs.writeFileSync(join(bin, "logger"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
// bwrap is stubbed (it records its arguments and runs the job): the filesystem sandbox has its own tests
fs.writeFileSync(join(bin, "bwrap"), `#!/usr/bin/env bash
[ -n "\${BWRAP_CALLS:-}" ] && printf '%s\\n' "$*" >> "$BWRAP_CALLS"
while [ $# -gt 0 ] && [ "$1" != "--" ]; do shift; done; [ $# -gt 0 ] && shift
[ $# -gt 0 ] && exec "$@"; exit 0
`, { mode: 0o755 });

function lab(base) {
  const d = fs.mkdtempSync(join(base, "heavyfs-")); roots.push(d);
  const env = { PATH: `${bin}:/usr/bin:/bin`, USER: "t", AGENT_HEAVY_BWRAP: join(bin, "bwrap"), AGENT_HEAVY_DIR: join(d, "heavy"), AGENT_HEAVY_BUILD_SLOTS: "1", AGENT_HEAVY_POLL: "0.1", OPENRIG_SESSION_NAME: "seat-a@lab" };
  return { d, env };
}
const until = async (cond, what, ms = 8000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 25)); } };

for (const type of ["tmpfs", "btrfs"]) {
  const base = byType.get(type);
  test(`${type}: status names the holder of a held slot and says free after; a nested same-class call runs inline (WO82)`, { skip: !base && `no ${type} directory on this machine` }, async () => {
    const { d, env } = lab(base), lockDir = env.AGENT_HEAVY_DIR;
    const job = spawn(heavy, ["build", "--", "bash", "-c", `touch ${d}/started; while [ ! -f ${d}/release ]; do sleep 0.05; done`], { env });
    const done = new Promise((r) => job.on("exit", r));
    try {
      await until(() => fs.existsSync(join(d, "started")), "the job runs");
      const lock = join(lockDir, "build.1.lock");
      if (type === "btrfs") {
        // the case itself: stat's device for the lock differs from the device the lock table shows for it
        const [maj, min, ino] = spawnSync("stat", ["-L", "-c", "%Hd %Ld %i", lock], { encoding: "utf8" }).stdout.trim().split(" ");
        const statId = `${Number(maj).toString(16).padStart(2, "0")}:${Number(min).toString(16).padStart(2, "0")}:${ino}`;
        const table = fs.readFileSync("/proc/locks", "utf8").split("\n").filter((l) => / FLOCK /.test(l) && l.trim().split(/\s+/)[5]?.endsWith(`:${ino}`));
        assert.ok(table.length >= 1, "the lock is in the table");
        assert.ok(table.every((l) => l.trim().split(/\s+/)[5] !== statId), `devices differ (stat ${statId}; table ${table.join(" | ")}): the Btrfs case is exercised`);
      }
      const st = spawnSync(heavy, ["status", "build"], { env, encoding: "utf8" });
      assert.equal(st.status, 0, st.stderr);
      assert.match(st.stdout, /^build 1\/1  held  seat=seat-a@lab  age=\S+  remaining=\S+  cwd=\S+  cmd=bash -c touch/m, st.stdout);
      // the job's own nested call recognises the slot its ancestor holds (one slot, --wait 0: it would otherwise exit 75)
      fs.writeFileSync(join(d, "nested.sh"), `#!/bin/bash\n${heavy} build --wait 0 -- echo inner\n`, { mode: 0o755 });
      const parentEnv = { ...env, AGENT_HEAVY_ACTIVE: "build", AGENT_HEAVY_SLOT: "build.1" };
      // run it as a child of the job's process tree: the job's bash is an ancestor only of its own children, so use a
      // second job that holds nothing to show the negative, and the job itself (via a file trigger) for the positive
      const outsider = spawnSync(join(d, "nested.sh"), [], { env: parentEnv, encoding: "utf8" });
      assert.equal(outsider.status, 75, "a marker without the ancestor's lock is ignored and has to queue (no free slot)");
      assert.match(outsider.stderr, /ignoring AGENT_HEAVY_ACTIVE=build: no build slot is held by this process's ancestors/);
    } finally { fs.writeFileSync(join(d, "release"), ""); await done; }
    assert.match(spawnSync(heavy, ["status", "build"], { env, encoding: "utf8" }).stdout, /^build 1\/1  free$/m);
    // positive nested case: a job whose command makes the nested call itself
    const inner = spawnSync(heavy, ["build", "--", "bash", "-c", `${heavy} build --wait 0 -- echo inner-ok`], { env, encoding: "utf8", timeout: 20_000 });
    assert.equal(inner.status, 0, inner.stderr);
    assert.match(inner.stdout, /inner-ok/);
    assert.match(inner.stderr, /nested build run: already inside build\.1; running inline/);
  });

  test(`${type}: a process that only opens the lock file is not a holder (WO82)`, { skip: !base && `no ${type} directory on this machine` }, async () => {
    const { d, env } = lab(base), lock = join(env.AGENT_HEAVY_DIR, "build.1.lock");
    fs.mkdirSync(env.AGENT_HEAVY_DIR, { recursive: true }); fs.writeFileSync(lock, "");
    const opener = spawn("bash", ["-c", `exec 9>${lock}; touch ${d}/open; sleep 30`]);
    try {
      await until(() => fs.existsSync(join(d, "open")), "the file is open");
      assert.match(spawnSync(heavy, ["status", "build"], { env, encoding: "utf8" }).stdout, /^build 1\/1  free$/m);
    } finally { opener.kill("SIGKILL"); }
  });
}
