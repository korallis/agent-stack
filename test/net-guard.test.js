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
const KIND = { browser_network_requests: "requests", browser_network_request: "request", browser_console_messages: "console" };

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
    const r = hook(runtime, h, `mcp__playwright__${t}`, { filename: join(dir, `${KIND[t]}-1.log`), static: true });
    assert.equal(r.deny, false, `${runtime} ${t}: ${r.reason}`); assert.equal(r.status, 0);
  }
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700); assert.equal(fs.statSync(dirname(dir)).mode & 0o777, 0o700);
  assert.equal(hook("codex", h, "mcp__playwright__browser_console_messages", { filename: join(dir, "sub/console-c.log") }).deny, false, "a subdir of it");
  // no OPENRIG_SESSION_NAME: the "local" dir
  assert.equal(hook("claude", h, "mcp__playwright__browser_network_requests", { filename: join(seatDir(h, "local"), "requests-n.log") }, null).deny, false);
  // any MCP server name exposing these tools; other Playwright tools are untouched
  assert.equal(hook("claude", h, "mcp__pw2__browser_network_requests", {}).deny, true);
  for (const other of ["mcp__playwright__browser_snapshot", "mcp__playwright__browser_navigate", "mcp__playwright__browser_take_screenshot"])
    assert.equal(hook("claude", h, other, {}).deny, false, other);
});

test("WO57: a symlink anywhere from the MCP output dir down is refused (the write would land elsewhere)", () => {
  const h = newHome(), dir = seatDir(h), out = dirname(dirname(dir));
  fs.mkdirSync(join(h, "outside"), { recursive: true });
  fs.mkdirSync(dirname(dir), { recursive: true }); fs.symlinkSync(join(h, "outside"), dir);
  let r = hook("codex", h, "mcp__playwright__browser_network_requests", { filename: join(dir, "requests-n.log") });
  assert.equal(r.deny, true); assert.match(r.reason, /is a symlink/);
  fs.unlinkSync(dir); fs.mkdirSync(dir); fs.symlinkSync(join(h, "outside/f.log"), join(dir, "requests-n.log"));
  assert.equal(hook("claude", h, "mcp__playwright__browser_network_requests", { filename: join(dir, "requests-n.log") }).deny, true, "the file itself");
  fs.rmSync(out, { recursive: true }); fs.mkdirSync(dirname(out), { recursive: true }); fs.symlinkSync(join(h, "outside"), out);
  assert.equal(hook("claude", h, "mcp__playwright__browser_network_requests", { filename: join(dir, "requests-n.log") }).deny, true, "the output dir");
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
  const f = join(root, "requests-list.log"), d = join(root, "request-7.log"), c = join(root, "console-1.log");
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
    ""].join("\n"), "the static-requests note is the list's own line: neither shown nor counted as hidden");
  assert.doesNotMatch(r.stdout, /SYNTHETIC|u:p@|tab=1|frag|base64/);
  fs.writeFileSync(d, "#7 [GET] https://api.example.test/v1/me?token=SYNTHETICVALUE3\n\n  General\n    status:    [401] Unauthorized\n  Request headers\n    authorization: Bearer SYNTHETICVALUE4\n");
  r = spawnSync(join(repo, "bin/agent-net-summary"), [d], { encoding: "utf8" });
  assert.equal(r.stdout, "1. GET api.example.test/v1/me => 401\n(3 other lines not shown: headers, bodies or console text)\n");
  fs.writeFileSync(c, "Total messages: 3 (Errors: 1, Warnings: 0)\n\n[ERROR] failed https://x.test/?token=SYNTHETICVALUE5 @ https://x.test/app.js:1\n[LOG] hello SYNTHETICVALUE6\n");
  r = spawnSync(join(repo, "bin/agent-net-summary"), [c], { encoding: "utf8" });
  assert.equal(r.stdout, "Total messages: 3 (Errors: 1, Warnings: 0)\n(2 other lines not shown: headers, bodies or console text)\n");
  r = spawnSync(join(repo, "bin/agent-net-summary"), [join(root, "missing.log")], { encoding: "utf8" });
  assert.equal(r.status, 1); assert.match(r.stderr, /No such file/); assert.equal(r.stdout, "");
});


