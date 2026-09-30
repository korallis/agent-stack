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
