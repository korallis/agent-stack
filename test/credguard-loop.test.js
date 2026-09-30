// WO32: the credential guard must never loop. Where mise doesn't activate `vercel`/`neon` in a project, its shim execs
// the next one on PATH, which was the guard again: guard -> shim -> guard at full CPU (hc, 2026-09-30). These tests use
// shims that behave like mise's (exec the next same-named command on PATH, skipping their own dir). Every run has a hard
// timeout, so a regression fails instead of hanging the suite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "credloop-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const home = join(root, "home"), seat = join(home, ".local/share/agent-stack/seat-bin"), shims = join(home, ".local/share/mise/shims");
const installs = join(home, ".local/share/mise/installs/node");
fs.mkdirSync(seat, { recursive: true }); fs.mkdirSync(shims, { recursive: true });
fs.copyFileSync(join(repo, "system/seat-bin-credguard"), join(seat, "credguard")); fs.chmodSync(join(seat, "credguard"), 0o755);
for (const t of ["neon", "neonctl", "vercel", "vc"]) fs.symlinkSync(join(seat, "credguard"), join(seat, t));
const exe = (p, body) => { fs.mkdirSync(dirname(p), { recursive: true }); fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 }); };
// A shim like mise's for an inactive tool: exec the next command of the same name on PATH, skipping its own directory.
const passOn = `me=$(dirname "$(readlink -f "$0")"); n=$(basename "$0")
IFS=:; for d in $PATH; do [ "$(readlink -f "$d")" = "$me" ] && continue; [ -x "$d/$n" ] && exec "$d/$n" "$@"; done; echo "no $n" >&2; exit 127`;
for (const t of ["vercel", "neon"]) exe(join(shims, t), passOn);
// Real CLIs in mise's node installs (numeric order: 22.10.0 is newer than 22.3.1 and 9.0.0).
for (const v of ["9.0.0", "22.3.1", "22.10.0"]) for (const t of ["vercel", "neon"]) exe(join(installs, v, "bin", t), `echo "real ${t} ${v} pid=$$ $*"`);

function run(cmd, pathDirs, extra = {}) {
  const t0 = Date.now();
  const r = spawnSync("bash", ["-c", cmd], { encoding: "utf8", timeout: 10000, killSignal: "SIGKILL",
    env: { HOME: home, PATH: [...pathDirs, "/usr/bin", "/bin"].join(":"), ...extra } });
  return { status: r.status, out: (r.stdout || "") + (r.stderr || ""), ms: Date.now() - t0, killed: r.signal === "SIGKILL" };
}

test("an inactive mise shim behind the guard: no loop; the real CLI comes from mise's node installs, newest version", () => {
  for (const t of ["vercel", "neon"]) {
    const r = run(`${t} whoami`, [seat, shims]);
    assert.ok(!r.killed, `${t} hung (${r.ms} ms)`);
    assert.equal(r.status, 0, r.out); assert.match(r.out, new RegExp(`^real ${t} 22\\.10\\.0 .* whoami`));
  }
  const nc = run("neonctl me", [seat, shims]);   // neonctl falls back to the neon CLI
  assert.equal(nc.status, 0, nc.out); assert.match(nc.out, /real neon 22\.10\.0/);
});

test("a symlink to the mise binary outside a shims dir is a shim too; a plain real CLI on PATH wins over the installs", () => {
  exe(join(home, "fakemise/mise"), passOn.replace('n=$(basename "$0")', 'n=vercel'));
  fs.mkdirSync(join(home, "tools"), { recursive: true }); fs.symlinkSync(join(home, "fakemise/mise"), join(home, "tools/vercel"));
  let r = run("vercel whoami", [seat, join(home, "tools")]);
  assert.ok(!r.killed); assert.match(r.out, /^real vercel 22\.10\.0/);
  exe(join(home, "plain/vercel"), 'echo "plain vercel $*"');
  r = run("vercel whoami", [seat, shims, join(home, "plain")]);
  assert.equal(r.status, 0, r.out); assert.match(r.out, /^plain vercel whoami/);
});

test("a wrapper that hands the call straight back is stopped by the loop guard, fast, with a clear message", () => {
  exe(join(home, "wrap/vercel"), passOn);   // not in a shims dir, not mise: resolution can't tell, the loop guard can
  const r = run("vercel whoami", [seat, join(home, "wrap")]);
  assert.ok(!r.killed, `hung (${r.ms} ms)`); assert.ok(r.ms < 5000, `${r.ms} ms`);
  assert.notEqual(r.status, 0); assert.match(r.out, /loop detected: a wrapper sent vercel straight back to the guard/);
});

test("a real CLI that runs vercel itself (a child process) is not mistaken for a loop", () => {
  exe(join(home, "nest/vercel"), `if [ -z "$NESTED" ]; then echo "outer pid=$$"; NESTED=1 vercel --version; echo "outer done rc=$?"; else echo "inner pid=$$ $*"; fi`);
  const r = run("vercel deploy --prebuilt", [seat, join(home, "nest")]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /outer pid=\d+\ninner pid=\d+ --version\nouter done rc=0/);
  assert.doesNotMatch(r.out, /loop detected/);
});

test("--credguard-resolve prints the real CLI the guard would run, and runs nothing", () => {
  let r = run("vercel --credguard-resolve", [seat, shims]);
  assert.equal(r.status, 0); assert.equal(r.out.trim(), join(installs, "22.10.0/bin/vercel"));
  fs.rmSync(installs, { recursive: true });
  r = run("vercel --credguard-resolve", [seat, shims]);
  assert.equal(r.status, 1); assert.equal(r.out.trim(), "none");
  r = run("vercel whoami", [seat, shims]);
  assert.ok(!r.killed); assert.notEqual(r.status, 0); assert.match(r.out, /the real vercel is not on PATH \(shims skipped\)/);
});

test("a CLI from mise's node installs runs on that install's own node, even with no node on PATH", () => {
  const v = join(home, ".local/share/mise/installs/node/30.0.0/bin");
  exe(join(v, "node"), 'echo "node-30 ran $(basename "$1") ${2:-}"');
  exe(join(v, "vercel"), 'echo "vercel script should be run by its node, not directly"');
  const r = run("vercel whoami", [seat, shims]);   // PATH has no node at all
  assert.equal(r.status, 0, r.out); assert.match(r.out, /^node-30 ran vercel whoami/);
  fs.rmSync(join(home, ".local/share/mise/installs/node/30.0.0"), { recursive: true });
});

test("mise's aliases (22, 22.10, latest) never make an older install win (QA round 1)", () => {
  const node = join(home, ".local/share/mise/installs/node");
  fs.rmSync(node, { recursive: true, force: true });
  for (const v of ["22.9.0", "22.10.0", "20.19.1"]) exe(join(node, v, "bin/vercel"), `echo "real vercel ${v}"`);
  for (const [alias, to] of [["22", "22.10.0"], ["22.10", "22.10.0"], ["latest", "22.10.0"], ["20", "20.19.1"], ["lts", "20.19.1"]])
    fs.symlinkSync(join(node, to), join(node, alias));
  const r = run("vercel --credguard-resolve", [seat, shims]);
  assert.equal(r.status, 0, r.out); assert.equal(r.out.trim(), join(node, "22.10.0/bin/vercel"));
  assert.match(run("vercel whoami", [seat, shims]).out, /^real vercel 22\.10\.0/);
  fs.rmSync(node, { recursive: true, force: true });
});
