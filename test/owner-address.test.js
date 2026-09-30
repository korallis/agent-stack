// WO33: the owner's human address is a per-machine setting (agent-owner-address), not a name in the public repo.
// The resolver runs from a copy of the repo layout, so the test never writes the real config/owner.env.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "owner-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const S = join(root, "repo"), bin = join(root, "bin");
fs.mkdirSync(join(S, "bin"), { recursive: true }); fs.mkdirSync(join(S, "config")); fs.mkdirSync(bin);
fs.copyFileSync(join(repo, "bin/agent-owner-address"), join(S, "bin/agent-owner-address")); fs.chmodSync(join(S, "bin/agent-owner-address"), 0o755);
const humans = (list) => fs.writeFileSync(join(bin, "rig"), `#!/bin/sh\n[ "$1 $2 $3" = "gateway human list" ] && echo '${JSON.stringify({ ok: true, humans: list })}'\nexit 0\n`, { mode: 0o755 });
const resolve = (env = {}, args = ["--source"]) => {
  const r = spawnSync(join(S, "bin/agent-owner-address"), args, { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, ...env } });
  return { out: r.stdout.trim(), err: r.stderr, status: r.status };
};
const file = (v) => (v === null ? fs.rmSync(join(S, "config/owner.env"), { force: true }) : fs.writeFileSync(join(S, "config/owner.env"), `# note\nOWNER_ADDRESS=${v}\n`));

test("resolution order: AGENT_OWNER_ADDRESS, then config/owner.env, then OpenRig's one registered human, then owner@external", () => {
  humans([{ entityId: "ann", address: "ann@external" }]); file("bob@external");
  assert.equal(resolve({ AGENT_OWNER_ADDRESS: "cy@external" }).out, "cy@external (AGENT_OWNER_ADDRESS)");
  assert.equal(resolve().out, "bob@external (config/owner.env)");
  file(null);
  assert.equal(resolve().out, "ann@external (OpenRig human registry)");
  assert.equal(resolve({}, []).out, "ann@external", "without --source: the address alone");
  humans([{ address: "ann@external" }, { address: "bob@external" }]);
  assert.equal(resolve().out, "owner@external (default)", "two registered humans: none is picked");
  humans([]);
  assert.equal(resolve().out, "owner@external (default)");
});

test("a value that isn't <name>@external is ignored with a warning", () => {
  humans([]); file("not an address");
  const r = resolve({ AGENT_OWNER_ADDRESS: "x@example.invalid" });
  assert.equal(r.out, "owner@external (default)");
  assert.match(r.err, /ignoring AGENT_OWNER_ADDRESS: 'x@example\.invalid' is not <name>@external/);
  assert.match(r.err, /ignoring config\/owner\.env/);
  file(null);
});

test("install.sh records a derived address once, never the bare default, and --check writes nothing", () => {
  const src = fs.readFileSync(join(repo, "install.sh"), "utf8");
  const a = src.indexOf('step "Owner address'), b = src.indexOf('step "Kernel operator');
  const block = (check) => `set -euo pipefail\nS=${S}\nCHECK=${check}\nstep() { :; }\nok() { echo "ok  $*"; }\ntodo() { echo "--  $*"; }\n${src.slice(a, b)}`;
  const run = (check) => spawnSync("bash", ["-c", block(check)], { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root } });
  humans([]); file(null);
  let r = run(0); assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /none registered yet; register yourself/);
  assert.ok(!fs.existsSync(join(S, "config/owner.env")), "the default is never written down");
  humans([{ address: "ann@external" }]);
  r = run(1); assert.match(r.stdout, /ann@external \(OpenRig human registry\), not recorded/); assert.ok(!fs.existsSync(join(S, "config/owner.env")));
  r = run(0); assert.match(r.stdout, /ann@external recorded in config\/owner\.env/);
  assert.match(fs.readFileSync(join(S, "config/owner.env"), "utf8"), /^OWNER_ADDRESS=ann@external$/m);
  humans([{ address: "zed@external" }]);
  r = run(0); assert.match(r.stdout, /owner address: ann@external \(config\/owner\.env\)/, "recorded once; the registry doesn't overwrite it");
  file(null);
});

test("the template carries @OWNER@, and config/owner.env stays out of git", () => {
  assert.match(fs.readFileSync(join(repo, "rig/template/CULTURE.md"), "utf8"), /informational row to the owner \(@OWNER@\)/);
  assert.equal(spawnSync("git", ["check-ignore", "-q", "config/owner.env"], { cwd: repo }).status, 0);
});
