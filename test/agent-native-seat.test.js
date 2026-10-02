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
if os.environ.get("FAKE_MODE") == "burst":   # busy and done in one write, quiet past the debounce, then plain output
    sys.stdout.write("\\x1b]9;4;3\\x07\\x1b]9;4;0\\x07"); sys.stdout.flush(); time.sleep(0.8)
    sys.stdout.write("."); sys.stdout.flush(); time.sleep(0.2); sys.exit(0)
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
  // a busy native CLI replays queued messages later: stale row notices are checked and skipped, not re-reported
  assert.match(rules, /Before acting on any queued notice about a row, run `rig queue show <id> --full --json`; if the row is already done or handed off, skip it without re-reporting it\./);
  assert.equal(rules.includes(fs.readFileSync(join(repo, "rig/template/agents/implementer/guidance/role.md"), "utf8").trim()), true);
  assert.ok(!("AGENTS.md" in p.files), "the project's AGENTS.md is never written");
  const hooks = JSON.parse(p.files[".grok/hooks/openrig-activity.json"]).hooks;
  assert.deepEqual(Object.keys(hooks), ["SessionStart", "UserPromptSubmit", "PreToolUse", "Stop", "Notification"]);
  const cmd = hooks.Stop[0].hooks[0].command;
  assert.match(cmd, /^\S*python3\S* \S+\/bin\/agent-native-seat hook --state \S+\/native-seats\/impl-grok-1@demo\/last-hook\.json -- node \/opt\/relay\.cjs$/,
    "through the launcher's hook mode (the idle keepalive), then OpenRig's relay");
  for (const k of ["HOOKS", "MCPS", "SKILLS", "AGENTS", "RULES"]) assert.equal(p.env[`GROK_CLAUDE_${k}_ENABLED`], "false", k);
  assert.equal(p.env.GROK_DISABLE_AUTOUPDATER, "1");
  assert.deepEqual(p.ignore, [".grok/.gitignore"], "one ignore file, in the directory the launcher creates");
  assert.match(p.files[".grok/.gitignore"], /^# agent-native-seat[^\n]*\n\*\n$/);
  assert.equal(dry("grok", wt, ["--model", "grok-4.7"]).argv[2], "grok-4.7");
});

