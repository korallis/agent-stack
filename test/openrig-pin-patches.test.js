// WO65: the OpenRig pin and its local patch set agree with the patches README (kept vs dropped per version). Applying
// them to the published package needs the registry; that proof is the throwaway-HOME run recorded in the README.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const pin = fs.readFileSync(join(repo, "config/versions.defaults.env"), "utf8").match(/^OPENRIG_VERSION=(\S+)/m)[1];
const readme = fs.readFileSync(join(repo, "patches/openrig/README.md"), "utf8");

test("the pinned OpenRig version has its patch directory, every patch there is 'kept' in the README, every 'dropped' one is gone", () => {
  assert.equal(pin, "0.6.3");
  const dir = join(repo, "patches/openrig", pin), patches = fs.readdirSync(dir).filter((f) => f.endsWith(".patch")).map((f) => f.replace(/\.patch$/, ""));
  assert.deepEqual(patches, ["132-project-scoped-proof", "133-unclaimed-human-routes-to-source", "135-codex-idle-composer", "136-poll-cadence",
    "137-proof-replace-keeps-sources", "139-batch-seat-tmux-reads", "140-delivery-outcome-resolved-close", "141-slack-upload-encoding-and-video", "142-batched-structural-capture", "143-remove-exited-session", "144-batched-transcript-capture", "145-usage-samples-latest-by-index", "146-seat-daemon-advice", "147-slack-sweep-active-ids-first", "148-queue-list-recovery-once"]);
  const section = readme.slice(readme.indexOf(`## ${pin}`), readme.indexOf("## The 0.6.1 set"));
  for (const p of patches) assert.match(section, new RegExp("\\| `" + p + "` \\| (\\*\\*)?kept"), p);
  for (const [, p] of section.matchAll(/\| `([\w-]+)` \| \*\*dropped\*\*/g)) assert.ok(!patches.includes(p), `${p} is dropped but still carried`);
  // every patch is a -p1 diff against the package root, and 136 no longer carries the single-flight guard upstream has
  for (const p of patches) assert.match(fs.readFileSync(join(dir, `${p}.patch`), "utf8"), /^--- a\/(daemon\/)?dist\/|^--- a\/daemon\//m, p);
  assert.doesNotMatch(fs.readFileSync(join(dir, "136-poll-cadence.patch"), "utf8"), /reconciling/, "136 must not add its own overlap guard on 0.6.3");
});

test("the pin is never below the newest version we carry patches for", () => {
  const versions = fs.readdirSync(join(repo, "patches/openrig")).filter((d) => /^\d+\.\d+\.\d+$/.test(d));
  const newest = versions.sort((a, b) => spawnSync(join(repo, "bin/semver-cmp"), [a, b], { encoding: "utf8" }).stdout.trim() === "1" ? 1 : -1).at(-1);
  assert.notEqual(spawnSync(join(repo, "bin/semver-cmp"), [pin, newest], { encoding: "utf8" }).stdout.trim(), "-1", `pin ${pin} < ${newest}`);
});
