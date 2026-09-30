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
    "cut -d= -f2 .env", "cut -d= -f1 .env", "cut -d= -f1 key.pem", "sort .env", "diff .env .env.local", "cat $HOME/.config/agent-stack/secrets/x.env",
    "cat ${HOME}/.config/agent-stack/secrets/x.env", "cat prod.env", "cat .env*", "cat config/*.pem",
    'echo "$(cat .env)"', "echo $(< .env)", "echo `cat .env`", "cat < .env", "tee < .env",
    "cp .env /dev/stdout", "cp .env /dev/tty", "dd if=.env", "git show HEAD:.env", "git diff .env", "git log -p -- .env",
    'bash -c "cat .env"', "sh -c 'head .env'", "eval cat .env", "sudo cat /etc/app/.env", "FOO=1 cat .env", "timeout 5 cat .env",
    "source .env && echo $DATABASE_URL", ". ./.env; printenv", "set -a; . .env; set +a; env", "source .env; export -p",
    "source .env && printf '%s' \"$TOKEN\"", "cd /tmp && cat .env | grep URL", "export $(grep -v '^#' .env | xargs)",
    "grep -e URL .env", "grep -A 2 URL .env",
    // QA WO42 f1: subshells, shell -c in any option spelling, env with options, groups, unquoted heredoc substitution
    "(cat .env)", "( head .env )", "{ cat .env; }", "if cat .env; then :; fi", 'bash --noprofile --norc -lc "cat .env"',
    "sh -ec 'cat .env'", "env -u UNUSED cat .env", "env -i PATH=/bin cat .env", 'env -S "cat .env"', "timeout -s KILL 5 cat .env",
    "cat <<EOF\n$(cat .env)\nEOF", "cat <<EOF\n`cat .env`\nEOF", "tee < .env",
    // QA WO42 f2: an option-looking pattern is a pattern; cut prints lines without "="
    "grep -- -l .env", "grep -e -l .env", "rg -- -q .env",
    // QA WO42 refresh: a named -p display after loading, and jq's file-valued options
    "source .env; declare -p FIXTURE_KEY", "source .env; typeset -p FIXTURE_KEY", "source .env; declare -px",
    "jq -n --rawfile secret .env '$secret'", "jq -n --slurpfile s prod.env '$s'", "jq --from-file f.jq .env", "rg --regexp TOKEN -- .env", "awk -F= '{print $2}' .env", "jq -r .key key.pem",
  ]) assert.equal(bash(c), true, c);
});

