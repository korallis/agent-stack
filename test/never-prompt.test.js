// Never prompt: the Codex seat shim injects `-a never`, system/codex-never-prompt fixes an existing config in place,
// and bin/agent-never-prompt-check reports config, spec and live seats (against a fake HOME and process table).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "neverprompt-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const write = (p, text, mode) => { fs.mkdirSync(dirname(p), { recursive: true }); fs.writeFileSync(p, text, mode ? { mode } : undefined); };

// ---- seat shim ------------------------------------------------------------------------------------------
const home = join(root, "home"), argvLog = join(root, "codex-argv.json");
write(join(home, ".local/share/mise/installs/codex/latest/bin/codex"),
  `#!/usr/bin/env python3\nimport json, sys\njson.dump(sys.argv[1:], open(${JSON.stringify(argvLog)}, "w"))\n`, 0o755);
const shim = join(root, "seat-bin/codex");
write(shim, fs.readFileSync(join(repo, "system/seat-bin-codex"), "utf8"), 0o755);
write(join(root, "seat-bin/codex-models.json"), "{}"); // fresh catalog: no proxy fetch
function launch(...args) {
  // setsid: no controlling terminal, so the shim's foreground-group step can't touch the test runner's tty
  const r = spawnSync("setsid", ["-w", "python3", shim, ...args], { env: { PATH: process.env.PATH, HOME: home }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(fs.readFileSync(argvLog, "utf8"));
}
const approval = argv => argv.flatMap((a, i) => (a === "-a" ? [argv[i + 1]] : []));

test("shim: every seat launch gets -a never, ahead of the caller's own arguments", () => {
  const fresh = launch("-s", "danger-full-access", "-m", "gpt-6-sol");
  assert.deepEqual(approval(fresh), ["never"]);
  assert.ok(fresh.indexOf("-a") < fresh.indexOf("-s"));
  const resumed = launch("resume", "0199-abc", "-s", "danger-full-access");
  assert.deepEqual(approval(resumed), ["never"]);
  assert.ok(resumed.indexOf("-a") < resumed.indexOf("resume"), "a global option, before the subcommand");
  assert.equal(resumed[0], "--no-daemon");
});

test("shim: a caller's own approval choice is kept, never duplicated", () => {
  assert.deepEqual(approval(launch("-a", "on-request")), ["on-request"]);
  assert.ok(!launch("--ask-for-approval=untrusted").includes("never"));
  assert.ok(!launch("--ask-for-approval", "untrusted").includes("never"));
  assert.ok(!launch("-anever").includes("-a"));
  assert.ok(!launch("--dangerously-bypass-approvals-and-sandbox").includes("-a"));
});

test("shim: no -a next to a no-prompt mode Codex refuses to combine with it (--yolo, --approve-for-me)", () => {
  for (const mode of ["--yolo", "--approve-for-me", "--dangerously-bypass-approvals-and-sandbox"]) assert.ok(!launch(mode).includes("-a"), mode);
  assert.ok(!launch("-c", 'approval_policy="on-request"').includes("-a"), "a -c approval override is the caller's choice");
});

test("shim: prompt text and option values are never read as an approval choice", () => {
  assert.deepEqual(approval(launch("--", "-ask about this code")), ["never"]);
  assert.deepEqual(approval(launch("-m", "-a-model", "fix it")), ["never"]);
  assert.deepEqual(approval(launch("-c", "model=\"-a\"")), ["never"]);
});

test("shim: --no-daemon exactly once, whether or not OpenRig already passed it (Codex rejects a repeat)", () => {
  const count = argv => argv.filter(a => a === "--no-daemon").length;
  assert.equal(count(launch("-s", "danger-full-access")), 1);
  assert.equal(count(launch("--no-daemon", "-s", "danger-full-access")), 1);
  assert.equal(count(launch("resume", "0199-abc", "--no-daemon")), 1);
  assert.equal(count(launch("--", "--no-daemon")), 2, "a prompt word after -- is not the option; the shim still adds its own");
});

// ---- system/codex-never-prompt ------------------------------------------------------------------------
const fixer = join(repo, "system/codex-never-prompt");
const fix = (file, ...flags) => spawnSync("python3", [fixer, ...flags, file], { encoding: "utf8" });
const backups = file => fs.readdirSync(dirname(file)).filter(f => f.startsWith("config.toml.bak-"));
const CONFIG = `# user comment
model = "gpt-6-astra"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[profiles.careful]
approval_policy = "on-request"

[projects."/home/u/p"]
trust_level = "trusted"
`;

test("fixer: sets only the two top-level keys, keeps every other byte, backs up once, is idempotent", () => {
  const file = join(root, "c1/config.toml"); write(file, CONFIG, 0o600);
  const check = fix(file, "--check");
  assert.equal(check.status, 1);
  assert.equal(fs.readFileSync(file, "utf8"), CONFIG, "--check never writes");
  const r = fix(file);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(fs.readFileSync(file, "utf8"), CONFIG.replace('approval_policy = "on-request"\nsandbox_mode = "workspace-write"', 'approval_policy = "never"\nsandbox_mode = "danger-full-access"'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(backups(file).length, 1);
  assert.equal(fs.readFileSync(join(dirname(file), backups(file)[0]), "utf8"), CONFIG);
  assert.equal(fix(file).status, 0);
  assert.equal(backups(file).length, 1, "nothing to change → no new backup");
});

test("fixer: missing keys are added before the first table; unreadable TOML is left alone", () => {
  const file = join(root, "c2/config.toml"); write(file, 'model = "m"\n\n[tui]\nx = 1\n');
  assert.equal(fix(file).status, 0);
  assert.equal(fs.readFileSync(file, "utf8"), 'model = "m"\n\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n[tui]\nx = 1\n');
  const bad = join(root, "c3/config.toml"); write(bad, "model = \n");
  assert.equal(fix(bad).status, 1);
  assert.equal(fs.readFileSync(bad, "utf8"), "model = \n");
});

test("fixer: a valid config without a final newline gets the keys on their own lines", () => {
  const file = join(root, "c4/config.toml"); write(file, 'model = "m"');
  const r = fix(file);
  assert.equal(r.status, 0, r.stdout);
  assert.equal(fs.readFileSync(file, "utf8"), 'model = "m"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n');
});

// ---- bin/agent-never-prompt-check -----------------------------------------------------------------------
const chk = join(repo, "bin/agent-never-prompt-check");
function machine({ approval = "never", sandbox = "danger-full-access", claude = "bypassPermissions", shimText = '["-a", "never"]' } = {}) {
  const h = fs.mkdtempSync(join(root, "m-"));
  write(join(h, ".codex/config.toml"), `approval_policy = "${approval}"\nsandbox_mode = "${sandbox}"\n`);
  write(join(h, ".codex/pool-x.config.toml"), 'approval_policy = "never"\n');
  write(join(h, ".claude/settings.json"), JSON.stringify({ skipDangerousModePermissionPrompt: true, permissions: { defaultMode: claude } }));
  write(join(h, ".local/share/agent-stack/seat-bin/codex"), `extra += ${shimText}\n`);
  fs.mkdirSync(join(h, "proc"));
  return h;
}
function proc(h, pid, args, session, { cwd, env = {} } = {}) {
  write(join(h, "proc", String(pid), "cmdline"), args.join("\0") + "\0");
  const vars = { PATH: "/bin", OPENRIG_SESSION_NAME: session, ...env };
  write(join(h, "proc", String(pid), "environ"), Object.entries(vars).map(([k, v]) => `${k}=${v}\0`).join(""));
  if (cwd) fs.symlinkSync(cwd, join(h, "proc", String(pid), "cwd"));
}
function runCheck(h, ...args) {
  const r = spawnSync("python3", [chk, "--json", ...args], { env: { PATH: process.env.PATH, HOME: h, AGENT_STACK_PROC: join(h, "proc") }, encoding: "utf8" });
  return { status: r.status, rows: JSON.parse(r.stdout) };
}
const failed = rows => rows.filter(r => r.level === "FAIL").map(r => r.check);
const CODEX = "/x/codex";

test("check: a correctly set machine and rig pass; each missing piece FAILs on its own line", () => {
  const good = machine();
  proc(good, 10, [CODEX, "--no-daemon", "-a", "never", "-s", "danger-full-access"], "impl-a@r");
  write(join(good, "rig.yaml"), "name: r\npermission_policy: builtin:yolo\npods: []\n");
  const ok = runCheck(good, "--rig", "r", "--spec", join(good, "rig.yaml"));
  assert.equal(ok.status, 0, JSON.stringify(ok.rows));
  const bad = machine({ approval: "on-request", sandbox: "workspace-write", claude: "default", shimText: "[]" });
  write(join(bad, "rig.yaml"), "name: r\npods: []\n");
  const r = runCheck(bad, "--spec", join(bad, "rig.yaml"));
  assert.equal(r.status, 1);
  assert.equal(failed(r.rows).length, 4);
  assert.match(failed(r.rows).join("|"), /Codex config.*\|Claude.*\|seat shim.*\|RigSpec rig.yaml/);
});

test("check: live Codex seats of the rig must run with approval never (flag, profile or config)", () => {
  const h = machine({ approval: "on-request" });
  proc(h, 20, [CODEX, "--no-daemon", "-a", "never"], "impl-a@r");                // flag
  proc(h, 21, [CODEX, "--no-daemon", "-p", "pool-x"], "impl-b@r");               // profile says never
  proc(h, 22, [CODEX, "--no-daemon", "resume", "0199"], "qa-codex-3@r");         // falls back to on-request config
  proc(h, 23, [CODEX, "--no-daemon"], "impl-z@other");                            // another rig: ignored
  proc(h, 24, [CODEX, "app-server", "daemon"], "impl-y@r");                       // helper process: ignored
  proc(h, 25, ["/usr/bin/node", "x.js"], "impl-w@r");                             // not codex
  const r = runCheck(h, "--rig", "r");
  const live = r.rows.find(x => x.check.startsWith("live Codex seats of r"));
  assert.equal(live.level, "FAIL");
  assert.match(live.check, /\(3 running\)/);
  assert.match(live.detail, /^qa-codex-3@r: relaunch/);
});

test("check: explicit settings on the command line decide, in every spelling Codex accepts", () => {
  const h = machine(); // global config says never
  proc(h, 30, [CODEX, "--no-daemon", "-aon-request"], "a@r");
  proc(h, 31, [CODEX, "--no-daemon", "-c", 'approval_policy="on-request"'], "b@r");
  proc(h, 32, [CODEX, "--no-daemon", "--config=approval_policy='untrusted'"], "c@r");
  proc(h, 33, [CODEX, "--no-daemon", "--yolo"], "d@r");
  proc(h, 34, [CODEX, "--no-daemon", "--approve-for-me"], "e@r");
  proc(h, 35, [CODEX, "--no-daemon", "--", "-aon-request is just prompt text"], "f@r");
  proc(h, 36, [CODEX, "--no-daemon", "-a", "never", "-c", 'approval_policy="on-request"'], "g@r");
  const live = runCheck(h, "--rig", "r").rows.find(x => x.check.startsWith("live Codex seats of r"));
  assert.equal(live.detail, "a@r, b@r, c@r, g@r: relaunch them once the shim and config are installed");
});

test("check: profile (-p or -c profile=), project config, CODEX_HOME and --ignore-user-config are resolved", () => {
  const h = machine(); // global config says never
  write(join(h, ".codex/pool-ask.config.toml"), 'approval_policy = "on-request"\n');
  const project = join(h, "work/p"); write(join(h, "work/.codex/config.toml"), 'approval_policy = "on-request"\n'); fs.mkdirSync(project, { recursive: true });
  const other = join(h, "other-codex-home"); write(join(other, "config.toml"), 'approval_policy = "on-request"\n');
  proc(h, 40, [CODEX, "--no-daemon", "-p", "pool-ask"], "a@r");
  proc(h, 41, [CODEX, "--no-daemon", "-c", "profile=pool-ask"], "b@r");
  proc(h, 42, [CODEX, "--no-daemon"], "c@r", { cwd: project });
  proc(h, 43, [CODEX, "--no-daemon"], "d@r", { env: { CODEX_HOME: other } });
  proc(h, 44, [CODEX, "--no-daemon", "--ignore-user-config"], "e@r");
  proc(h, 45, [CODEX, "--no-daemon", "-p", "pool-x"], "f@r"); // profile says never
  proc(h, 46, [CODEX, "--no-daemon", "-a", "never"], "g@r", { cwd: project }); // flag outranks the project file
  const live = runCheck(h, "--rig", "r").rows.find(x => x.check.startsWith("live Codex seats of r"));
  assert.equal(live.detail, "a@r, b@r, c@r, d@r, e@r: relaunch them once the shim and config are installed");
});

test("check: every Codex process of a seat must be never; helpers are recognised by their real subcommand", () => {
  const h = machine({ approval: "on-request" });
  proc(h, 50, [CODEX, "--no-daemon", "-a", "never"], "a@r");
  proc(h, 51, [CODEX, "--no-daemon", "-a", "on-request"], "a@r");              // same seat, second process prompts
  proc(h, 52, [CODEX, "--no-daemon", "-a", "on-request", "--", "app-server"], "b@r"); // prompt text, not a subcommand
  proc(h, 53, [CODEX, "app-server", "daemon"], "c@r");                         // real helper: skipped
  proc(h, 54, [CODEX, "-c", "x=1", "mcp-server"], "c@r");                       // real helper after an option value
  proc(h, 55, [CODEX, "--no-daemon", "-a", "never"], "c@r");
  const live = runCheck(h, "--rig", "r").rows.find(x => x.check.startsWith("live Codex seats of r"));
  assert.match(live.check, /\(3 running\)/);
  assert.equal(live.detail, "a@r, b@r: relaunch them once the shim and config are installed");
});
