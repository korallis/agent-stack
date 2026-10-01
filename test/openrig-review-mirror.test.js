// WO72: the local 0.6.3 patches carry the fixes upstream review asked for on our PRs (#295 -> 135, #296 -> 140,
// #298 follow-up -> 141). 141 is exercised on the vendored Slack files (openrig-slack-upload.test.js); 135 and 140 touch
// dist files too large to vendor, so their added code is checked here (behaviour proof: the throwaway install, PR body).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const added = (name) => fs.readFileSync(join(repo, "patches/openrig/0.6.3", name), "utf8").split("\n")
  .filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1)).join("\n");

test("135: beyond the last 8 lines only Codex's turn-status row counts as busy (#295 review)", () => {
  const a = added("135-codex-idle-composer.patch");
  assert.match(a, /const recent = plain\.filter\(\(line\) => line !== ""\)\.slice\(-8\)\.join\("\\n"\);/);
  assert.match(a, /plain\.some\(\(line\) => \/\^\[•◦\]\\s\+\\S\.\*\\\(\(\?:\\d\+\[hms\]\\s\*\)\+•\\s\*esc to interrupt\\\)\/\.test\(line\)\)/);
  assert.match(a, /MID_WORK_PATTERNS\.some\(\(pattern\) => pattern\.test\(recent\)\)/);
  assert.doesNotMatch(a, /MID_WORK_PATTERNS\.some\(\(pattern\) => pattern\.test\(everything\)\)/, "no generic Working match over the whole capture");
  const sig = /^[•◦]\s+\S.*\((?:\d+[hms]\s*)+•\s*esc to interrupt\)/;
  for (const busy of ["• Working (1h 09m 39s • esc to interrupt)", "◦ Working (11s • esc to interrupt) · 1 background terminal running", "• Exploring fixtures (2m 03s • esc to interrupt)"])
    assert.match(busy, sig, busy);
  for (const prose of ["• Working directory: /tmp/project", "• Working tree is clean.", "Press esc to interrupt (Working)"])
    assert.doesNotMatch(prose, sig, prose);
});

test("140: judged by the resolved notice's own transition; recipient is the human who closed the row (#296 review)", () => {
  const a = added("140-delivery-outcome-resolved-close.patch");
  assert.match(a, /!\["pending", "in-progress", "blocked"\]\.includes\(transition\.state\)/);
  assert.doesNotMatch(a, /includes\(item\.state\)/, "never the row's current state");
  assert.match(a, /resolvedBy = transition\.actorSession;/);
  assert.match(a, /const humanAddress = resolvedBy !== null\s*\? resolveRegisteredHumanAddress\(resolvedBy, registry\.entities\)/);
});

test("141: the local attachment is opened once, non-blocking, and read through that descriptor (#298 follow-up)", () => {
  const a = added("141-slack-upload-encoding-and-video.patch");
  assert.match(a, /fd = fs\.openSync\(refPath, fs\.constants\.O_RDONLY \| fs\.constants\.O_NONBLOCK\);/);
  assert.match(a, /const st = fs\.fstatSync\(fd\);/); assert.match(a, /fs\.readSync\(fd, bytes, read, bytes\.length - read, read\)/);
  assert.match(a, /fs\.closeSync\(fd\)/);
  assert.doesNotMatch(a, /fs\.statSync\(refPath\)|fs\.readFileSync\(refPath\)/);
});
