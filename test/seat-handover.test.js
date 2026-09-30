// agent-seat-recap and agent-seat-handover (WO29): a rebuild handover must find the seat's packet on its declared
// chain, and a CLI timeout must not be mistaken for a failure. A stub `rig` and a throwaway topology tree only; no
// live handover, no daemon.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = fs.mkdtempSync(join(fs.existsSync("/tmp/claude-1000") ? "/tmp/claude-1000" : "/tmp", "seathandover-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const topo = join(root, "topology"), orHome = join(root, "openrig"), stubs = join(root, "stubs"), calls = join(root, "calls");
fs.mkdirSync(join(topo, "rigs/hc"), { recursive: true }); fs.mkdirSync(stubs);
// Stub rig: config get, context recap-write (as OpenRig does it: supersede, then write), seat handover/status from files.
fs.writeFileSync(join(stubs, "rig"), `#!/usr/bin/env bash
echo "rig $*" >> "${calls}"
case "$1 $2" in
  "config get") echo "${topo}" ;;
  "context recap-write")
    [ -f "${root}/recap-fail" ] && { echo "recap is not addressable" >&2; exit 1; }
    shift 2; while [ $# -gt 0 ]; do case $1 in --rig) r=$2;; --seat) s=$2;; --file) f=$2;; esac; shift 2; done
    d="${topo}/rigs/$r/seats/$s"; mkdir -p "$d"
    if [ -f "$d/RECAP.md" ]; then mkdir -p "$d/recap-superseded"; mv "$d/RECAP.md" "$d/recap-superseded/RECAP-$(date +%s%N | cut -c1-13 | awk '{printf "%015d", $1}').md"; fi
    cp "$f" "$d/RECAP.md"; echo "Recap written: $d/RECAP.md" ;;
  "seat handover") cat "${root}/handover.out" 2>/dev/null; cat "${root}/handover.err" >&2 2>/dev/null; exit "$(cat "${root}/handover.rc" 2>/dev/null || echo 0)" ;;
  "seat status")
    n=$(cat "${root}/polls" 2>/dev/null || echo 0); echo $((n + 1)) > "${root}/polls"
    if [ "$n" -ge "$(cat "${root}/complete-after" 2>/dev/null || echo 999)" ]; then cat "${root}/status-done.json"; else cat "${root}/status-before.json"; fi ;;
esac
`, { mode: 0o755 });
const env = (extra = {}) => ({ PATH: `${stubs}:/usr/bin:/bin`, HOME: root, OPENRIG_HOME: orHome, AGENT_SEAT_HANDOVER_POLL: "0.1", ...extra });
const run = (bin, a, extra) => {
  fs.rmSync(calls, { force: true });
  const r = spawnSync(join(repo, "bin", bin), a, { cwd: root, encoding: "utf8", env: env(extra) });
  return { ...r, calls: fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "" };
};
const seatDir = join(topo, "rigs/hc/seats/arch-claude");
const SEAT = { OPENRIG_SESSION_NAME: "arch-claude@hc" };

test("recap write: the packet becomes the seat's RECAP.md through `rig context recap-write`; show lists the chain", () => {
  fs.writeFileSync(join(root, "packet.md"), "# Handover\n\n## Decisions\n- chose X because Y\n");
  const r = run("agent-seat-recap", ["write", "packet.md"], SEAT);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.calls, /rig context recap-write --rig hc --seat arch-claude --file packet\.md/);
  assert.equal(fs.readFileSync(join(seatDir, "RECAP.md"), "utf8"), "# Handover\n\n## Decisions\n- chose X because Y\n");
  assert.match(r.stdout, /ok +authored recap \(highest trust\): .*seats\/arch-claude\/RECAP\.md/);
  assert.match(r.stdout, /MISSING seat lineage lessons: .*LEARNED\.md/);
});

