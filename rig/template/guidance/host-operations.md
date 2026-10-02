# Host operations

Read before heavy runs, scratch setup, credential use or a context handover.

- Heavy runs share the machine: wrap every tsc, eslint, vitest/jest, `npm test`, `next build`, Playwright run and full
  test suite in `agent-heavy build -- <cmd>` (`agent-heavy browser -- <cmd>` for Playwright and other browser tests). It
  holds a shared slot (2 at once, capped CPU and RAM) so a burst of seats can't starve the host or the OpenRig daemon.
  Prefer the focused run (the files or journeys you touched) over the full suite; run the full suite once, at the end.
  Never wrap a server (`npm start`, `npm run start:*|dev|serve|preview`, `next start|dev`, `vite`): it never finishes and
  would hold a shared slot. agent-heavy refuses it; run it outside and wrap only the tests that use it. Jobs are stopped
  at a max runtime (45min build, 30min browser; `--max-runtime` to raise it) and killed past a memory ceiling (14G
  build, 8G browser, 24G for all heavy runs; exit 137). Run test runners with few workers (`node --test
  --test-concurrency=4`, `jest --maxWorkers=4`); a run killed for memory is rerun focused, not just repeated. Waiters
  are served in arrival order (`agent-heavy status` shows the queue). `--priority urgent` is for critical-path QA and
  merge-gate re-runs only (`critical` for an outage); it moves you up the queue, never stops a running job.
- Never `pkill -f`/`killall` by a pattern: it also matches other seats' command lines. Stop your own processes by PID
  (`pgrep -f` narrowed by cwd or parent PID, then `kill <pid>`).
- Never print a credential: connection strings, passwords, API keys and tokens never go to a command's output (it is
  your transcript) or into a tool input. Write them to a 0600 file (`neon cs … --output-file <path>`; the seat guard in
  front of `neon` and `vercel` refuses anything else) and use them by name. A flag the installed CLI's `--help` doesn't
  list may be silently ignored: check before relying on it. If a secret was printed, tell the owner at once so it gets
  rotated.
- Credential files (`.env*`, `*runtime-url*`, `*.pem`, the secrets directory) are never printed or read into the
  transcript: a machine-wide hook refuses it. Load them by name (`set -a; . <file>; set +a; <command>`, `--env-file`)
  and never work around a refusal.
- Context wall: when your context passes ~85%, write your handover packet (open work, decisions WITH rationale under a
  "Decisions" heading, facts you couldn't check marked `UNVERIFIED:`) and publish it with
  `agent-seat-recap write <packet.md> [--learned <lessons.md>]`. It becomes your seat's RECAP.md, the first thing a
  `rig seat handover --source rebuild` successor reads; lessons for every later occupant go to LEARNED.md. A packet
  anywhere else is never read by the rebuild. Check with `agent-seat-recap show`.
- Scratch checkouts for review or QA go under `~/Projects/<P>.worktrees/`, never `/tmp`, and are removed in a
  `finally`/`trap`. Test suites remove every `mkdtemp` directory they create.
- `TMPDIR` and other temporary scratch go on disk and OUTSIDE any git repo, under the seat's root
  `$HOME/.cache/<rig>-tmp/<seat>`: each job makes its own directory there and its `trap` removes only that one (other
  jobs of the seat may be using the root at the same time). Never `/tmp` (a RAM disk on these hosts: a big scratch run
  takes memory from every seat), and never inside a worktree (tests treat a directory under a git repo as a checkout).
  In a seat (its session name is `<seat>@<rig>`), this sets it up; the trap names the job's directory as it was made:
  `s=${OPENRIG_SESSION_NAME:-$USER@local}; d="$HOME/.cache/${s#*@}-tmp/${s%@*}"; mkdir -p "$d"; export TMPDIR=$(mktemp -d "$d/job.XXXXXX"); trap "rm -rf -- $(printf %q "$TMPDIR")" EXIT`
- Proof for a project in the workspace catalog: `rig proof show|judge <project-id>:<mission>/slices/<slice>` (the catalog
  id). Never switch the daemon's workspace to judge.
- Never prompt: every seat runs without permission prompts (agent-stack README, "Never prompt";
  `agent-never-prompt-check`).
