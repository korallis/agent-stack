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

// WO85: Codex now sends each window's length. Primary is the WEEKLY window (10080 minutes) and secondary is a 0-minute,
// 0% window: there is no 5-hour limit. An account that has used its week carries on on credits. The current shape,
// anonymised from a live read; the older shape (no Window-Minutes) keeps the old by-position reading.
test("WO85: Codex windows by their reported length; no 5 h limit; a used-up week on credits is neither over nor ineligible", () => {
  const cx = (note, sig) => ({ note, provider: "codex", disabled: false, status: "active", unavailable: false, cooldowns: [], success: 1, failed: 0, quota: { observed_at: "t", signals: sig } });
  const now = (used, credits, extra = {}) => ({ "X-Codex-Active-Limit": "premium", "X-Codex-Plan-Type": "pro", "X-Codex-Primary-Used-Percent": used, "X-Codex-Primary-Window-Minutes": "10080",
    "X-Codex-Secondary-Used-Percent": "0", "X-Codex-Secondary-Window-Minutes": "0", ...(credits === undefined ? {} : { "X-Codex-Credits-Has-Credits": credits }), "X-Codex-Credits-Unlimited": "False", ...extra });
  const files = [cx("codex-a", now("100", "True")), cx("codex-b", now("42", "True")), cx("codex-c", now("100", "False")), cx("codex-d", now("100", undefined)),
    cx("codex-e", { "X-Codex-Primary-Used-Percent": "12", "X-Codex-Primary-Window-Minutes": "300", "X-Codex-Secondary-Used-Percent": "57", "X-Codex-Secondary-Window-Minutes": "10080" }),
    cx("codex-f", { "X-Codex-Primary-Used-Percent": "57", "X-Codex-Primary-Window-Minutes": "10080", "X-Codex-Secondary-Used-Percent": "12", "X-Codex-Secondary-Window-Minutes": "300" }),
    cx("codex-g", now("100", "False", { "X-Codex-Credits-Unlimited": "True" }))];
  const d = fs.mkdtempSync(join(dir, "wo85-"));
  fs.copyFileSync(join(repo, "proxy/status.py"), join(d, "status.py"));
  fs.writeFileSync(join(d, "usage_collector.py"), `import json, pathlib\nLOG = pathlib.Path("/nonexistent")\ndef mgmt_key(): return "k"\ndef get(path, key): return {"files": json.loads(${JSON.stringify(JSON.stringify(files))})}\n`);
  const go = (...a) => spawnSync("python3", [join(d, "status.py"), ...a], { encoding: "utf8" });
  const by = Object.fromEntries(JSON.parse(go("--json").stdout).map((r) => [r.label, r]));
  const v = (l) => [by[l].short_window_pct, by[l].weekly_pct, by[l].on_credits, by[l].over_limit];
  assert.deepEqual(v("codex-a"), [null, 100, true, false], "the current shape: weekly 100% on credits; no 5 h reading; not over");
  assert.deepEqual([by["codex-a"].short_window_used, by["codex-a"].weekly_used, by["codex-a"].weekly_window_minutes, by["codex-a"].has_credits], [null, "100", 10080, true]);
  assert.deepEqual(v("codex-b"), [null, 42, false, false]);
  assert.deepEqual(v("codex-c"), [null, 100, false, true], "a used-up week with credits reported as none is over its limit");
  assert.deepEqual(v("codex-d"), [null, 100, false, false], "no credits header: not evidence either way");
  assert.deepEqual(v("codex-e"), [12, 57, false, false], "a real 5 h window (300 minutes) still reads as 5 h");
  assert.deepEqual(v("codex-f"), [12, 57, false, false], "by length, not position");
  assert.deepEqual(v("codex-g"), [null, 100, true, false], "unlimited credits");
  const t = go();
  assert.equal(t.status, 0, t.stderr);
  const row = (n) => t.stdout.split("\n").find((l) => l.startsWith(n + " "));
  assert.match(t.stdout.split("\n")[0], /\s5h\s+weekly\s+credits\s/);
  assert.match(row("codex-a"), /\s-\s+100%\s+in use\s/, "no 5 h column value, the week, on credits");
  assert.match(row("codex-b"), /\s-\s+42%\s+yes\s/);
  assert.match(row("codex-c"), /\s-\s+100%\s+none\s/);
  assert.doesNotMatch(row("codex-a"), /OVER/);
  assert.match(t.stdout, /^eligible: codex 6\/7 \(1 over limit\)$/m, "only the account with no credits left is ineligible");
});
