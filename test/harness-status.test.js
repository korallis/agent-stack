// agent-harness-status: Grok (grokbuild) and Kimi quota from those CLIs. Never invents a percent.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const { asNum, usedPercentFrom, windowsFrom, parseUsageJson, which, collect } = await import(join(repo, "harness/status.js"));
const scratch = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "harness-"));
process.on("exit", () => fs.rmSync(scratch, { recursive: true, force: true }));

const cli = (args, env = {}) => spawnSync(process.execPath, [join(repo, "harness/status.js"), ...args], {
  encoding: "utf8", env: { PATH: env.PATH ?? scratch, HOME: scratch, ...env }, timeout: 15_000,
});

test("used percent: remaining becomes used only when a remaining number is present; missing stays null", () => {
  assert.equal(asNum("34.2"), 34.2);
  assert.equal(asNum("NaN"), null);
  assert.equal(asNum(""), null);
  assert.equal(usedPercentFrom({ used_percent: 34 }), 34);
  assert.equal(usedPercentFrom({ usedPercent: "12" }), 12);
  assert.equal(usedPercentFrom({ percentUsed: 7 }), 7);
  assert.equal(usedPercentFrom({ remaining_percent: 82 }), 18);
  assert.equal(usedPercentFrom({ percent_left: "93" }), 7);
  assert.equal(usedPercentFrom({ remaining: 82 }), 18);
  assert.equal(usedPercentFrom({ remaining: 50000 }), null, "a token count is not a percent");
  assert.equal(usedPercentFrom({ used: 25, total: 100 }), 25);
  assert.equal(usedPercentFrom({ percent: 45, window: "5h" }), 45);
  assert.equal(usedPercentFrom({ percent: 45 }), null, "bare percent without a window is ambiguous");
  assert.equal(usedPercentFrom({}), null);
  assert.equal(usedPercentFrom(null), null);
});

test("windows: short vs weekly from labeled fields; a single remaining sits on weekly", () => {
  assert.deepEqual(windowsFrom({ weekly: { used_percent: 34 } }), { short: null, weekly: 34 });
  assert.deepEqual(windowsFrom({ short_window: { remaining_percent: 80 }, weekly: { usedPercent: 12 } }), { short: 20, weekly: 12 });
  assert.deepEqual(windowsFrom({ quotas: [{ window: "5h", percent: 18 }, { window: "weekly", percent: 7 }] }), { short: 18, weekly: 7 });
  assert.deepEqual(windowsFrom({ productUsage: [{ product: "GrokBuild", usagePercent: 34 }] }), { short: null, weekly: 34 });
  assert.deepEqual(windowsFrom({ remaining_percent: 82 }), { short: null, weekly: 18 });
  assert.deepEqual(windowsFrom({}), { short: null, weekly: null });
});

test("parseUsageJson: JSON only; prose or empty is not a reading", () => {
  assert.deepEqual(parseUsageJson('{"used_percent": 34}'), { short: null, weekly: 34 });
  assert.deepEqual(parseUsageJson('note\n{"weekly": {"usedPercent": 12}}'), { short: null, weekly: 12 });
  assert.equal(parseUsageJson(""), null);
  assert.equal(parseUsageJson("Weekly usage looks fine"), null);
  assert.equal(parseUsageJson("{not json"), null);
  assert.equal(parseUsageJson("{}"), null);
});

test("which: an executable on PATH, nothing otherwise", () => {
  const bin = join(scratch, "bin-which");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(join(bin, "grok"), "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(which("grok", bin), join(bin, "grok"));
  assert.equal(which("kimi", bin), null);
  assert.equal(which("grok", join(scratch, "empty-path")), null);
});

test("collect: missing CLIs are not_installed with no percents", async () => {
  const rows = await collect({ path: join(scratch, "no-clis") });
  assert.deepEqual(rows.map((r) => [r.id, r.status, r.installed, r.short_window_pct, r.weekly_pct, r.unknown_reason]), [
    ["grok", "not_installed", false, null, null, "grok / grokbuild not on PATH"],
    ["kimi", "not_installed", false, null, null, "kimi not on PATH"],
  ]);
});

test("collect: real usage JSON is reported; a failed or empty usage is unavailable, never 0%", async () => {
  const bin = join(scratch, "bin-ok");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(join(bin, "grok"), `#!/bin/sh\n[ "$1" = usage ] || exit 2\nprintf '%s\\n' '{"productUsage":[{"product":"GrokBuild","usagePercent":34}]}'\n`, { mode: 0o755 });
  fs.writeFileSync(join(bin, "kimi"), `#!/bin/sh\n[ "$1" = usage ] || exit 2\nprintf '%s\\n' '{"quotas":[{"window":"5h","percent":18},{"window":"weekly","percent":7}]}'\n`, { mode: 0o755 });
  const ok = await collect({ path: bin });
  assert.equal(ok[0].status, "ok");
  assert.equal(ok[0].weekly_pct, 34);
  assert.equal(ok[0].short_window_pct, null);
  assert.match(ok[0].source, /grok usage --json/);
  assert.equal(ok[1].status, "ok");
  assert.equal(ok[1].short_window_pct, 18);
  assert.equal(ok[1].weekly_pct, 7);

  const fail = join(scratch, "bin-fail");
  fs.mkdirSync(fail, { recursive: true });
  fs.writeFileSync(join(fail, "grok"), `#!/bin/sh\necho "unknown command usage" >&2; exit 2\n`, { mode: 0o755 });
  fs.writeFileSync(join(fail, "kimi"), `#!/bin/sh\nprintf '%s\\n' '{}'\n`, { mode: 0o755 });
  const bad = await collect({ path: fail });
  assert.equal(bad[0].status, "unavailable");
  assert.equal(bad[0].short_window_pct, null);
  assert.equal(bad[0].weekly_pct, null);
  assert.match(bad[0].unknown_reason, /unknown command|usage command/);
  assert.equal(bad[1].status, "unavailable");
  assert.deepEqual([bad[1].short_window_pct, bad[1].weekly_pct], [null, null]);
  assert.match(bad[1].unknown_reason, /no quota reading/);
});

test("CLI: --json and the table; empty PATH; unknown args; --help", () => {
  const empty = cli(["--json"], { PATH: join(scratch, "none") });
  assert.equal(empty.status, 0, empty.stderr);
  const d = JSON.parse(empty.stdout);
  assert.deepEqual(d.harnesses.map((r) => [r.id, r.status, r.weekly_pct]), [["grok", "not_installed", null], ["kimi", "not_installed", null]]);
  const t = cli([], { PATH: join(scratch, "none") });
  assert.equal(t.status, 0, t.stderr);
  assert.match(t.stdout, /grokbuild\s+grok\s+not_installed/);
  assert.match(t.stdout, /kimi\s+kimi\s+not_installed/);
  assert.doesNotMatch(t.stdout, /\b0%/);
  assert.equal(cli(["--bogus"]).status, 2);
  assert.match(cli(["--help"]).stdout, /Never invents a used percent|never invents/i);
});
