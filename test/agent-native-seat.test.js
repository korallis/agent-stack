// WO88: agent-native-seat runs grok and kimi as OpenRig terminal seats (proven live on a throwaway rig: each took a queue
// row, did the task, closed the row; `rig send --wait-for-idle` delivered once activity was reported). Here: a fake CLI
// on PATH and a stub activity ingest, in a throwaway HOME; no model call.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import { createHash } from "node:crypto";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const tool = join(repo, "bin/agent-native-seat");
const root = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "native-seat-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));

// a seat worktree inside a workspace that has rig/CULTURE.md, with the project's own AGENTS.md
function workspace(name) {
  const ws = join(root, name), wt = join(ws, "worktrees", "impl-grok-1");
  fs.mkdirSync(join(ws, "rig"), { recursive: true }); fs.writeFileSync(join(ws, "rig/CULTURE.md"), "# Culture\nClaim before you work.\n");
  fs.mkdirSync(wt, { recursive: true });
  spawnSync("git", ["init", "-q", wt]);
  fs.writeFileSync(join(wt, "AGENTS.md"), "# The app's own agent notes\n");
  return { ws, wt };
}
// a fake CLI: reports busy (OSC 9;4;3), records the bytes it reads until CR, then done (OSC 9;4;0) and exits
function fakeCli(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, name), `#!/usr/bin/env python3
import os, sys, json, time, tty
tty.setraw(0)   # as a real TUI does: keys arrive as typed, CR stays CR
out = os.environ["FAKE_OUT"]
with open(out, "w") as f: json.dump({"argv": sys.argv[1:], "env": {k: v for k, v in os.environ.items() if k.startswith(("GROK_", "KIMI_", "TERM_PROGRAM"))}}, f)
sys.stdout.write("\\x1b]9;4;3\\x07working"); sys.stdout.flush()
import select
got, deadline = b"", time.time() + 5   # never hang the suite: give up after 5 s without an Enter
while not got.endswith(b"\\r") and time.time() < deadline:
    if not select.select([0], [], [], 0.2)[0]: continue
    b = os.read(0, 1)
    if not b: break
    got += b
with open(out + ".stdin", "wb") as f: f.write(got)
sys.stdout.write("\\x1b]9;4;0\\x07done"); sys.stdout.flush(); time.sleep(0.6)
`, { mode: 0o755 });
}
const env = (o) => ({ PATH: `${join(root, "bin")}:/usr/bin:/bin`, HOME: join(root, "home"), AGENT_STACK_STATE: join(root, "state"), ...o });
const dry = (cli, wt, extra = [], o = {}) => {
  const r = spawnSync("python3", [tool, cli, "--role", "implementer", "--dry-run", ...extra], { cwd: wt, encoding: "utf8", env: env(o) });
  assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
};

