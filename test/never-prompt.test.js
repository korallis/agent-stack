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
function proc(h, pid, args, session) {
  write(join(h, "proc", String(pid), "cmdline"), args.join("\0") + "\0");
  write(join(h, "proc", String(pid), "environ"), `PATH=/bin\0OPENRIG_SESSION_NAME=${session}\0`);
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
