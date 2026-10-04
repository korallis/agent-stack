### Security
- `agent-heavy` runs every job in a filesystem sandbox (bwrap): everything read-only except the job's repository,
  `~/.cache`, `~/Projects/*.worktrees`, `/tmp`, its `TMPDIR` and the slot dir; `HOME` and the XDG dirs are a per-run
  scratch dir. No unsandboxed fallback (exit 78 if bwrap can't run), and a job that would get the home directory
  writable is refused. A mutation run of a test-harness cleanup, started directly as the owner, had called
  `rmSync('/', {recursive: true})` and deleted `~/.config`, `~/.local/share` and the dotfiles.
- The seats' PreToolUse hook (Claude and Codex) refuses a test runner started outside agent-heavy, and CULTURE says
  tests, mutation runs and test scripts run only there.
- The seat `rig` wrapper finds the real `rig` from the passwd home, not `$HOME` (a per-run scratch dir inside
  agent-heavy).