test("Bash: using credentials without printing them, and ordinary commands, are allowed", () => {
  for (const c of [
    "grep -r TODO .", "cat README.md", "ls .env*", "ls -la", "cat .env.example", "cat .env.sample", "head .env.template",
    "set -a; . .env; set +a; npm run migrate", "source .env && npm test", "source .env && echo done", "npm run dev -- --env-file .env",
    "docker run --env-file .env img", "grep -q '^DATABASE_URL=' .env && echo present", "grep -c KEY .env", "grep -l KEY -r .",
    "rg -l TOKEN", "wc -l .env", "sha256sum .env", "test -f .env && echo yes", "stat .env",
    "cp .env .env.bak", "mv .env.local .env", "sed -i 's/old/new/' .env", "echo 'X=1' >> .env", "printf 'K=v\\n' > .env.local",
    "tail -f log.txt 2>&1 | grep err",
    // QA WO42 f3: quiet input redirection, set options after loading, a file-looking pattern after --
    "grep -q FIXTURE_KEY < .env", "source .env; set -e; true", "source .env; set -euo pipefail; npm test", "grep -- .env README.md",
    "rg -- prod.env docs/", "cat <<'EOF'\n$(cat .env)\nEOF", "export -n FOO", "declare -r X=1",
    "source .env; declare OTHER=safe", "source .env; declare -i COUNT=3", "jq -n --arg k v '$k'", "jq -n --rawfile tpl notes.txt '$tpl'", "env | grep PATH", "git add .env.example", "git status", "chmod 600 .env",
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
  assert.match(d.reason, /agent-credguard-read-hook --keys ~\/app\/\.env/);
  assert.doesNotMatch(d.reason, /cut -d/, "cut can print whole lines, so it is not advised");
});

test("--keys prints only the key names, never a value or a line without one", () => {
  assert.deepEqual(g.keyNames("# c\nA=1\nexport B_2 = x\n  C=\nnot a pair\nD"), ["A", "B_2", "C"]);
  assert.deepEqual(g.keyNames("-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC=\n-----END PRIVATE KEY-----\n"), [], "a key file has no names");
  assert.deepEqual(g.keyNames("TOKEN=x\nAAAAB3NzaC1yc2EAAAADAQABAAAB==\n"), ["TOKEN"], "a base64 line is not a name");
  const f = join(root, "keys.env"); fs.writeFileSync(f, "FIXTURE_KEY=synthetic-value\nPLAIN LINE\n");
  const r = spawnSync(process.execPath, [hookFile, "--keys", f], { encoding: "utf8" });
  assert.equal(r.stdout, "FIXTURE_KEY\n"); assert.doesNotMatch(r.stdout, /synthetic|PLAIN/);
  assert.equal(bash(`"$HOME/.local/share/agent-stack/bin/agent-credguard-read-hook" --keys .env`), false, "the advised command is allowed");
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
  fs.writeFileSync(join(h, "config.toml"), '[features]\nother = 1\n\n[x]\nhooks = true\n');
  assert.match(install(h).stdout, /-- Codex: \[features\] hooks = true is not set/, "hooks = true under another table doesn't count");
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

test("installer: a guard handler sharing a group with another hook leaves that hook in place (QA WO42 f4)", () => {
  const h = fs.mkdtempSync(join(root, "s-")); fs.writeFileSync(join(h, "hook"), ""); fs.writeFileSync(join(h, "config.toml"), "[features]\nhooks = true\n");
  const old = { type: "command", command: '"/old/agent-credguard-read-hook" --runtime claude' }, audit = { type: "command", command: "echo audit" };
  fs.writeFileSync(join(h, "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [old, audit] }, { matcher: "Read", hooks: [old] }] } }));
  assert.equal(install(h).status, 0);
  const pre = JSON.parse(fs.readFileSync(join(h, "settings.json"), "utf8")).hooks.PreToolUse;
  assert.deepEqual(pre.map((g) => [g.matcher, g.hooks.map((x) => x.command)]),
    [["Bash", ["echo audit"]], ["Bash|Read|Grep", [`"${join(h, "hook")}" --runtime claude`]]], "the old guard handlers go; audit stays; an emptied group goes");
});

test("installer: malformed settings JSON is refused, never overwritten (QA WO42 f4)", () => {
  const h = fs.mkdtempSync(join(root, "m-")); fs.writeFileSync(join(h, "hook"), ""); fs.writeFileSync(join(h, "config.toml"), "[features]\nhooks = true\n");
  fs.writeFileSync(join(h, "settings.json"), '{"hooks": {"PreToolUse": [ broken');
  const r = install(h);
  assert.equal(r.status, 1); assert.match(r.stdout, /-- Claude: .*settings\.json is not valid JSON .*left unchanged/);
  assert.equal(fs.readFileSync(join(h, "settings.json"), "utf8"), '{"hooks": {"PreToolUse": [ broken');
  assert.equal(fs.readdirSync(h).filter((f) => f.startsWith("settings.json.bak")).length, 0);
});

test("installer: the Codex group index comes from the parsed TOML, comments and spacing included (QA WO42 f5)", () => {
  for (const header of ["[[hooks.PreToolUse]] # existing audit", "[[ hooks.PreToolUse ]]", '[[hooks."PreToolUse"]]']) {
    const h = fs.mkdtempSync(join(root, "p-")); fs.writeFileSync(join(h, "hook"), ""); fs.writeFileSync(join(h, "settings.json"), "{}");
    fs.writeFileSync(join(h, "config.toml"), `[features]\nhooks = true\n\n${header}\nmatcher = "Bash"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "audit"\n`);
    assert.equal(install(h).status, 0, header);
    const t = tomlJson(join(h, "config.toml"));
    assert.equal(t.hooks.PreToolUse.findIndex((grp) => /--runtime codex/.test(grp.hooks[0].command)), 1, header);
    assert.deepEqual(Object.keys(t.hooks.state), [`${fs.realpathSync(join(h, "config.toml"))}:pre_tool_use:1:0`], header);
    assert.equal(install(h, "--check").status, 0);
  }
  const h = fs.mkdtempSync(join(root, "q-")); fs.writeFileSync(join(h, "hook"), ""); fs.writeFileSync(join(h, "settings.json"), "{}");
  const bad = "[features]\nhooks = true\n[hooks\nbroken";
  fs.writeFileSync(join(h, "config.toml"), bad);
  const r = install(h);
  assert.equal(r.status, 1); assert.match(r.stdout, /-- Codex: .*not valid TOML.*left unchanged/); assert.equal(fs.readFileSync(join(h, "config.toml"), "utf8"), bad);
  fs.writeFileSync(join(h, "config.toml"), '[features]\nhooks = true\n[hooks]\nPreToolUse = [{ matcher = "Edit", hooks = [] }]\n');
  const r2 = install(h);
  assert.equal(r2.status, 1, "a static inline array can't take another group: refused, not written wrong"); assert.match(r2.stdout, /-- Codex: .*left unchanged/);
});

test("agent-never-prompt-check: a wrong trusted_hash or a missing hooks feature FAILs (QA WO42 f6)", () => {
  const h = fs.mkdtempSync(join(root, "a-"));
  const w = (f, c) => { fs.mkdirSync(dirname(join(h, f)), { recursive: true }); fs.writeFileSync(join(h, f), c); };
  w(".local/share/agent-stack/bin/agent-credguard-read-hook", ""); w(".claude/settings.json", "{}"); w(".codex/config.toml", "[features]\nhooks = true\n");
  spawnSync(process.execPath, [installFile, "--hook", join(h, ".local/share/agent-stack/bin/agent-credguard-read-hook"),
    "--claude-settings", join(h, ".claude/settings.json"), "--codex-config", join(h, ".codex/config.toml")]);
  const codexRow = () => JSON.parse(spawnSync("python3", [join(repo, "bin/agent-never-prompt-check"), "--json"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: h } }).stdout)
    .find((x) => x.check.startsWith("Codex: credential read guard"));
  assert.equal(codexRow().level, "OK");
  const c = fs.readFileSync(join(h, ".codex/config.toml"), "utf8");
  fs.writeFileSync(join(h, ".codex/config.toml"), c.replace(/trusted_hash = "sha256:[0-9a-f]+"/, 'trusted_hash = "sha256:invalid"'));
  assert.equal(codexRow().level, "FAIL"); assert.match(codexRow().detail, /trusted_hash doesn't match the hook/);
  fs.writeFileSync(join(h, ".codex/config.toml"), c.replace("hooks = true", "hooks = false"));
  assert.equal(codexRow().level, "FAIL"); assert.match(codexRow().detail, /\[features\] hooks = true is not set/);
});

// Runtime evidence: Codex itself (app-server hooks/list, no model call) reports the installed guard as trusted and
// enabled, with the hash the installer computed. Skipped where no codex binary is installed.
// The real codex binary: a native executable whose resolved file is named codex. Not the agent-stack seat shim or a
// wrapper script (both need the real HOME), and not the mise shim (it resolves to mise). Falls back to `mise which`.
const isNativeCodex = (f) => {
  try {
    const real = fs.realpathSync(f), fd = fs.openSync(real, "r"), b = Buffer.alloc(4); fs.readSync(fd, b, 0, 4, 0); fs.closeSync(fd);
    return fs.statSync(real).isFile() && real.endsWith("/codex") && b.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]));
  } catch { return false; }
};
const codexBin = (process.env.PATH || "").split(":").filter(Boolean).map((d) => join(d, "codex")).find(isNativeCodex)
  || [spawnSync("mise", ["which", "codex"], { encoding: "utf8" }).stdout?.trim()].find((f) => f && isNativeCodex(f)) || "";
test("Codex accepts the installed guard as trusted (hooks/list)", { skip: !codexBin && "codex not installed" }, () => {
  const h = fs.mkdtempSync(join(root, "cx-")); fs.mkdirSync(join(h, "home")); fs.mkdirSync(join(h, "work"));
  fs.writeFileSync(join(h, "hook"), ""); fs.writeFileSync(join(h, "settings.json"), "{}");
  fs.writeFileSync(join(h, "home/config.toml"), '[features]\nhooks = true\n\n[[hooks.PreToolUse]] # another hook first\nmatcher = "Edit"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "true"\n');
  spawnSync(process.execPath, [installFile, "--hook", join(h, "hook"), "--claude-settings", join(h, "settings.json"), "--codex-config", join(h, "home/config.toml")]);
  const input = ['{"id":1,"method":"initialize","params":{"clientInfo":{"name":"test","version":"0"}}}', '{"method":"initialized"}',
    JSON.stringify({ id: 2, method: "hooks/list", params: { cwds: [join(h, "work")] } })].join("\n") + "\n";
  const r = spawnSync("sh", ["-c", `(cat; sleep 4) | timeout 25 "${codexBin}" app-server`], { input, cwd: join(h, "work"), encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: h, CODEX_HOME: join(h, "home") } });
  const line = r.stdout.split("\n").find((l) => /"id":2/.test(l));
  assert.ok(line, r.stderr.slice(-500));
  const guard = JSON.parse(line).result.data[0].hooks.find((x) => /--runtime codex/.test(x.command || ""));
  assert.deepEqual([guard.eventName, guard.matcher, guard.enabled, guard.trustStatus], ["preToolUse", "Bash", true, "trusted"]);
  assert.equal(guard.key, `${fs.realpathSync(join(h, "home/config.toml"))}:pre_tool_use:1:0`);
  assert.equal(guard.currentHash, tomlJson(join(h, "home/config.toml")).hooks.state[guard.key].trusted_hash);
});

// ---- globs, cd, links and quoting against a real directory (the operator's attack list) ---------------------------
test("globs follow bash's dotfile rule; dotglob, .* and ** still refuse; cd, links, copies, $'…', braces and variables resolve", () => {
  const w = fs.mkdtempSync(join(root, "glob-")), d = join(w, "app"), bin = join(w, "bin");
  fs.mkdirSync(d); fs.mkdirSync(bin);
  fs.writeFileSync(join(d, ".env"), "FIXTURE_KEY=x\n"); fs.writeFileSync(join(d, "notes.txt"), "hi\n");
  fs.writeFileSync(join(bin, "tool"), "#!/bin/sh\n"); fs.writeFileSync(join(bin, "other"), "x\n");
  const dec = (command, cwd = w) => g.decide({ tool_name: "Bash", tool_input: { command }, cwd }, { home, pats: g.DEFAULT_PATTERNS }).deny;
  // the false positive that started this: a glob over a directory with no credential files
  assert.equal(dec("grep -rn TODO bin/*"), false);
  assert.equal(dec("cat app/*"), false, "bash's * doesn't match .env (dotglob off)");
  for (const c of ["shopt -s dotglob; cat app/*", "bash -O dotglob -c 'cat app/*'", "cat app/.*", "cat app/.e*", "cat app/**", "cat app/.en?"])
    assert.equal(dec(c), true, c);
  assert.equal(dec("shopt -s dotglob; shopt -u dotglob; cat app/*"), false, "dotglob turned off again");
  fs.writeFileSync(join(d, "prod.env"), "K=v\n");
  assert.equal(dec("cat app/*"), true, "a non-dot credential file matched by *"); fs.rmSync(join(d, "prod.env"));
  // cd: relative paths resolve against the directory the command moved to
  assert.equal(dec("cd ~/.config/agent-stack/secrets && cat cliproxy.env", "/"), true, "cd into the secrets dir, then a bare name");
  assert.equal(dec("cd app; cat .env"), true); assert.equal(dec("cd app && cat notes.txt"), false);
  assert.equal(dec("cd /; cd ~/.config/agent-stack && cat secrets/x.env"), true);
  // links and copies (an existing symlink to .env also makes `cat app/*` print it)
  fs.symlinkSync(join(d, ".env"), join(d, "readme-link"));
  assert.equal(dec("cat app/readme-link"), true, "an existing symlink to .env");
  assert.equal(dec("cat app/*"), true, "* now matches a link to .env");
  for (const c of ["ln -s app/.env n && cat n", "cp app/.env /tmp/n.txt; cat /tmp/n.txt", "mv app/.env keep; head keep", "cp app/.env app/ && cat app/.env",
    "dd if=app/.env of=out.txt; cat out.txt", "tee copy.txt < app/.env >/dev/null; cat copy.txt"]) assert.equal(dec(c), true, c);
  assert.equal(dec("cp app/notes.txt n && cat n"), false, "copying an ordinary file taints nothing");
  // quoting, braces, variables
  for (const c of ["cat $'app/\\x2eenv'", "cat $'app/.e\\156v'", "cat app/.{e,x}nv", "cat \"app/.e\"nv", "cat app/\\.env", "F=app/.env; cat $F",
    "export F=app/.env; cat \"$F\"", "D=app; cat ${D}/.env"]) assert.equal(dec(c), true, c);
  assert.equal(dec("cat app/.{x,y}nv"), false, "braces that name nothing protected");
});

// QA PR59 (c5830bd9): brackets, directory state, globs over new copies, cp -t / directory copies, \U, and variables.
test("QA PR59: bracket classes, every visited directory, tainted names in globs, cp -t, dir copies, \\U, command-local variables", () => {
  const h = fs.mkdtempSync(join(root, "qa59-")), app = join(h, "app"), sec = join(h, ".config/agent-stack/secrets");
  fs.mkdirSync(app); fs.mkdirSync(sec, { recursive: true }); fs.mkdirSync(join(h, "out"));
  fs.writeFileSync(join(app, ".env"), "K=v\n"); fs.writeFileSync(join(app, "key.pem"), "x\n"); fs.writeFileSync(join(app, "notes"), "hi\n");
  fs.writeFileSync(join(sec, "token.txt"), "t\n"); fs.symlinkSync(join(app, ".env"), join(app, "nlink"));
  const dec = (command) => g.decide({ tool_name: "Bash", tool_input: { command }, cwd: h }, { home: h, pats: g.DEFAULT_PATTERNS }).deny;
  for (const c of [
    "cat app/.[e]nv", "cat app/key.[p]em", "cat app/.[!x]nv", "cat app/n[l]ink",                                  // f1
    `cd "$HOME/.config/agent-stack/secrets"; (cd "$HOME"); cat token.txt`, "pushd ~/.config/agent-stack/secrets; popd; cat token.txt",
    "cd ~/.config/agent-stack/secrets; cd -; cat token.txt", "env -C ~/.config/agent-stack/secrets cat token.txt",  // f2
    "cp app/.env copied; cat cop*", "cp app/.env c1; cp c* c2; cat c2", "mv app/.env moved; cat mov*", "ln -s app/.env lk; cat l?", "dd if=app/.env of=d1; cat d*", // f3
    'cp -t out "$HOME/.config/agent-stack/secrets/token.txt"; cat out/token.txt', 'cp -r "$HOME/.config/agent-stack/secrets" out/; cat out/secrets/token.txt', // f4
    "cat $'app/\\U0000002eenv'",                                                                                       // f5
    "F=app/.env bash -c 'cat \"$F\"'", "declare F=app/.env; cat $F", "read F <<< app/.env; cat $F", "for f in app/.env; do cat \"$f\"; done", // f6
    "cat \"$(printf app/.env)\" # names app/.env", "X=$(echo app); cat app/.env",                                      // backstop / plain
  ]) assert.equal(dec(c), true, c);
  for (const c of ["cat app/n[o]tes", "cat app/[!.]otes", "cd app; cat notes", "cp app/notes n2; cat n*", "for f in app/notes; do cat \"$f\"; done",
    "cat \"$UNSET\"", "ls app/.[e]nv", "cp -t out app/notes; cat out/notes"]) assert.equal(dec(c), false, c);
});

// QA PR59 refresh (9225d851): an assignment that may not reach this shell must not replace a protected value.
test("QA PR59 refresh: subshell / prefix / branch scope, dotglob off in a subshell, [[:class:]], env -CDIR, read field splitting", () => {
  const h = fs.mkdtempSync(join(root, "qa59r-")), app = join(h, "app"), sec = join(h, ".config/agent-stack/secrets");
  fs.mkdirSync(app); fs.mkdirSync(sec, { recursive: true }); fs.mkdirSync(join(h, "out"));
  fs.writeFileSync(join(app, ".env"), "K=v\n"); fs.writeFileSync(join(app, "safe.txt"), "hi\n"); fs.writeFileSync(join(sec, "token.txt"), "t\n");
  const dec = (command) => g.decide({ tool_name: "Bash", tool_input: { command }, cwd: h }, { home: h, pats: g.DEFAULT_PATTERNS }).deny;
  for (const c of [
    'F=app/.env; (F=app/safe.txt); cat "$F"', 'F=app/.env; F=app/safe.txt true; cat "$F"',
    'F=app/.env; if false; then F=app/safe.txt; fi; cat "$F"', 'F=app/.env; false && F=app/safe.txt; cat "$F"',
    'F=app/.env; echo x | F=app/safe.txt; cat "$F"', 'F=app/.env; export F=app/safe.txt & cat "$F"',
    "shopt -s dotglob; (shopt -u dotglob); cat app/*", "cat app/.[[:alpha:]]nv", "cat app/.[[:lower:]]n[[:alpha:]]",
    'env -C"$HOME/.config/agent-stack/secrets" cat token.txt', "read -r F rest <<< 'app/.env ignore'; cat \"$F\"",
    "read -r A B <<< 'x app/.env'; cat $B", "cp -t out app/.[e]nv; cat out/.env",
  ]) assert.equal(dec(c), true, c);
  for (const c of ['F=app/.env; F=app/safe.txt; cat "$F"', 'F=app/safe.txt true; cat app/safe.txt', "cat app/.[[:digit:]]nv",
    "shopt -s dotglob; shopt -u dotglob; cat app/*", "read -r F rest <<< 'app/safe.txt app/.env'; cat \"$F\"",
    "cp app/.env out/; cp app/safe.txt out/; cat out/safe.txt"]) assert.equal(dec(c), false, c);
});