test("recap write again with --learned: the old recap is superseded, lessons appended (never rewritten)", () => {
  fs.writeFileSync(join(root, "packet2.md"), "# Handover 2\n\n## Decisions\n- Z\n");
  fs.writeFileSync(join(root, "l1.md"), "Run heavy suites through agent-heavy.\n");
  fs.writeFileSync(join(root, "l2.md"), "The hc main mirror lags; run agent-repos-sync.\n");
  assert.equal(run("agent-seat-recap", ["write", "packet2.md", "--learned", "l1.md"], SEAT).status, 0);
  const r = run("agent-seat-recap", ["write", "packet2.md", "--learned", "l2.md", "--json"], SEAT);
  const learned = fs.readFileSync(join(seatDir, "LEARNED.md"), "utf8");
  assert.match(learned, /^# Lessons for every occupant of this seat\n\n## \d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{6}Z \(arch-claude@hc\)\n\nRun heavy suites/);
  assert.match(learned, /agent-heavy\.\n\n## .*\n\nThe hc main mirror lags/);
  const c = JSON.parse(r.stdout).chain;
  assert.deepEqual(c.slice(0, 2).map((l) => l.exists), [true, true]);
  assert.ok(c.filter((l) => /superseded/.test(l.label)).length >= 2);
});

test("show: the compaction restore packet leg, valid or not; exit 1 when there is no RECAP.md", () => {
  const key = join(orHome, "compaction/restore-pending"); fs.mkdirSync(key, { recursive: true });
  fs.writeFileSync(join(key, "arch-claude@hc.json"), JSON.stringify({ outputDir: join(root, "packet-dir") }));
  assert.match(run("agent-seat-recap", ["show"], SEAT).stdout, /MISSING latest compaction restore packet: .*packet-dir/);
  fs.writeFileSync(join(key, "arch-claude@hc.json"), "{nope");
  assert.match(run("agent-seat-recap", ["show"], SEAT).stdout, /restore marker INVALID \(unparseable\)/);
  const r = run("agent-seat-recap", ["show", "--seat", "review-kimi@hc"], {});
  assert.equal(r.status, 1); assert.match(r.stdout, /MISSING authored recap/);
});

test("recap write: a recap-write failure writes nothing else; a bad or missing seat ref is refused", () => {
  fs.writeFileSync(join(root, "recap-fail"), ""); const before = fs.readFileSync(join(seatDir, "LEARNED.md"), "utf8");
  const r = run("agent-seat-recap", ["write", "packet.md", "--learned", "l1.md"], SEAT);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /recap-write failed/);
  assert.equal(fs.readFileSync(join(seatDir, "LEARNED.md"), "utf8"), before);
  fs.rmSync(join(root, "recap-fail"));
  for (const [a, e] of [[["show"], {}], [["show", "--seat", "nohost"], {}], [["show", "--seat", "x@"], {}]]) {
    const b = run("agent-seat-recap", a, e); assert.notEqual(b.status, 0); assert.match(b.stderr, /not <member>@<rig>/);
  }
});

function handover({ out = "", err = "", rc = 0, before = {}, done = null, after = 999 }) {
  for (const f of ["polls"]) fs.rmSync(join(root, f), { force: true });
  fs.writeFileSync(join(root, "handover.out"), out); fs.writeFileSync(join(root, "handover.err"), err);
  fs.writeFileSync(join(root, "handover.rc"), String(rc));
  fs.writeFileSync(join(root, "status-before.json"), JSON.stringify(before));
  fs.writeFileSync(join(root, "status-done.json"), JSON.stringify(done ?? before));
  fs.writeFileSync(join(root, "complete-after"), String(after));
}

test("handover: a JSON answer is final (complete / failed with the daemon's code)", () => {
  handover({ out: JSON.stringify({ ok: true, currentStatus: { currentOccupant: "arch-claude@hc" } }) });
  let r = run("agent-seat-handover", ["arch-claude@hc", "--source", "rebuild", "--reason", "context-wall"]);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /complete/);
  assert.match(r.calls, /rig seat handover arch-claude@hc --source rebuild --reason context-wall --json/);
  assert.doesNotMatch(r.calls, /seat status/);
  handover({ out: JSON.stringify({ ok: false, code: "successor_create_failed", message: "no" }), rc: 1 });
  r = run("agent-seat-handover", ["arch-claude@hc", "--source", "rebuild"]);
  assert.equal(r.status, 1); assert.match(r.stderr, /FAILED: successor_create_failed: no/);
});

test("handover: a CLI timeout waits for a handover_at from THIS run; an older completed handover doesn't count", () => {
  const old = { handover_result: "complete", handover_at: "2026-09-30T08:00:00.000Z", current_occupant: "arch-claude@hc" };
  const fresh = { handover_result: "complete", handover_at: new Date(Date.now() + 1000).toISOString(), current_occupant: "arch-claude@hc", previous_occupant: "arch-claude@hc" };
  handover({ err: "Request to http://127.0.0.1:7433/api/seat/handover timed out after 5000ms (outcome UNKNOWN)", rc: 1, before: old, done: fresh, after: 3 });
  let r = run("agent-seat-handover", ["arch-claude@hc", "--source", "rebuild", "--wait", "30"]);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /complete at/); assert.match(r.stderr, /waiting up to 30s/);
  assert.equal((r.calls.match(/seat status arch-claude@hc --json/g) || []).length, 4);
  handover({ err: "timed out", rc: 1, before: old });   // never completes: UNKNOWN, with the don't-retry advice
  r = run("agent-seat-handover", ["arch-claude@hc", "--source", "rebuild", "--wait", "0.5"]);
  assert.equal(r.status, 3); assert.match(r.stderr, /UNKNOWN after 0s .*Do NOT start another handover/);
  assert.equal((r.calls.match(/seat handover/g) || []).length, 1);   // never retried
});

