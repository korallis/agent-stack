// WO84: agent-proxy-status reads quota headers by provider, never by magnitude: Anthropic sends fractions (0.29, and
// 1.01 when over the limit), Codex sends percents ("100"). The magnitude rule printed 1.01 as "1%" while the account was
// over its limit. A copy of proxy/status.py runs next to a stub usage_collector (no proxy, no key).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "pxstatus-"));
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
fs.copyFileSync(join(repo, "proxy/status.py"), join(dir, "status.py"));
const acct = (note, provider, s5, s7, extra = {}) => ({ note, provider, disabled: false, status: "active", unavailable: false, cooldowns: [], success: 1, failed: 0,
  quota: { observed_at: "t", signals: provider === "claude" ? { "Anthropic-Ratelimit-Unified-5h-Utilization": s5, "Anthropic-Ratelimit-Unified-7d-Utilization": s7 }
    : { "X-Codex-Primary-Used-Percent": s5, "X-Codex-Secondary-Used-Percent": s7 } }, ...extra });
const files = [acct("claude-a", "claude", "0.29", "0.79"), acct("claude-b", "claude", "1.01", "0.85"), acct("claude-c", "claude", undefined, undefined),
  acct("codex-a", "codex", "100", "0"), acct("codex-b", "codex", "37", "12"), acct("kimi-a", "kimi-ai", undefined, undefined),
  acct("claude-n", "claude", "NaN", "Infinity"), acct("codex-n", "codex", "-inf", "1e999"), acct("claude-x", "claude", "1e307", "nan")];
fs.writeFileSync(join(dir, "usage_collector.py"), `import json, pathlib\nLOG = pathlib.Path("/nonexistent")\ndef mgmt_key(): return "k"\ndef get(path, key): return {"files": json.loads(${JSON.stringify(JSON.stringify(files))})}\n`);
const run = (...a) => spawnSync("python3", [join(dir, "status.py"), ...a], { encoding: "utf8" });

test("the table: Anthropic fractions and Codex percents by provider; past 100% says OVER; missing is '-'", () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  const row = (name) => r.stdout.split("\n").find((l) => l.startsWith(name + " "));
  assert.match(row("claude-a"), /\s29%\s+79%\s/);
  assert.match(row("claude-b"), /\s101% OVER\s+85%\s/, "1.01 is 101%, not 1%");
  assert.match(row("claude-c"), /\s-\s+-\s/);
  assert.match(row("codex-a"), /\s100%\s+0%\s/, "a Codex percent is not multiplied");
  assert.match(row("codex-b"), /\s37%\s+12%\s/);
  assert.match(r.stdout, /^eligible: claude 4\/5 \(1 over limit\), codex 3\/3, kimi-ai 1\/1$/m, "an account over its limit is not eligible");
  assert.match(row("claude-n"), /\s-\s+-\s/, "NaN / Infinity: no reading");
});

test("--json keeps the raw header values and adds the percents and over_limit", () => {
  const out = run("--json").stdout;
  assert.doesNotMatch(out, /:\s*-?(NaN|Infinity)\b/, "valid JSON: no bare NaN/Infinity (QA PR88)");
  const rows = JSON.parse(out), by = Object.fromEntries(rows.map((r) => [r.label, r]));
  for (const l of ["claude-n", "codex-n", "claude-x"]) assert.deepEqual([by[l].short_window_pct, by[l].weekly_pct, by[l].over_limit], [null, null, false], l);
  assert.equal(by["claude-n"].short_window_used, "NaN", "the raw string is kept");
  assert.equal(by["claude-b"].short_window_used, "1.01", "raw value unchanged for existing readers");
  assert.deepEqual([by["claude-a"].short_window_pct, by["claude-b"].short_window_pct, by["codex-a"].short_window_pct, by["claude-c"].short_window_pct].map((v) => v === null ? null : Math.round(v)), [29, 101, 100, null]);
  assert.deepEqual(rows.filter((r) => r.over_limit).map((r) => r.label), ["claude-b"]);
});
