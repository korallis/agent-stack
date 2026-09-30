// bin/semver-cmp: SemVer 2.0 precedence (the OpenRig downgrade guard depends on it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const bin = join(dirname(fileURLToPath(import.meta.url)), "../bin/semver-cmp");
const cmp = (a, b) => spawnSync(bin, [a, b], { encoding: "utf8" });
test("SemVer 2.0 precedence, including the spec's own prerelease chain", () => {
  const chain = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
  for (let i = 0; i + 1 < chain.length; i++) { assert.equal(cmp(chain[i], chain[i + 1]).stdout.trim(), "-1", chain[i]); assert.equal(cmp(chain[i + 1], chain[i]).stdout.trim(), "1"); }
  assert.equal(cmp("0.6.10", "0.6.9").stdout.trim(), "1");
  assert.equal(cmp("v0.6.1", "0.6.1").stdout.trim(), "0");
  assert.equal(cmp("0.6.1+build.5", "0.6.1").stdout.trim(), "0");
  assert.equal(cmp("0.6.1-rc.1", "0.6.1").stdout.trim(), "-1");
});
test("a non-version is an error (exit 2), never a comparison", () => {
  for (const x of ["latest", "0.6", "", "0.6.1.2"]) assert.equal(cmp(x, "0.6.1").status, 2, x);
});