test("handover: --dry-run passes straight through; no seat is refused", () => {
  handover({ out: "{\"ok\":true,\"dryRun\":true}" });
  const r = run("agent-seat-handover", ["arch-claude@hc", "--source", "rebuild", "--dry-run"]);
  assert.equal(r.status, 0); assert.equal(r.calls.trim(), "rig seat handover arch-claude@hc --source rebuild --dry-run");
  assert.notEqual(run("agent-seat-handover", []).status, 0);
});

test("handover: a completion earlier in the SAME second as this run is not this run's (QA round 1)", () => {
  const stale = { handover_result: "complete", handover_at: new Date(Date.now() - 20).toISOString(), current_occupant: "OLD@hc" };
  handover({ err: "timed out", rc: 1, before: stale });
  const r = run("agent-seat-handover", ["arch-claude@hc", "--source", "rebuild", "--wait", "0.4"]);
  assert.equal(r.status, 3, r.stdout + r.stderr); assert.doesNotMatch(r.stdout, /complete/);
});

test("lessons: every entry heading stays unique, even on the same clock tick (QA round 1)", () => {
  fs.writeFileSync(join(root, "l3.md"), "Lesson three.\n");
  const clock = { ...SEAT, AGENT_SEAT_RECAP_NOW: "2026-09-30 12:00:00.000000Z" };
  for (let i = 0; i < 3; i++) assert.equal(run("agent-seat-recap", ["write", "packet.md", "--learned", "l3.md"], clock).status, 0);
  const heads = fs.readFileSync(join(seatDir, "LEARNED.md"), "utf8").match(/^## .+$/gm);
  assert.equal(new Set(heads).size, heads.length, heads.join("\n"));
  assert.ok(heads.includes("## 2026-09-30 12:00:00.000000Z (arch-claude@hc) #3"));
  assert.equal(fs.readFileSync(join(seatDir, "LEARNED.md"), "utf8").match(/Lesson three\./g).length, 3);   // append-only
});

// Parity with the installed OpenRig's own rebuild chain builder, when it is installed (QA round 1).
const OR = join(process.env.HOME || "", ".local/share/agent-stack/openrig/lib/node_modules/@openrig/cli/daemon/dist/domain/rebuild-priming-chain.js");
test("show lists exactly the legs, in the order, that OpenRig's buildRebuildPrimingChain declares", { skip: !fs.existsSync(OR) && "OpenRig not installed" }, async () => {
  const { buildRebuildPrimingChain } = await import(OR);
  const seat = "par-ity@hc", dir = join(topo, "rigs/hc/seats/par-ity"), sup = join(dir, "recap-superseded");
  fs.mkdirSync(sup, { recursive: true }); fs.writeFileSync(join(dir, "RECAP.md"), "# r\n");
  for (const f of ["RECAP-not-a-generation.md", "RECAP-000000000000100.md", "RECAP-000000000000100-2.md", "RECAP-000000000000100-10.md",
    "RECAP-000000000000099.md", "RECAP-12.md.bak", "notes.md"]) fs.writeFileSync(join(sup, f), "# old\n");
  const markers = join(orHome, "compaction/restore-pending"); fs.mkdirSync(markers, { recursive: true });
  const markerFile = join(markers, "par-ity@hc.json");
  for (const marker of [null, JSON.stringify({ outputDir: "  /x/packet  " }), JSON.stringify({ outputDir: 42 }), JSON.stringify({ outputDir: "" }), "{bad"]) {
    fs.rmSync(markerFile, { force: true }); if (marker !== null) fs.writeFileSync(markerFile, marker);
    const mine = JSON.parse(run("agent-seat-recap", ["show", "--seat", seat, "--json"], {}).stdout).chain.map((l) => l.path);
    const theirs = buildRebuildPrimingChain(seat, { topologyRoot: topo, openrigHome: orHome }).artifacts.map((a) => a.address);
    assert.deepEqual(mine, theirs, `marker ${marker}`);
  }
  const uni = "pär-ity@hc";   // non-ASCII: both sanitize it the same (ASCII-only rule)
  fs.writeFileSync(join(markers, `p_r-ity@hc.json`), JSON.stringify({ outputDir: "/y" }));
  assert.deepEqual(JSON.parse(run("agent-seat-recap", ["show", "--seat", uni, "--json"], {}).stdout).chain.map((l) => l.path),
    buildRebuildPrimingChain(uni, { topologyRoot: topo, openrigHome: orHome }).artifacts.map((a) => a.address));
});
