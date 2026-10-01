// WO57: the credential guard keeps Playwright MCP network/console listings out of transcripts. browser_network_requests,
// browser_network_request and browser_console_messages are allowed only with `filename` in the seat's protected
// scratch dir; agent-net-summary prints method, host, path and status. Control checks only: a throwaway HOME, the real
// hook process in both runtime formats, synthetic log files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const hookFile = join(repo, "system/credguard-read-hook"), g = require(hookFile), inst = require(join(repo, "system/credguard-read-install"));
const root = fs.mkdtempSync(join(os.tmpdir(), "netguard-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const SEAT = "qa-one@shop";

// The real hook, as each runtime calls it: Claude denies with JSON on stdout, Codex with exit 2 and stderr.
function hook(runtime, home, tool_name, tool_input, seat = SEAT) {
  const r = spawnSync(process.execPath, [hookFile, "--runtime", runtime], { encoding: "utf8",
    input: JSON.stringify({ tool_name, tool_input, cwd: join(home, "work") }),
    env: { PATH: process.env.PATH, HOME: home, AGENT_CREDGUARD_READ_PATHS: join(home, "none"), ...(seat ? { OPENRIG_SESSION_NAME: seat } : {}) } });
  if (runtime === "codex") return { deny: r.status === 2, reason: r.stderr, status: r.status };
  const out = r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
  return { deny: out?.permissionDecision === "deny", reason: out?.permissionDecisionReason || "", status: r.status };
}
const newHome = () => { const h = fs.mkdtempSync(join(root, "h-")); fs.mkdirSync(join(h, "work")); return h; };
const seatDir = (h, seat = SEAT) => join(h, ".local/state/agent-stack/playwright-mcp/net", seat);
const TOOLS = ["browser_network_requests", "browser_network_request", "browser_console_messages"];

test("WO57: without a filename (or with one outside the seat's scratch dir) each tool is refused in both runtimes, with how to do it", () => {
  const h = newHome(), dir = seatDir(h);
  for (const runtime of ["claude", "codex"]) for (const t of TOOLS) {
    const name = `mcp__playwright__${t}`;
    for (const input of [{}, { filter: "auth", static: true }, { index: 1, part: "request-headers" }, { level: "debug", all: true },
      { filename: "net.log" }, { filename: join(h, "work/net.log") }, { filename: join(h, "elsewhere/x.log") },
      { filename: `${dir}/../other-seat/x.log` }, { filename: join(seatDir(h, "someone-else@shop"), "x.log") }, { filename: dir }, { filename: 42 }]) {
      const r = hook(runtime, h, name, input);
      assert.equal(r.deny, true, `${runtime} ${t} ${JSON.stringify(input)}`);
      assert.match(r.reason, new RegExp(`blocked ${t}`));
      assert.match(r.reason, /filename: ".*\/playwright-mcp\/net\/qa-one@shop\//);
      assert.match(r.reason, /agent-net-summary ~\/\.local\/state\/agent-stack\/playwright-mcp\/net\/qa-one@shop\//);
    }
  }
});

test("WO57: with a filename in the seat's scratch dir each tool is allowed in both runtimes; the dir is made 0700", () => {
  const h = newHome(), dir = seatDir(h);
  for (const runtime of ["claude", "codex"]) for (const t of TOOLS) {
    const r = hook(runtime, h, `mcp__playwright__${t}`, { filename: join(dir, `${t}.log`), static: true });
    assert.equal(r.deny, false, `${runtime} ${t}: ${r.reason}`); assert.equal(r.status, 0);
  }
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700); assert.equal(fs.statSync(dirname(dir)).mode & 0o777, 0o700);
  assert.equal(hook("codex", h, "mcp__playwright__browser_console_messages", { filename: join(dir, "sub/c.log") }).deny, false, "a subdir of it");
  // no OPENRIG_SESSION_NAME: the "local" dir
  assert.equal(hook("claude", h, "mcp__playwright__browser_network_requests", { filename: join(seatDir(h, "local"), "n.log") }, null).deny, false);
  // any MCP server name exposing these tools; other Playwright tools are untouched
  assert.equal(hook("claude", h, "mcp__pw2__browser_network_requests", {}).deny, true);
  for (const other of ["mcp__playwright__browser_snapshot", "mcp__playwright__browser_navigate", "mcp__playwright__browser_take_screenshot"])
    assert.equal(hook("claude", h, other, {}).deny, false, other);
});

test("WO57: a symlink anywhere from the MCP output dir down is refused (the write would land elsewhere)", () => {
  const h = newHome(), dir = seatDir(h), out = dirname(dirname(dir));
  fs.mkdirSync(join(h, "outside"), { recursive: true });
  fs.mkdirSync(dirname(dir), { recursive: true }); fs.symlinkSync(join(h, "outside"), dir);
  let r = hook("codex", h, "mcp__playwright__browser_network_requests", { filename: join(dir, "n.log") });
  assert.equal(r.deny, true); assert.match(r.reason, /is a symlink/);
  fs.unlinkSync(dir); fs.mkdirSync(dir); fs.symlinkSync(join(h, "outside/f.log"), join(dir, "n.log"));
  assert.equal(hook("claude", h, "mcp__playwright__browser_network_requests", { filename: join(dir, "n.log") }).deny, true, "the file itself");
  fs.rmSync(out, { recursive: true }); fs.mkdirSync(dirname(out), { recursive: true }); fs.symlinkSync(join(h, "outside"), out);
  assert.equal(hook("claude", h, "mcp__playwright__browser_network_requests", { filename: join(dir, "n.log") }).deny, true, "the output dir");
});

test("WO57: the scratch dir is protected like a credential file; agent-net-summary may read it", () => {
  const h = newHome(), f = join(seatDir(h), "n.log"), work = join(h, "work");
  fs.mkdirSync(seatDir(h), { recursive: true }); fs.writeFileSync(f, "1. [GET] https://a.test/x?token=SYNTHETIC => [200] OK\n");
  const dec = (tool_name, tool_input) => g.decide({ tool_name, tool_input, cwd: work }, { home: h, pats: g.DEFAULT_PATTERNS }).deny;
  for (const c of [`cat ${f}`, `head -5 ${f}`, `grep token ${f}`, `cat ~/.local/state/agent-stack/playwright-mcp/net/*/n.log`, `cp ${f} copy.log; cat copy.log`])
    assert.equal(dec("Bash", { command: c }), true, c);
  assert.equal(dec("Read", { file_path: f }), true);
  assert.equal(dec("Grep", { path: seatDir(h), pattern: "token", output_mode: "content" }), true);
  for (const c of [`agent-net-summary ${f}`, "agent-net-summary ~/.local/state/agent-stack/playwright-mcp/net/qa-one@shop/n.log", `ls ${seatDir(h)}`])
    assert.equal(dec("Bash", { command: c }), false, c);
});

test("WO57: the hook matcher names exactly these tools; the installer registers it for both runtimes", () => {
  const re = new RegExp(inst.NET_MATCHER);
  for (const t of TOOLS) { assert.ok(re.test(`mcp__playwright__${t}`), t); assert.ok(g.NET_TOOL.test(`mcp__playwright__${t}`), t); }
  for (const t of ["mcp__playwright__browser_snapshot", "mcp__playwright__browser_network_requestsX", "browser_network_requests", "Bash"])
    { assert.ok(!re.test(t), t); assert.ok(!g.NET_TOOL.test(t), t); }
  const s = inst.withClaudeHook({}, "/opt/hook");
  assert.deepEqual(s.hooks.PreToolUse.map((x) => x.matcher), ["Bash|Read|Grep", inst.NET_MATCHER]);
  assert.ok(inst.claudeHasHook(s, "/opt/hook"));
  assert.ok(!inst.claudeHasHook({ hooks: { PreToolUse: [s.hooks.PreToolUse[0]] } }, "/opt/hook"), "an install without the net entry is outdated");
  const toml = inst.withCodexBlock("[features]\nhooks = true\n", "/opt/hook", "/c", (t) => inst.parseToml(t));
  assert.match(toml, new RegExp(`matcher = ${JSON.stringify(inst.NET_MATCHER).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("agent-net-summary: method, host, path and status only; query, fragment, userinfo, params and token-like segments go", () => {
  const f = join(root, "list.log");
  fs.writeFileSync(f, [
    "1. [GET] https://app.example.test/dashboard?tab=1 => [200] OK",
    "2. [POST] https://u:p@auth.example.test/v1/client/sessions/sess_2abcDEF345ghiJKL678mno/touch?__session_param=SYNTHETICVALUE1 => [200] OK",
    "3. [GET] https://api.example.test/files/eyJhbGciOiJIUzI1NiJ9.e30.sig/download#frag => [FAILED] net::ERR_ABORTED",
    "4. [GET] data:image/png;base64,iVBORw0KGgoAAAANSUhEUg => [200] OK",
    "5. [GET] https://cdn.example.test/a/0123456789abcdef0123/x.js;jsessionid=SYNTHETICVALUE2 => [304] Not Modified",
    "", "Note: 3 static requests not shown, run with \"static\" option to see them.", ""].join("\n"));
  let r = spawnSync(join(repo, "bin/agent-net-summary"), [f], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, ["1. GET app.example.test/dashboard => 200", "2. POST auth.example.test/v1/client/sessions/<masked>/touch => 200",
    "3. GET api.example.test/files/<masked>/download => FAILED", "4. GET data:image/png => 200", "5. GET cdn.example.test/a/<masked>/x.js => 304",
    "(1 other line not shown: headers, bodies or console text)", ""].join("\n"));
  assert.doesNotMatch(r.stdout, /SYNTHETIC|u:p@|tab=1|frag|base64/);
  fs.writeFileSync(f, "#7 [GET] https://api.example.test/v1/me?token=SYNTHETICVALUE3\n\n  General\n    status:    [401] Unauthorized\n  Request headers\n    authorization: Bearer SYNTHETICVALUE4\n");
  r = spawnSync(join(repo, "bin/agent-net-summary"), [f], { encoding: "utf8" });
  assert.equal(r.stdout, "1. GET api.example.test/v1/me => 401\n(3 other lines not shown: headers, bodies or console text)\n");
  fs.writeFileSync(f, "Total messages: 3 (Errors: 1, Warnings: 0)\n\n[ERROR] failed https://x.test/?token=SYNTHETICVALUE5 @ https://x.test/app.js:1\n[LOG] hello SYNTHETICVALUE6\n");
  r = spawnSync(join(repo, "bin/agent-net-summary"), [f], { encoding: "utf8" });
  assert.equal(r.stdout, "Total messages: 3 (Errors: 1, Warnings: 0)\n(2 other lines not shown: headers, bodies or console text)\n");
  r = spawnSync(join(repo, "bin/agent-net-summary"), [join(root, "missing.log")], { encoding: "utf8" });
  assert.equal(r.status, 1); assert.match(r.stderr, /No such file/); assert.equal(r.stdout, "");
});

