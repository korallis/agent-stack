### Security
- `agent-heavy` runs every job in a filesystem sandbox (bwrap): everything read-only except the job's repository,
  its seat's dir `~/.cache/agent-heavy/<seat>/` and the slot dir, with a private tmpfs `/tmp` per run (never another
  worktree, project or seat's files, nor the host's `/tmp`); `HOME` and the XDG dirs are a per-run
  scratch dir. No unsandboxed fallback (exit 78 if bwrap can't run), and a job that would get the home directory
  writable is refused. A mutation run of a test-harness cleanup, started directly as the owner, had called
  `rmSync('/', {recursive: true})` and deleted `~/.config`, `~/.local/share` and the dotfiles.
- The seats' PreToolUse hook (Claude and Codex) refuses a test runner started outside agent-heavy, and CULTURE says
  tests, mutation runs and test scripts run only there.
- The seat `rig` wrapper finds the real `rig` from the passwd home, not `$HOME` (a per-run scratch dir inside
  agent-heavy).
- `agent-heavy test`: a light class for test runs (4 slots, 200% CPU, 4G, 30 min, 2 workers, the same sandbox), so the
  test runs the guard now sends to agent-heavy don't queue behind builds. CULTURE: tests use it; Docker and sudo stay
  outside agent-heavy (bring services up first).
- Inside agent-heavy, mise keeps its trust state in the run's scratch HOME and trusts `~/Projects` and the job's repo
  by path, so `mise exec` and the shims apply a repo's tool pin; mise never installs a tool inside a job.
