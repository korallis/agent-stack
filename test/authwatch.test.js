// cliproxy-authwatch: refreshes a CLIProxyAPI credential left "token expired" / unavailable (WO15 item 2), with backoff
// (max 4/hour per credential), alerting only when the refresh itself fails; never prints the management key. Also the
// existing routing-log 401/403 alert. A stub management server stands in for CLIProxyAPI; logger/notify-send are faked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "authwatch-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const KEY = "mgmt-secret-DO-NOT-PRINT-7f3a";
const bin = join(root, "bin"), calls = join(root, "calls"), secrets = join(root, "cliproxy.env");
fs.mkdirSync(bin);
fs.writeFileSync(secrets, `CLIPROXY_CLIENT_KEY=client\nCLIPROXY_MGMT_KEY=${KEY}\n`);
for (const s of ["logger", "notify-send"]) fs.writeFileSync(join(bin, s), `#!/bin/sh\necho "${s} $*" >> "${calls}"\n`, { mode: 0o755 });

// The stub: GET /v0/management/auth-files lists `files`; POST .../refresh answers `refreshStatus` and records requests.
let files = [], refreshStatus = 200, requests = [];
const server = http.createServer((req, res) => {
  let body = ""; req.on("data", (d) => { body += d; });
  req.on("end", () => {
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    if (req.headers.authorization !== `Bearer ${KEY}`) { res.writeHead(401); return res.end('{"error":"unauthorized"}'); }
    if (req.method === "GET" && req.url === "/v0/management/auth-files") { res.writeHead(200); return res.end(JSON.stringify({ files })); }
    if (req.method === "POST" && req.url === "/v0/management/auth-files/refresh") {
      res.writeHead(refreshStatus); return res.end(refreshStatus === 200 ? '{"status":"ok"}' : '{"error":"upstream 521"}');
    }
    res.writeHead(404); res.end("{}");
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/v0/management`;
test.after(() => server.close());

function watch(env = {}) {
  fs.rmSync(calls, { force: true }); requests = [];
  return new Promise((resolve) => {
    const p = spawn(join(repo, "system/cliproxy-authwatch"), [], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root,
      AUTHWATCH_STATE: join(root, "state"), AUTHWATCH_MGMT_URL: url, AUTHWATCH_SECRETS: secrets, AUTHWATCH_LOG: join(root, "none.jsonl"),
      ...(process.env.TZ ? { TZ: process.env.TZ } : {}), ...env } });   // the routing log's local time must be the test's
    let out = ""; p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { out += d; });
    p.on("exit", (code) => resolve({ code, out, c: fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "" }));
  });
}
const refreshes = () => requests.filter((r) => r.url.endsWith("/refresh"));
const expired = { name: "kimi-ai.json", provider: "kimi", status: "error", status_message: "token expired", unavailable: true, disabled: false };
const reset = () => fs.rmSync(join(root, "state"), { recursive: true, force: true });

test("an expired credential gets one refresh request, is logged, and nothing is alerted", async () => {
  reset(); files = [expired, { name: "claude-a.json", provider: "claude", status: "active", status_message: "", unavailable: false }];
  refreshStatus = 200;
  const r = await watch();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(refreshes().map((q) => JSON.parse(q.body)), [{ name: "kimi-ai.json" }], "only the expired one");
  assert.match(r.c, /^logger -t cliproxy-authwatch kimi credential kimi-ai\.json was 'token expired'; refresh requested \(attempt 1 this hour, HTTP 200\)$/m);
  assert.doesNotMatch(r.c, /notify-send/);
});

test("unavailable after a failed refresh also qualifies; disabled or healthy credentials never do", async () => {
  reset(); files = [
    { name: "a.json", provider: "codex", status: "active", status_message: "refresh failed: 521", unavailable: true },
    { name: "b.json", provider: "codex", status: "error", status_message: "token expired", disabled: true },
    { name: "c.json", provider: "codex", status: "error", status_message: "quota exceeded", unavailable: true },
    { name: "d.json", provider: "codex", status: "active", status_message: "", unavailable: false },
  ];
  await watch();
  assert.deepEqual(refreshes().map((q) => JSON.parse(q.body).name), ["a.json"]);
});

test("backoff: attempts 5, 10 and 20 min apart, at most 4 per hour per credential", async () => {
  reset(); files = [expired]; refreshStatus = 200;
  const log = join(root, "state", "refresh-kimi-ai.json");
  const now = Math.floor(Date.now() / 1000);
  const withHistory = async (agos) => { fs.mkdirSync(join(root, "state"), { recursive: true }); fs.writeFileSync(log, agos.map((a) => `${now - a}\n`).join("")); return (await watch(), refreshes().length); };
  assert.equal(await withHistory([240]), 0, "1 attempt 4 min ago: wait for 5 min");
  assert.equal(await withHistory([360]), 1, "1 attempt 6 min ago: go");
  assert.equal(await withHistory([900, 540]), 0, "2 attempts, last 9 min ago: wait for 10 min");
  assert.equal(await withHistory([1500, 1200, 1100]), 0, "3 attempts, last ~18 min ago: wait for 20 min");
  assert.equal(await withHistory([3000, 2400, 1800, 400]), 0, "4 attempts in the hour: stop");
  const capped = await watch();
  assert.match(capped.c, /4 refresh attempts in the last hour, waiting \(max 4\/hour\)/);
  assert.equal(await withHistory([4000, 3700, 3650, 3620]), 1, "older attempts age out");
  assert.equal(fs.readFileSync(log, "utf8").trim().split("\n").length, 1, "the history keeps only the last hour, plus this attempt");
});

test("a failed refresh is logged and alerted with the reason; a refused connection too", async () => {
  reset(); files = [expired]; refreshStatus = 502;
  const r = await watch();
  assert.equal(r.code, 0);
  assert.match(r.c, /^notify-send --urgency=critical --app-name=Agent stack Proxy credential refresh failed kimi credential kimi-ai\.json is 'token expired' and the refresh failed \(HTTP 502: \{"error":"upstream 521"\}; attempt 1 this hour\)\. Log in again if it keeps failing: agent-login kimi\.$/m);
  assert.match(r.c, /^logger -t cliproxy-authwatch kimi credential kimi-ai\.json is 'token expired' and the refresh failed/m);
});

test("the management key is sent only as the Authorization header, never on the command line or in any output", async () => {
  reset(); files = [expired]; refreshStatus = 502;
  // capture every curl argv while the script runs
  const argv = join(root, "argv");
  fs.writeFileSync(join(bin, "curl"), `#!/bin/bash\nprintf '%s\\n' "$*" >> "${argv}"\nexec /usr/bin/curl "$@"\n`, { mode: 0o755 });
  try {
    const r = await watch();
    assert.ok(requests.length >= 2 && requests.every((q) => q.auth === `Bearer ${KEY}`), "authenticated with the key");
    assert.ok(!fs.readFileSync(argv, "utf8").includes(KEY), "not in curl's argv");
    assert.ok(!r.out.includes(KEY) && !r.c.includes(KEY), "not in output, logs or alerts");
  } finally { fs.rmSync(join(bin, "curl")); fs.rmSync(argv, { force: true }); }
});

test("no key, or the management API unreachable: no refresh, no error; the routing-log check still runs", async () => {
  reset(); files = [expired];
  const noKey = join(root, "empty.env"); fs.writeFileSync(noKey, "CLIPROXY_CLIENT_KEY=x\n");
  const ts = new Date(Date.now() - 60000); const local = new Date(ts.getTime() - ts.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
  const routing = join(root, "routing.jsonl");
  fs.writeFileSync(routing, [1, 2, 3].map(() => JSON.stringify({ ts: local, account: "acct-1", provider: "claude", status: 401 })).join("\n") + "\n");
  const a = await watch({ AUTHWATCH_SECRETS: noKey, AUTHWATCH_LOG: routing });
  assert.equal(a.code, 0, a.out);
  assert.equal(requests.length, 0);
  assert.match(a.c, /notify-send .*Proxy account failing auth claude account 'acct-1': 3 auth failures \(last HTTP 401\)/);
  reset();
  const b = await watch({ AUTHWATCH_MGMT_URL: "http://127.0.0.1:9/v0/management" });
  assert.equal(b.code, 0, b.out);
  assert.doesNotMatch(b.c, /refresh/);
});

test("the proxy is never restarted", () => {
  const code = fs.readFileSync(join(repo, "system/cliproxy-authwatch"), "utf8").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
  assert.doesNotMatch(code, /systemctl|restart|kill/);
});

// QA round 1 (PR #17): a newline inside a field must never become another credential row.
test("multiline status_message or name: exactly one refresh per credential, with its exact name; logs stay one line", async () => {
  reset(); refreshStatus = 200;
  files = [
    { name: "a.json", provider: "kimi", status: "error", status_message: "token expired\nupstream refresh failed", unavailable: true },
    { name: "odd\nb.json", provider: "codex", status: "error", status_message: "token expired", unavailable: false },
  ];
  const r = await watch();
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(refreshes().map((q) => JSON.parse(q.body).name).sort(), ["a.json", "odd\nb.json"], "no row made from message text");
  assert.match(r.c, /^logger -t cliproxy-authwatch kimi credential a\.json was 'token expired upstream refresh failed'; refresh requested/m);
});
