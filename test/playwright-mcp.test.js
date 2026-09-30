// WO18: seats' Playwright MCP uses a PINNED @playwright/mcp with Playwright's own Chrome for Testing (--browser
// chromium), installed by that release's own Playwright; never @latest (0.0.83 needed CfT 155 while 153 was installed)
// and never an older system browser via --executable-path (/usr/bin/chromium was 152 when apps required 153+).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "pwmcp-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const read = (p) => fs.readFileSync(join(repo, p), "utf8");
const pin = read("system/codex/config.toml").match(/"@playwright\/mcp@([^"]+)"/)[1];

test("the Codex template pins one @playwright/mcp release with --browser chromium; no @latest, no system browser", () => {
  const t = read("system/codex/config.toml");
  assert.match(pin, /^\d+\.\d+\.\d+$/);
  assert.match(t, new RegExp(`^args = \\["-y", "@playwright/mcp@${pin.replace(/\./g, "\\.")}", "--headless", "--browser", "chromium"\\]$`, "m"));
  assert.doesNotMatch(t, /@playwright\/mcp@latest|--executable-path/);
});

test("install.sh reads that pin, registers Claude's MCP with it, installs via playwright-browsers, never playwright@latest", () => {
  const s = read("install.sh");
  assert.match(s, /PW_MCP=\$\(sed -n .*system\/codex\/config\.toml/);
  assert.match(s, /pw=\(npx -y "@playwright\/mcp@\$PW_MCP" --headless --browser chromium\)/);
  assert.match(s, /claude mcp remove --scope user playwright/, "an entry with other args is replaced");
  assert.match(s, /"\$S\/bin\/playwright-browsers" >\/dev\/null \|\| todo/);
  const code = s.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.doesNotMatch(code, /playwright@latest|--executable-path|command -v chromium/);
  assert.match(s, /for t in [^;]*\bplaywright-browsers; do systemctl --user enable --now/);
  assert.match(read("system/systemd/playwright-browsers.timer"), /OnUnitActiveSec=1d/);
  assert.match(read("system/systemd/playwright-browsers.service"), /ExecStart=%h\/\.local\/bin\/playwright-browsers/);
});

// playwright-browsers with a stub npx that stands in for the pinned release's Playwright: the dry run names install
// locations (or nothing, with FAKE_PLAN=empty); the launch check (`sh -c …`) succeeds only once a real install has run
// (the READY marker). Directories alone are not enough, as with an interrupted download.
const bin = join(root, "bin"), calls = join(root, "calls"), cache = join(root, "cache"), ready = join(root, "READY");
fs.mkdirSync(bin);
// A fake npx install tree, like the real one: .bin/playwright -> ../playwright/cli.js, @playwright/mcp/package.json, and a
// playwright-core whose chromium.launch() works only once installed (READY). The stub runs the probe's real sh -c script
// with that tree's .bin on PATH, so node module resolution is exercised for real.
const tree = join(root, "npx-tree", "node_modules");
const mkTree = (mcpVersion) => {
  fs.rmSync(join(root, "npx-tree"), { recursive: true, force: true });
  fs.mkdirSync(join(tree, ".bin"), { recursive: true }); fs.mkdirSync(join(tree, "playwright")); fs.mkdirSync(join(tree, "@playwright/mcp"), { recursive: true });
  fs.mkdirSync(join(tree, "playwright-core"));
  fs.writeFileSync(join(tree, "playwright/cli.js"), "#!/usr/bin/env node\n", { mode: 0o755 });
  fs.symlinkSync("../playwright/cli.js", join(tree, ".bin/playwright"));
  fs.writeFileSync(join(tree, "@playwright/mcp/package.json"), JSON.stringify({ version: mcpVersion }));
  fs.writeFileSync(join(tree, "playwright-core/index.js"), `module.exports = { chromium: { launch: async () => {
    if (!require("fs").existsSync(${JSON.stringify(ready)})) throw new Error("browserType.launch: Executable doesn't exist at ${cache}/chromium_headless_shell-1243/chrome-headless-shell");
    return { close: async () => {} }; } } };`);
};
fs.writeFileSync(join(bin, "npx"), `#!/bin/bash
printf '%s\\n' "npx $* (cwd $PWD)" >> "${calls}"
if [[ "$*" == *"--dry-run"* ]]; then
  [ "\${FAKE_PLAN:-}" = empty ] && exit 0
  echo "Chrome for Testing 153.0.8010.12 (playwright chromium v1243)"; echo "  Install location:    ${cache}/chromium-1243"
  echo "Chrome Headless Shell 153.0.8010.12 (playwright chromium-headless-shell v1243)"; echo "  Install location:    ${cache}/chromium_headless_shell-1243"
elif [[ "$*" == *"install --force chromium"* ]]; then mkdir -p "${cache}/chromium-1243" "${cache}/chromium_headless_shell-1243"; touch "${ready}"
else
  while [ "$1" != sh ]; do shift; done; shift 2   # -y -p <pkg> sh -c <script> [args]
  script=$1; shift; PATH="${tree}/.bin:$PATH" exec sh -c "$script" sh "$@"
fi
`, { mode: 0o755 });
fs.writeFileSync(join(bin, "logger"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
const nodeDir = dirname(process.execPath);   // the probe runs node
const ensure = (args = [], env = {}) => { fs.rmSync(calls, { force: true });
  const r = spawnSync(join(repo, "bin/playwright-browsers"), args, { encoding: "utf8", env: { PATH: `${bin}:${nodeDir}:/usr/bin:/bin`, HOME: root, ...env } });
  return { ...r, c: fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "" }; };
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const fresh = (mcpVersion = pin) => { fs.rmSync(cache, { recursive: true, force: true }); fs.rmSync(ready, { force: true }); mkTree(mcpVersion); };

test("playwright-browsers: ready means it launches; --check reports and installs nothing; plain mode installs, then verifies", () => {
  fresh();
  const check = ensure(["--check"]);
  assert.equal(check.status, 1);
  assert.match(check.stdout, new RegExp(`@playwright/mcp@${esc(pin)} needs Chrome for Testing 153\\.0\\.8010\\.12 \\(playwright chromium v1243\\), which does not launch: headless shell: .*Executable doesn't exist`));
  assert.doesNotMatch(check.c, /install --force/, "--check installs nothing");
  const inst = ensure();
  assert.equal(inst.status, 0, inst.stdout + inst.stderr);
  assert.match(inst.c, new RegExp(`^npx -y -p @playwright/mcp@${esc(pin)} playwright install --force chromium \\(cwd `, "m"));
  assert.doesNotMatch(inst.c, /playwright@latest/);
  assert.equal((inst.c.match(/ sh -c /g) || []).length, 2, "launch checked before and after the install");
  assert.doesNotMatch(inst.c, new RegExp(`\\(cwd ${esc(process.cwd())}\\)`), "npx never runs from the caller's directory");
  const again = ensure();
  assert.equal(again.status, 0);
  assert.match(again.stdout, /browser ready \(launches\): Chrome for Testing 153\.0\.8010\.12/);
  assert.doesNotMatch(again.c, /install --force/, "no reinstall when it launches");
});

test("QA: a partial cache (the install directories exist, the browser doesn't) is not ready, and plain mode repairs it", () => {
  fresh();
  fs.mkdirSync(join(cache, "chromium-1243"), { recursive: true }); fs.mkdirSync(join(cache, "chromium_headless_shell-1243"), { recursive: true });
  const check = ensure(["--check"]);
  assert.equal(check.status, 1);
  assert.match(check.stdout, /which does not launch/);
  const repair = ensure();
  assert.equal(repair.status, 0);
  assert.match(repair.c, /playwright install --force chromium \(cwd /m, "reinstalled over the partial directories");
});

test("QA: an empty or unrecognised install plan is an error, never 'present'", () => {
  fresh(); fs.writeFileSync(ready, "");   // even with a browser that would launch
  for (const args of [["--check"], []]) {
    const r = ensure(args, { FAKE_PLAN: "empty" });
    assert.equal(r.status, 1, args.join(" "));
    assert.match(r.stdout, /unrecognised install plan from @playwright\/mcp@/);
    assert.doesNotMatch(r.stdout, /browser ready|browser present/);
  }
});

// agent-project-check on a fake HOME: npx and the system browser are stubbed.
test("agent-project-check WARNs on @latest and on an --executable-path older than the release's Chrome for Testing", () => {
  const home = join(root, "home"), W = join(home, "Projects/P-work");
  fs.mkdirSync(join(home, ".codex"), { recursive: true }); fs.mkdirSync(W, { recursive: true });
  fs.writeFileSync(join(W, "project.yaml"), "kind: project\n");
  const chromium = join(bin, "chromium-152"); fs.writeFileSync(chromium, "#!/bin/sh\necho 'Chromium 152.0.7777.1 Arch Linux'\n", { mode: 0o755 });
  const run = () => JSON.parse(spawnSync("python3", [join(repo, "bin/agent-project-check"), W, "--json"], { encoding: "utf8", timeout: 120000,
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, OPENRIG_URL: "http://127.0.0.1:9" } }).stdout)
    .filter((r) => r.check.startsWith("Playwright MCP"));
  fs.writeFileSync(join(home, ".codex/config.toml"), `[mcp_servers.playwright]\ncommand = "npx"\nargs = ["-y", "@playwright/mcp@latest", "--headless", "--executable-path", "${chromium}"]\n`);
  fs.writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { playwright: { args: ["-y", `@playwright/mcp@${pin}`, "--headless", "--browser", "chromium"] } } }));
  const bad = run();
  assert.equal(bad.find((r) => r.check.includes("pinned")).level, "WARN");
  assert.match(bad.find((r) => r.check.includes("pinned")).detail, /~\/\.codex\/config\.toml \[playwright\]/);
  const old = bad.find((r) => r.check.includes("older system browser"));
  assert.equal(old.level, "WARN");
  assert.match(old.detail, /chromium-152 is 152, @playwright\/mcp@latest bundles Chrome for Testing 153/);
  fs.writeFileSync(join(home, ".codex/config.toml"), `[mcp_servers.playwright]\ncommand = "npx"\nargs = ["-y", "@playwright/mcp@${pin}", "--headless", "--browser", "chromium"]\n`);
  assert.deepEqual(run().map((r) => r.level), ["OK", "OK"]);
});

