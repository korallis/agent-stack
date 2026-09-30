# Patch 139 evidence: full daemon suite, before/after event loop, rollback (2026-09-30)

Collected for the operator's re-gate after a live Jev HOLD on PR #21. Nothing on the live host was changed; only tmux
read queries were sent to the live tmux server.

## 1. Full daemon test suite (all 744 test files, 2,282 suites, 10,051 tests, through `agent-heavy build`)
The same worktree (korallis/openrig `local-patch-0.6.1`) was run twice:
- **patched** at f23494a2;
- **baseline**, with only the three changed sources (`adapters/tmux.ts`, `domain/seat-activity-service.ts`,
  `domain/seat-identity-reconciler.ts`) checked out from f930c450 (patch 138).

| run | tests | failed |
|---|---|---|
| baseline (138) | 10,051 | 77 |
| patched (139) | 10,051 | 73 |

Differences between the two failure sets:
- **Failing only at baseline (5):** the 5 new `tmux-batched-reads` tests, which need 139.
- **Failing only with 139 (1):** `list-processes-async.test.ts` › "F1 real async resolve_home … hands control back to the
  event loop". This is a real-`ps` timing test that imports none of the changed code, and it is **flaky on both**: run
  on its own, it failed 1 of 3 runs patched and 3 of 5 runs at baseline.
- The remaining 72 failures are identical in both runs. They are pre-existing on this host: runtime-adapter and resume
  tests (codex 19, claude-resume 9, codex-resume 9, native-resume-probe 7, pi 7, queue-pickup 5, …), the same set seen
  since WO9.

So 139 introduces no new test failure. Raw reports: `openrig-fix/tmp/p139-full-{patched,base}.json`.

## 2. Before/after event loop of the patched services, 87-seat topology
**What this is:** `patch-139-harness.mjs` (this directory) runs the daemon's **real** `SeatActivityService` (1 Hz sweep,
the daemon's cadence) and `SeatIdentityReconciler` (15 s, patch 136's cadence) from an `@openrig/cli` tree:
- against a **copy** of the live `openrig.sqlite` (87 running seats);
- against the **real tmux server** (read-only queries);
- in a Node 22 process holding **~380 MB** extra, so its RSS (~460–490 MB) is at or above the daemon's 378 MB. Spawn
  cost grows with RSS, so this is conservative.

**Before** = the live install's own dist (0.6.1 + 131–138). **After** = a copy of it with 139 applied. Two alternating
rounds of 120 s each, at host load ~8 → 3.

**What it isn't:** the whole daemon. Structural captures (5 s), transcript rotation and HTTP traffic are not included;
they are unchanged by 139. The live daemon at 84% includes them.

| round | tree | RSS MB | event-loop utilization | tmux spawns/s | delay p50 ms | delay p99 ms | delay max ms |
|---|---|---|---|---|---|---|---|
| 1 | before | 489 | **60%** | 102.9 | 10.1 | **520.9** | 812.1 |
| 1 | after | 460 | **1.3%** | 1.2 | 10.1 | **12.3** | 31.9 |
| 2 | before | 489 | **54.9%** | 102.9 | 10.1 | **470** | 534.5 |
| 2 | after | 461 | **1.3%** | 1.2 | 10.1 | **12.3** | 23 |

The two sweeps alone went from **55–60% → 1.3%** event-loop use, with p99 loop delay **470–521 ms → 12 ms** and tmux
spawns **103/s → 1.2/s**. The operator's live profile put these two at ~59% of daemon CPU (51.7% activity + 7%
identity). Expect the live daemon to drop by about that share, from 84% toward the ~25–30% seen after 136. That is an
expectation, not a measurement of the live daemon.

Reproduce: `node patch-139-harness.mjs <@openrig/cli tree> <copy of openrig.sqlite> 120` (Node 22, the daemon's).

## 3. Deploy and exact rollback
Deploy (operator):
```bash
L=~/.local/share/agent-stack/openrig/lib/node_modules/@openrig/cli
B=~/.local/share/agent-stack/backups; mkdir -p "$B"
for f in adapters/tmux domain/seat-activity-service domain/seat-identity-reconciler; do
  cp -p "$L/daemon/dist/$f.js" "$B/$(basename $f).js.pre-139"; done
openrig-apply-patches            # expect: applied 139-batch-seat-tmux-reads
openrig-daemon-cycle --reason "patch 139 batched tmux reads"
```
Rollback: restore the backups, then cycle.
```bash
L=~/.local/share/agent-stack/openrig/lib/node_modules/@openrig/cli; B=~/.local/share/agent-stack/backups
for f in adapters/tmux domain/seat-activity-service domain/seat-identity-reconciler; do
  cp -p "$B/$(basename $f).js.pre-139" "$L/daemon/dist/$f.js"; done
openrig-daemon-cycle --reason "rollback patch 139"
```
Equivalent without backups: `patch -p1 -d "$L" --reverse --forward --no-backup-if-mismatch < patches/openrig/0.6.1/139-batch-seat-tmux-reads.patch`.
Verified on a copy of the live install: after 139, the reverse restores all three files byte-identical to live pre-139.
To keep a later `openrig-apply-patches` (run by openrig-upgrade) from re-applying it, also move or delete
`patches/openrig/0.6.1/139-batch-seat-tmux-reads.patch` (revert the PR).
