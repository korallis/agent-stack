### Added
- Local CI runners (WO100, docs/RUNNERS.md): `agent-ci-runner` installs one ephemeral, sandboxed GitHub Actions runner
  per korallis repo as `agent-ci-runner@<repo>.service`. Jobs can't see the agents' homes or keys. Runners sit inside
  agent-heavy.slice with low CPU and IO weight. A job gate allows at most `AGENT_CI_MAX_JOBS` (2) CI jobs at once and
  waits while the host is overloaded. The repo variable `CI_LOCAL` routes a repo's Linux jobs here, and
  `agent-ci-runner-watch.timer` clears it when a runner has been down for 10 minutes. Fork PRs always run hosted.