// QA PR62 (dcd47021): the summary reads only the file kind's own record lines; text shaped like a request inside a
// console message, a header or a body is never printed.
test("QA PR62 f1: request-shaped console, header and body text is counted, never summarised", () => {
  let f;
  const sum = () => spawnSync(join(repo, "bin/agent-net-summary"), [f], { encoding: "utf8" }).stdout;
  f = join(root, "console-shaped.log");
  fs.writeFileSync(f, "Total messages: 2 (Errors: 0, Warnings: 0)\n\n[LOG] 1. [GET] https://x.test/SYNTHETIC_CONSOLE_PATH => [200] OK\n[LOG] #2 [GET] https://x.test/SYNTHETIC_CONSOLE_PATH2\n");
  assert.equal(sum(), "Total messages: 2 (Errors: 0, Warnings: 0)\n(2 other lines not shown: headers, bodies or console text)\n");
  f = join(root, "request-shaped.log");
  fs.writeFileSync(f, "#4 [GET] https://api.example.test/v1/me\n\n  General\n    status:    [200] OK\n  Request headers\n    x-note: 1. [GET] https://x.test/SYNTHETIC_HEADER_PATH => [200] OK\n    status:    [500] SYNTHETIC\n  Response body\n#5 [POST] https://x.test/SYNTHETIC_BODY_PATH\n");
  assert.equal(sum(), "1. GET api.example.test/v1/me => 200\n(6 other lines not shown: headers, bodies or console text)\n");
  // a part file holds a raw header or body, written as is: whatever it looks like, only its lines are counted
  f = join(root, "part-body.log");
  for (const raw of ["1. [GET] https://x.test/SYNTHETIC_PART_PATH => [200] OK\n", "#1 [GET] https://x.test/SYNTHETIC_PART_PATH\n    status: [200] OK\n",
    "Total messages: 1 (Errors: 0, Warnings: 0)\n"]) {
    fs.writeFileSync(f, raw);
    assert.equal(sum(), `(${raw.trim().split("\n").length} other line${raw.trim().includes("\n") ? "s" : ""} not shown: headers, bodies or console text)\n`, raw);
  }
  f = join(root, "raw-request-body.log"); fs.writeFileSync(f, "1. [GET] https://x.test/SYNTHETIC_BODY_PATH => [200] OK\n");
  assert.equal(sum(), "(1 other line not shown: headers, bodies or console text)\n", "a name of no known kind: counted");
  f = join(root, "requests-seq.log");
  // in a list, a line that isn't the next numbered record isn't one
  fs.writeFileSync(f, "1. [GET] https://a.test/one => [200] OK\n1. [GET] https://x.test/SYNTHETIC_DUP_PATH => [200] OK\n  2. [GET] https://x.test/SYNTHETIC_INDENT_PATH => [200] OK\n3. [GET] https://a.test/three => [204] No Content\n");
  assert.equal(sum(), "1. GET a.test/one => 200\n2. GET a.test/three => 204\n(2 other lines not shown: headers, bodies or console text)\n");
  assert.doesNotMatch(fs.readFileSync(f, "utf8") && sum(), /SYNTHETIC/);
});

test("QA PR62 f3: each call must name its file by what it writes; a wrong prefix is refused", () => {
  const h = newHome(), dir = seatDir(h);
  const call = (tool, input) => hook("codex", h, `mcp__playwright__${tool}`, input);
  assert.equal(call("browser_network_requests", { filename: join(dir, "requests-a.log") }).deny, false);
  assert.equal(call("browser_network_request", { index: 1, filename: join(dir, "request-a.log") }).deny, false);
  assert.equal(call("browser_network_request", { index: 1, part: "response-body", filename: join(dir, "part-a.log") }).deny, false);
  assert.equal(call("browser_console_messages", { filename: join(dir, "console-a.log") }).deny, false);
  for (const [tool, input, want] of [["browser_network_requests", { filename: join(dir, "request-a.log") }, "requests-"],
    ["browser_network_request", { index: 1, part: "response-body", filename: join(dir, "requests-a.log") }, "part-"],
    ["browser_network_request", { index: 1, part: "request-headers", filename: join(dir, "request-a.log") }, "part-"],
    ["browser_network_request", { index: 1, filename: join(dir, "part-a.log") }, "request-"],
    ["browser_console_messages", { filename: join(dir, "requests-a.log") }, "console-"],
    ["browser_console_messages", { filename: join(dir, "a.log") }, "console-"]]) {
    const r = call(tool, input);
    assert.equal(r.deny, true, `${tool} ${input.filename}`); assert.match(r.reason, new RegExp(`must start with "${want}"`));
    assert.match(r.reason, new RegExp(`${want}1\\.log`), "the example name has the right prefix");
  }
});

test("QA PR62 f2: template names are exempt outside the scratch tree, never inside it", () => {
  const h = newHome(), work = join(h, "work"), dir = seatDir(h);
  fs.mkdirSync(dir, { recursive: true });
  const dec = (tool_name, tool_input) => g.decide({ tool_name, tool_input, cwd: work }, { home: h, pats: g.DEFAULT_PATTERNS }).deny;
  for (const n of [".env.example", ".env.sample", ".env.template", "report.log"]) {
    fs.writeFileSync(join(dir, n), "x\n"); fs.writeFileSync(join(work, n), "x\n");
    assert.equal(dec("Read", { file_path: join(dir, n) }), true, `inside: Read ${n}`);
    assert.equal(dec("Bash", { command: `cat ${join(dir, n)}` }), true, `inside: cat ${n}`);
    // (the MCP can't be told to write these names at all now: they don't start with a kind)
    for (const runtime of ["claude", "codex"]) assert.equal(hook(runtime, h, "mcp__playwright__browser_network_requests", { filename: join(dir, n) }).deny, true, `${runtime} ${n}`);
  }
  for (const c of [`cat ${dir}/*`, `cat ${dir}/.*`, `cat ${dir}/.env.*`]) assert.equal(dec("Bash", { command: c }), true, `inside: ${c}`);
  for (const n of [".env.example", ".env.sample", ".env.template"]) {
    assert.equal(dec("Read", { file_path: join(work, n) }), false, `outside: Read ${n} (a template)`);
    assert.equal(dec("Bash", { command: `cat ${n}` }), false, `outside: cat ${n}`);
  }
});
