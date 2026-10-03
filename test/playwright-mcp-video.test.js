// Witness videos: the pinned @playwright/mcp offers browser_start_video / browser_stop_video only with --caps=devtools,
// which agent-playwright-mcp adds for every seat. The real pinned MCP, launched through the launcher (as both runtimes
// do), must list them. npx fetches the package once (the npm cache is reused); skipped only when it can't be fetched.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(join(os.tmpdir(), "pwvideo-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test("the launched MCP lists browser_start_video and browser_stop_video", { timeout: 180000 }, async (t) => {
  const pin = fs.readFileSync(join(repo, "system/codex/config.toml"), "utf8").match(/@playwright\/mcp@([\d.]+)/)[1];
  const p = spawn(join(repo, "bin/agent-playwright-mcp"), ["-y", `@playwright/mcp@${pin}`, "--headless", "--browser", "chromium"], {
    env: { ...process.env, HOME: root, npm_config_cache: process.env.npm_config_cache || join(os.homedir(), ".npm"), OPENRIG_SESSION_NAME: "witness@test" },
    stdio: ["pipe", "pipe", "pipe"] });
  const got = await new Promise((resolve) => {
    let buf = "", err = "";
    const send = (m) => p.stdin.write(JSON.stringify(m) + "\n");
    const timer = setTimeout(() => resolve({ error: `no tools/list answer in 150 s: ${err.slice(-300)}` }), 150000);
    p.stderr.on("data", (d) => { err += d; });
    p.stdout.on("data", (d) => {
      buf += d;
      for (let i; (i = buf.indexOf("\n")) >= 0;) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) { send({ jsonrpc: "2.0", method: "notifications/initialized" }); send({ jsonrpc: "2.0", id: 2, method: "tools/list" }); }
        if (m.id === 2) { clearTimeout(timer); resolve({ names: m.result.tools.map((x) => x.name) }); }
      }
    });
    p.on("exit", () => { clearTimeout(timer); resolve({ error: `exited before answering: ${err.slice(-300)}` }); });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
  });
  p.kill();
  if (got.error && /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT/.test(got.error)) { t.skip(`package not fetchable: ${got.error}`); return; }
  assert.ok(got.names, got.error);
  for (const n of ["browser_start_video", "browser_stop_video"]) assert.ok(got.names.includes(n), `${n} in ${got.names.join(",")}`);
});
