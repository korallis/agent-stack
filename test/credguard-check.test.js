// agent-credguard-check (WO27): which live seats have neon/vercel behind the guard. Run against a fake /proc and a
// throwaway HOME; read-only by design.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "cgcheck-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const home = join(root, "home"), proc = join(root, "proc"), seatBin = join(home, ".local/share/agent-stack/seat-bin");
const real = join(root, "node26/bin");
fs.mkdirSync(seatBin, { recursive: true }); fs.mkdirSync(real, { recursive: true }); fs.mkdirSync(join(home, ".config/agent-stack"), { recursive: true });
// A guard stub that answers --credguard-resolve (as the WO32 guard does) from $HOME/resolve-<tool>.
const guardSrc = '#!/bin/sh\n# answers --credguard-resolve\nt=$(basename "$0"); [ "$1" = --credguard-resolve ] && { cat "$HOME/resolve-$t" 2>/dev/null || echo none; exit 0; }\n';
fs.writeFileSync(join(seatBin, "credguard"), guardSrc, { mode: 0o755 });
for (const t of ["neon", "neonctl", "vercel", "vc"]) fs.symlinkSync(join(seatBin, "credguard"), join(seatBin, t));
for (const t of ["neon", "vercel"]) fs.writeFileSync(join(real, t), "#!/bin/sh\n", { mode: 0o755 });
const envSh = join(home, ".config/agent-stack/env.sh");
const TCK = 100, BOOT = 1_000_000;   // fake boot time; the checker reads SC_CLK_TCK (100 on Linux)
fs.mkdirSync(proc); fs.writeFileSync(join(proc, "stat"), `cpu 0\nbtime ${BOOT}\n`);
function pid(n, comm, env, startSec) {
  const d = join(proc, String(n)); fs.mkdirSync(d);
  fs.writeFileSync(join(d, "comm"), comm + "\n");
  fs.writeFileSync(join(d, "environ"), Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\0") + "\0");
  const fields = Array(20).fill("0"); fields[19] = String((startSec - BOOT) * TCK);
  fs.writeFileSync(join(d, "stat"), `${n} (${comm}) S ${fields.slice(1).join(" ")}\n`);
}
const check = () => {
  const r = spawnSync(join(repo, "bin/agent-credguard-check"), ["--json"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: home, AGENT_CREDGUARD_PROC: proc } });
  return { status: r.status, rows: JSON.parse(r.stdout || "[]"), err: r.stderr };
};

fs.writeFileSync(envSh, 'if [ -x "$HOME/.local/share/agent-stack/seat-bin/credguard" ]; then\n  neon() { :; }\nfi\n');
fs.utimesSync(envSh, BOOT + 500, BOOT + 500);
pid(101, "codex", { OPENRIG_NODE_ID: "n1", OPENRIG_SESSION_NAME: "a@r", PATH: `/usr/bin:${seatBin}:${real}` }, BOOT + 10);
pid(102, "codex", { OPENRIG_NODE_ID: "n2", OPENRIG_SESSION_NAME: "b@r", PATH: `${real}:${seatBin}` }, BOOT + 10);
pid(103, "claude", { OPENRIG_NODE_ID: "n3", OPENRIG_SESSION_NAME: "c@r", PATH: real }, BOOT + 900);
pid(104, "claude", { OPENRIG_NODE_ID: "n4", OPENRIG_SESSION_NAME: "d@r", PATH: seatBin }, BOOT + 100);
pid(105, "claude", { PATH: real }, BOOT + 10);             // the owner's own Claude: not a seat
pid(106, "bash", { OPENRIG_NODE_ID: "n6", PATH: real }, BOOT + 10);

test("codex: the first neon/vercel on its PATH must be the guard; claude: launched after env.sh got the functions", () => {
  const { status, rows } = check();
  assert.equal(status, 1);
  const by = Object.fromEntries(rows.map((r) => [r.seat, r]));
  assert.deepEqual(Object.keys(by).sort(), ["a@r", "b@r", "c@r", "d@r"]);   // only claude/codex seat processes
  assert.equal(by["a@r"].guarded, true);
  assert.equal(by["b@r"].guarded, false); assert.match(by["b@r"].why, /real CLI first: neon -> .*node26/);
  assert.equal(by["c@r"].guarded, true);
  assert.equal(by["d@r"].guarded, false); assert.match(by["d@r"].why, /relaunch at idle/);
});

test("no guard functions in env.sh, or no guard installed: every seat fails with the reason", () => {
  fs.writeFileSync(envSh, "# old env.sh\n");
  assert.match(check().rows.find((r) => r.seat === "c@r").why, /no guard functions/);
  fs.rmSync(join(seatBin, "credguard"));
  assert.ok(check().rows.every((r) => !r.guarded && /guard not installed/.test(r.why)));
});


test("loop-prone seats FAIL (WO32): a guard from before the shim fix, or one that would run a mise shim", () => {
  fs.writeFileSync(envSh, 'if [ -x "$HOME/.local/share/agent-stack/seat-bin/credguard" ]; then\n  neon() { :; }\nfi\n');
  fs.utimesSync(envSh, BOOT + 500, BOOT + 500);
  fs.writeFileSync(join(seatBin, "credguard"), guardSrc, { mode: 0o755 });
  for (const t of ["neon", "vercel"]) fs.writeFileSync(join(home, `resolve-${t}`), `${real}/${t}\n`);
  assert.equal(check().rows.find((r) => r.seat === "a@r").guarded, true, "resolves to real CLIs: OK");
  fs.writeFileSync(join(home, "resolve-vercel"), `${home}/.local/share/mise/shims/vercel\n`);
  let a = check().rows.find((r) => r.seat === "a@r");
  assert.equal(a.guarded, false); assert.match(a.why, /loop-prone: vercel -> .*\/shims\/vercel \(a shim\)/);
  fs.writeFileSync(join(seatBin, "credguard"), "#!/bin/sh\n# a guard from before WO32\n", { mode: 0o755 });
  const rows = check().rows;
  assert.ok(rows.every((r) => !r.guarded && /predates the shim fix/.test(r.why)), JSON.stringify(rows));
});
