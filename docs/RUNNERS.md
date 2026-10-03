# Local CI runners

The owner won't buy more GitHub Actions capacity (2026-10-02), and every korallis repo shares one account-wide
concurrency cap. So Linux CI jobs run on this host instead, on self-hosted runners that `agent-ci-runner` manages. Hosted runners
remain only for the exceptions below, and as the automatic fallback.

## How it works

- **Ephemeral runners, one or more per repo** (`--count`; a repo with parallel jobs, such as browser shards, can use
  several, still under the global job cap). korallis is a personal account, so a runner can serve only one repo. Each repo gets
  `agent-ci-runner@<repo>.service`, a systemd user unit. Before every job, `agent-ci-runner-register@<repo>.service`
  (`agent-ci-runner register <repo>`, a separate unit outside the sandbox because it needs `gh`; the runner unit requires
  it before each start) does three things:
  - wipes the work dir;
  - fetches a registration token with `gh api`. The token reaches the runner only as `ACTIONS_RUNNER_INPUT_TOKEN` in
    its environment: it is never printed and never on a command line;
  - registers a fresh `--ephemeral` runner `<host>-<repo>` with the label `korallis-local`.

  The runner exits after one job, and systemd starts the next fresh one.
- **Nothing a job writes reaches the next job.** A job can write its whole runner directory. So before every job, the
  runner itself is re-extracted from the checksum-verified release, and its `home/` and `toolcache/` are wiped. That
  means each job downloads its tools (Node, Playwright's browser) again. `AGENT_CI_KEEP_CACHE=1` keeps `home/` and
  `toolcache/` between jobs, which is faster, but a same-repo PR job could then leave files that a later main job
  uses. The runner itself is always fresh, and a release that fails its checksum is refused at every registration.
- **The job is sandboxed.** It runs with `PrivateUsers`, `ProtectHome=tmpfs`, `PrivateTmp` and `NoNewPrivileges`, and
  sees only:
  - its own `~/.local/share/agent-stack/ci-runners/<repo>/` (runner, `home/`, `toolcache/`). Its `home/` is mounted over
    the real home path, because the runner's worker sets `HOME` from the user database and tools write under `~`;
  - the shared gate hook;
  - the CI slot state.

  It never sees `~/.codex`, `~/.claude`, the proxy's keys, `gh`'s login or the seats' worktrees. That was proven on
  this host with a transient unit using the same properties.
- **Load bounds.**
  - Every runner sits in `agent-heavy.slice`, sharing its 24G memory ceiling with heavy builds.
  - Each runner has `MemoryMax=8G`, `MemorySwapMax=0`, `CPUQuota=800%` and `CPUWeight`/`IOWeight` 20, so seats win
    under contention.
  - The job-started hook (`system/ci-runner-hook`) holds a job until one of the `AGENT_CI_MAX_JOBS` global slots is
    free, so at most 2 CI jobs run at once across all repos.
  - For up to 15 minutes it also waits while load1 is above 24 (`AGENT_CI_MAX_LOAD`) or the host's CPU count, or
    MemAvailable is below 6 GB. Two parallel browser jobs plus the seats pushed load1 to about 35, and UI tests timed
    out, so the ceiling sits well below the CPU count.
- **Settings** live in `~/.config/agent-stack/ci-runners.env` (numbers only). Each job start reads them, so no restart
  is needed:

  ```
  AGENT_CI_MAX_JOBS=2          # raise to 3 if load allows
  AGENT_CI_MAX_LOAD_PER_CPU=1.0
  AGENT_CI_MAX_LOAD=24
  AGENT_CI_MIN_MEM_GB=6
  AGENT_CI_GATE_WAIT_S=900
  AGENT_CI_KEEP_CACHE=0        # 1 keeps home/ and toolcache/ between jobs (see above)
  ```
- **Fallback.** The repo variable `CI_LOCAL=1` sends a repo's Linux jobs here.
  - `agent-ci-runner install` sets it only once GitHub lists the runner online.
  - `stop` and `remove` clear it first.
  - `agent-ci-runner-watch.timer` checks every 2 minutes. If a runner has been down for 10 minutes it clears the
    variable, so jobs run hosted instead of queueing, and it sets the variable again when the runner is back.
- **Each runner has its own app port.** Jobs get `E2E_PORT` (from 47100 upwards, stable per runner, set by
  `register`), `TZ=UTC` and `C.UTF-8`, as on hosted Ubuntu. Two runners on this host share its network, so a project
  whose tests start an app server must take its port from `E2E_PORT` (a fixed port collides between parallel jobs).
- **Fork PRs never run here.** `runs-on` sends them to a hosted runner (see below). Also turn on the repo setting
  "Require approval for all outside collaborators" (Settings → Actions → Fork pull request workflows), especially on
  the public agent-stack-hd.

## Workflow change (one small PR per repo, through its own gate)

For each Linux job:

```yaml
    runs-on: ${{ (vars.CI_LOCAL == '1' && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository)) && fromJSON('["self-hosted","linux","korallis-local"]') || 'ubuntu-24.04' }}
```

Each workflow also needs `concurrency: { group: <name>-${{ github.ref }}, cancel-in-progress: true }`. Jobs that
install system packages with `sudo apt-get` must use the tools on this host instead: a sandboxed job has no sudo.

**Main lane (optional).** With one runner, a repo's post-merge runs on `main` queue behind its PR runs, and when every
merge waits for a green `main`, those runs are the bottleneck. `agent-ci-runner install <repo> --count 2 --main-lane`
gives the last runner only the label `korallis-local-main`, so it never takes a PR job. The repo's workflow then sends
push-to-main jobs to that label:

```yaml
    runs-on: ${{ (vars.CI_LOCAL == '1' && (github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository)) && fromJSON(github.event_name == 'push' && github.ref == 'refs/heads/main' && '["self-hosted","linux","korallis-local-main"]' || '["self-hosted","linux","korallis-local"]') || 'ubuntu-24.04' }}
```

The lane is kept on re-install until `--no-main-lane`, scale-down below 2, or `remove`. A change reaches an active runner
at its next registration (after its current job). The global job cap and the load gate apply to the lane runner too.
`watch` counts the repo healthy only while a PR runner and the lane runner are both up; otherwise it clears `CI_LOCAL`
after 10 minutes, as for a single runner.

## Hosted exceptions

- **A project job with service containers** (for example postgres and redis under `services:`). That needs Docker, and this user isn't in
  the `docker` group, which would be root-equivalent and needs sudo, so the job stays on hosted runners. Easy upgrade:
  if the owner installs rootless podman (`sudo pacman -S podman`, plus `systemctl --user enable --now podman.socket`), point
  `DOCKER_HOST` at the podman socket in the unit and move the job here.
- **agent-stack-hd macOS and Windows** stay hosted. They run only on non-draft
  `pull_request: [opened, ready_for_review, synchronize]`, with `cancel-in-progress`, to spare the scarce hosted slots.

## Runbook

| Task | Command |
|---|---|
| Install or upgrade a repo's runner(s) | `agent-ci-runner install <repo> [--count N]` (`--dry-run` to see the plan) |
| Run N runners for one repo | `agent-ci-runner install <repo> --count N`: runner k >= 2 is the instance `<repo>_r<k>` (unit `agent-ci-runner@<repo>_r<k>`, GitHub name `<host>-<repo>-<k>`), each with its own job slot. A lower N removes the extra runners |
| Keep one runner for `main` | `agent-ci-runner install <repo> --count 2 --main-lane` (undo: `--no-main-lane`); see *Main lane* above |
| Pause (jobs go hosted) / resume | `agent-ci-runner stop <repo>` / `agent-ci-runner start <repo>` (a runner that is already active, maybe mid-job, is left alone) |
| Re-register after a failure | `agent-ci-runner stop <repo> && agent-ci-runner start <repo>` (every start registers afresh) |
| Remove | `agent-ci-runner remove <repo>` (`--keep` keeps the directory) |
| State of all runners, slots and load | `agent-ci-runner status` (`--json`) |
| Logs | `agent-ci-runner logs <repo> -n 200`, or `journalctl --user -u agent-ci-runner@<repo>` |
| Change the job cap | edit `AGENT_CI_MAX_JOBS` in `~/.config/agent-stack/ci-runners.env` |
| Upgrade the runner version | bump `VERSION` and `SHA256` in `bin/agent-ci-runner` (from the release notes' `BEGIN SHA linux-x64`), then `install` each repo |

The runner version is pinned and `--disableupdate`. GitHub stops accepting very old runners, so bump the pin when a
job log warns about it.
