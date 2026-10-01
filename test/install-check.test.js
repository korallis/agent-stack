// WO59: `install.sh --check` is read-only, and nothing installs by accident. On 2026-10-01 `./install.sh --help` ran a
// full install (any first argument but --check meant "install"). Now: --check writes nothing (no file, link, directory,
// mode or backup under HOME or in the repo) and starts nothing; --help prints usage; any other argument, or no
// argument without a terminal, does nothing; a full install needs --apply. The scripts that act on the OpenRig daemon
// refuse an OPENRIG_HOME outside HOME. Everything runs in a throwaway HOME under an explicit minimal env (never the
// seat's OPENRIG_*), with recording stubs for every tool that could change the machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(join(os.tmpdir(), "install-check-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const stubs = join(root, "stubs"), calls = join(root, "calls");
fs.mkdirSync(stubs);
const has = (c) => spawnSync("sh", ["-c", `command -v ${c}`]).status === 0;
// Tools that could change the machine: every one is a recording stub that answers like a read.
for (const c of ["logger", "claude", "codex", "rig", "systemctl", "mise", "npm", "npx", "gh", "notify-send", "loginctl", "crontab",
  "journalctl", "curl", "neon", "vercel", "toon", "uv", "pipx"]) {
  fs.writeFileSync(join(stubs, c), `#!/usr/bin/env bash
echo "${c} $*" >> "${calls}"
case "${c} $1 $2" in
  "mise where "*) dirname "$(dirname "${process.execPath}")" ;;
  "systemctl --user show-environment") echo PATH=/usr/bin ;;
esac
exit 0
`, { mode: 0o755 });
}
// install.sh's prerequisites that this host lacks (a CI runner has no fd or rg): presence is all it checks of them.
const prereqs = (fs.readFileSync(join(repo, "install.sh"), "utf8").match(/for c in ([^;]+); do command -v/) || [, ""])[1].trim().split(/\s+/);
for (const c of prereqs) if (!fs.existsSync(join(stubs, c)) && !has(c)) fs.writeFileSync(join(stubs, c), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
const env = (home, extra = {}) => ({ HOME: home, USER: "u", LANG: "C.UTF-8", TERM: "dumb",
  PATH: `${stubs}:${dirname(process.execPath)}:/usr/bin:/bin`, XDG_RUNTIME_DIR: join(home, ".run"), ...extra });
const run = (script, args, home, extra) => { fs.writeFileSync(calls, "");
  const r = spawnSync("bash", [join(repo, script), ...args], { encoding: "utf8", env: env(home, extra), input: "", timeout: 300000 });
  return { ...r, calls: fs.readFileSync(calls, "utf8") }; };

// A HOME with something for every step to judge: the hook and MCP entries out of date, stale placed files and units, a
// wrong link, a loose secrets dir.
function seededHome() {
  const h = fs.mkdtempSync(join(root, "home-"));
  const w = (p, c, mode) => { fs.mkdirSync(dirname(join(h, p)), { recursive: true }); fs.writeFileSync(join(h, p), c); if (mode) fs.chmodSync(join(h, p), mode); };
  w(".claude/settings.json", JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "fmt" }] }] } }));
  w(".codex/config.toml", '[features]\nhooks = true\n\n[mcp_servers.playwright]\ncommand = "npx"\nargs = ["-y", "@playwright/mcp@0.0.80", "--headless"]\n');
  w(".local/share/agent-stack/bin/agent-credguard-read-hook", "old\n", 0o755); w(".local/share/agent-stack/seat-bin/codex", "old\n", 0o755);
  w(".config/systemd/user/cliproxyapi.service", "old\n"); w(".config/agent-stack/secrets/typesafe.env", "TYPESAFE_API_KEY=\n", 0o600);
  fs.chmodSync(join(h, ".config/agent-stack/secrets"), 0o755);
  fs.mkdirSync(join(h, ".claude/skills"), { recursive: true }); fs.symlinkSync("/nonexistent", join(h, ".claude/skills/agent-stack"));
  return h;
}
// Every path under HOME: type, mode, size, mtime, link target and content hash.
function snapshot(dir) {
  const out = [];
  const walk = (d) => { for (const n of fs.readdirSync(d).sort()) {
    const p = join(d, n), st = fs.lstatSync(p), rel = relative(dir, p);
    let extra = "";
    if (st.isSymbolicLink()) extra = `-> ${fs.readlinkSync(p)}`;
    else if (st.isFile()) extra = createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    out.push(`${rel} ${st.mode.toString(8)} ${st.size} ${st.mtimeMs} ${extra}`);
    if (st.isDirectory() && !st.isSymbolicLink()) walk(p);
  } };
  walk(dir); return out;
}
const gitState = () => spawnSync("git", ["status", "--porcelain=v1", "--ignored", "-uall"], { cwd: repo, encoding: "utf8" }).stdout;
const MUTATING = /^(systemctl --user (enable|disable|start|stop|restart|reload|daemon-reload|set-property|reset-failed|mask|unmask)|claude (mcp (add|remove)|plugin (install|uninstall|marketplace))|codex plugin (install|add)|rig (config set|daemon (start|stop)|gateway human add)|loginctl enable-linger|npm (i|install|ci|update)\b|mise (use|install)|npx -y|curl .*-o|gh (repo|auth login))/m;