test("grok: instructions beside the project's AGENTS.md, OpenRig's activity relay as hooks, no Claude settings, a fixed session to resume", () => {
  const { wt } = workspace("g1");
  const p = dry("grok", wt, [], { OPENRIG_SESSION_NAME: "impl-grok-1@demo", OPENRIG_ACTIVITY_RELAY: "/opt/relay.cjs" });
  assert.equal(p.seat, "impl-grok-1@demo"); assert.equal(p.model, "grok-4.7-build-fast");
  assert.deepEqual(p.argv.slice(0, 7), ["grok", "-m", "grok-4.7-build-fast", "--always-approve", "--trust", "--no-leader", "--no-alt-screen"]);
  assert.equal(p.argv[7], "-s"); assert.match(p.argv[8], /^[0-9a-f-]{36}$/);
  const rules = p.files[".grok/rules/openrig-seat.md"];
  assert.match(rules, /# You are an OpenRig seat/); assert.match(rules, /# Rig culture\s+# Culture\nClaim before you work\./); assert.match(rules, /# Your role\s+/);
  assert.equal(rules.includes(fs.readFileSync(join(repo, "rig/template/agents/implementer/guidance/role.md"), "utf8").trim()), true);
  assert.ok(!("AGENTS.md" in p.files), "the project's AGENTS.md is never written");
  const hooks = JSON.parse(p.files[".grok/hooks/openrig-activity.json"]).hooks;
  assert.deepEqual(Object.keys(hooks), ["SessionStart", "UserPromptSubmit", "PreToolUse", "Stop", "Notification"]);
  assert.equal(hooks.Stop[0].hooks[0].command, "node /opt/relay.cjs");
  for (const k of ["HOOKS", "MCPS", "SKILLS", "AGENTS", "RULES"]) assert.equal(p.env[`GROK_CLAUDE_${k}_ENABLED`], "false", k);
  assert.equal(p.env.GROK_DISABLE_AUTOUPDATER, "1");
  assert.deepEqual(p.exclude.sort(), [".grok/hooks/openrig-activity.json", ".grok/rules/openrig-seat.md"]);
  assert.equal(dry("grok", wt, ["--model", "grok-4.7"]).argv[2], "grok-4.7");
});

test("kimi: instructions in .kimi-code/AGENTS.md, the folder pre-trusted with kimi's own key, never-prompt, continue on restart", () => {
  const { wt } = workspace("k1");
  const p = dry("kimi", wt, [], { KIMI_CODE_HOME: join(root, "kimi-home") });
  assert.deepEqual(p.argv, ["kimi", "--auto", "-m", "kimi-code/k3-256k"]);
  assert.match(p.files[".kimi-code/AGENTS.md"], /# You are an OpenRig seat/);
  // kimi's encodeWorkDirKey(canonicalWorkspaceRoot(root)): wd_<slug of the last segment>_<sha256 of the path, 12 hex>
  const real = fs.realpathSync(wt), key = `wd_${basename(real).toLowerCase()}_${createHash("sha256").update(real).digest("hex").slice(0, 12)}`;
  const trust = join(root, "kimi-home", "workspace-trust", key);
  assert.ok(trust in p.files, Object.keys(p.files).join(", "));
  assert.equal(JSON.parse(p.files[trust]).root, real);
  assert.deepEqual(p.env, { KIMI_CODE_NO_AUTO_UPDATE: "1", KIMI_CLI_NO_AUTO_UPDATE: "1" });
});

test("refuses a [1m] model and an unknown role", () => {
  const { wt } = workspace("r1");
  const big = spawnSync("python3", [tool, "kimi", "--role", "reviewer", "--model", "kimi-k3[1m]", "--dry-run"], { cwd: wt, encoding: "utf8", env: env({}) });
  assert.equal(big.status, 2); assert.match(big.stderr, /1M-token window/);
  const role = spawnSync("python3", [tool, "grok", "--role", "astronaut", "--dry-run"], { cwd: wt, encoding: "utf8", env: env({}) });
  assert.equal(role.status, 2); assert.match(role.stderr, /no role guidance .*roles: .*implementer/);
});

test("a real start: files written and excluded from git, Ctrl+M from tmux reaches the CLI as Enter, busy/idle reach the activity ingest, and the next start resumes", async () => {
  const { wt } = workspace("run1");
  fakeCli(join(root, "bin"), "grok");
  const posts = [];
  const server = http.createServer((req, res) => {
    let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { posts.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(b) }); res.end("{}"); });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const out = join(root, "fake-out.json");
  try {
    const seatEnv = env({ FAKE_OUT: out, OPENRIG_URL: `http://127.0.0.1:${server.address().port}`, OPENRIG_SESSION_NAME: "impl-grok-1@demo",
      OPENRIG_ACTIVITY_HOOK_TOKEN: "tok", OPENRIG_NODE_ID: "n1", OPENRIG_RUNTIME: "terminal", AGENT_NATIVE_SEAT_IDLE_S: "0.3", TERM_PROGRAM: "tmux" });
    const child = spawn("python3", [tool, "grok", "--role", "implementer"], { cwd: wt, env: seatEnv });
    let stdout = ""; child.stdout.on("data", (d) => (stdout += d));
    await new Promise((r) => setTimeout(r, 700));
    child.stdin.write("fix the test\x1b[109;5u");   // what tmux sends for `send-keys C-m` with extended-keys on
    const code = await new Promise((r) => child.on("exit", r));
    assert.equal(code, 0);
    assert.equal(fs.readFileSync(out + ".stdin", "utf8"), "fix the test\r", "Ctrl+M became a plain Enter");
    const seen = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(seen.env.TERM_PROGRAM, "WezTerm"); assert.equal(seen.env.GROK_CLAUDE_HOOKS_ENABLED, "false");
    assert.match(stdout, /working[\s\S]*done/, "output passes through");
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(posts.map((p) => p.body.hookEvent), ["active", "Stop", "SessionEnd"]);
    for (const p of posts) {
      assert.equal(p.url, "/api/activity/hooks"); assert.equal(p.auth, "Bearer tok");
      assert.deepEqual([p.body.sessionName, p.body.runtime, p.body.nodeId], ["impl-grok-1@demo", "terminal", "n1"]);
    }
    assert.ok(fs.existsSync(join(wt, ".grok/rules/openrig-seat.md")) && fs.existsSync(join(wt, ".grok/hooks/openrig-activity.json")));
    assert.equal(fs.readFileSync(join(wt, "AGENTS.md"), "utf8"), "# The app's own agent notes\n", "the project's file is untouched");
    assert.match(fs.readFileSync(join(wt, ".git/info/exclude"), "utf8"), /^\.grok\/$/m);
    assert.equal(spawnSync("git", ["status", "--porcelain"], { cwd: wt, encoding: "utf8" }).stdout.includes(".grok"), false);
    // the restart resumes the session it fixed
    const first = seen.argv[seen.argv.indexOf("-s") + 1];
    const again = dry("grok", wt, [], { OPENRIG_SESSION_NAME: "impl-grok-1@demo" });
    assert.deepEqual(again.argv.slice(-2), ["-r", first]);
    assert.equal(dry("grok", wt, ["--fresh"], { OPENRIG_SESSION_NAME: "impl-grok-1@demo" }).argv.at(-2), "-s");
  } finally { server.close(); }
});

test("outside a seat it reports nothing, and a kimi restart continues its session", async () => {
  const { wt } = workspace("run2");
  fakeCli(join(root, "bin"), "kimi");
  const out = join(root, "fake-kimi.json");
  const child = spawn("python3", [tool, "kimi", "--role", "reviewer"], { cwd: wt, env: env({ FAKE_OUT: out, KIMI_CODE_HOME: join(root, "kh"), AGENT_NATIVE_SEAT_LOG: join(root, "kimi.log") }) });
  child.stdout.resume();
  await new Promise((r) => setTimeout(r, 500)); child.stdin.write("hi\r");
  assert.equal(await new Promise((r) => child.on("exit", r)), 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf8")).argv, ["--auto", "-m", "kimi-code/k3-256k"]);
  const log = fs.readFileSync(join(root, "kimi.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(log.every((l) => !("posted" in l)), "no OPENRIG_URL: no posts");
  assert.ok(fs.readdirSync(join(root, "kh", "workspace-trust")).length === 1, "trusted");
  assert.deepEqual(dry("kimi", wt, [], { KIMI_CODE_HOME: join(root, "kh") }).argv.at(-1), "-c");
});
