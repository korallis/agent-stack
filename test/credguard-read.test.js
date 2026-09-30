// The credential read guard (system/credguard-read-hook) and its installer (system/credguard-read-install). Fake
// paths and a throwaway HOME only: no real credential file is read, and the live settings are never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const hookFile = join(repo, "system/credguard-read-hook"), installFile = join(repo, "system/credguard-read-install");
const g = require(hookFile), inst = require(installFile);
const root = fs.mkdtempSync("/tmp/claude-1000/credread-");
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const home = "/home/seat", cwd = "/work/app";
const decide = (tool_name, tool_input, pats = g.DEFAULT_PATTERNS) => g.decide({ tool_name, tool_input, cwd }, { home, pats });
const bash = (command, pats) => decide("Bash", { command }, pats).deny;

test("Bash: commands that would print a credential file are denied", () => {
  for (const c of [
    "cat /work/app/.preview-db-runtime-url",                       // incident shape 1: a runtime-url file
    "cat ~/.config/agent-stack/secrets/preview/db-runtime-url",    // incident shape 2: the secrets directory
    "cat .env", "cat ./.env.local", "head -3 .env.production", "tail -n 5 ../api/.env", "less .env", "bat .env",
    "jq . certs/server.pem", "grep DATABASE_URL .env", "rg TOKEN .env.local", "awk -F= '{print $2}' .env",
    "sed -n 1,5p .env", "sed 's/x/y/' .env", "xxd .env", "od -c .env", "strings key.pem", "base64 .env",
    "cut -d= -f2 .env", "sort .env", "diff .env .env.local", "cat $HOME/.config/agent-stack/secrets/x.env",
    "cat ${HOME}/.config/agent-stack/secrets/x.env", "cat prod.env", "cat .env*", "cat config/*.pem",
    'echo "$(cat .env)"', "echo $(< .env)", "echo `cat .env`", "cat < .env", "tee < .env",
    "cp .env /dev/stdout", "cp .env /dev/tty", "dd if=.env", "git show HEAD:.env", "git diff .env", "git log -p -- .env",
    'bash -c "cat .env"', "sh -c 'head .env'", "eval cat .env", "sudo cat /etc/app/.env", "FOO=1 cat .env", "timeout 5 cat .env",
    "source .env && echo $DATABASE_URL", ". ./.env; printenv", "set -a; . .env; set +a; env", "source .env; export -p",
    "source .env && printf '%s' \"$TOKEN\"", "cd /tmp && cat .env | grep URL", "export $(grep -v '^#' .env | xargs)",
    "grep -e URL .env", "grep -A 2 URL .env", "rg --regexp TOKEN -- .env", "awk -F= '{print $2}' .env", "jq -r .key key.pem",
  ]) assert.equal(bash(c), true, c);
});

test("Bash: using credentials without printing them, and ordinary commands, are allowed", () => {
  for (const c of [
    "grep -r TODO .", "cat README.md", "ls .env*", "ls -la", "cat .env.example", "cat .env.sample", "head .env.template",
    "set -a; . .env; set +a; npm run migrate", "source .env && npm test", "source .env && echo done", "npm run dev -- --env-file .env",
    "docker run --env-file .env img", "grep -q '^DATABASE_URL=' .env && echo present", "grep -c KEY .env", "grep -l KEY -r .",
    "rg -l TOKEN", "cut -d= -f1 .env", "cut -d '=' -f 1 .env", "wc -l .env", "sha256sum .env", "test -f .env && echo yes", "stat .env",
    "cp .env .env.bak", "mv .env.local .env", "sed -i 's/old/new/' .env", "echo 'X=1' >> .env", "printf 'K=v\\n' > .env.local",
    "tail -f log.txt 2>&1 | grep err", "env | grep PATH", "git add .env.example", "git status", "chmod 600 .env",
    "cat <<'EOF' > notes.md\nNever run: cat .env\nEOF", "echo 'do not cat .env'", "grep -rn 'runtime-url' docs/",
    "node scripts/migrate.js", "cat src/app.ts", "cat package.json | jq .scripts", "rg -n 'prod.env' src/",
    "grep -A 3 '.env' README.md", "awk '/runtime-url/ {print}' notes.txt", "sed -n '/.env/p' docs/setup.md",
  ]) assert.equal(bash(c), false, c);
});

