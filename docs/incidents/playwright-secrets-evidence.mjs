// WO24 evidence: a real stdio session with the pinned @playwright/mcp@0.0.80 (--headless --browser chromium), with and
// without --secrets, in a throwaway HOME, against a local page with a password field. Prints what the agent SENDS and
// what the MCP RETURNS.
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "wo24-home-"));
const secrets = path.join(home, "playwright.env");
fs.writeFileSync(secrets, "# test logins, typed by NAME\nWITNESS_PASSWORD=S3cretXYZ\n", { mode: 0o600 });
const page = `<!doctype html><title>login</title><form><label>Email <input name=email></label>
<label>Password <input type=password name=password aria-label="Password"></label></form>`;
const server = http.createServer((q, r) => { r.writeHead(200, { "content-type": "text/html" }); r.end(page); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

async function session(label, extra) {
  const env = { ...process.env, HOME: home, PLAYWRIGHT_BROWSERS_PATH: path.join(os.homedir(), ".cache/ms-playwright"), npm_config_cache: path.join(os.homedir(), ".npm") };
  const p = spawn("npx", ["-y", "@playwright/mcp@0.0.80", "--headless", "--browser", "chromium", "--isolated", ...extra], { env, stdio: ["pipe", "pipe", "inherit"] });
  let buf = "", id = 0; const waiting = new Map();
  p.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(line); waiting.get(m.id)?.(m); } catch {} } });
  const call = (method, params) => new Promise((res) => { const n = ++id; waiting.set(n, res); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
  await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "wo24", version: "1" } });
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const text = (r) => (r.result?.content || []).map((c) => c.text || "").join("\n");
  await call("tools/call", { name: "browser_navigate", arguments: { url } });
  const snap = text(await call("tools/call", { name: "browser_snapshot", arguments: {} }));
  const ref = snap.match(/textbox "Password" \[ref=(e\d+)\]/)[1];
  const sent = { element: "Password", target: ref, text: extra.length ? "WITNESS_PASSWORD" : "S3cretXYZ" };
  const typedRaw = await call("tools/call", { name: "browser_type", arguments: sent }); const typed = text(typedRaw);

  const after = text(await call("tools/call", { name: "browser_snapshot", arguments: {} }));
  const value = text(await call("tools/call", { name: "browser_evaluate", arguments: { function: "() => document.querySelector('input[type=password]').value.length" } }));
  p.kill();
  const show = (t) => t.split("\n").filter((l) => /Password|secret|S3cret|WITNESS|fill\(|type\(/.test(l)).slice(0, 6).join("\n    ");
  console.log(`\n=== ${label}\n  agent SENDS browser_type: ${JSON.stringify(sent)}\n  browser_type RETURNS:\n    ${show(typed)}\n  next browser_snapshot RETURNS:\n    ${show(after)}\n  page's password length (browser_evaluate): ${value.match(/\d+/)?.[0]}\n  literal value "S3cretXYZ" appears in ANY response: ${[typed, after, value].some((t) => t.includes("S3cretXYZ"))}`);
}
await session("WITHOUT --secrets (today)", []);
await session(`WITH --secrets ${secrets}`, ["--secrets", secrets]);
server.close(); fs.rmSync(home, { recursive: true, force: true });
