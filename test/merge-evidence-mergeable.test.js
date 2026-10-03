// agent-merge-evidence --decide never asks Jev while GitHub reports mergeable UNKNOWN (it is recomputing after a push
// or a base change): three HOLDs on one project on 2026-10-03 were only that. It polls (5 s, up to 90 s) and, if still
// UNKNOWN, exits 4 without calling Jev. The CLI runs against a stub gh; an unreadable Jev stub proves Jev is not called.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { awaitMergeable } from "../orchestration/merge-evidence.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(join(os.tmpdir(), "merge-mergeable-"));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const fake = (values) => { const slept = []; let i = 0; return { read: () => values[Math.min(i++, values.length - 1)], sleep: async (s) => { slept.push(s); }, slept, reads: () => i }; };

test("awaitMergeable: polls every 5 s while UNKNOWN, up to 90 s; any other value returns at once", async () => {
  let f = fake(["UNKNOWN", "UNKNOWN", "MERGEABLE"]);
  assert.deepEqual(await awaitMergeable(f), { value: "MERGEABLE", waited: 10 }); assert.deepEqual(f.slept, [5, 5]);
  f = fake(["UNKNOWN"]);
  assert.deepEqual(await awaitMergeable(f), { value: "UNKNOWN", waited: 90 }); assert.equal(f.reads(), 19, "the first read plus one every 5 s for 90 s");
  for (const v of ["MERGEABLE", "CONFLICTING"]) { f = fake([v]); assert.deepEqual(await awaitMergeable(f), { value: v, waited: 0 }); assert.deepEqual(f.slept, []); }
  // QA (#171): a zero or negative interval would never advance the wait (an endless loop on UNKNOWN): refused
  for (const pollS of [0, -1, NaN]) await assert.rejects(awaitMergeable({ ...fake(["UNKNOWN"]), pollS }), /pollS must be > 0/);
});

function cli(sequence, extraEnv = {}) {
  const d = fs.mkdtempSync(join(root, "w-")), bin = join(d, "bin"); fs.mkdirSync(bin);
  fs.writeFileSync(join(d, "seq"), sequence.join("\n") + "\n");
  // gh answers only `pr view N --json mergeable`, from the sequence (the last value repeats); anything else fails
  fs.writeFileSync(join(bin, "gh"), `#!/bin/sh
echo "$*" >> "${d}/calls"
case "$*" in
  "pr view 7 --json mergeable"|"pr view 7 -R o/r --json mergeable")
    n=$(grep -c "json mergeable" "${d}/calls"); v=$(sed -n "\${n}p" "${d}/seq"); [ -n "$v" ] || v=$(tail -1 "${d}/seq")
    echo "{\\"mergeable\\":\\"$v\\"}" ;;
  *) echo "stub gh: unexpected call: $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 });
  const r = spawnSync("node", [join(repo, "orchestration/merge-evidence.js"), "7", "-R", "o/r", "--repo", "o/r", "--decide"], { encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: d, AGENT_JEV_STUB: join(d, "no-such-jev-stub.json"), AGENT_MERGE_EVIDENCE_POLL_S: "0.05", AGENT_MERGE_EVIDENCE_MERGEABLE_WAIT_S: "0.2", ...extraEnv }, timeout: 30000 });
  const calls = fs.readFileSync(join(d, "calls"), "utf8").trim().split("\n");
  return { ...r, calls };
}

test("--decide: still UNKNOWN after the wait means exit 4, NOT DECIDED, and Jev is never asked", () => {
  const r = cli(["UNKNOWN"]);
  assert.equal(r.status, 4, r.stderr);
  assert.match(r.stderr, /merge gate: NOT DECIDED \(GitHub still reports mergeable UNKNOWN after 0\.2s/);
  assert.match(r.stderr, /Jev was not asked/);
  assert.ok(r.calls.every((c) => c.endsWith("--json mergeable")), "nothing but mergeable reads (no gather, no Jev)");
  assert.equal(r.calls.length, 5, "the first read plus 4 polls in the 0.2 s window");
});

test("--decide: AGENT_MERGE_EVIDENCE_POLL_S=0 (or junk) falls back to 5 s, never an endless loop", () => {
  for (const poll of ["0", "-3", "x"]) {
    const r = cli(["UNKNOWN"], { AGENT_MERGE_EVIDENCE_POLL_S: poll, AGENT_MERGE_EVIDENCE_MERGEABLE_WAIT_S: "0" });
    assert.equal(r.status, 4, `${poll}: ${r.stderr}`); assert.equal(r.calls.length, 1, `${poll}: one read, then NOT DECIDED`);
  }
});

test("--decide: once GitHub has computed it, the gate goes on to gather the evidence", () => {
  const r = cli(["UNKNOWN", "UNKNOWN", "MERGEABLE"]);
  assert.equal(r.calls.filter((c) => c.endsWith("--json mergeable")).length, 3);
  assert.ok(r.calls.some((c) => /--json number,title/.test(c)), "went on to the full read");
  assert.equal(r.status, 2, "the stub can't answer the full read; past the wait is what this shows");
  assert.doesNotMatch(r.stderr, /NOT DECIDED/);
});