test("Read and Grep tools: credential files are denied; templates and names-only searches are not", () => {
  assert.equal(decide("Read", { file_path: "/work/app/.env" }).deny, true);
  assert.equal(decide("Read", { file_path: "/work/app/.env.local" }).deny, true);
  assert.equal(decide("Read", { file_path: "/home/seat/.config/agent-stack/secrets/cliproxy.env" }).deny, true);
  assert.equal(decide("Read", { file_path: "/work/app/deploy/tls.pem" }).deny, true);
  assert.equal(decide("Read", { file_path: "/work/app/.env.example" }).deny, false);
  assert.equal(decide("Read", { file_path: "/work/app/README.md" }).deny, false);
  assert.equal(decide("Grep", { pattern: "URL", path: "/work/app/.env", output_mode: "content" }).deny, true);
  assert.equal(decide("Grep", { pattern: "URL", path: ".", glob: ".env*", output_mode: "content" }).deny, true);
  assert.equal(decide("Grep", { pattern: "URL", path: "/work/app/.env" }).deny, false, "files_with_matches (the default) prints names only");
  assert.equal(decide("Grep", { pattern: "TODO", path: ".", output_mode: "content" }).deny, false);
  assert.equal(decide("Write", { file_path: "/work/app/.env", content: "X=1" }).deny, false, "writing is not printing");
});

test("the deny reason names the file and how to use it by name", () => {
  const d = decide("Bash", { command: "cat /home/seat/app/.env" });
  assert.match(d.reason, /credential guard: blocked, because this would print ~\/app\/\.env \(a credential file, pattern \*\*\/\.env\)/);
  assert.match(d.reason, /set -a; \. ~\/app\/\.env; set \+a; <the command that needs them>/);
  assert.match(d.reason, /cut -d= -f1/);
});

test("local extra patterns come from a file outside the repo", () => {
  const f = join(root, "paths"); fs.writeFileSync(f, "# local\n~/.config/project-x/**\n**/*.kubeconfig\n");
  const pats = g.patterns({ AGENT_CREDGUARD_READ_PATHS: f }, home);
  assert.deepEqual(pats.slice(-2), ["~/.config/project-x/**", "**/*.kubeconfig"]);
  assert.equal(bash("cat ~/.config/project-x/db.url", pats), true);
  assert.equal(bash("cat cluster.kubeconfig", pats), true);
  assert.equal(bash("cat ~/.config/project-x/db.url"), false, "not protected without the local file");
  assert.deepEqual(g.patterns({ AGENT_CREDGUARD_READ_PATHS: join(root, "absent") }, home), g.DEFAULT_PATTERNS);
});

test("the hook's output contract: Claude JSON deny, Codex exit 2 + stderr, allow = silence, bad input never blocks", () => {
  const run = (input, runtime) => spawnSync(process.execPath, [hookFile, ...(runtime ? ["--runtime", runtime] : [])],
    { input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8", env: { PATH: process.env.PATH, HOME: home, AGENT_CREDGUARD_READ_PATHS: join(root, "none") } });
  const deny = { tool_name: "Bash", tool_input: { command: "cat .env" }, cwd };
  let r = run(deny);
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout).hookSpecificOutput;
  assert.deepEqual([out.hookEventName, out.permissionDecision], ["PreToolUse", "deny"]); assert.match(out.permissionDecisionReason, /credential guard/);
  r = run(deny, "codex");
  assert.equal(r.status, 2); assert.equal(r.stdout, ""); assert.match(r.stderr, /credential guard: blocked/);
  for (const rt of [undefined, "codex"]) {
    r = run({ tool_name: "Bash", tool_input: { command: "npm test" }, cwd }, rt);
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""]);
    r = run("not json", rt); assert.equal(r.status, 0, "a broken input must not block every tool call");
  }
});

// ---- installer --------------------------------------------------------------------------------------------------
const install = (h, ...flags) => spawnSync(process.execPath, [installFile, ...flags, "--hook", join(h, "hook"),
  "--claude-settings", join(h, "settings.json"), "--codex-config", join(h, "config.toml")], { encoding: "utf8" });
const tomlJson = (f) => JSON.parse(spawnSync("python3", ["-c", "import tomllib,json,sys;print(json.dumps(tomllib.load(open(sys.argv[1],'rb'))))", f], { encoding: "utf8" }).stdout);

