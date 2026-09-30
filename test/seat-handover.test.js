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
fs.mkdirSync(join(topo, "rigs/shop"), { recursive: true }); fs.mkdirSync(stubs);
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
  "queue list")   # WO56: the blocked rows of --destination, from rows/ (their first, pre-handover state)
    [ -f "${root}/list-fail" ] && { echo "daemon down" >&2; exit 1; }
    while [ $# -gt 0 ]; do [ "$1" = --destination ] && d=$2; shift; done
    python3 -c 'import json,sys,glob; print(json.dumps([r for r in (json.load(open(f)) for f in sorted(glob.glob(sys.argv[1] + "/*.json"))) if r.get("destinationSession") == sys.argv[2] and r.get("state") == "blocked"]))' "${root}/rows" "$d" ;;
  "queue show")   # the first read of a row is rows/<id>.json; later ones rows-after/<id>.json when there is one
    [ -f "${root}/show-fail-$3" ] && { echo "transport failure" >&2; exit 1; }
    n=$(cat "${root}/shows-$3" 2>/dev/null || echo 0); echo $((n + 1)) > "${root}/shows-$3"
    if [ "$n" -ge 1 ] && [ -f "${root}/rows-after/$3.json" ]; then cat "${root}/rows-after/$3.json"; else cat "${root}/rows/$3.json" 2>/dev/null || { echo "no such qitem" >&2; exit 1; }; fi ;;
  "watchdog show") cat "${root}/jobs/$3.json" 2>/dev/null || { echo "no such job" >&2; exit 1; } ;;
  "queue update") [ -f "${root}/update-fail" ] && { echo "blocker_not_live: the blocker is done" >&2; exit 1; }; echo '{"ok":true}' ;;