test("kimi: instructions in .kimi-code/AGENTS.md, the folder pre-trusted with kimi's own key, never-prompt, continue on restart", () => {
  const { wt } = workspace("k1");
  const p = dry("kimi", wt, [], { KIMI_CODE_HOME: join(root, "kimi-home") });
  assert.deepEqual(p.argv, ["kimi", "--auto", "-m", "kimi-code/k3-256k"]);
  assert.match(p.files[".kimi-code/AGENTS.md"], /# You are an OpenRig seat/);
  assert.match(p.files[".kimi-code/AGENTS.md"], /Before acting on any queued notice about a row, run `rig queue show <id> --full --json`/);
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

// QA PR116 (P1): seats' worktrees usually sit beside the workspace (<app>.worktrees/<seat>, <app>-work/rig/CULTURE.md)
test("the culture comes from --culture, else $OPENRIG_WORK_ROOT, else the workspace beside the worktrees, else above the seat; none, or a missing --culture, is an error", () => {
  const ws = join(root, "app-work"), wt = join(root, "app.worktrees", "impl-grok-1");
  fs.mkdirSync(join(ws, "rig"), { recursive: true }); fs.writeFileSync(join(ws, "rig/CULTURE.md"), "# Work-root culture\n");
  fs.mkdirSync(wt, { recursive: true }); spawnSync("git", ["init", "-q", wt]);
  const p = dry("grok", wt, [], { OPENRIG_WORK_ROOT: ws });
  assert.equal(p.culture, join(ws, "rig/CULTURE.md")); assert.match(p.files[".grok/rules/openrig-seat.md"], /# Work-root culture/);
  // OpenRig gives a seat no work root (WO96): agent-project-new's layout, <P>.worktrees/<seat> beside <P>-work, is enough
  assert.equal(dry("grok", wt, []).culture, join(ws, "rig/CULTURE.md"));
  const lone = join(root, "lone.worktrees", "impl-grok-1"); fs.mkdirSync(lone, { recursive: true }); spawnSync("git", ["init", "-q", lone]);
  const none = spawnSync("python3", [tool, "grok", "--role", "implementer", "--dry-run"], { cwd: lone, encoding: "utf8", env: env({}) });
  assert.equal(none.status, 2); assert.match(none.stderr, /no rig CULTURE\.md: pass --culture/);
  const missing = spawnSync("python3", [tool, "grok", "--role", "implementer", "--culture", join(root, "nope.md"), "--dry-run"], { cwd: wt, encoding: "utf8", env: env({ OPENRIG_WORK_ROOT: ws }) });
  assert.equal(missing.status, 2); assert.match(missing.stderr, /--culture .*nope\.md: no such file/);
  assert.equal(dry("grok", wt, ["--no-culture"]).culture, null, "an explicit opt-out");
});

// QA PR116 (P2): a linked worktree (git worktree add) — its own git dir's info/exclude is not read by git
test("a linked worktree: the seat's files stay out of git status there, without hiding anything in the main worktree", async () => {
  const main = join(root, "repo-main"); fs.mkdirSync(main, { recursive: true });
  spawnSync("git", ["init", "-q", main]); fs.writeFileSync(join(main, "a.txt"), "a");
  spawnSync("git", ["-C", main, "-c", "user.email=t@example.invalid", "-c", "user.name=t", "add", "-A"]);
  spawnSync("git", ["-C", main, "-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-qm", "init"]);
  const wt = join(root, "repo.worktrees", "impl-kimi-1");
  assert.equal(spawnSync("git", ["-C", main, "worktree", "add", "-q", wt]).status, 0);
  fakeCli(join(root, "bin"), "kimi");
  const child = spawn("python3", [tool, "kimi", "--role", "reviewer", "--culture", join(root, "g1/rig/CULTURE.md")], { cwd: wt, env: env({ FAKE_OUT: join(root, "lw.json"), KIMI_CODE_HOME: join(root, "kh2") }) });
  child.stdout.resume(); await new Promise((r) => setTimeout(r, 400)); child.stdin.write("go\r");
  assert.equal(await new Promise((r) => child.on("exit", r)), 0);
  assert.ok(fs.existsSync(join(wt, ".kimi-code/AGENTS.md")));
  assert.equal(spawnSync("git", ["status", "--porcelain"], { cwd: wt, encoding: "utf8" }).stdout, "", "nothing new shows in the linked worktree");
  fs.mkdirSync(join(main, ".kimi-code"), { recursive: true }); fs.writeFileSync(join(main, ".kimi-code/notes.md"), "mine");
  assert.match(spawnSync("git", ["status", "--porcelain"], { cwd: main, encoding: "utf8" }).stdout, /\?\? \.kimi-code\//, "the main worktree's own .kimi-code is not hidden");
  // a directory the project already owns gets no ignore file: the launcher reports the file as visible instead
  const owned = join(root, "owned"); fs.mkdirSync(join(owned, ".grok/rules"), { recursive: true }); spawnSync("git", ["init", "-q", owned]);
  const p = dry("grok", owned, ["--culture", join(root, "g1/rig/CULTURE.md")]);
  assert.deepEqual([p.ignore, p.visible_to_git], [[".grok/hooks/.gitignore"], [".grok/rules/openrig-seat.md"]]);
});

// QA PR116 (P2): tmux may write a Ctrl+M sequence in more than one chunk
test("Ctrl+M split across writes still arrives as Enter; a lone Esc and other keys pass through unchanged", async () => {
  const { wt } = workspace("split");
  fakeCli(join(root, "bin"), "grok");
  for (const [label, parts, want] of [["CSI u", ["x\x1b[109;", "5u"], "x\r"], ["modifyOtherKeys", ["y\x1b[27;5;", "13~"], "y\r"],
      ["byte by byte", [..."z\x1b[109;5u"], "z\r"], ["lone Esc then Enter", ["\x1b", "\x1b[A", "\r"], "\x1b\x1b[A\r"]]) {
    const out = join(root, `split-${label.replace(/\W+/g, "-")}.json`);
    const child = spawn("python3", [tool, "grok", "--role", "implementer"], { cwd: wt, env: env({ FAKE_OUT: out, AGENT_STACK_STATE: join(root, `st-${label.length}`) }) });
    child.stdout.resume(); await new Promise((r) => setTimeout(r, 400));
    for (const part of parts) { child.stdin.write(part); await new Promise((r) => setTimeout(r, 120)); }
    assert.equal(await new Promise((r) => child.on("exit", r)), 0, label);
    assert.equal(fs.readFileSync(out + ".stdin", "latin1"), want, label);
  }
});

// QA PR116 (P2): a progress sequence already acted on is never counted again when ordinary output follows
test("progress: each sequence counts once; plain output after a finished turn is not a new turn", async () => {
  const { wt } = workspace("burst");
  fakeCli(join(root, "bin"), "grok");
  const posts = [];
  const server = http.createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { posts.push(JSON.parse(b).hookEvent); res.end("{}"); }); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const child = spawn("python3", [tool, "grok", "--role", "implementer"], { cwd: wt, env: env({ FAKE_OUT: join(root, "burst.json"), FAKE_MODE: "burst",
      OPENRIG_URL: `http://127.0.0.1:${server.address().port}`, OPENRIG_SESSION_NAME: "impl-grok-1@demo", OPENRIG_ACTIVITY_HOOK_TOKEN: "tok", AGENT_NATIVE_SEAT_IDLE_S: "0.3" }) });
    child.stdout.resume();
    assert.equal(await new Promise((r) => child.on("exit", r)), 0);
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(posts, ["active", "Stop", "SessionEnd"]);
  } finally { server.close(); }
});


// WO96: OpenRig trusts a hook report for 5 minutes and has no screen reader for terminal seats, so an idle native seat
// read "unknown" and dropped out of dispatch (pick-seat lists observed-idle seats only).
test("hook mode: notes only the event's name, then hands the payload unchanged to the relay, with its exit code", () => {
  const state = join(root, "hk", "last-hook.json"), got = join(root, "hk-relay.bin");
  fs.mkdirSync(join(root, "hk"), { recursive: true });
  const relay = join(root, "hk-relay.sh"); fs.writeFileSync(relay, `#!/bin/sh\ncat > ${got}\nexit 3\n`, { mode: 0o755 });
  const payload = JSON.stringify({ hook_event_name: "Stop", prompt: "private text", session_id: "s1" });
  const r = spawnSync("python3", [tool, "hook", "--state", state, "--", relay], { input: payload, encoding: "utf8" });
  assert.equal(r.status, 3);
  assert.equal(fs.readFileSync(got, "utf8"), payload);
  const noted = JSON.parse(fs.readFileSync(state, "utf8"));
  assert.deepEqual(Object.keys(noted).sort(), ["event", "t"]); assert.equal(noted.event, "Stop");
  assert.equal(spawnSync("python3", [tool, "hook", "--state", state, "--", relay], { input: "not json", encoding: "utf8" }).status, 3, "a bad payload still reaches the relay");
  assert.equal(JSON.parse(fs.readFileSync(state, "utf8")).event, "Stop", "a payload without a turn event leaves the record");
  // grok sends a notification after every Stop (seen live, WO96): relayed unchanged, but the Stop stays the last turn event
  const note = JSON.stringify({ hook_event_name: "notification", session_id: "s1", message: "private text" });
  assert.equal(spawnSync("python3", [tool, "hook", "--state", state, "--", relay], { input: note, encoding: "utf8" }).status, 3);
  assert.equal(fs.readFileSync(got, "utf8"), note, "relayed byte for byte");
  assert.equal(JSON.parse(fs.readFileSync(state, "utf8")).event, "Stop");
  spawnSync("python3", [tool, "hook", "--state", state, "--", relay], { input: JSON.stringify({ hook_event_name: "pre_tool_use" }), encoding: "utf8" });
  assert.equal(JSON.parse(fs.readFileSync(state, "utf8")).event, "pre_tool_use", "a turn event still moves it");
});

test("idle keepalive: an idle seat re-reports idle (first soon after start, then on an interval); a busy grok, by its last hook, does not", async () => {
  const { wt } = workspace("keep");
  fs.mkdirSync(join(root, "kbin"), { recursive: true });
  // the CLI stays up until the test has seen enough (no fixed lifetime: a loaded CI runner starts Python slowly)
  fs.writeFileSync(join(root, "kbin", "grok"), "#!/bin/sh\nexec sleep 60\n", { mode: 0o755 });
  fs.writeFileSync(join(root, "kbin", "kimi"), "#!/bin/sh\nexec sleep 60\n", { mode: 0o755 });
  // want: resolve once that many idle reports arrived (20 s deadline); null: watch a window that is eight keepalive
  // intervals long, in which an idle seat would have reported several times, and count
  const run = async (cli, lastHook, want = null) => {
    const posts = [], st = join(root, `kst-${cli}-${lastHook}`);
    const seatDir = join(st, "native-seats", `impl-${cli}-1@demo`);
    if (lastHook) { fs.mkdirSync(seatDir, { recursive: true }); fs.writeFileSync(join(seatDir, "last-hook.json"), JSON.stringify({ event: lastHook, t: 0 })); }
    let enough; const reached = new Promise((r) => (enough = r));
    const server = http.createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
      posts.push(JSON.parse(b).hookEvent); res.end("{}");
      if (want && posts.filter((p) => p === "idle").length >= want) enough();
    }); });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const child = spawn("python3", [tool, cli, "--role", "implementer", "--culture", join(root, "keep/rig/CULTURE.md")], { cwd: wt, detached: true,
      env: { ...env({ AGENT_STACK_STATE: st, KIMI_CODE_HOME: join(root, "kkh") }), PATH: `${join(root, "kbin")}:/usr/bin:/bin`, OPENRIG_URL: `http://127.0.0.1:${server.address().port}`,
        OPENRIG_SESSION_NAME: `impl-${cli}-1@demo`, OPENRIG_ACTIVITY_HOOK_TOKEN: "tok", AGENT_NATIVE_SEAT_FIRST_IDLE_S: "0.3", AGENT_NATIVE_SEAT_KEEPALIVE_S: "0.3" } });
    child.stdout.resume(); child.stderr.resume();
    const exited = new Promise((r) => child.on("exit", r));
    try {
      let timer;
      await Promise.race([want ? reached : new Promise((r) => setTimeout(r, 2500)), new Promise((r) => (timer = setTimeout(r, 20000))), exited]);
      clearTimeout(timer);
      return posts.filter((p) => p === "idle").length;
    } finally {
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
      server.close();
    }
  };
  assert.ok(await run("grok", "Stop", 3) >= 3, "grok idle after a turn: idle soon after start, then on every interval");
  assert.ok(await run("grok", "SessionStart", 3) >= 3, "a fresh grok session is idle at its prompt");
  assert.equal(await run("grok", "UserPromptSubmit"), 0, "grok mid-turn: no idle");
  assert.equal(await run("grok", null), 0, "grok before any hook: not known, nothing said");
  assert.ok(await run("kimi", null, 3) >= 3, "kimi: idle while no progress sequence runs");
  // grok's own spellings (seen live, WO96): snake_case as well as PascalCase
  assert.ok(await run("grok", "session_start", 3) >= 3, "grok's session_start");
  assert.ok(await run("grok", "stop", 3) >= 3, "grok's stop");
  assert.equal(await run("grok", "pre_tool_use"), 0, "grok's pre_tool_use is a turn");
});
