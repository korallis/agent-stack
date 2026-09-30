// agent-login: after the OAuth login it labels the new credential through the management API. A label call that fails
// must fail loudly (exit 4, clear message; the credential is kept), and the management key never goes on curl's
// command line. A stub server stands in for CLIProxyAPI; a fake proxy binary "logs in" by writing a credential file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "agent-login-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const KEY = "mgmt-secret-DO-NOT-PRINT-91c2";
const secrets = join(root, "cliproxy.env"), bin = join(root, "bin"), argv = join(root, "curl-argv");
fs.writeFileSync(secrets, `CLIPROXY_CLIENT_KEY=client\nCLIPROXY_MGMT_KEY=${KEY}\n`);
fs.mkdirSync(bin);
// a fake proxy: "logs in" by writing one new credential file (unless FAKE_NO_NEW is set)
const proxyBin = join(root, "cli-proxy-api");
fs.writeFileSync(proxyBin, `#!/bin/bash\n[ -n "\${FAKE_NO_NEW:-}" ] && exit 0\nd=$(dirname "$2"); printf '{"type":"claude","email":"a@example.com","plan_type":"max"}' > "$d/claude-a@example.com-$RANDOM.json"\n`, { mode: 0o755 });
// record curl's argv, then run the real curl
fs.writeFileSync(join(bin, "curl"), `#!/bin/bash\nprintf '%s\\n' "$*" >> "${argv}"\nexec /usr/bin/curl "$@"\n`, { mode: 0o755 });

let answer = { code: 200, body: '{"status":"ok"}' }, requests = [];
const server = http.createServer((req, res) => {
  let body = ""; req.on("data", (d) => { body += d; });
  req.on("end", () => {
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    if (req.headers.authorization !== `Bearer ${KEY}`) { res.writeHead(401); return res.end('{"error":"unauthorized"}'); }
    res.writeHead(answer.code); res.end(answer.body);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const mgmt = `http://127.0.0.1:${server.address().port}/v8/management`;
test.after(() => server.close());

function login(env = {}) {
  requests = []; fs.rmSync(argv, { force: true });
  const dir = fs.mkdtempSync(join(root, "auth-"));
  return new Promise((resolve) => {
    const p = spawn(join(repo, "system/agent-login"), ["claude", "claude-a"], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root,
      AGENT_LOGIN_SECRETS: secrets, AGENT_LOGIN_MGMT: mgmt, AGENT_LOGIN_DIR: dir, AGENT_LOGIN_PROXY_BIN: proxyBin, ...env } });
    let out = "", err = ""; p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { err += d; });
    p.on("exit", (code) => resolve({ code, out, err, dir }));
  });
}

test("success: the new credential is labelled on the existing v8 credentials/fields route and summarised", async () => {
  answer = { code: 200, body: '{"status":"ok"}' };
  const r = await login();
  assert.equal(r.code, 0, r.err);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, "PATCH");
  assert.equal(requests[0].url, "/v8/management/credentials/fields");
  assert.match(JSON.parse(requests[0].body).name, /^claude-a@example\.com-\d+\.json$/);
  assert.equal(JSON.parse(requests[0].body).note, "claude-a");
  assert.match(r.out, /^OK label=claude-a type=claude email=a@example\.com plan=max file=claude-a@example\.com-\d+\.json$/m);
});

test("a refused label (404 auth file not found, 500) fails loudly with exit 4 and keeps the credential", async () => {
  for (const a of [{ code: 404, body: '{"error":"auth file not found"}' }, { code: 500, body: '{"error":"boom"}' }]) {
    answer = a;
    const r = await login();
    assert.equal(r.code, 4, `${a.code}: ${r.err}`);
    assert.match(r.err, new RegExp(`!! Could not label claude-a@example\\.com-\\d+\\.json as 'claude-a' \\(HTTP ${a.code}: .*${JSON.parse(a.body).error}.*\\)\\. The credential itself is saved and in use\\.`));
    assert.match(r.err, /Label it later: .*credentials\/fields with \{"name":"claude-a@example\.com-\d+\.json","note":"claude-a"\}/);
    assert.doesNotMatch(r.out, /^OK /m);
    assert.equal(fs.readdirSync(r.dir).filter((f) => f.endsWith(".json")).length, 1, "the credential is kept");
  }
});

test("an unreachable management API also fails loudly (HTTP 000), exit 4", async () => {
  const r = await login({ AGENT_LOGIN_MGMT: "http://127.0.0.1:9/v8/management" });
  assert.equal(r.code, 4, r.err);
  assert.match(r.err, /!! Could not label .* \(HTTP 000: .*\)\. The credential itself is saved and in use\./);
});

test("the management key is sent as the header but never on curl's command line or in any output", async () => {
  answer = { code: 500, body: '{"error":"boom"}' };
  const r = await login();
  assert.equal(requests[0].auth, `Bearer ${KEY}`);
  assert.ok(!fs.readFileSync(argv, "utf8").includes(KEY), "not in argv");
  assert.ok(!r.out.includes(KEY) && !r.err.includes(KEY), "not in output");
});

test("no new credential file is still exit 3, with no label call", async () => {
  const r = await login({ FAKE_NO_NEW: "1" });
  assert.equal(r.code, 3);
  assert.equal(requests.length, 0);
});