test("WO59: install.sh --check writes nothing under HOME or in the repo, starts nothing, and says it is a report", () => {
  const h = seededHome(), before = snapshot(h), git = gitState();
  const r = run("install.sh", ["--check"], h);
  assert.equal(r.status, 0, (r.stdout + r.stderr).slice(-1500));
  assert.match(r.stdout.split("\n")[0], /^install\.sh --check: report only, nothing is written or started$/);
  assert.deepEqual(snapshot(h), before, "nothing under HOME changed (contents, modes, mtimes, links)");
  assert.equal(gitState(), git, "nothing in the repo changed");
  assert.doesNotMatch(r.calls, MUTATING, "no installing, enabling or starting");
  // it still reports what an install would change
  assert.match(r.stdout, /--  .*agent-credguard-read-hook differs or missing/);
  assert.match(r.stdout, /--  .*secrets should be a 0700 directory/);
  assert.match(r.stdout, /--  link .*\.claude\/skills\/agent-stack/);
  assert.match(r.stdout, /--  .*cliproxyapi\.service differs or missing/);
  // a fresh, empty HOME too: not even the directories an install would create
  const empty = fs.mkdtempSync(join(root, "empty-"));
  const r2 = run("install.sh", ["--check"], empty);
  assert.equal(r2.status, 0, r2.stderr.slice(-800));
  assert.deepEqual(fs.readdirSync(empty), [], "an empty HOME stays empty");
});

test("WO59: --help prints usage and does nothing; unknown arguments, both modes, or no mode without a terminal are refused", () => {
  const h = fs.mkdtempSync(join(root, "args-"));
  let r = run("install.sh", ["--help"], h);
  assert.equal(r.status, 0); assert.match(r.stdout, /\.\/install\.sh --apply +install \/ repair everything/); assert.match(r.stdout, /--check +only report/);
  assert.equal(r.calls, ""); assert.deepEqual(fs.readdirSync(h), []);
  for (const args of [["--bogus"], ["-x", "--check"], ["--", "--check"], ["--check", "--apply"], ["--apply", "--check"], []]) {
    r = run("install.sh", args, h);
    assert.equal(r.status, 2, args.join(" ")); assert.match(r.stderr, /Nothing was done/, args.join(" "));
    assert.equal(r.calls, "", `${args.join(" ")}: no tool ran`); assert.deepEqual(fs.readdirSync(h), [], `${args.join(" ")}: nothing written`);
  }
  assert.match(run("install.sh", [], h).stderr, /say --apply to install or --check to report \(no terminal to ask\)/);
});

test("WO59: install.sh, openrig-ensure, openrig-upgrade and openrig-daemon-cycle refuse an OPENRIG_HOME outside HOME", () => {
  const h = fs.mkdtempSync(join(root, "foreign-")), foreign = { OPENRIG_HOME: join(root, "someone-elses-openrig") };
  for (const [script, args] of [["install.sh", ["--check"]], ["install.sh", ["--apply"]], ["bin/openrig-ensure", ["--check"]], ["bin/openrig-ensure", []],
    ["bin/openrig-upgrade", ["0.6.1"]], ["bin/openrig-daemon-cycle", []], ["bin/openrig-daemon-cycle", ["--stop-only"]]]) {
    const r = run(script, args, h, foreign);
    assert.equal(r.status, 2, `${script} ${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, /not under HOME=.*refusing/, script);
    assert.equal(r.calls, "", `${script} ${args.join(" ")}: no tool ran`);
  }
  assert.deepEqual(fs.readdirSync(h), [], "nothing written");
  // under HOME is fine: the guard lets it through (the report runs)
  const ok = run("install.sh", ["--check"], h, { OPENRIG_HOME: join(h, ".openrig") });
  assert.doesNotMatch(ok.stderr, /refusing/); assert.equal(ok.status, 0, ok.stderr.slice(-800));
});