test("installer: merges into both configs, keeps every other hook, is idempotent, and --check changes nothing", () => {
  const h = fs.mkdtempSync(join(root, "i-")); fs.writeFileSync(join(h, "hook"), "");
  const settings = { permissions: { defaultMode: "bypassPermissions" }, hooks: { PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "fmt" }] }], Stop: [{ hooks: [{ type: "command", command: "relay" }] }] } };
  fs.writeFileSync(join(h, "settings.json"), JSON.stringify(settings));
  const cfg = '[features]\nhooks = true\n\n[[hooks.PreToolUse]]\nmatcher = "Bash"\n\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "audit"\n\n[projects."/x"]\ntrust_level = "trusted"\n';
  fs.writeFileSync(join(h, "config.toml"), cfg);
  let r = install(h, "--check");
  assert.equal(r.status, 1); assert.match(r.stdout, /-- Claude: credential read guard missing/); assert.match(r.stdout, /-- Codex: credential read guard missing/);
  assert.equal(fs.readFileSync(join(h, "config.toml"), "utf8"), cfg, "--check writes nothing");
  r = install(h); assert.equal(r.status, 0, r.stdout);
  const s = JSON.parse(fs.readFileSync(join(h, "settings.json"), "utf8"));
  assert.deepEqual(s.permissions, settings.permissions); assert.deepEqual(s.hooks.Stop, settings.hooks.Stop);
  assert.deepEqual(s.hooks.PreToolUse.map((x) => x.matcher), ["Edit", "Bash|Read|Grep"]);
  assert.equal(s.hooks.PreToolUse[1].hooks[0].command, `"${join(h, "hook")}" --runtime claude`);
  const t = tomlJson(join(h, "config.toml"));
  assert.deepEqual(t.hooks.PreToolUse.map((x) => x.hooks[0].command), ["audit", `"${join(h, "hook")}" --runtime codex`]);
  assert.equal(t.projects["/x"].trust_level, "trusted");
  const key = `${fs.realpathSync(join(h, "config.toml"))}:pre_tool_use:1:0`;   // positional: after the existing group
  assert.deepEqual(Object.keys(t.hooks.state), [key]);
  assert.equal(t.hooks.state[key].trusted_hash, inst.codexHookHash({ event: "pre_tool_use", matcher: "Bash", command: `"${join(h, "hook")}" --runtime codex`, timeout: 10 }));
  const after = [fs.readFileSync(join(h, "settings.json"), "utf8"), fs.readFileSync(join(h, "config.toml"), "utf8")];
  const backups = fs.readdirSync(h).filter((f) => f.includes(".bak-credguard-")).length;
  r = install(h); assert.equal(r.status, 0);
  assert.deepEqual([fs.readFileSync(join(h, "settings.json"), "utf8"), fs.readFileSync(join(h, "config.toml"), "utf8")], after, "idempotent");
  assert.equal(fs.readdirSync(h).filter((f) => f.includes(".bak-credguard-")).length, backups, "no backup when nothing changes");
  assert.equal(install(h, "--check").status, 0);
});

test("installer: Codex's trust hash is sha256 over the hook identity's sorted compact JSON", () => {
  const cmd = '"/opt/hook" --runtime codex';
  const expected = "sha256:" + require("node:crypto").createHash("sha256")
    .update(`{"event_name":"pre_tool_use","hooks":[{"async":false,"command":${JSON.stringify(cmd)},"timeout":10,"type":"command"}],"matcher":"Bash"}`).digest("hex");
  assert.equal(inst.codexHookHash({ event: "pre_tool_use", matcher: "Bash", command: cmd, timeout: 10 }), expected);
  const changed = inst.withCodexBlock(inst.withCodexBlock("x = 1\n", "/a", "/c"), "/b", "/c");
  assert.equal((changed.match(/BEGIN AGENT-STACK CREDENTIAL READ GUARD/g) || []).length, 1, "a new hook path replaces the block");
  assert.match(changed, /--runtime codex/); assert.doesNotMatch(changed, /"\/a"/);
});

test("installer: a Codex config without [features] hooks = true is reported", () => {
  const h = fs.mkdtempSync(join(root, "f-")); fs.writeFileSync(join(h, "hook"), ""); fs.writeFileSync(join(h, "settings.json"), "{}");
  fs.writeFileSync(join(h, "config.toml"), 'model = "x"\n');
  const r = install(h);
  assert.equal(r.status, 1); assert.match(r.stdout, /-- Codex: \[features\] hooks = true is not set/);
  assert.equal(inst.hooksFeatureOn("[features]\nother = 1\nhooks = true\n[x]\n"), true);
  assert.equal(inst.hooksFeatureOn("[features]\nother = 1\n[x]\nhooks = true\n"), false);
});

test("agent-never-prompt-check: an untrusted Codex guard FAILs", () => {
  const h = fs.mkdtempSync(join(root, "n-"));
  const w = (f, c) => { fs.mkdirSync(dirname(join(h, f)), { recursive: true }); fs.writeFileSync(join(h, f), c); };
  w(".local/share/agent-stack/bin/agent-credguard-read-hook", "");
  w(".claude/settings.json", "{}"); w(".codex/config.toml", "[features]\nhooks = true\n");
  spawnSync(process.execPath, [installFile, "--hook", join(h, ".local/share/agent-stack/bin/agent-credguard-read-hook"),
    "--claude-settings", join(h, ".claude/settings.json"), "--codex-config", join(h, ".codex/config.toml")]);
  const rows = () => JSON.parse(spawnSync("python3", [join(repo, "bin/agent-never-prompt-check"), "--json"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: h } }).stdout);
  const guard = (r) => r.filter((x) => /credential read guard/.test(x.check)).map((x) => x.level);
  assert.deepEqual(guard(rows()), ["OK", "OK"]);
  const c = fs.readFileSync(join(h, ".codex/config.toml"), "utf8");
  fs.writeFileSync(join(h, ".codex/config.toml"), c.replace(/\[hooks\.state[^\n]*\]\ntrusted_hash[^\n]*\n/, ""));
  assert.deepEqual(guard(rows()), ["OK", "FAIL"]);
});
