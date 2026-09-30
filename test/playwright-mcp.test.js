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

// playwright-browsers with a stub npx: the dry run names two install locations; FAKE_PRESENT decides whether they exist.
const bin = join(root, "bin"), calls = join(root, "calls"), cache = join(root, "cache");
fs.mkdirSync(bin);
fs.writeFileSync(join(bin, "npx"), `#!/bin/bash
printf '%s\\n' "npx $*" >> "${calls}"
if [[ "$*" == *"--dry-run"* ]]; then
  echo "Chrome for Testing 153.0.8010.12 (playwright chromium v1243)"; echo "  Install location:    ${cache}/chromium-1243"
  echo "Chrome Headless Shell 153.0.8010.12 (playwright chromium-headless-shell v1243)"; echo "  Install location:    ${cache}/chromium_headless_shell-1243"
else mkdir -p "${cache}/chromium-1243" "${cache}/chromium_headless_shell-1243"; fi
`, { mode: 0o755 });
fs.writeFileSync(join(bin, "logger"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
const ensure = (...args) => { fs.rmSync(calls, { force: true });
  const r = spawnSync(join(repo, "bin/playwright-browsers"), args, { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root } });
  return { ...r, c: fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "" }; };

test("playwright-browsers: asks the PINNED release's own Playwright; --check reports a missing build; install only when missing", () => {
  fs.rmSync(cache, { recursive: true, force: true });
  const check = ensure("--check");
  assert.equal(check.status, 1);
  assert.match(check.stdout, new RegExp(`@playwright/mcp@${pin.replace(/\./g, "\\.")} needs Chrome for Testing 153\\.0\\.8010\\.12 \\(playwright chromium v1243\\); missing: `));
  assert.doesNotMatch(check.c, /install chromium$/m, "--check installs nothing");
  const inst = ensure();
  assert.equal(inst.status, 0, inst.stderr);
  assert.match(inst.c, new RegExp(`^npx -y -p @playwright/mcp@${pin.replace(/\./g, "\\.")} playwright install chromium$`, "m"));
  assert.doesNotMatch(inst.c, /playwright@latest/);
  const again = ensure();
  assert.equal(again.status, 0);
  assert.match(again.stdout, /browser present: Chrome for Testing 153\.0\.8010\.12/);
  assert.doesNotMatch(again.c, /install chromium$/m, "no reinstall when present");
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