// QA round 2: the probe must use the PINNED release's playwright-core, whatever the caller's directory holds.
test("a playwright-core in the caller's directory can't stand in for the pinned one (absolute path, neutral cwd)", () => {
  fresh();
  const proj = join(root, "project"); fs.mkdirSync(join(proj, "node_modules/playwright-core"), { recursive: true });
  fs.writeFileSync(join(proj, "node_modules/playwright-core/index.js"), "module.exports = { chromium: { launch: async () => ({ close: async () => {} }) } };");
  fs.rmSync(calls, { force: true });
  const r = spawnSync(join(repo, "bin/playwright-browsers"), ["--check"], { cwd: proj, encoding: "utf8", env: { PATH: `${bin}:${nodeDir}:/usr/bin:/bin`, HOME: root, NODE_PATH: join(proj, "node_modules") } });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /which does not launch: headless shell: .*Executable doesn't exist/, "the shadow copy (which always launches) was not used");
});

test("a playwright tree that isn't from the pinned @playwright/mcp release is refused, never 'ready'", () => {
  fresh("0.0.83"); fs.writeFileSync(ready, "");   // a browser that would launch, but from the wrong release
  const r = ensure(["--check"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, new RegExp(`the playwright found is not from @playwright/mcp@${esc(pin)} \\(found 0\\.0\\.83 in `));
});
