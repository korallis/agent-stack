# WO9 item 3: why the 0.6.1 daemon stalled (18:30–18:50Z, anon_pipe_read, accept queue 509/511)

Read-only. Nothing on the live host was changed.

## Answer
There is **no synchronous call site behind it**. The main thread was saturated, not stopped, by the fork cost of
**asynchronous** child processes: tmux captures and reads plus `ps` from the daemon's background sweeps. By the
operator's profile, 96% of daemon CPU was in `child_process.spawn`: structural poll 30%, identity reconciler 27%,
seat-activity 19%, transcripts 16%. On Linux, libuv's `uv_spawn` forks, and the parent then does a blocking `read()` on a CLOEXEC pipe until the
child has exec'd. That is `anon_pipe_read`, and it happens for `execFile`/`spawn` too, not only `*Sync`. The fork's
cost grows with the parent's RSS, and more so under swap.

## Evidence
1. **Slow-operations log** (`~/.openrig/logs/slow-operations.jsonl*`, written off-thread by the daemon's recorder):
   - Between 18:30 and 18:50Z, no gap between records is longer than 24s. The loop kept turning, slowly. A 9-minute
     sync block would leave a 9-minute hole.
   - No recorded sync site (`runSyncSite`) completed slowly in the window.
   - Async `codex.runtime.list_processes` (`ps -Ao …`, about 400KB of output with 1,700 host processes): mean 0.2s at
     17:00–17:30Z, 2.2s at 18:30Z, 3.6s at 18:40Z (max 26.5s). This is lag, not the cause.
2. **The "crash loop" was the old healthcheck cycling a live daemon** (journal). It used a 5s curl, and 2 misses
   triggered a cycle. The cycles came at 18:34, 18:36 and 18:38Z; each new daemon used 2m30s of CPU in 2 minutes of wall
   time, reached 0.75–1.1 GB RSS, and swapped (329 MB peak). From 18:40Z the hot-tuned healthcheck (15s curl, 3
   probes, 600s cooldown) held off; healthz kept timing out until about 18:48Z.
3. **Repro** (`docs/incidents/spawn-cost.mjs`): 200 async `execFile("tmux",["-V"])` calls; main-thread time spent inside the call:
   - RSS 59 MB: mean 0.84 ms
   - RSS ~960 MB: mean **12.5 ms** (max 33 ms); under a 3,000-spawn burst, mean 20.9 ms (max 108 ms)
   - Sampling the main thread's `wchan` during the burst: **anon_pipe_read 95/200**, running 105/200.
4. **Load at 0.6.1's defaults**: `transcripts.lines=1000`, `poll_interval_seconds=2`. That is one `capture-pane -S -1000`
   per seat every 2s: about 45 spawns/s with ~90 seats, plus a full-file sync write and rename for each.
   - At ~12–20 ms per spawn, that alone is 55–90% of the main thread, before any requests or probes. Under swap the loop
     saturates:
     - accept() falls behind, so the accept queue fills;
     - SIGCHLD is handled on the loop, so exited tmux clients stay defunct (the "hundreds of defunct tmux clients").
   - `transcript-rotation.js` uses `setInterval` with no single-flight, so slow ticks overlap and add more spawns.
   - At 15s/400 lines: about 6 spawns/s, which is 7x fewer.
5. **Sync sites inventoried** (for completeness):
   - Wrapped by `runSyncSite` with a timeout: bootstrap/rigspec/codex preflights 10s, review.gather 4s.
   - Unwrapped: execution-view 5s (served in ≤0.4s in the window), workflow-guidance 2s, skill-catalog git with **no
     timeout** (managed skill catalog only; not used here).
   - None fired slowly in the window. A Node repro confirms that `*Sync` with a timeout returns at the timeout even if
     a grandchild holds the pipe.

## Operator CPU profile and the follow-up fix (patch 136)
- The operator's 19:05Z CPU profile of the daemon: **96% in `child_process.spawn`** (via the tmux adapter).
  - structural activity poll: 30%, including patch 135's ANSI re-capture at 7.6%;
  - seat identity reconciler: 27%;
  - seat-activity (window_activity) sampler: 19%;
  - transcript rotation: 16%.
- So transcripts alone were not the cause: the stall recurred at 19:03Z with transcripts already at 400/15.
- The operator hot-patched the live dist (backups `~/.local/share/agent-stack/backups/*.pre-interval`):
  - `DEFAULT_STRUCTURAL_POLL_INTERVAL_MS` 1000 → 5000;
  - `DEFAULT_STRUCTURAL_STALE_MS` 5000 → 25000;
  - `DEFAULT_IDENTITY_POLL_INTERVAL_MS` 5000 → 15000.
  Daemon load went from **100% to 25–31%**. The seat-activity sampler (1s, feeds the debounce windows) was left alone
  on purpose.
- Spawns per sweep, for scale:
  - the structural sweep captures every running seat (a second, ANSI capture for unclassified Codex panes);
  - the identity sweep runs `tmux list-sessions`, two whole-host `ps` snapshots, and tmux pane pid/command reads per
    seat: ~200 spawns on an 87-seat host.
- **The identity sweep had no single-flight guard** (`setInterval(() => void reconcileAll())`). Once `ps` took longer
  than the interval under load (26.5s at 18:44Z in the slow-ops log), sweeps overlapped and multiplied the spawns.
- Patch 136 (0.6.1; source korallis/openrig `local-patch-0.6.1` 9674d254) carries the three values and adds the
  single-flight guard. A failed sweep releases the guard, and its rejection still surfaces exactly as before.

What else depended on the old cadence (audited in the 0.6.1 source):
- The structural cache has one reader, `attachAgentActivity` (the `rig ps` / sessions ACTIVITY column).
  - It is consulted only when no fresh positive hook exists, and live window motion still upgrades it to running.
  - A verdict is refreshed every 5s. The 25s stale window matters only if the poller stops, and it keeps its old 5x
    ratio to the poll.
- Patch 135's idle-composer path runs inside the same sweep, so it now updates every 5s too: an idle Codex seat may read
  "running" for up to ~5s after it stops.
- The seat-activity arbitration (`HOOK_AUTHORITY_WINDOW_MS` 15s, `CROSS_RUNG_CONTRADICTION_WINDOW_MS` 10s, idle debounce
  2 ticks / 2.5s) reads the hook and window-sampling rungs only. These are fed by hooks and the unchanged 1Hz sampler,
  never by the structural cache.
- The identity verdicts have no freshness window. Nothing reads them on a timer, so 15s only delays noticing a
  squatted or dead pane by up to 10s more.
- Tests: `packages/daemon/test/poll-cadence.test.ts`, plus the structural, identity, activity and idle-composer suites
  (52/52). The full daemon suite has 72 pre-existing failures on this host. With the patch there were 77. The 5 extra
  are timing-sensitive tests run under load 60+: 4 pass when rerun on their own, and the fifth fails the same way in
  the baseline.

Deploying 136 on the live, hand-patched install:
1. Restore the two `*.pre-interval` backups over `daemon/dist/domain/seat-{structural-activity-service,identity-reconciler}.js`.
   They equal the 0.6.1 tarball plus 131–135.
2. Run `openrig-apply-patches`. As is, 136 would be reported failed, because neither forward nor reverse applies over
   the hand edit.
3. `openrig-daemon-cycle` to load the single-flight guard.
Simulated on a copy of the live files: the result is byte-identical to a fresh install with 131–136.

## Live finding: the 15s/400 tune was undone
- `rig daemon start` resolves `transcripts.*` env-first, then `config.json`, and **re-exports the result**
  (`dist/daemon-lifecycle.js:310`, `commands/daemon.js:196`).
- The daemon's environment is inherited by every seat it launches: 28 of 40 sampled agent processes carry
  `OPENRIG_TRANSCRIPTS_LINES=1000`.
- So a daemon cycle run **from a seat** re-exports 1000/2 and silently overrides `config.json`. The 19:06Z manual cycle
  (pid 2964442) did exactly that. `rig config get transcripts.lines` gives 1000 from a seat and 400 with the variables
  unset.
- The healthcheck's own cycles run under systemd, with a clean environment, so they were not affected.
- Fix (this PR): `openrig-daemon-cycle` starts the daemon with the four transcript variables unset (`env -u`), so
  `config.json` (400/15, set by install.sh) wins.

## Load from outside the daemon (19:20Z)
Host load reached 101 on 32 cores. The biggest consumers were full daemon vitest runs from openrig-fix (mine) plus
MTA's tsc/eslint/vitest across worktrees. That starved the daemon again. Changes in this PR:
- the daemon runs at `CPUWeight=1000` (`openrig-daemon-cycle`'s scope and `openrig.service`). IOWeight is set too, but
  the user manager here delegates only `cpu memory pids`, so it takes effect only after the root step in docs/UPGRADE.md;
- every seat's rules (rig template CULTURE, starter-kit AGENTS, role guidance, skills) now require
  `agent-heavy build|browser --` for heavy runs and forbid pattern `pkill`; `agent-project-check` WARNs when a
  project's conventions lack the rule.

## Health check: slow versus hung
The 600s cooldown left a genuinely stalled daemon stalled (repeated cooldown skips 19:05–19:22Z). The health check now
cycles inside the cooldown when the daemon is hung:
- the listener's accept queue is at least 80% of the backlog; or
- its main thread gained no CPU time across the ~50s of probes.

A daemon that is merely slow (still accepting, main thread busy) still waits the cooldown out. At most 3 health-check
cycles in 30 minutes, then alerts only.

## Upstream issue (recommended), draft
**Title:** Transcript rotation saturates the daemon event loop at scale (spawn cost ~ RSS); transcript config leaks into seat env

1. With the default `transcripts.lines=1000` / `poll_interval_seconds=2`, the daemon spawns one `tmux capture-pane` per
   seat every 2s. Each async spawn blocks the main thread in `uv_spawn` (fork, then a blocking read on the exec-status
   pipe), and that cost grows with RSS: 0.8 ms at 60 MB, 12–20 ms at 1 GB (repro attached). With ~90 seats the loop
   saturates: healthz times out, the accept queue fills, and child zombies build up. Proposals:
   - single-flight per session (skip a tick while one is in flight);
   - one global cap or a batched tick (one tmux invocation for all panes, e.g. a `capture-pane … \;` chain);
   - jitter;
   - a less aggressive default (for example 15s/400);
   - skip unchanged panes (check `#{history_size}` / `#{cursor_y}`, or compare by hash, before the full rewrite);
   - move the sync `writeFileSync`/`renameSync` off the loop.
2. `rig daemon start` exports resolved `OPENRIG_TRANSCRIPTS_*` into the daemon's environment. That environment reaches
   every seat, so a restart launched from a seat pins the old values over `config.json`. Suggest not exporting defaults,
   or not propagating these variables to seat processes.
3. The background sweeps' cadence is too aggressive for large fleets. The structural activity poll captures every seat
   every 1s. The seat identity reconciler runs about 200 tmux/ps spawns every 5s, with no single-flight, so slow `ps`
   stacks sweeps. Proposals:
   - scale the cadence with fleet size, or batch the reads into one tmux call (`list-panes -a -F` covers pane
     pid/command for every seat at once);
   - add single-flight to the identity sweep;
   - skip the ANSI re-capture when the plain capture is unchanged.
   Operator profile: 96% of daemon CPU in `child_process.spawn`; load 100% → 25–31% with 5s/25s/15s.
4. Minor: `skill-catalog.js` git `execFileSync` calls have no timeout; give them the same bound as the other sync
   sites.
