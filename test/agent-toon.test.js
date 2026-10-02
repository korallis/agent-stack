import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(join(tmpdir(), "agent-toon-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const home = join(root, "home"), bin = join(root, "upstream"), log = join(root, "calls");
fs.mkdirSync(join(home, ".local/bin"), { recursive: true }); fs.mkdirSync(bin);
// Resolve the actual encoder before changing HOME; a mise shim otherwise asks the fixture HOME to trust host config.
let toon = spawnSync("sh", ["-c", "command -v toon"], { encoding: "utf8" }).stdout.trim();
if (toon.includes("/mise/shims/")) toon = spawnSync("mise", ["which", "toon"], { encoding: "utf8" }).stdout.trim();
assert.ok(toon, "install @toon-format/cli for these real encoder tests");
fs.symlinkSync(toon, join(bin, "toon"));
const upstream = `#!/usr/bin/env python3
import json, os, sys
with open(os.environ['CALL_LOG'], 'a') as f: f.write(json.dumps(sys.argv[1:])+'\\n')
sys.stdout.write(os.environ['UPSTREAM_OUTPUT'])
sys.stderr.write(os.environ.get('UPSTREAM_ERROR', ''))
sys.exit(int(os.environ.get('UPSTREAM_EXIT', '0')))
`;
for (const path of [join(home, ".local/bin/rig"), join(bin, "gh")]) fs.writeFileSync(path, upstream, { mode: 0o755 });
const data = [{ name: "one", state: "ready" }, { name: "two", state: "done" }];
function run(file, args = [], input, extra = {}) {
  fs.rmSync(log, { force: true });
  const r = spawnSync("python3", [join(repo, file), ...args], { input, encoding: "utf8", env: {
    HOME: home, PATH: `${join(repo, "bin")}:${bin}:${dirname(process.execPath)}:${process.env.PATH}`, CALL_LOG: log,
    UPSTREAM_OUTPUT: JSON.stringify(data), ...extra,
  } });
  return { ...r, calls: fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse) : [] };
}
function decode(s) {
  const r = spawnSync("toon", ["--decode"], { input: s, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
}
test("filter round-trips nested JSON, ambiguous strings, escapes, arrays, null and unicode", () => {
  const value = { rows: data, nested: { values: [null, false, 0, -2.5, "01", "true", "a,b", "a:b", "a\nb", 'say "hi"', "café"], empty: [] }, empty: {} };
  const r = run("bin/agent-toon", [], JSON.stringify(value));
  assert.equal(r.status, 0, r.error?.message || r.stderr);
  assert.deepEqual(decode(r.stdout), value);
});
test("filter rejects invalid JSON and mode-changing options with no success output", () => {
  for (const [args, input] of [[[], '{"bad":'], [["--decode"], "a: 1"]]) {
    const r = run("bin/agent-toon", args, input);
    assert.notEqual(r.status, 0); assert.equal(r.stdout, ""); assert.ok(r.stderr);
  }
});
test("rig ps and queue list --toon request JSON and return equivalent TOON", () => {
  for (const args of [["ps", "--nodes", "--toon"], ["queue", "list", "--owned", "--json", "--toon"]]) {
    const r = run("system/seat-tools-rig", args);
    assert.equal(r.status, 0, r.stderr); assert.deepEqual(decode(r.stdout), data);
    assert.equal(r.calls.length, 1); assert.ok(!r.calls[0].includes("--toon"));
    assert.equal(r.calls[0].filter(x => x === "--json").length, 1);
  }
});
test("rig writes reject the formatting flag before touching upstream", () => {
  const r = run("system/seat-tools-rig", ["queue", "create", "--toon"]);
  assert.equal(r.status, 2); assert.equal(r.calls.length, 0);
});
test("gh --json --toon converts; missing --json is rejected before upstream", () => {
  const r = run("system/seat-tools-gh", ["pr", "list", "--json", "number,title", "--toon"]);
  assert.equal(r.status, 0, r.error?.message || r.stderr); assert.deepEqual(decode(r.stdout), data);
  assert.deepEqual(r.calls[0], ["pr", "list", "--json", "number,title"]);
  const noJson = run("system/seat-tools-gh", ["pr", "list", "--toon"]);
  assert.equal(noJson.status, 2); assert.equal(noJson.calls.length, 0);
});
test("ordinary calls preserve stdout, stderr, argument order and status", () => {
  for (const file of ["system/seat-tools-gh", "system/seat-tools-rig"]) {
    const r = run(file, ["version"], undefined, { UPSTREAM_OUTPUT: "raw\n", UPSTREAM_ERROR: "warning\n", UPSTREAM_EXIT: "7" });
    assert.equal(r.status, 7, r.error?.message); assert.equal(r.stdout, "raw\n"); assert.equal(r.stderr, "warning\n");
    assert.deepEqual(r.calls, [["version"]]);
  }
});
test("failed upstream reads keep their failure and are never encoded as success", () => {
  for (const [file, args] of [["system/seat-tools-rig", ["ps", "--toon"]], ["system/seat-tools-gh", ["pr", "list", "--json=number", "--toon"]]]) {
    const r = run(file, args, undefined, { UPSTREAM_OUTPUT: "partial output", UPSTREAM_ERROR: "upstream failed\n", UPSTREAM_EXIT: "3" });
    assert.equal(r.status, 3); assert.equal(r.stdout, "partial output"); assert.equal(r.stderr, "upstream failed\n");
    assert.equal(r.calls.length, 1);
  }
});

test("the -- separator keeps literal --toon data out of wrapper option parsing", () => {
  for (const file of ["system/seat-tools-gh", "system/seat-tools-rig"]) {
    const r = run(file, ["version", "--", "--toon"], undefined, { UPSTREAM_OUTPUT: "unchanged\n" });
    assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, "unchanged\n");
    assert.deepEqual(r.calls, [["version", "--", "--toon"]]);
  }
});

test("filter refuses numbers the JavaScript encoder would silently round", () => {
  for (const input of ['{"id":9007199254740993}', '{"value":0.123456789012345678901}', '{"value":1e400}']) {
    const r = run("bin/agent-toon", [], input);
    assert.notEqual(r.status, 0); assert.equal(r.stdout, ""); assert.match(r.stderr, /precision|range/);
  }
});
