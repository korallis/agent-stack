// install.sh config defaults (WO26 item 1): queue.pickup_stall_threshold_minutes = 480 unless config.json already has a
// value (OpenRig's 3-minute default paged on busy seats). The block is extracted from install.sh and run against a fake
// config.json and a stub rig, so nothing live is touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "instcfg-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const src = fs.readFileSync(join(repo, "install.sh"), "utf8");
const block = src.slice(src.indexOf("# Stuck-sweep pickup threshold"), src.indexOf("# OpenRig's own seat skills"));
fs.mkdirSync(join(root, "bin"));
fs.writeFileSync(join(root, "bin/rig"), `#!/bin/sh\necho "rig $*" >> "${root}/calls"\n`, { mode: 0o755 });

function run(conf, check = 0) {
  fs.rmSync(join(root, "calls"), { force: true });
  const oh = join(root, "oh"); fs.rmSync(oh, { recursive: true, force: true }); fs.mkdirSync(oh);
  if (conf !== null) fs.writeFileSync(join(oh, "config.json"), JSON.stringify(conf));
  const script = `set -euo pipefail\nok() { echo "ok  $*"; }\ntodo() { echo "--  $*"; }\nCHECK=${check}; B=${root}/bin\n${block}`;
  const r = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: root, OPENRIG_HOME: oh } });
  return { ...r, calls: fs.existsSync(join(root, "calls")) ? fs.readFileSync(join(root, "calls"), "utf8") : "" };
}

test("unset: install sets 480; --check reports it as todo and sets nothing", () => {
  const r = run({ transcripts: { lines: 400 } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.calls, /^rig config set queue\.pickup_stall_threshold_minutes 480$/m);
  assert.match(r.stdout, /queue\.pickup_stall_threshold_minutes = 480 \(set\)/);
  const c = run({}, 1);
  assert.equal(c.calls, "");
  assert.match(c.stdout, /--  queue\.pickup_stall_threshold_minutes should be 480/);
  assert.equal(run(null).calls.trim(), "rig config set queue.pickup_stall_threshold_minutes 480", "no config.json at all");
});

test("an existing value is kept, whatever it is", () => {
  for (const v of [480, 60]) {
    const r = run({ queue: { pickupStallThresholdMinutes: v } });
    assert.equal(r.calls, "");
    assert.match(r.stdout, new RegExp(`ok  queue\\.pickup_stall_threshold_minutes = ${v} \\(kept\\)`));
  }
});

// Exercise the same settings merge used by install.sh, without installing services or changing live HOME.
const claudeStart = src.indexOf('if [ $CHECK = 0 ]; then\n  mkdir -p "$HOME/.claude"');
const claudeBlock = src.slice(claudeStart, src.indexOf("# Credential read guard: seats never stop", claudeStart));
function claudeSettings(settings, check = 0) {
  const h = fs.mkdtempSync(join(root, "claude-")), dir = join(h, ".claude"), file = join(dir, "settings.json");
  fs.mkdirSync(dir);
  if (settings !== null) fs.writeFileSync(file, JSON.stringify(settings));
  const r = spawnSync("bash", ["-c", `set -euo pipefail
ok() { echo "ok $*"; }
todo() { echo "todo $*"; }
backup() { cp -p "$1" "$1.bak"; }
CHECK=${check}
${claudeBlock}`], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: h, TMPDIR: root } });
  return { ...r, file, settings: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null };
}
test("Claude install disables flagged-message switching, preserves unrelated settings and backs up changes", () => {
  for (const previous of [null, {}, { switchModelsOnFlag: true }, { switchModelsOnFlag: false }]) {
    const before = previous === null ? null : { ...previous, hooks: { Stop: [] }, permissions: { allow: ["Read"] }, theme: "dark" };
    const r = claudeSettings(before);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.settings.switchModelsOnFlag, false);
    assert.equal(r.settings.permissions.defaultMode, "bypassPermissions");
    if (before) {
      assert.deepEqual(r.settings.hooks, before.hooks);
      assert.deepEqual(r.settings.permissions.allow, ["Read"]);
      assert.equal(r.settings.theme, "dark");
      assert.deepEqual(JSON.parse(fs.readFileSync(r.file + ".bak", "utf8")), before);
    }
  }
});
test("Claude install check reports the setting without writing", () => {
  for (const before of [null, { switchModelsOnFlag: true }, { switchModelsOnFlag: false }]) {
    const r = claudeSettings(before, 1);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.settings, before);
    assert.equal(fs.existsSync(r.file + ".bak"), false);
    assert.match(r.stdout, /switchModelsOnFlag/);
  }
});