esac
`, { mode: 0o755 });
const env = (extra = {}) => ({ PATH: `${stubs}:/usr/bin:/bin`, HOME: root, OPENRIG_HOME: orHome, AGENT_SEAT_HANDOVER_POLL: "0.1", ...extra });
const run = (bin, a, extra) => {
  fs.rmSync(calls, { force: true });
  const r = spawnSync(join(repo, "bin", bin), a, { cwd: root, encoding: "utf8", env: env(extra) });
  return { ...r, calls: fs.existsSync(calls) ? fs.readFileSync(calls, "utf8") : "" };
};
const seatDir = join(topo, "rigs/shop/seats/arch-claude");
const SEAT = { OPENRIG_SESSION_NAME: "arch-claude@shop" };

test("recap write: the packet becomes the seat's RECAP.md through `rig context recap-write`; show lists the chain", () => {
  fs.writeFileSync(join(root, "packet.md"), "# Handover\n\n## Decisions\n- chose X because Y\n");
  const r = run("agent-seat-recap", ["write", "packet.md"], SEAT);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.calls, /rig context recap-write --rig shop --seat arch-claude --file packet\.md/);
  assert.equal(fs.readFileSync(join(seatDir, "RECAP.md"), "utf8"), "# Handover\n\n## Decisions\n- chose X because Y\n");
  assert.match(r.stdout, /ok +authored recap \(highest trust\): .*seats\/arch-claude\/RECAP\.md/);
  assert.match(r.stdout, /MISSING seat lineage lessons: .*LEARNED\.md/);
});

test("recap write again with --learned: the old recap is superseded, lessons appended (never rewritten)", () => {
  fs.writeFileSync(join(root, "packet2.md"), "# Handover 2\n\n## Decisions\n- Z\n");
  fs.writeFileSync(join(root, "l1.md"), "Run heavy suites through agent-heavy.\n");
  fs.writeFileSync(join(root, "l2.md"), "The shop main mirror lags; run agent-repos-sync.\n");
  assert.equal(run("agent-seat-recap", ["write", "packet2.md", "--learned", "l1.md"], SEAT).status, 0);
  const r = run("agent-seat-recap", ["write", "packet2.md", "--learned", "l2.md", "--json"], SEAT);
  const learned = fs.readFileSync(join(seatDir, "LEARNED.md"), "utf8");
  assert.match(learned, /^# Lessons for every occupant of this seat\n\n## \d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{6}Z \(arch-claude@shop\)\n\nRun heavy suites/);
  assert.match(learned, /agent-heavy\.\n\n## .*\n\nThe shop main mirror lags/);
  const c = JSON.parse(r.stdout).chain;
  assert.deepEqual(c.slice(0, 2).map((l) => l.exists), [true, true]);
  assert.ok(c.filter((l) => /superseded/.test(l.label)).length >= 2);
});

test("show: the compaction restore packet leg, valid or not; exit 1 when there is no RECAP.md", () => {
  const key = join(orHome, "compaction/restore-pending"); fs.mkdirSync(key, { recursive: true });
  fs.writeFileSync(join(key, "arch-claude@shop.json"), JSON.stringify({ outputDir: join(root, "packet-dir") }));
  assert.match(run("agent-seat-recap", ["show"], SEAT).stdout, /MISSING latest compaction restore packet: .*packet-dir/);
  fs.writeFileSync(join(key, "arch-claude@shop.json"), "{nope");
  assert.match(run("agent-seat-recap", ["show"], SEAT).stdout, /restore marker INVALID \(unparseable\)/);
  const r = run("agent-seat-recap", ["show", "--seat", "review-kimi@shop"], {});
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
  for (const f of fs.readdirSync(root)) if (/^(polls|list-fail|update-fail|rows|rows-after|jobs|shows-.*|show-fail-.*)$/.test(f)) fs.rmSync(join(root, f), { force: true, recursive: true });
  fs.writeFileSync(join(root, "handover.out"), out); fs.writeFileSync(join(root, "handover.err"), err);
  fs.writeFileSync(join(root, "handover.rc"), String(rc));
  fs.writeFileSync(join(root, "status-before.json"), JSON.stringify(before));
  fs.writeFileSync(join(root, "status-done.json"), JSON.stringify(done ?? before));
  fs.writeFileSync(join(root, "complete-after"), String(after));
}

test("handover: a JSON answer is final (complete / failed with the daemon's code)", () => {
  handover({ out: JSON.stringify({ ok: true, currentStatus: { currentOccupant: "arch-claude@shop" } }) });
  let r = run("agent-seat-handover", ["arch-claude@shop", "--source", "rebuild", "--reason", "context-wall"]);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /complete/);
  assert.match(r.calls, /rig seat handover arch-claude@shop --source rebuild --reason context-wall --json/);
  assert.equal((r.calls.match(/seat status/g) || []).length, 1, "one read of the seat before, no polling");
  handover({ out: JSON.stringify({ ok: false, code: "successor_create_failed", message: "no" }), rc: 1 });
  r = run("agent-seat-handover", ["arch-claude@shop", "--source", "rebuild"]);
  assert.equal(r.status, 1); assert.match(r.stderr, /FAILED: successor_create_failed: no/);
});

test("handover: a CLI timeout waits for a handover_at from THIS run; an older completed handover doesn't count", () => {
  const old = { handover_result: "complete", handover_at: "2026-09-30T08:00:00.000Z", current_occupant: "arch-claude@shop" };
  const fresh = { handover_result: "complete", handover_at: new Date(Date.now() + 1000).toISOString(), current_occupant: "arch-claude@shop", previous_occupant: "arch-claude@shop" };
  handover({ err: "Request to http://127.0.0.1:7433/api/seat/handover timed out after 5000ms (outcome UNKNOWN)", rc: 1, before: old, done: fresh, after: 3 });
  let r = run("agent-seat-handover", ["arch-claude@shop", "--source", "rebuild", "--wait", "30"]);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /complete at/); assert.match(r.stderr, /waiting up to 30s/);
  assert.equal((r.calls.match(/seat status arch-claude@shop --json/g) || []).length, 4);
  handover({ err: "timed out", rc: 1, before: old });   // never completes: UNKNOWN, with the don't-retry advice
  r = run("agent-seat-handover", ["arch-claude@shop", "--source", "rebuild", "--wait", "0.5"]);
  assert.equal(r.status, 3); assert.match(r.stderr, /UNKNOWN after 0s .*Do NOT start another handover/);
  assert.equal((r.calls.match(/seat handover/g) || []).length, 1);   // never retried
});

test("handover: --dry-run passes straight through; no seat is refused", () => {
  handover({ out: "{\"ok\":true,\"dryRun\":true}" });
  const r = run("agent-seat-handover", ["arch-claude@shop", "--source", "rebuild", "--dry-run"]);
  assert.equal(r.status, 0); assert.equal(r.calls.trim(), "rig seat handover arch-claude@shop --source rebuild --dry-run");
  assert.notEqual(run("agent-seat-handover", []).status, 0);
});

test("handover: a completion earlier in the SAME second as this run is not this run's (QA round 1)", () => {
  const stale = { handover_result: "complete", handover_at: new Date(Date.now() - 20).toISOString(), current_occupant: "OLD@shop" };
  handover({ err: "timed out", rc: 1, before: stale });
  const r = run("agent-seat-handover", ["arch-claude@shop", "--source", "rebuild", "--wait", "0.4"]);
  assert.equal(r.status, 3, r.stdout + r.stderr); assert.doesNotMatch(r.stdout, /complete/);
});

test("lessons: every entry heading stays unique, even on the same clock tick (QA round 1)", () => {
  fs.writeFileSync(join(root, "l3.md"), "Lesson three.\n");
  const clock = { ...SEAT, AGENT_SEAT_RECAP_NOW: "2026-09-30 12:00:00.000000Z" };
  for (let i = 0; i < 3; i++) assert.equal(run("agent-seat-recap", ["write", "packet.md", "--learned", "l3.md"], clock).status, 0);
  const heads = fs.readFileSync(join(seatDir, "LEARNED.md"), "utf8").match(/^## .+$/gm);
  assert.equal(new Set(heads).size, heads.length, heads.join("\n"));
  assert.ok(heads.includes("## 2026-09-30 12:00:00.000000Z (arch-claude@shop) #3"));
  assert.equal(fs.readFileSync(join(seatDir, "LEARNED.md"), "utf8").match(/Lesson three\./g).length, 3);   // append-only
});

// Parity with the installed OpenRig's own rebuild chain builder, when it is installed (QA round 1).
const OR = join(process.env.HOME || "", ".local/share/agent-stack/openrig/lib/node_modules/@openrig/cli/daemon/dist/domain/rebuild-priming-chain.js");
test("show lists exactly the legs, in the order, that OpenRig's buildRebuildPrimingChain declares", { skip: !fs.existsSync(OR) && "OpenRig not installed" }, async () => {
  const { buildRebuildPrimingChain } = await import(OR);
  const seat = "par-ity@shop", dir = join(topo, "rigs/shop/seats/par-ity"), sup = join(dir, "recap-superseded");
  fs.mkdirSync(sup, { recursive: true }); fs.writeFileSync(join(dir, "RECAP.md"), "# r\n");
  for (const f of ["RECAP-not-a-generation.md", "RECAP-000000000000100.md", "RECAP-000000000000100-2.md", "RECAP-000000000000100-10.md",
    "RECAP-000000000000099.md", "RECAP-12.md.bak", "notes.md"]) fs.writeFileSync(join(sup, f), "# old\n");
  const markers = join(orHome, "compaction/restore-pending"); fs.mkdirSync(markers, { recursive: true });
  const markerFile = join(markers, "par-ity@shop.json");
  for (const marker of [null, JSON.stringify({ outputDir: "  /x/packet  " }), JSON.stringify({ outputDir: 42 }), JSON.stringify({ outputDir: "" }), "{bad"]) {
    fs.rmSync(markerFile, { force: true }); if (marker !== null) fs.writeFileSync(markerFile, marker);
    const mine = JSON.parse(run("agent-seat-recap", ["show", "--seat", seat, "--json"], {}).stdout).chain.map((l) => l.path);
    const theirs = buildRebuildPrimingChain(seat, { topologyRoot: topo, openrigHome: orHome }).artifacts.map((a) => a.address);
    assert.deepEqual(mine, theirs, `marker ${marker}`);
  }
  const uni = "pär-ity@shop";   // non-ASCII: both sanitize it the same (ASCII-only rule)
  fs.writeFileSync(join(markers, `p_r-ity@shop.json`), JSON.stringify({ outputDir: "/y" }));
  assert.deepEqual(JSON.parse(run("agent-seat-recap", ["show", "--seat", uni, "--json"], {}).stdout).chain.map((l) => l.path),
    buildRebuildPrimingChain(uni, { topologyRoot: topo, openrigHome: orHome }).artifacts.map((a) => a.address));
});

// WO56: OpenRig stops the retiring generation's watchdog jobs at a swap, park timers included; the wrapper re-arms them.
// A row's wake is what the daemon projects for it (waiting.nextBackstop "watchdog:<job>" while that job is active).
const SEATN = "arch-claude@shop";
const put = (dir, id, obj) => { fs.mkdirSync(join(root, dir), { recursive: true }); fs.writeFileSync(join(root, dir, `${id}.json`), JSON.stringify(obj)); };
const rowObj = (q, { state = "blocked", blockedOn = null, dest = SEATN, wake = null } = {}) => ({ qitemId: q, state, blockedOn, destinationSession: dest,
  waiting: { nextBackstop: wake ? { mechanism: `watchdog:${wake}`, intervalSeconds: 1 } : { mechanism: blockedOn ? "blocker-transition / queue-stuck-sweep" : "UNVERIFIED: no timed backstop" } } });
const row = (q, o) => put("rows", q, rowObj(q, o));            // before the handover
const rowAfter = (q, o) => put("rows-after", q, rowObj(q, o));  // after it
const DEFAULT = (q) => `Wake timer fired for parked qitem ${q}. Resume the recorded continuation and update the row.`;
const job = (id, interval, { wait = false, q = null, msg = null, policy = "periodic-reminder" } = {}) => put("jobs", id, { jobId: id, policy, intervalSeconds: interval, state: "active",
  specYaml: wait ? JSON.stringify({ message: "custom", context: { queue_wait: { qitemId: "q" } } })
    : `policy: ${policy}\ntarget:\n  session: "${SEATN}"\n` + (msg ?? (q && DEFAULT(q)) ? `message: ${JSON.stringify(msg ?? DEFAULT(q))}\n` : "") });
const OK = JSON.stringify({ ok: true, currentStatus: { currentOccupant: SEATN } });

test("WO56: after a completed handover, each parked row that lost its wake is re-armed (same row, blocker, interval); a live wake is left alone", () => {
  handover({ out: OK, before: { current_occupant: SEATN } });
  job("J-a", 3600); job("J-b", 900); job("J-live", 1800); job("J-lad", 300, { wait: true }); job("J-other", 60);
  row("qitem-a", { blockedOn: "qitem-up", wake: "J-a" }); rowAfter("qitem-a", { blockedOn: "qitem-up" });
  row("qitem-b", { wake: "J-b" }); rowAfter("qitem-b", {});
  row("qitem-live", { blockedOn: "qitem-up", wake: "J-live" }); rowAfter("qitem-live", { blockedOn: "qitem-up", wake: "J-successor-custom" });
  row("qitem-lad", { blockedOn: "qitem-up", wake: "J-lad" }); rowAfter("qitem-lad", { blockedOn: "qitem-up" });
  row("qitem-blocker-only", { blockedOn: "qitem-up" });                               // no timed wake: nothing to lose
  row("qitem-other", { wake: "J-other", dest: "review@shop" });                        // another seat's row
  row("qitem-done", { state: "done", wake: "J-a" });                                   // not parked
  const r = run("agent-seat-handover", [SEATN, "--source", "rebuild"]);
  assert.equal(r.status, 4, r.stdout + r.stderr);
  assert.match(r.calls, /rig queue update qitem-a --state blocked --blocked-on qitem-up --wake-after 3600s --note wake re-armed after the seat handover of arch-claude@shop \(the retiring occupant's wake J-a was stopped\)/);
  assert.match(r.calls, /rig queue update qitem-b --state blocked --wake-after 900s --note/);
  assert.match(r.stdout, /wake of qitem-a: re-armed, every 3600s, blocked on qitem-up/);
  assert.match(r.stdout, /wake of qitem-live: still live \(job J-successor-custom\), left alone/);
  assert.doesNotMatch(r.calls, /queue update qitem-(live|other|done|lad|blocker-only)/);
  assert.match(r.stderr, /wake of qitem-lad: NOT re-armed: it was a repeating wait \(every 300s\).*re-park it by hand/);
  assert.equal((r.calls.match(/^rig seat handover/gm) || []).length, 1);
});

test("WO56 (QA PR61): a row now owned by another seat, or no longer parked, is not re-parked; nothing recorded is exit 0", () => {
  handover({ out: OK }); job("J-a", 3600); job("J-b", 600);
  row("qitem-a", { blockedOn: "qitem-up", wake: "J-a" }); rowAfter("qitem-a", { blockedOn: "qitem-up", dest: "review@shop" });
  row("qitem-b", { wake: "J-b" }); rowAfter("qitem-b", { state: "handed-off" });
  let r = run("agent-seat-handover", [SEATN, "--source", "rebuild"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /wake of qitem-a: left alone, the row belongs to review@shop now/);
  assert.match(r.stdout, /wake of qitem-b: not needed, the row is handed-off now/);
  assert.doesNotMatch(r.calls, /queue update/);
  handover({ out: OK });
  r = run("agent-seat-handover", [SEATN, "--source", "rebuild"]);
  assert.equal(r.status, 0); assert.doesNotMatch(r.stdout + r.stderr, /wake of|WARN/);
});

test("WO56: the timeout-then-poll path re-arms too; a refused re-park exits 4 with the reason", () => {
  const fresh = { handover_result: "complete", handover_at: new Date(Date.now() + 1000).toISOString(), current_occupant: SEATN };
  handover({ err: "timed out", rc: 1, before: {}, done: fresh, after: 2 });
  job("J-a", 3600); row("qitem-a", { blockedOn: "qitem-up", wake: "J-a" }); rowAfter("qitem-a", { blockedOn: "qitem-up" });
  let r = run("agent-seat-handover", [SEATN, "--source", "rebuild", "--wait", "30"]);
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /complete at .*\n.*wake of qitem-a: re-armed/);
  handover({ out: OK }); job("J-a", 3600); row("qitem-a", { blockedOn: "qitem-up", wake: "J-a" }); rowAfter("qitem-a", { blockedOn: "qitem-up" });
  fs.writeFileSync(join(root, "update-fail"), "");
  r = run("agent-seat-handover", [SEATN, "--source", "rebuild"]);
  assert.equal(r.status, 4); assert.match(r.stderr, /wake of qitem-a: NOT re-armed: blocker_not_live: the blocker is done/);
});

test("WO56 (QA PR61): unreadable rows are never silent: a list failure or a row read failure WARNs, exits 4, and says what to check", () => {
  handover({ out: OK }); fs.writeFileSync(join(root, "list-fail"), "");
  let r = run("agent-seat-handover", [SEATN, "--source", "rebuild"]);
  assert.equal(r.status, 4, r.stderr); assert.match(r.stderr, /WARN: could not record arch-claude@shop's parked rows \(exit 1: daemon down\); no wake will be re-armed/);
  assert.match(r.stderr, /CHECK BY HAND: the seat's parked rows could not be recorded/);
  assert.match(r.calls, /rig seat handover/); assert.doesNotMatch(r.calls, /queue update/);
  handover({ out: OK }); job("J-a", 3600); job("J-b", 900);
  row("qitem-a", { blockedOn: "qitem-up", wake: "J-a" }); rowAfter("qitem-a", { blockedOn: "qitem-up" });
  row("qitem-b", { wake: "J-b" }); fs.writeFileSync(join(root, "show-fail-qitem-b"), "");
  r = run("agent-seat-handover", [SEATN, "--source", "rebuild"]);
  assert.equal(r.status, 4); assert.match(r.stderr, /WARN: qitem-b: could not read the row \(exit 1: transport failure\); its wake is not recorded/);
  assert.match(r.stdout, /wake of qitem-a: re-armed/); assert.match(r.stderr, /CHECK BY HAND: qitem-b/);
  handover({ out: OK }); row("qitem-c", { wake: "J-missing" });   // the wake job can't be read
  r = run("agent-seat-handover", [SEATN, "--source", "rebuild"]);
  assert.equal(r.status, 4); assert.match(r.stderr, /qitem-c: could not read its wake J-missing/);
  handover({ out: OK }); job("J-a", 3600); row("qitem-a", { blockedOn: "qitem-up", wake: "J-a" });
  fs.rmSync(join(root, "rows-after"), { recursive: true, force: true });
  const orig = fs.readFileSync(join(stubs, "rig"), "utf8");   // the row can't be read after the handover
  assert.ok(orig.includes(`[ -f "${root}/show-fail-$3" ]`), "stub hook point");
  fs.writeFileSync(join(stubs, "rig"), orig.replace(`[ -f "${root}/show-fail-$3" ]`, `[ -f "${root}/show-fail-$3" ] || { [ -f "${root}/shows-$3" ] && [ -f "${root}/fail-after" ]; }`));
  try {
    fs.writeFileSync(join(root, "fail-after"), "");
    r = run("agent-seat-handover", [SEATN, "--source", "rebuild"]);
    assert.equal(r.status, 4, r.stdout + r.stderr);
    assert.match(r.stderr, /wake of qitem-a: NOT checked: could not read the row .*rig queue update qitem-a --state blocked --blocked-on qitem-up --wake-after 3600s/);
  } finally { fs.writeFileSync(join(stubs, "rig"), orig, { mode: 0o755 }); fs.rmSync(join(root, "fail-after"), { force: true }); }
});

test("WO56: --wakes lists the parked rows' wakes and changes nothing; an UNKNOWN outcome lists them to check by hand", () => {
  handover({ out: OK }); job("J-a", 3600); job("J-l", 300, { wait: true });
  row("qitem-a", { blockedOn: "qitem-up", wake: "J-a" }); row("qitem-l", { blockedOn: "qitem-up", wake: "J-l" });
  let r = run("agent-seat-handover", [SEATN, "--wakes"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /qitem-a: timer every 3600s \(job J-a\), blocked on qitem-up\nqitem-l: repeating wait every 300s/);
  assert.match(r.stdout, /2 parked row\(s\) of arch-claude@shop with a timed wake/);
  assert.doesNotMatch(r.calls, /seat handover|queue update/);
  handover({ err: "timed out", rc: 1 }); job("J-a", 3600); row("qitem-a", { blockedOn: "qitem-up", wake: "J-a" });
  r = run("agent-seat-handover", [SEATN, "--source", "rebuild", "--wait", "0.3"]);
  assert.equal(r.status, 3); assert.match(r.stderr, /Parked rows whose timers a completed handover stops .*--wakes.*: qitem-a \(3600s\)/);
  assert.doesNotMatch(r.calls, /queue update/);
});

test("WO56 (QA PR61 f3): a custom wake message is re-armed but reported as not kept; a non-timer watchdog is reported, not re-armed", () => {
  handover({ out: OK });
  job("J-c", 1200, { msg: "Wake timer fired for parked qitem qitem-c. Check the provider limit first." });
  job("J-d", 600, { q: "qitem-d" }); job("J-w", 60, { policy: "artifact-gate" });
  row("qitem-c", { blockedOn: "qitem-up", wake: "J-c" }); rowAfter("qitem-c", { blockedOn: "qitem-up" });
  row("qitem-d", { wake: "J-d" }); rowAfter("qitem-d", {});
  row("qitem-w", { blockedOn: "qitem-up", wake: "J-w" }); rowAfter("qitem-w", { blockedOn: "qitem-up" });
  const r = run("agent-seat-handover", [SEATN, "--source", "rebuild"]);
  assert.equal(r.status, 4, r.stdout + r.stderr);
  assert.match(r.stdout, /wake of qitem-c: re-armed, every 1200s, blocked on qitem-up/);
  assert.match(r.stderr, /wake of qitem-c: its custom wake message was NOT kept .*: Wake timer fired for parked qitem qitem-c\. Check the provider limit first\./);
  assert.match(r.stdout, /wake of qitem-d: re-armed, every 600s/); assert.doesNotMatch(r.stderr, /qitem-d/);   // the default message: nothing lost
  assert.match(r.stderr, /wake of qitem-w: NOT re-armed: its wake was watchdog J-w \(policy artifact-gate\)/);
  assert.doesNotMatch(r.calls, /queue update qitem-w/);
});
