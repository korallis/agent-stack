// install.sh's transcript-capture defaults: the poll interval is a floor of 15 s, so a slower value set on purpose
// (60 s, set during the 2026-10-02 daemon stall) survives a later install; a faster or missing one becomes 15. Lines
// stay exactly 400. The block is cut from install.sh and run against a stub `rig` that answers `config get`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(join(repo, "install.sh"), "utf8");
const block = src.slice(src.indexOf("# Transcript capture defaults"), src.indexOf("done", src.indexOf('for kv in "transcripts.')) + 4);
const root = fs.mkdtempSync(join(os.tmpdir(), "install-transcripts-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function run(values, check) {
  const B = fs.mkdtempSync(join(root, "b-")), calls = join(B, "calls");
  fs.writeFileSync(join(B, "rig"), `#!/usr/bin/env bash
echo "$*" >> "${calls}"
case "$1 $2 $3" in
  "config get transcripts.poll_interval_seconds") [ -n "$POLL" ] && echo "$POLL" ;;
  "config get transcripts.lines") [ -n "$LINES" ] && echo "$LINES" ;;
esac
exit 0
`, { mode: 0o755 });
  const script = `ok() { echo "OK $*"; }; todo() { echo "TODO $*"; }; B=${B}; CHECK=${check ? 1 : 0}\n${block}\n`;
  const r = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", POLL: values.poll ?? "", LINES: values.lines ?? "" } });
  assert.equal(r.status, 0, r.stderr);
  const sets = fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").split("\n").filter((l) => l.startsWith("config set")) : [];
  return { out: r.stdout.trim().split("\n"), sets };
}

test("a slower interval set on purpose is kept by install and by --check; 15 is ok as before", () => {
  for (const check of [false, true]) {
    const r = run({ poll: "60", lines: "400" }, check);
    assert.deepEqual(r.out, ["OK transcripts.poll_interval_seconds = 60 (kept; at least 15)", "OK transcripts.lines = 400"]);
    assert.deepEqual(r.sets, []);
  }
  assert.deepEqual(run({ poll: "15", lines: "400" }, false).out, ["OK transcripts.poll_interval_seconds = 15", "OK transcripts.lines = 400"]);
});

test("a faster or missing interval becomes 15; --check reports it without writing; lines are exact", () => {
  for (const poll of ["2", "", "abc"]) {
    const r = run({ poll, lines: "1000" }, false);
    assert.deepEqual(r.sets, ["config set transcripts.poll_interval_seconds 15", "config set transcripts.lines 400"], poll);
    const c = run({ poll, lines: "1000" }, true);
    assert.deepEqual(c.out, ["TODO transcripts.poll_interval_seconds should be at least 15", "TODO transcripts.lines should be 400"]);
    assert.deepEqual(c.sets, []);
  }
});
